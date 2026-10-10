#!/usr/bin/env node
import { spawn } from "node:child_process";
import fs from "node:fs";
import { fileURLToPath } from "node:url";
import {
  ackInbox,
  appendInbox,
  appendSeenKeys,
  appendTalk,
  clearAccountWake,
  clearBlocked,
  clearPid,
  findAccount,
  getAccountAssistant,
  getTalkCount,
  hasGlobalWake,
  inboxByIds,
  isAllowed,
  lastAssistantAt,
  listAccounts,
  listBlocked,
  listInboxRaw,
  loadSeenKeys,
  loadState,
  markAssistantLost,
  monitorRunning,
  packMsgs,
  noteBlocked,
  paths,
  peekInbox,
  removeAccount,
  resolveWakeForAccount,
  slim,
  talkKey,
  updateState,
  writePid,
} from "./store.js";
import {
  collectInbound,
  getUpdates,
  MSG_STATE,
  MSG_TYPE,
  loginStart,
  loginWait,
  notifyStart,
  notifyStop,
  sendMedia,
  sendText,
  setAccountWake,
  setDedicatedAssistant,
  setTyping,
  statusPayload,
} from "./ilink.js";
import { registerShutdownCleanup, touchConnectorActive, connectorAbandoned, runUninstall, uninstallWechat } from "./uninstall.js";

const self = fileURLToPath(import.meta.url);

// Per-RPC disk logging is sync I/O on the hot path; opt in with GROK_WECHAT_DEBUG=1.
const DEBUG = process.env.GROK_WECHAT_DEBUG === "1";
function dlog(line) {
  if (!DEBUG) return;
  try {
    const { home, debug } = paths();
    fs.mkdirSync(home, { recursive: true });
    fs.appendFileSync(debug, `${new Date().toISOString()} ${line}\n`);
  } catch { /* ignore */ }
}
dlog(`spawn pid=${process.pid} argv=${JSON.stringify(process.argv)} cwd=${process.cwd()}`);
try {
  if (process.stdout._handle?.setBlocking) process.stdout._handle.setBlocking(true);
  if (process.stdin._handle?.setBlocking) process.stdin._handle.setBlocking(true);
} catch { /* ignore */ }


function ok(data) {
  // Compact JSON — tools/list + tool results are billed as agent tokens.
  return { content: [{ type: "text", text: JSON.stringify(data) }] };
}

function fail(message) {
  return { content: [{ type: "text", text: JSON.stringify({ error: message }) }], isError: true };
}

async function sleep(ms) {
  await new Promise((r) => setTimeout(r, ms));
}

function ensureMonitor() {
  const existing = monitorRunning();
  if (existing) return { already_running: true, pid: existing };
  const accounts = listAccounts();
  if (!accounts.length) return { started: false, reason: "not_logged_in" };
  const child = spawn(process.execPath, [self, "--monitor"], {
    detached: true,
    stdio: "ignore",
    env: process.env,
  });
  child.unref();
  writePid(child.pid);
  return { started: true, pid: child.pid, account_count: accounts.length };
}

const accountRefSchema = {
  ilink_bot_id: { type: "string", description: "bound bot id" },
  ilink_user_id: { type: "string", description: "bound user id" },
};

const tools = {
  wechat_login_start: {
    description: "QR login start; then wechat_login_wait until logged_in.",
    inputSchema: { type: "object", properties: {} },
    handle: async () => ok(await loginStart()),
  },
  wechat_login_wait: {
    description: "Poll QR; retry while waiting; on expired re-start.",
    inputSchema: {
      type: "object",
      properties: {
        timeout_ms: { type: "number", description: "ms, default 120000" },
        qrcode: { type: "string", description: "optional qr id" },
      },
    },
    handle: async ({ timeout_ms, qrcode }) => {
      const r = await loginWait(timeout_ms || 120_000, qrcode);
      if (r && r.logged_in) ensureMonitor();
      return ok(r);
    },
  },
  wechat_status: {
    description: "Accounts, allowlist, monitor pid.",
    inputSchema: { type: "object", properties: {} },
    handle: async () => {
      const payload = statusPayload();
      payload.monitor_pid = monitorRunning();
      return ok(payload);
    },
  },
  wechat_logout: {
    description: "Logout all, or one via ilink_bot_id.",
    inputSchema: {
      type: "object",
      properties: {
        ...accountRefSchema,
        all: { type: "boolean", description: "logout all (default)" },
      },
    },
    handle: async ({ ilink_bot_id, ilink_user_id, all }) => {
      const pid = monitorRunning();
      const state = loadState();
      const logoutAll = all !== false && !ilink_bot_id && !ilink_user_id;
      if (logoutAll) {
        if (pid) {
          try { process.kill(pid, "SIGTERM"); } catch { /* already gone */ }
          clearPid();
        }
        updateState((s) => {
          s.accounts = [];
          s.pendingQrs = [];
          return s;
        });
        return ok({ logged_out: true, scope: "all" });
      }
      const before = listAccounts(state).length;
      updateState((s) => removeAccount(s, { ilink_bot_id, ilink_user_id }));
      const after = listAccounts(loadState()).length;
      if (after === before) {
        throw new Error("未找到要登出的账号");
      }
      if (!after && pid) {
        try { process.kill(pid, "SIGTERM"); } catch { /* already gone */ }
        clearPid();
      } else if (after && !monitorRunning()) {
        ensureMonitor();
      }
      return ok(slim({
        logged_out: true,
        scope: "one",
        ilink_bot_id: ilink_bot_id || undefined,
        remaining_accounts: after,
      }));
    },
  },
  wechat_inbox: {
    description: "Peek inbox (does NOT clear). Returns msgs[{id,from,bot,text,media,sid,asst}] + hist{sid:[{r,t}]} (full history, until the assistant's thread has it) + thread[sids] (history already in the assistant's thread, not resent). Prefer the wake payload if present. After replying call wechat_ack.",
    inputSchema: { type: "object", properties: {} },
    handle: async () => ok({ ...peekInbox(), ack: "wechat_ack" }),
  },
  wechat_ack: {
    description: "Ack/remove inbox msgs after successful reply (call AFTER wechat_send). Pass ids from msgs; omit ids to clear all. `unsynced` lists conversations acked with no reply sent since: their history will be resent.",
    inputSchema: {
      type: "object",
      properties: {
        ids: { type: "array", items: { type: "string" }, description: "msg ids to remove" },
      },
    },
    handle: async ({ ids }) => ok(ackInbox(ids)),
  },
  wechat_send: {
    description: "Send text; needs prior inbound context_token. Markdown→plain.",
    inputSchema: {
      type: "object",
      properties: {
        text: { type: "string" },
        to_user_id: { type: "string" },
        ilink_bot_id: accountRefSchema.ilink_bot_id,
      },
      required: ["text", "to_user_id"],
    },
    handle: async ({ text, to_user_id, ilink_bot_id }) => ok(await sendText(to_user_id, text, ilink_bot_id)),
  },
  wechat_send_media: {
    description: "Send local image|video|file.",
    inputSchema: {
      type: "object",
      properties: {
        path: { type: "string" },
        kind: { type: "string", enum: ["image", "video", "file"] },
        to_user_id: { type: "string" },
        ilink_bot_id: accountRefSchema.ilink_bot_id,
        caption: { type: "string" },
      },
      required: ["path", "kind", "to_user_id"],
    },
    handle: async ({ path, kind, to_user_id, ilink_bot_id, caption }) =>
      ok(await sendMedia(to_user_id, path, kind, caption, ilink_bot_id)),
  },
  wechat_typing: {
    description: "Typing on/off. Auto-on after receive; auto-off after send.",
    inputSchema: {
      type: "object",
      properties: {
        on: { type: "boolean" },
        to_user_id: { type: "string" },
        ilink_bot_id: accountRefSchema.ilink_bot_id,
      },
      required: ["on", "to_user_id"],
    },
    handle: async ({ on, to_user_id, ilink_bot_id }) => ok(await setTyping(to_user_id, on, ilink_bot_id)),
  },
  wechat_start_monitor: {
    description: "Start inbound long-poll monitor.",
    inputSchema: { type: "object", properties: {} },
    handle: async () => ok(ensureMonitor()),
  },
  wechat_set_wake: {
    description: "Save wake webhook url+key. With ilink_bot_id: that account's own webhook, created under its dedicated assistant so wakes go straight to it (no dispatcher). Without: global fallback for accounts that have none.",
    inputSchema: {
      type: "object",
      properties: {
        url: { type: "string" },
        key: { type: "string" },
        ilink_bot_id: { type: "string" },
      },
      required: ["url", "key"],
    },
    handle: async ({ ilink_bot_id, url, key }) => ok(await setAccountWake(ilink_bot_id, url, key)),
  },
  wechat_set_dedicated_assistant: {
    description: "Register per-account dedicated assistant. Re-registering resets sync: the next wake carries full history again.",
    inputSchema: {
      type: "object",
      properties: {
        ilink_bot_id: { type: "string" },
        assistant_id: { type: "string" },
        assistant_name: { type: "string" },
      },
      required: ["ilink_bot_id", "assistant_name"],
    },
    handle: async ({ ilink_bot_id, assistant_id, assistant_name }) =>
      ok(setDedicatedAssistant(ilink_bot_id, assistant_id, assistant_name)),
  },
  wechat_stop_monitor: {
    description: "Stop monitor.",
    inputSchema: { type: "object", properties: {} },
    handle: async () => {
      const pid = monitorRunning();
      if (!pid) return ok({ stopped: true, was_running: false });
      try { process.kill(pid, "SIGTERM"); } catch { /* ignore */ }
      clearPid();
      return ok({ stopped: true, pid });
    },
  },
  wechat_approve: {
    description: "Allowlist (default-deny; the account owner is always allowed). user_id=allow that sender; clear=empty the list. No args: list allow_from + recently blocked senders.",
    inputSchema: {
      type: "object",
      properties: {
        user_id: { type: "string" },
        clear: { type: "boolean" },
      },
    },
    handle: async ({ user_id, clear }) => {
      const state = updateState((s) => {
        if (clear) s.allowFrom = [];
        else if (user_id && !s.allowFrom.includes(user_id)) s.allowFrom.push(user_id);
        return s;
      });
      if (user_id && !clear) clearBlocked(user_id);
      return ok({ allow_from: state.allowFrom, blocked: listBlocked() });
    },
  },
  wechat_uninstall: {
    description: "Full local uninstall + platform cleanup hints.",
    inputSchema: { type: "object", properties: {} },
    handle: async () => ok(uninstallWechat()),
  },
};

const TOOL_LIST = Object.entries(tools).map(([name, t]) => ({
  name,
  description: t.description,
  inputSchema: t.inputSchema,
}));

async function dispatch(name, args) {
  const tool = tools[name];
  if (!tool) return fail(`未知工具: ${name}`);
  try {
    return await tool.handle(args || {});
  } catch (err) {
    return fail(err instanceof Error ? err.message : String(err));
  }
}

function writeMessage(msg) {
  const json = JSON.stringify(msg);
  fs.writeSync(1, json + "\n");
  dlog(`out ${json.slice(0, 200)}`);
}

async function onRpc(msg) {
  dlog(`in ${JSON.stringify({ id: msg.id, method: msg.method }).slice(0, 300)}`);
  const { id, method, params } = msg;
  if (method === "initialize") {
    touchConnectorActive();
    ensureMonitor();
    return {
      jsonrpc: "2.0",
      id,
      result: {
        protocolVersion: params?.protocolVersion || "2024-11-05",
        capabilities: { tools: {} },
        serverInfo: { name: "grok-wechat", version: "1.11.1" },
      },
    };
  }
  if (method === "notifications/initialized" || method === "initialized") return null;
  if (method === "ping") return { jsonrpc: "2.0", id, result: {} };
  if (method === "tools/list") {
    touchConnectorActive();
    return { jsonrpc: "2.0", id, result: { tools: TOOL_LIST } };
  }
  if (method === "tools/call") {
    touchConnectorActive();
    const result = await dispatch(params?.name, params?.arguments);
    return { jsonrpc: "2.0", id, result };
  }
  if (id === undefined) return null;
  return { jsonrpc: "2.0", id, error: { code: -32601, message: `Method not found: ${method}` } };
}

function startMcp() {
  registerShutdownCleanup();
  ensureMonitor();
  let buf = Buffer.alloc(0);
  process.stdin.on("data", async (chunk) => {
    buf = Buffer.concat([buf, chunk]);
    while (true) {
      const headerEnd = buf.indexOf("\r\n\r\n");
      if (headerEnd === -1) {
        const nl = buf.indexOf("\n");
        if (nl !== -1) {
          const line = buf.slice(0, nl).toString("utf8").trim();
          buf = buf.slice(nl + 1);
          if (line.startsWith("{")) {
            try {
              const reply = await onRpc(JSON.parse(line));
              if (reply) writeMessage(reply);
            } catch (err) {
              writeMessage({ jsonrpc: "2.0", id: null, error: { code: -32700, message: String(err) } });
            }
            continue;
          }
        }
        break;
      }
      const header = buf.slice(0, headerEnd).toString("utf8");
      const match = header.match(/Content-Length:\s*(\d+)/i);
      if (!match) {
        buf = buf.slice(headerEnd + 4);
        continue;
      }
      const len = Number(match[1]);
      const start = headerEnd + 4;
      if (buf.length < start + len) break;
      const body = buf.slice(start, start + len).toString("utf8");
      buf = buf.slice(start + len);
      try {
        const reply = await onRpc(JSON.parse(body));
        if (reply) writeMessage(reply);
      } catch (err) {
        writeMessage({ jsonrpc: "2.0", id: null, error: { code: -32700, message: String(err) } });
      }
    }
  });
}


// ---------------------------------------------------------------------------
// Monitor: one independent long-poll loop per account, a coalesce window to merge
// bursts into one wake, typing keepalive, and wake retry.
// ---------------------------------------------------------------------------

// Burst merging: wake once no new message has arrived for IDLE ms, but never later than
// CAP ms after the first message of the burst. A lone message therefore waits ~IDLE, not CAP.
const DEFAULT_COALESCE_MS = 3000; // CAP (GROK_WECHAT_COALESCE_MS)
const DEFAULT_COALESCE_IDLE_MS = 1000; // GROK_WECHAT_COALESCE_IDLE_MS

/** Non-negative integer milliseconds. Unset, blank, or invalid values use the default. */
function readMs(raw, dflt) {
  if (raw == null) return dflt;
  const text = String(raw).trim();
  if (!/^\d+$/.test(text)) return dflt;
  const n = Number(text);
  return Number.isSafeInteger(n) ? n : dflt;
}

const COALESCE_MS = readMs(process.env.GROK_WECHAT_COALESCE_MS, DEFAULT_COALESCE_MS);
const COALESCE_IDLE_MS = Math.min(readMs(process.env.GROK_WECHAT_COALESCE_IDLE_MS, DEFAULT_COALESCE_IDLE_MS), COALESCE_MS);
const WAKE_TIMEOUT_MS = 12_000;
const WAKE_ATTEMPT_DELAYS_MS = [0, 800, 2_500];
// Background retries (after the quick attempts failed): sooner at first, then every 30s.
const WAKE_RETRY_INTERVALS_MS = [10_000, 20_000, 30_000];
const WAKE_RETRY_MAX = 6;
const TYPING_KEEPALIVE_MS = 5_000;
const TYPING_MAX_MS = 180_000;
const SUPERVISE_MS = 5_000;
const ABANDON_CHECK_MS = 15_000;
const SEEN_MAX = 2_000;
// Dedicated-assistant health: a wake that is still unanswered after STALE counts as a strike;
// STRIKES in a row (or one wake unanswered for DEAD) means the assistant is gone.
const ASSISTANT_STALE_MS = 120_000;
const ASSISTANT_DEAD_MS = 300_000;
const ASSISTANT_STRIKES = 3;
// Login expiry: tell the agent (so it can tell you to re-scan), then remind periodically.
const EXPIRED_RETRY_MS = 60_000;
const EXPIRED_NOTIFY_EVERY_MS = 30 * 60_000;
const EXPIRED_NOTIFY_MAX = 6;

const errText = (err) => (err instanceof Error ? err.message : String(err));

// --- inbound dedupe (iLink may redeliver after a cursor reset) ---------------
// Kept in memory for speed and persisted (seen.log) once a message is safely in the inbox,
// so a restart can't make the same message get answered twice.
const seenIds = new Set();
const seenKey = (m) => (m.message_id ? `${m.ilink_bot_id}:${m.message_id}` : "");
function isNewInbound(m) {
  const key = seenKey(m);
  if (!key) return true;
  if (seenIds.has(key)) return false;
  seenIds.add(key);
  if (seenIds.size > SEEN_MAX) seenIds.delete(seenIds.values().next().value);
  return true;
}

// --- typing: on immediately, then keepalive until the reply is sent ----------
const typingWatch = new Map(); // "bot::peer" -> { botId, peer, since }

function startTyping(messages, log) {
  const now = Date.now();
  const seen = new Set();
  for (const m of messages) {
    if (!m.from_user_id) continue;
    const botId = m.ilink_bot_id || "";
    const key = `${botId}::${m.from_user_id}`;
    // Keep the earliest start of a still-unanswered conversation (reply latency is measured from it).
    const prev = typingWatch.get(key);
    const open = prev && lastAssistantAt(botId, m.from_user_id) < prev.since;
    typingWatch.set(key, { botId, peer: m.from_user_id, since: open ? prev.since : now });
    if (seen.has(key)) continue;
    seen.add(key);
    setTyping(m.from_user_id, true, botId || undefined)
      .then(() => log(`typing on peer=${m.from_user_id} bot=${botId}`))
      .catch((err) => log(`typing error peer=${m.from_user_id} ${errText(err)}`));
  }
}

function typingTick(log) {
  const now = Date.now();
  for (const [key, w] of typingWatch) {
    // Stop once we replied (send turns typing off) or after a hard ceiling.
    const repliedAt = lastAssistantAt(w.botId, w.peer);
    if (now - w.since > TYPING_MAX_MS || repliedAt >= w.since) {
      if (repliedAt >= w.since) log(`replied ${repliedAt - w.since}ms after receipt bot=${w.botId} peer=${w.peer}`);
      typingWatch.delete(key);
      continue;
    }
    setTyping(w.peer, true, w.botId || undefined).catch(() => {});
  }
}

// --- wake ---------------------------------------------------------------------
async function postOnce(cfg, body) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), WAKE_TIMEOUT_MS);
  try {
    const res = await fetch(cfg.url, {
      method: "POST",
      headers: { Authorization: `Bearer ${cfg.key}`, "Content-Type": "application/json" },
      body: JSON.stringify(body),
      signal: controller.signal,
    });
    const text = await res.text();
    return { ok: res.ok, status: res.status, text };
  } finally {
    clearTimeout(timer);
  }
}

/** POST with a couple of quick retries. Client errors (4xx except 429) are not retried. */
async function postWake(cfg, body, botId, log) {
  for (const delay of WAKE_ATTEMPT_DELAYS_MS) {
    if (delay) await sleep(delay);
    try {
      const t0 = Date.now();
      const r = await postOnce(cfg, body);
      log(`wake bot=${botId} n=${body.n ?? body.event} ${r.status} ${Date.now() - t0}ms ${r.text.slice(0, 100)}`);
      if (r.ok) return true;
      if (r.status >= 400 && r.status < 500 && r.status !== 429) return false;
    } catch (err) {
      log(`wake error bot=${botId} ${errText(err)}`);
    }
  }
  return false;
}

const failedWakes = []; // { botId, ids, tries, next }

async function wakeBot(botId, batch, log) {
  const state = loadState();
  const account = findAccount(state, { ilink_bot_id: botId });
  const cfg = resolveWakeForAccount(account);
  if (!cfg) {
    log(`wake skipped bot=${botId}: no wake config`);
    return null; // nothing to retry or watch
  }
  const dedicated = getAccountAssistant(state, botId);
  const packed = packMsgs(batch, state);
  const body = {
    src: "grok-wechat",
    n: packed.msgs.length,
    bot: botId,
    asst: dedicated?.name || "",
    asst_id: dedicated?.id || "",
    ...packed,
    warn: account?.lostAssistant
      ? `assistant_missing:${account.lostAssistant.name || account.lostAssistant.id} - tell the user; recreate it and wechat_set_dedicated_assistant`
      : undefined,
    ack: "wechat_ack",
  };
  return postWake(cfg, slim(body), botId, log);
}

/** Non-message wake (e.g. login expired) so the agent can tell the user. */
async function wakeEvent(botId, event, extra, log) {
  const state = loadState();
  const cfg = resolveWakeForAccount(findAccount(state, { ilink_bot_id: botId }));
  if (!cfg) return null;
  const dedicated = getAccountAssistant(state, botId);
  return postWake(cfg, slim({ src: "grok-wechat", event, bot: botId, asst: dedicated?.name || "", asst_id: dedicated?.id || "", ...extra }), botId, log);
}

async function wakeAgent(messages, log) {
  const byBot = new Map();
  for (const m of messages) {
    const botId = m.ilink_bot_id || "";
    if (!byBot.has(botId)) byBot.set(botId, []);
    byBot.get(botId).push(m);
  }
  await Promise.all([...byBot.entries()].map(([botId, batch]) => wakeAndTrack(botId, batch, log)));
}

/** Wake once; on failure queue a background retry, on success watch for a reply. */
async function wakeAndTrack(botId, batch, log) {
  const ok = await wakeBot(botId, batch, log);
  const ids = batch.map((m) => m.id).filter(Boolean);
  if (ok === false) {
    // Stays in the inbox (un-acked); keep retrying in the background.
    failedWakes.push({ botId, ids, tries: 0, next: Date.now() + WAKE_RETRY_INTERVALS_MS[0] });
  } else if (ok === true && ids.length) {
    watches.push({ botId, ids, at: Date.now(), struck: false });
  }
}

async function retryFailedWakes(log) {
  const now = Date.now();
  for (let i = failedWakes.length - 1; i >= 0; i--) {
    const f = failedWakes[i];
    if (f.next > now) continue;
    const still = inboxByIds(f.ids); // acked/handled messages drop out
    if (!still.length || f.tries >= WAKE_RETRY_MAX) {
      failedWakes.splice(i, 1);
      if (still.length) {
        // Its own webhook never accepts wakes (e.g. the assistant/Routine was deleted): treat the assistant as gone.
        const account = findAccount(loadState(), { ilink_bot_id: f.botId });
        if (account?.wake?.url && getAccountAssistant(loadState(), f.botId)) {
          log(`WARN own webhook failed ${WAKE_RETRY_MAX}x bot=${f.botId}`);
          await demoteAssistant(f.botId, log);
        }
      }
      continue;
    }
    f.tries += 1;
    f.next = now + WAKE_RETRY_INTERVALS_MS[Math.min(f.tries, WAKE_RETRY_INTERVALS_MS.length - 1)];
    const ok = await wakeBot(f.botId, still, log);
    if (ok !== false) {
      failedWakes.splice(i, 1);
      if (ok === true) watches.push({ botId: f.botId, ids: still.map((m) => m.id).filter(Boolean), at: Date.now(), struck: false });
    }
  }
}

// --- dedicated-assistant health -----------------------------------------------
const watches = []; // { botId, ids, at, struck } - successful wakes still waiting for a reply
const strikes = new Map(); // botId -> consecutive wakes that went unanswered

/** Unanswered = still in the inbox and no reply has been sent since it was received. */
const isUnanswered = (m) => typeof m.recv_at === "number" && lastAssistantAt(m.ilink_bot_id, m.from_user_id) < m.recv_at;

async function demoteAssistant(botId, log) {
  const lost = markAssistantLost(botId);
  strikes.delete(botId);
  for (let i = watches.length - 1; i >= 0; i--) if (watches[i].botId === botId) watches.splice(i, 1);
  if (!lost) return;
  // Its own webhook belonged to that assistant; fall back to the global one if there is one.
  if (hasGlobalWake() && clearAccountWake(botId)) log(`own webhook cleared bot=${botId}: falling back to the global webhook`);
  log(`ALERT dedicated assistant "${lost.name || lost.id}" is not replying bot=${botId}: registration cleared, next wakes carry full history. Recreate it and run wechat_set_dedicated_assistant`);
  const rows = listInboxRaw().filter((m) => m.ilink_bot_id === botId && isUnanswered(m));
  if (rows.length) await wakeAndTrack(botId, rows, log);
}

async function checkAssistantHealth(log) {
  const now = Date.now();
  for (let i = watches.length - 1; i >= 0; i--) {
    const w = watches[i];
    if (!getAccountAssistant(loadState(), w.botId)) {
      watches.splice(i, 1); // nothing to demote
      continue;
    }
    if (!inboxByIds(w.ids).some(isUnanswered)) {
      strikes.delete(w.botId); // replied or acked: the assistant is alive
      watches.splice(i, 1);
      continue;
    }
    const age = now - w.at;
    if (age < ASSISTANT_STALE_MS) continue;
    if (!w.struck) {
      w.struck = true;
      strikes.set(w.botId, (strikes.get(w.botId) || 0) + 1);
      log(`WARN no reply ${Math.round(age / 1000)}s after wake bot=${w.botId} strike=${strikes.get(w.botId)}/${ASSISTANT_STRIKES}`);
    }
    if ((strikes.get(w.botId) || 0) >= ASSISTANT_STRIKES || age >= ASSISTANT_DEAD_MS) {
      await demoteAssistant(w.botId, log);
    }
  }
}

/** After a restart the in-memory retry queue is gone: re-wake what is still unanswered. */
async function recoverInbox(log) {
  const byBot = new Map();
  for (const m of listInboxRaw().filter(isUnanswered)) {
    const botId = m.ilink_bot_id || "";
    if (!byBot.has(botId)) byBot.set(botId, []);
    byBot.get(botId).push(m);
  }
  for (const [botId, batch] of byBot) {
    log(`recover: re-waking ${batch.length} unanswered message(s) bot=${botId}`);
    await wakeAndTrack(botId, batch, log);
  }
}

// --- inbound batching ----------------------------------------------------------
const pending = new Map(); // botId -> { msgs, timer }

function stampBatch(messages) {
  const state = loadState();
  for (const m of messages) {
    const dedicated = getAccountAssistant(state, m.ilink_bot_id);
    m.session_id = m.session_id || talkKey(m.ilink_bot_id, m.from_user_id);
    m.dedicated_assistant_name = dedicated?.name || m.dedicated_assistant_name || "";
    // Turns that existed before this batch; the history itself is read lazily (no copy stored).
    m.hist_n = getTalkCount(m.ilink_bot_id, m.from_user_id);
    m.recv_at = Date.now(); // ack guard: a reply must be sent after this before the thread counts as synced
  }
}

function recordInboundTalks(messages) {
  for (const m of messages) {
    appendTalk({
      ilink_bot_id: m.ilink_bot_id,
      from_user_id: m.from_user_id,
      role: "user",
      text: m.text,
      at: m.create_time_ms || Date.now(),
    });
  }
}

async function flush(botId, log) {
  const slot = pending.get(botId);
  if (!slot) return;
  pending.delete(botId);
  const batch = slot.msgs;
  if (!batch.length) return;
  stampBatch(batch);
  recordInboundTalks(batch);
  const stored = appendInbox(batch);
  batch.forEach((m, i) => {
    if (stored[i]?.id) m.id = stored[i].id;
  });
  appendSeenKeys(batch.map(seenKey).filter(Boolean), SEEN_MAX);
  log(`inbox +${batch.length} bot=${botId}`);
  await wakeAgent(batch, log);
}

/** Typing starts instantly; the wake waits a beat so a burst becomes one cold start. */
function enqueue(botId, messages, log) {
  const fresh = messages.filter(isNewInbound);
  if (!fresh.length) return;
  startTyping(fresh, log);
  let slot = pending.get(botId);
  if (!slot) {
    slot = { msgs: [], timer: null, first: Date.now() };
    pending.set(botId, slot);
  }
  slot.msgs.push(...fresh);
  // Restart the quiet timer on every message, bounded by the cap measured from the first one.
  if (slot.timer) clearTimeout(slot.timer);
  const wait = Math.max(0, Math.min(COALESCE_IDLE_MS, slot.first + COALESCE_MS - Date.now()));
  slot.timer = setTimeout(() => { flush(botId, log).catch((err) => log(`flush error ${errText(err)}`)); }, wait);
}

// --- polling -------------------------------------------------------------------
/**
 * Media messages are downloaded before they are collected, which can take seconds. Show
 * "typing" as soon as such a message arrives instead of after the download.
 */
function earlyTyping(rawMsgs, account, log) {
  const state = loadState();
  const early = [];
  for (const msg of rawMsgs) {
    if (msg.message_type && msg.message_type !== MSG_TYPE.USER) continue;
    if (msg.message_state && msg.message_state !== MSG_STATE.FINISH) continue;
    const from = msg.from_user_id;
    if (!from || !isAllowed(state, from)) continue;
    if (!(msg.item_list || []).some((it) => it?.image_item || it?.file_item || it?.video_item)) continue;
    if (seenIds.has(`${account.ilinkBotId}:${String(msg.message_id ?? msg.client_id ?? "")}`)) continue;
    early.push({ from_user_id: from, ilink_bot_id: account.ilinkBotId });
  }
  if (early.length) startTyping(early, log);
}

async function pollAccount(account, log) {
  const raw = await getUpdates(account);
  if (raw.session_expired) {
    log(`session expired bot=${account.ilinkBotId}`);
    return { messages: [], expired: true };
  }
  if (account.expiredAt) {
    updateState((s) => {
      const hit = findAccount(s, { token: account.token });
      if (hit) hit.expiredAt = 0;
      return s;
    });
    expiryNotes.delete(account.token);
    log(`login restored bot=${account.ilinkBotId}`);
  }
  earlyTyping(raw.msgs || [], account, log);
  const collected = await collectInbound(raw.msgs || [], account);
  const state = loadState();
  const messages = [];
  for (const m of collected.messages) {
    if (isAllowed(state, m.from_user_id)) {
      messages.push(m);
    } else {
      noteBlocked(account.ilinkBotId, m.from_user_id);
      log(`blocked from=${m.from_user_id} bot=${account.ilinkBotId}: not on the allowlist (wechat_approve to allow)`);
    }
  }
  return { messages, expired: false };
}

// --- login expiry -------------------------------------------------------------
const expiryNotes = new Map(); // token -> { n, last }

async function handleExpired(account, log) {
  const token = account.token;
  if (!account.expiredAt) {
    updateState((s) => {
      const hit = findAccount(s, { token });
      if (hit) hit.expiredAt = Date.now();
      return s;
    });
  }
  const note = expiryNotes.get(token) || { n: 0, last: 0 };
  if (note.n >= EXPIRED_NOTIFY_MAX || Date.now() - note.last < EXPIRED_NOTIFY_EVERY_MS) return;
  expiryNotes.set(token, { n: note.n + 1, last: Date.now() });
  log(`ALERT login expired bot=${account.ilinkBotId}: WeChat no longer receives messages; re-scan needed (notice ${note.n + 1}/${EXPIRED_NOTIFY_MAX})`);
  await wakeEvent(account.ilinkBotId, "login_expired", {
    hint: "WeChat login expired - no messages arrive. Tell the user, then wechat_login_start and immediately wechat_login_wait so they re-scan the QR code.",
  }, log);
}

const loops = new Map(); // token -> { stop }

/** Each account long-polls independently so one idle account never delays another. */
async function accountLoop(token, ctl, log) {
  const first = findAccount(loadState(), { token });
  if (first) await notifyStart(first);
  let failures = 0;
  while (!ctl.stop) {
    const account = findAccount(loadState(), { token });
    if (!account?.token) break;
    try {
      const r = await pollAccount(account, log);
      failures = 0;
      if (r.expired) {
        await handleExpired(account, log).catch((err) => log(`expiry notice error ${errText(err)}`));
        await sleep(EXPIRED_RETRY_MS);
        continue;
      }
      if (r.messages.length) enqueue(account.ilinkBotId, r.messages, log);
    } catch (err) {
      failures += 1;
      log(`getupdates error bot=${account.ilinkBotId} ${errText(err)}`);
      await sleep(Math.min(500 * 2 ** (failures - 1), 15_000));
    }
  }
  if (loops.get(token) === ctl) loops.delete(token);
}

async function runMonitor() {
  const logStream = fs.createWriteStream(paths().log, { flags: "a" });
  const log = (line) => {
    logStream.write(`${new Date().toISOString()} ${line}\n`);
  };
  log("monitor start");
  for (const key of loadSeenKeys(SEEN_MAX)) seenIds.add(key);
  const onExit = async () => {
    await Promise.all(listAccounts().map((a) => notifyStop(a)));
    clearPid();
    process.exit(0);
  };
  process.on("SIGTERM", onExit);
  process.on("SIGINT", onExit);
  // A stray error must not kill polling: the next keepalive can be up to 20 minutes away.
  process.on("uncaughtException", (err) => log(`uncaught ${errText(err)}`));
  process.on("unhandledRejection", (err) => log(`unhandled rejection ${errText(err)}`));

  let lastAbandonCheck = 0;
  const supervise = () => {
    const now = Date.now();
    if (now - lastAbandonCheck >= ABANDON_CHECK_MS) {
      lastAbandonCheck = now;
      if (connectorAbandoned()) {
        log("connector removed, running uninstall");
        runUninstall();
        process.exit(0);
      }
    }
    const accounts = listAccounts();
    if (!accounts.length) {
      log("no accounts, stopping");
      clearPid();
      process.exit(0);
    }
    const live = new Set(accounts.map((a) => a.token));
    for (const a of accounts) {
      if (loops.has(a.token)) continue;
      const ctl = { stop: false };
      loops.set(a.token, ctl);
      accountLoop(a.token, ctl, log).catch((err) => log(`loop crashed ${errText(err)}`));
    }
    for (const [token, ctl] of loops) {
      if (!live.has(token)) {
        ctl.stop = true;
        loops.delete(token);
      }
    }
    retryFailedWakes(log).catch((err) => log(`wake retry error ${errText(err)}`));
    checkAssistantHealth(log).catch((err) => log(`assistant health error ${errText(err)}`));
  };

  recoverInbox(log).catch((err) => log(`recover error ${errText(err)}`));
  supervise();
  setInterval(supervise, SUPERVISE_MS);
  setInterval(() => typingTick(log), TYPING_KEEPALIVE_MS);
}

if (process.argv.includes("--monitor")) {
  runMonitor();
} else if (process.argv.includes("--ensure-monitor")) {
  process.stdout.write(JSON.stringify(ensureMonitor()) + "\n");
} else if (process.argv.includes("--uninstall")) {
  process.stdout.write(`${JSON.stringify(runUninstall({ deferPluginRemoval: false }), null, 2)}\n`);
} else {
  startMcp();
}

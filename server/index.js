#!/usr/bin/env node
import { spawn } from "node:child_process";
import fs from "node:fs";
import { fileURLToPath } from "node:url";
import {
  ackInbox,
  appendInbox,
  appendTalk,
  clearPid,
  findAccount,
  getAccountAssistant,
  getTalkCount,
  inboxByIds,
  isAllowed,
  lastAssistantAt,
  listAccounts,
  loadState,
  monitorRunning,
  packMsgs,
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
    fs.mkdirSync("/workspace/.grok-wechat", { recursive: true });
    fs.appendFileSync("/workspace/.grok-wechat/mcp-host.log", `${new Date().toISOString()} ${line}\n`);
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
    description: "Peek inbox (does NOT clear). Returns msgs[{id,from,bot,text,media,sid,asst}] + hist{sid:[{r,t}]} (full history, once per conversation). Prefer the wake payload if present. After replying call wechat_ack.",
    inputSchema: { type: "object", properties: {} },
    handle: async () => ok({ ...peekInbox(), ack: "wechat_ack" }),
  },
  wechat_ack: {
    description: "Ack/remove inbox msgs after successful reply. Pass ids from msgs; omit ids to clear all.",
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
    description: "Save global wake webhook url+key.",
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
    description: "Register per-account dedicated assistant.",
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
    description: "Allowlist add/clear. Empty=accept all.",
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
      return ok({ allow_from: state.allowFrom });
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
        serverInfo: { name: "grok-wechat", version: "1.4.0" },
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
// Monitor: one independent long-poll loop per account, a short debounce to merge
// bursts into one wake, typing keepalive, and wake retry.
// ---------------------------------------------------------------------------

const COALESCE_MS = 600;
const WAKE_TIMEOUT_MS = 12_000;
const WAKE_ATTEMPT_DELAYS_MS = [0, 1_500, 4_000];
const WAKE_RETRY_INTERVAL_MS = 30_000;
const WAKE_RETRY_MAX = 6;
const TYPING_KEEPALIVE_MS = 5_000;
const TYPING_MAX_MS = 180_000;
const SUPERVISE_MS = 5_000;
const ABANDON_CHECK_MS = 15_000;
const SEEN_MAX = 2_000;

const errText = (err) => (err instanceof Error ? err.message : String(err));

// --- inbound dedupe (iLink may redeliver after a cursor reset) ---------------
const seenIds = new Set();
function isNewInbound(m) {
  const id = m.message_id;
  if (!id) return true;
  const key = `${m.ilink_bot_id}:${id}`;
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
    typingWatch.set(key, { botId, peer: m.from_user_id, since: now });
    if (seen.has(key)) continue;
    seen.add(key);
    setTyping(m.from_user_id, true, botId || undefined)
      .then(() => log(`typing on peer=${m.from_user_id} bot=${botId}`))
      .catch((err) => log(`typing error peer=${m.from_user_id} ${errText(err)}`));
  }
}

function typingTick() {
  const now = Date.now();
  for (const [key, w] of typingWatch) {
    // Stop once we replied (send turns typing off) or after a hard ceiling.
    if (now - w.since > TYPING_MAX_MS || lastAssistantAt(w.botId, w.peer) >= w.since) {
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
      const r = await postOnce(cfg, body);
      log(`wake bot=${botId} n=${body.n} ${r.status} ${r.text.slice(0, 100)}`);
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
    return true; // nothing to retry
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
    ack: "wechat_ack",
  };
  return postWake(cfg, slim(body), botId, log);
}

async function wakeAgent(messages, log) {
  const byBot = new Map();
  for (const m of messages) {
    const botId = m.ilink_bot_id || "";
    if (!byBot.has(botId)) byBot.set(botId, []);
    byBot.get(botId).push(m);
  }
  await Promise.all([...byBot.entries()].map(async ([botId, batch]) => {
    const ok = await wakeBot(botId, batch, log);
    if (!ok) {
      // Stays in the inbox (un-acked); keep retrying in the background.
      failedWakes.push({
        botId,
        ids: batch.map((m) => m.id).filter(Boolean),
        tries: 0,
        next: Date.now() + WAKE_RETRY_INTERVAL_MS,
      });
    }
  }));
}

async function retryFailedWakes(log) {
  const now = Date.now();
  for (let i = failedWakes.length - 1; i >= 0; i--) {
    const f = failedWakes[i];
    if (f.next > now) continue;
    const still = inboxByIds(f.ids); // acked/handled messages drop out
    if (!still.length || f.tries >= WAKE_RETRY_MAX) {
      failedWakes.splice(i, 1);
      continue;
    }
    f.tries += 1;
    f.next = now + WAKE_RETRY_INTERVAL_MS;
    const ok = await wakeBot(f.botId, still, log);
    if (ok) failedWakes.splice(i, 1);
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
    slot = { msgs: [], timer: null };
    pending.set(botId, slot);
  }
  slot.msgs.push(...fresh);
  if (!slot.timer) slot.timer = setTimeout(() => { flush(botId, log).catch((err) => log(`flush error ${errText(err)}`)); }, COALESCE_MS);
}

// --- polling -------------------------------------------------------------------
async function pollAccount(account, log) {
  const raw = await getUpdates(account);
  if (raw.session_expired) {
    log(`session expired bot=${account.ilinkBotId}`);
    return { messages: [], expired: true };
  }
  const collected = await collectInbound(raw.msgs || [], account);
  const state = loadState();
  return { messages: collected.messages.filter((m) => isAllowed(state, m.from_user_id)), expired: false };
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
        await sleep(60_000);
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
  const onExit = async () => {
    await Promise.all(listAccounts().map((a) => notifyStop(a)));
    clearPid();
    process.exit(0);
  };
  process.on("SIGTERM", onExit);
  process.on("SIGINT", onExit);

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
  };

  supervise();
  setInterval(supervise, SUPERVISE_MS);
  setInterval(typingTick, TYPING_KEEPALIVE_MS);
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

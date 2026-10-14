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
  getHandoffFrom,
  getTalkCount,
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
  writeHeartbeat,
  clearHeartbeat,
  monitorHeartbeatStale,
  readHeartbeat,
  listMonitorPids,
  readPid,
  stopMonitorPids,
  withMonitorLock,
  isPidAlive,
  packMsgs,
  noteBlocked,
  paths,
  peekInbox,
  removeAccount,
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
import { handoffWakeToAssistant, gatewayAvailable } from "./handoff.js";
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

const HEARTBEAT_STALE_MS = 90_000; // > ~2 long-poll cycles with no getupdates return
const MCP_WATCHDOG_MS = 30_000; // awake box: MCP host re-checks monitor. Complements Ori「微信监听保活」; does not replace that external box wake.
// Hard ceiling around one getupdates (ilink long-poll is 35s + 5s abort). If AbortSignal
// fails to fire, Promise.race still forces recovery instead of a forever-hung account loop.
const POLL_HARD_TIMEOUT_MS = 50_000;
const SELF_HEAL_MS = 15_000; // monitor checks its own heartbeat; does not need MCP host

/** Append to monitor.log from the MCP host (no --monitor log stream). */
function mcpWatchLog(line) {
  try {
    fs.appendFileSync(paths().log, `${new Date().toISOString()} mcp-watchdog pid=${process.pid} ${line}\n`);
  } catch {
    // ignore disk errors; never block tool RPC
  }
}

function ensureMonitor() {
  return withMonitorLock(() => {
    const accounts = listAccounts();
    const live = listMonitorPids().filter((p) => p !== process.pid);
    const filePid = monitorRunning();

    if (!accounts.length) {
      const reaped = live.length ? stopMonitorPids(live) : [];
      clearPid();
      clearHeartbeat();
      return { started: false, reason: "not_logged_in", reaped_orphans: reaped };
    }

    // Reap orphans that are not the pid-file owner (dual-monitor races).
    const orphans = live.filter((p) => p !== filePid);
    if (orphans.length) stopMonitorPids(orphans, { waitMs: 800, clearFiles: false });

    const existing = monitorRunning();
    if (existing && !monitorHeartbeatStale(HEARTBEAT_STALE_MS)) {
      const extras = listMonitorPids().filter((p) => p !== existing && p !== process.pid);
      if (extras.length) stopMonitorPids(extras, { waitMs: 500, clearFiles: false });
      writePid(existing);
      return {
        already_running: true,
        pid: existing,
        healthy: true,
        reaped_orphans: orphans.concat(extras),
      };
    }

    // Dead, missing, or heartbeat-stale → tear down everything and spawn one.
    const toStop = listMonitorPids().filter((p) => p !== process.pid);
    const restarted_stale = Boolean(existing) || monitorHeartbeatStale(HEARTBEAT_STALE_MS);
    if (toStop.length) stopMonitorPids(toStop);
    else {
      clearPid();
      clearHeartbeat();
    }

    const child = spawn(process.execPath, [self, "--monitor"], {
      detached: true,
      stdio: "ignore",
      env: process.env,
    });
    child.unref();
    writePid(child.pid);
    writeHeartbeat({ pid: child.pid, boot: true });
    return {
      started: true,
      pid: child.pid,
      account_count: accounts.length,
      restarted_stale,
      reaped_orphans: orphans.concat(toStop.filter((p) => p !== existing)),
    };
  });
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
      const hb = readHeartbeat();
      if (hb?.at) payload.monitor_heartbeat_age_ms = Date.now() - Number(hb.at);
      payload.monitor_stale = monitorHeartbeatStale(HEARTBEAT_STALE_MS);
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
    description: "Peek inbox (no clear). Prefer wake payload. Reply then wechat_ack.",
    inputSchema: { type: "object", properties: {} },
    handle: async () => ok({ ...peekInbox(), ack: "wechat_ack" }),
  },
  wechat_ack: {
    description: "After wechat_send: remove inbox ids (omit=all). unsynced=needs hist again.",
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
    description: "Typing on/off (usually auto).",
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
    description: "Register Ori/installing assistant as sendPrompt fallback (assistant_id+assistant_name). External Cursor webhook url/key removed in 1.11.6 and are ignored. Primary wake remains dedicated handoff.",
    inputSchema: {
      type: "object",
      properties: {
        assistant_id: { type: "string", description: "installing assistant / Ori agent id for sendPrompt fallback" },
        assistant_name: { type: "string", description: "e.g. Ori" },
        url: { type: "string", description: "deprecated; ignored" },
        key: { type: "string", description: "deprecated; ignored" },
        ilink_bot_id: { type: "string", description: "optional; clears leftover account.wake if set" },
      },
    },
    handle: async ({ ilink_bot_id, url, key, assistant_id, assistant_name }) =>
      ok(await setAccountWake(ilink_bot_id, url, key, assistant_id, assistant_name)),
  },
  wechat_set_dedicated_assistant: {
    description: "Register dedicated assistant (assistant_name = short random English sidebar name). Same asst_id rename keeps hist; new/swapped id resets hist sync.",
    inputSchema: {
      type: "object",
      properties: {
        ilink_bot_id: { type: "string" },
        assistant_id: { type: "string" },
        assistant_name: { type: "string", description: "Sidebar display name: short random English (e.g. Cedar Finch). Handoff uses assistant_id only." },
      },
      required: ["ilink_bot_id", "assistant_name"],
    },
    handle: async ({ ilink_bot_id, assistant_id, assistant_name }) =>
      ok(setDedicatedAssistant(ilink_bot_id, assistant_id, assistant_name)),
  },
  wechat_stop_monitor: {
    description: "Stop monitor (all --monitor processes).",
    inputSchema: { type: "object", properties: {} },
    handle: async () => {
      const pids = listMonitorPids();
      if (!pids.length) {
        clearPid();
        clearHeartbeat();
        return ok({ stopped: true, was_running: false });
      }
      stopMonitorPids(pids);
      return ok({ stopped: true, pids });
    },
  },
  wechat_approve: {
    description: "Allowlist (default-deny; owner always ok). user_id / clear / no-args=list.",
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
        serverInfo: { name: "grok-wechat", version: "1.11.14" },
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

function runMcpWatchdogTick(reason) {
  const hb = readHeartbeat();
  const age = hb?.at ? Date.now() - Number(hb.at) : null;
  const filePid = readPid();
  try {
    const r = ensureMonitor();
    const stale = age == null || age > HEARTBEAT_STALE_MS;
    // Always one line per tick so we can prove the host timer is alive.
    mcpWatchLog(
      `tick reason=${reason}`
      + ` filePid=${filePid || 0}`
      + ` hbAgeMs=${age == null ? "none" : age}`
      + ` stale=${stale}`
      + ` result=${JSON.stringify(r)}`,
    );
    return r;
  } catch (err) {
    mcpWatchLog(`ERROR reason=${reason} ${errText(err)}`);
    throw err;
  }
}

function startMcp() {
  registerShutdownCleanup();
  try {
    runMcpWatchdogTick("boot");
  } catch {
    /* ignore boot ensure errors */
  }
  // Hung-poll self-heal while this process is scheduled. A frozen VM does not
  // advance this timer; Ori「微信监听保活」wakes the box. Complements that
  // external wake and does not replace it.
  setInterval(() => {
    try {
      runMcpWatchdogTick("interval");
    } catch {
      /* already logged */
    }
  }, MCP_WATCHDOG_MS).unref?.();
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
const DEFAULT_COALESCE_MS = 7000; // CAP (GROK_WECHAT_COALESCE_MS)
const DEFAULT_COALESCE_IDLE_MS = 2000; // GROK_WECHAT_COALESCE_IDLE_MS

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
// Background retries for failed sendPrompt handoff: sooner at first, then every 30s.
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

// --- wake (local gateway sendPrompt only; no external Cursor webhook) ---------
const failedWakes = []; // { botId, ids, tries, next }

function buildWakeBody(botId, batch, state, extraWarn) {
  const account = findAccount(state, { ilink_bot_id: botId });
  const dedicated = getAccountAssistant(state, botId);
  const packed = packMsgs(batch, state);
  if (packed.msgs) {
    packed.msgs = packed.msgs.map((m) => {
      const { bot: _b, asst: _a, ...rest } = m;
      return rest;
    });
  }
  const warns = [];
  if (account?.lostAssistant) warns.push(`assistant_missing:${account.lostAssistant.name || account.lostAssistant.id}`);
  if (extraWarn) warns.push(extraWarn);
  return slim({
    bot: botId,
    asst: dedicated?.name || "",
    asst_id: dedicated?.id || "",
    ...packed,
    warn: warns.length ? warns.join(";") : undefined,
    ack: "wechat_ack",
  });
}

/** sendPrompt → Ori / installing assistant (persistent chat). */
async function handoffToFallback(body, mid, log, reason) {
  const fb = getHandoffFrom();
  if (!fb?.id) {
    log(`fallback skipped: no handoffFrom (register Ori via wechat_set_wake assistant_id=...) reason=${reason || ""}`);
    return null;
  }
  if (!gatewayAvailable()) {
    log(`fallback skipped: gateway unavailable reason=${reason || ""}`);
    return false;
  }
  const payload = slim({ ...body, warn: [body.warn, `fallback:${reason || "ori"}`].filter(Boolean).join(";") || undefined });
  log(`wake mode=fallback bot=${body.bot || ""} asst=${fb.name || fb.id} via=sendPrompt reason=${reason || ""}`);
  return handoffWakeToAssistant(fb, payload, mid ? `${mid}:fb` : undefined, log);
}

async function wakeBot(botId, batch, log, opts = {}) {
  const state = loadState();
  const dedicated = getAccountAssistant(state, botId);
  const forceFallback = Boolean(opts.forceFallback);
  const reason = opts.reason || "";
  const body = buildWakeBody(botId, batch, state, forceFallback ? reason : undefined);
  const msgIds = (batch || []).map((m) => m.id).filter(Boolean);
  const mid = `wechat-wake:${botId}:${msgIds.join(",") || Date.now()}`;

  // Primary: dedicated assistant persistent session (same path as SendToAgent).
  if (!forceFallback && dedicated?.id && gatewayAvailable()) {
    log(`wake mode=handoff bot=${botId} asst=${dedicated.name || dedicated.id}`);
    const ok = await handoffWakeToAssistant(dedicated, body, mid, log);
    if (ok) return true;
    log(`handoff failed; falling back to Ori sendPrompt bot=${botId}`);
    return handoffToFallback(body, mid, log, reason || "handoff_failed");
  }

  if (!forceFallback && dedicated?.id && !gatewayAvailable()) {
    log(`handoff unavailable (no gateway); trying Ori fallback bot=${botId}`);
  } else if (!forceFallback && !dedicated?.id) {
    log(`no dedicated asst; trying Ori fallback bot=${botId}`);
  }

  return handoffToFallback(body, mid, log, reason || (dedicated?.id ? "gateway_unavailable" : "no_dedicated"));
}

/** Non-message wake (e.g. login expired): sendPrompt to dedicated if any, else Ori. */
async function wakeEvent(botId, event, extra, log) {
  const state = loadState();
  const dedicated = getAccountAssistant(state, botId);
  const fb = getHandoffFrom(state);
  const body = slim({
    src: "grok-wechat",
    event,
    bot: botId,
    asst: dedicated?.name || "",
    asst_id: dedicated?.id || "",
    ...extra,
  });
  const mid = `wechat-event:${botId}:${event}:${Date.now()}`;
  if (!gatewayAvailable()) {
    log(`event ${event} bot=${botId}: gateway unavailable (logged only)`);
    return null;
  }
  if (dedicated?.id) {
    log(`event ${event} mode=handoff bot=${botId} asst=${dedicated.name || dedicated.id}`);
    const ok = await handoffWakeToAssistant(dedicated, body, mid, log);
    if (ok) return true;
    log(`event handoff failed; Ori fallback event=${event} bot=${botId}`);
  }
  if (!fb?.id) {
    log(`event ${event} bot=${botId}: no handoff target (logged only)`);
    return null;
  }
  return handoffToFallback(body, mid, log, `event:${event}`);
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
        log(`WARN sendPrompt wake failed ${WAKE_RETRY_MAX}x bot=${f.botId}; messages remain in inbox (no external webhook)`);
        // If dedicated still registered but never accepted handoff, try one forced Ori fallback.
        if (getAccountAssistant(loadState(), f.botId) && getHandoffFrom()) {
          const ok = await wakeBot(f.botId, still, log, { forceFallback: true, reason: "handoff_retry_exhausted" });
          if (ok === true) watches.push({ botId: f.botId, ids: still.map((m) => m.id).filter(Boolean), at: Date.now(), struck: false });
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
  // Drop leftover legacy account.wake fields (external webhook removed).
  if (clearAccountWake(botId)) log(`cleared leftover account.wake bot=${botId}`);
  log(`ALERT dedicated assistant "${lost.name || lost.id}" is not replying bot=${botId}: registration cleared. Unanswered msgs → Ori sendPrompt fallback (no external webhook). Recreate dedicated with wechat_set_dedicated_assistant`);
  const rows = listInboxRaw().filter((m) => m.ilink_bot_id === botId && isUnanswered(m));
  // Force Ori fallback: dedicated was just cleared / unresponsive.
  if (rows.length) {
    const ok = await wakeBot(botId, rows, log, { forceFallback: true, reason: "assistant_unresponsive" });
    const ids = rows.map((m) => m.id).filter(Boolean);
    if (ok === false) failedWakes.push({ botId, ids, tries: 0, next: Date.now() + WAKE_RETRY_INTERVALS_MS[0] });
    else if (ok === true && ids.length) watches.push({ botId, ids, at: Date.now(), struck: false });
  }
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

/** Replace this monitor process. Used when a poll hangs past POLL_HARD_TIMEOUT or our own heartbeat goes stale — does not depend on the MCP host watchdog. */
function respawnMonitor(log, reason) {
  try {
    log(`monitor self-respawn: ${reason}`);
  } catch { /* ignore */ }
  const child = spawn(process.execPath, [self, "--monitor"], {
    detached: true,
    stdio: "ignore",
    env: process.env,
  });
  child.unref();
  writePid(child.pid);
  writeHeartbeat({ pid: child.pid, boot: true, replaced: process.pid, reason: String(reason).slice(0, 200) });
  process.exit(0);
}

/** Each account long-polls independently so one idle account never delays another. */
async function accountLoop(token, ctl, log) {
  const first = findAccount(loadState(), { token });
  if (first) await notifyStart(first);
  let failures = 0;
  while (!ctl.stop) {
    const account = findAccount(loadState(), { token });
    if (!account?.token) break;
    try {
      let hardTimer;
      const r = await Promise.race([
        pollAccount(account, log),
        new Promise((_, reject) => {
          hardTimer = setTimeout(() => {
            const err = new Error(`poll hard timeout ${POLL_HARD_TIMEOUT_MS}ms`);
            err.name = "PollHardTimeout";
            reject(err);
          }, POLL_HARD_TIMEOUT_MS);
        }),
      ]).finally(() => {
        if (hardTimer) clearTimeout(hardTimer);
      });
      failures = 0;
      writeHeartbeat({ bot: account.ilinkBotId, ok: true });
      if (r.expired) {
        await handleExpired(account, log).catch((err) => log(`expiry notice error ${errText(err)}`));
        writeHeartbeat({ bot: account.ilinkBotId, expired: true });
        await sleep(EXPIRED_RETRY_MS);
        continue;
      }
      if (r.messages.length) enqueue(account.ilinkBotId, r.messages, log);
    } catch (err) {
      if (err?.name === "PollHardTimeout") {
        // Underlying fetch may still be wedged; replace the whole process.
        respawnMonitor(log, err.message);
        return;
      }
      failures += 1;
      // Still breathing: avoid stale-kill restart storms during transient network errors.
      // Hung polls that never return still go stale (no heartbeat) and get restarted.
      writeHeartbeat({ bot: account.ilinkBotId, ok: false, failures });
      log(`getupdates error bot=${account.ilinkBotId} ${errText(err)} failures=${failures}`);
      // After a few hard failures, re-bind the session so idle reconnects recover faster.
      if (failures === 3 || failures % 10 === 0) {
        await notifyStart(account).catch(() => {});
        log(`re-notifyStart after failures bot=${account.ilinkBotId}`);
      }
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
  // Singleton: if another healthy monitor already owns the pid file, exit (orphan).
  const owner = monitorRunning();
  if (owner && owner !== process.pid && !monitorHeartbeatStale(HEARTBEAT_STALE_MS)) {
    log(`monitor duplicate exit pid=${process.pid} owner=${owner}`);
    process.exit(0);
  }
  writePid(process.pid);
  writeHeartbeat({ pid: process.pid, boot: true });
  log(`monitor start pid=${process.pid}`);
  for (const key of loadSeenKeys(SEEN_MAX)) seenIds.add(key);
  const onExit = async () => {
    await Promise.all(listAccounts().map((a) => notifyStop(a)));
    if (readPid() === process.pid || !isPidAlive(readPid())) {
      clearPid();
      clearHeartbeat();
    }
    process.exit(0);
  };
  process.on("SIGTERM", onExit);
  process.on("SIGINT", onExit);
  // A stray error must not kill polling; MCP watchdog (~30s) + heartbeat stale (~90s) restart us.
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
  // Own-heartbeat self-heal while this process is scheduled (VM awake). Does not
  // run during box freeze; Ori「微信监听保活」is the external wake. MCP watchdog
  // is the other awake-path backup.
  setInterval(() => {
    try {
      const hb = readHeartbeat();
      const age = hb?.at ? Date.now() - Number(hb.at) : null;
      if (readPid() === process.pid && monitorHeartbeatStale(HEARTBEAT_STALE_MS)) {
        log(`self-heal: heartbeat stale ageMs=${age == null ? "none" : age} threshold=${HEARTBEAT_STALE_MS}`);
        respawnMonitor(log, `own heartbeat stale >${HEARTBEAT_STALE_MS}ms`);
      }
    } catch (err) {
      log(`self-heal error ${errText(err)}`);
    }
  }, SELF_HEAL_MS);
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

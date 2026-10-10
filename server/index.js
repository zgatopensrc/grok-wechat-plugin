#!/usr/bin/env node
import { spawn } from "node:child_process";
import fs from "node:fs";
import { fileURLToPath } from "node:url";
import {
  appendInbox,
  appendTalk,
  clearPid,
  drainInbox,
  findAccount,
  getAccountAssistant,
  getTalkHistory,
  HISTORY_RETURN_TURNS,
  isAllowed,
  listAccounts,
  loadState,
  monitorRunning,
  paths,
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

try {
  fs.mkdirSync("/workspace/.grok-wechat", { recursive: true });
  fs.appendFileSync(
    "/workspace/.grok-wechat/mcp-host.log",
    `${new Date().toISOString()} spawn pid=${process.pid} argv=${JSON.stringify(process.argv)} cwd=${process.cwd()}\n`,
  );
} catch { /* ignore */ }
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
    description: "Drain inbox. Fields: from,bot,text,media,sid,asst,hist(r/t). Route by bot→asst; use hist.",
    inputSchema: { type: "object", properties: {} },
    handle: async () => ok({ msgs: drainInbox() }),
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
  try {
    fs.appendFileSync("/workspace/.grok-wechat/mcp-host.log", `${new Date().toISOString()} out ${json.slice(0, 200)}\n`);
  } catch { /* ignore */ }
}

async function onRpc(msg) {
  try {
    fs.appendFileSync("/workspace/.grok-wechat/mcp-host.log", `${new Date().toISOString()} in ${JSON.stringify({id: msg.id, method: msg.method}).slice(0,300)}\n`);
  } catch { /* ignore */ }
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
        serverInfo: { name: "grok-wechat", version: "1.2.0" },
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


async function startTypingForInbound(messages, log) {
  const seen = new Set();
  const jobs = [];
  for (const m of messages) {
    const peer = m.from_user_id;
    const botId = m.ilink_bot_id || "";
    if (!peer) continue;
    const key = `${botId}::${peer}`;
    if (seen.has(key)) continue;
    seen.add(key);
    jobs.push(
      setTyping(peer, true, botId || undefined)
        .then(() => log(`typing on peer=${peer} bot=${botId}`))
        .catch((err) => log(`typing error peer=${peer} ${err instanceof Error ? err.message : String(err)}`)),
    );
  }
  await Promise.all(jobs);
}

function stampSessionContext(messages) {
  const state = loadState();
  for (const m of messages) {
    const dedicated = getAccountAssistant(state, m.ilink_bot_id);
    m.session_id = m.session_id || talkKey(m.ilink_bot_id, m.from_user_id);
    m.dedicated_assistant_id = dedicated?.id || m.dedicated_assistant_id || "";
    m.dedicated_assistant_name = dedicated?.name || m.dedicated_assistant_name || "";
    // Prior turns only — current inbound is recorded after this stamp.
    m.history = getTalkHistory(m.ilink_bot_id, m.from_user_id, HISTORY_RETURN_TURNS);
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

async function wakeAgent(messages, log) {
  if (!messages.length) return;
  const state = loadState();
  const byBot = new Map();
  for (const m of messages) {
    const botId = m.ilink_bot_id || "";
    if (!byBot.has(botId)) byBot.set(botId, []);
    byBot.get(botId).push(m);
  }
  await Promise.all([...byBot.entries()].map(async ([botId, batch]) => {
    const account = findAccount(state, { ilink_bot_id: botId });
    const cfg = resolveWakeForAccount(account);
    if (!cfg) {
      log(`wake skipped bot=${botId}: no wake config`);
      return;
    }
    const dedicated = getAccountAssistant(state, botId);
    try {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), 8_000);
      let res;
      try {
        res = await fetch(cfg.url, {
          method: "POST",
          headers: {
            Authorization: `Bearer ${cfg.key}`,
            "Content-Type": "application/json",
          },
          // Minimal wake body — agent pulls detail via wechat_inbox.
          body: JSON.stringify({
            src: "grok-wechat",
            n: batch.length,
            bot: botId,
            asst: dedicated?.name || account?.dedicatedAssistant?.name || "",
          }),
          signal: controller.signal,
        });
      } finally {
        clearTimeout(timer);
      }
      const text = await res.text();
      log(`wake bot=${botId} ${res.status} ${text.slice(0, 120)}`);
    } catch (err) {
      log(`wake error bot=${botId} ${err instanceof Error ? err.message : String(err)}`);
    }
  }));
}

async function pollAccount(account, log) {
  const raw = await getUpdates(account);
  if (raw.session_expired) {
    log(`session expired bot=${account.ilinkBotId}`);
    return { messages: [], expired: true };
  }
  const collected = await collectInbound(raw.msgs || [], account);
  const state = loadState();
  const allowed = collected.messages.filter((m) => isAllowed(state, m.from_user_id));
  return { messages: allowed, expired: false };
}

async function runMonitor() {
  const logStream = fs.createWriteStream(paths().log, { flags: "a" });
  const log = (line) => {
    logStream.write(`${new Date().toISOString()} ${line}\n`);
  };
  log("monitor start");
  const accounts = listAccounts();
  await Promise.all(accounts.map((a) => notifyStart(a)));
  const onExit = async () => {
    const current = listAccounts();
    await Promise.all(current.map((a) => notifyStop(a)));
    clearPid();
    process.exit(0);
  };
  process.on("SIGTERM", onExit);
  process.on("SIGINT", onExit);
  let failures = 0;
  while (true) {
    try {
      if (connectorAbandoned()) {
        log("connector removed, running uninstall");
        runUninstall();
        process.exit(0);
      }
      const accountsNow = listAccounts();
      if (!accountsNow.length) {
        log("no accounts, stopping");
        clearPid();
        process.exit(0);
      }
      const results = await Promise.all(accountsNow.map((account) => pollAccount(account, log)));
      failures = 0;
      const batch = results.flatMap((r) => r.messages);
      if (results.some((r) => r.expired)) {
        await sleep(60_000);
      }
      if (batch.length) {
        stampSessionContext(batch);
        recordInboundTalks(batch);
        appendInbox(batch);
        log(`inbox +${batch.length}`);
        // Wake agent immediately; typing in parallel (must not delay wake).
        await Promise.all([
          wakeAgent(batch, log),
          startTypingForInbound(batch, log),
        ]);
      }
    } catch (err) {
      failures += 1;
      log(`getupdates error ${err instanceof Error ? err.message : String(err)}`);
      await sleep(failures >= 3 ? 15_000 : 500);
    }
  }
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

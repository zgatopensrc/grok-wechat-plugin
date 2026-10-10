import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const DEFAULT_BASE = "https://ilinkai.weixin.qq.com";
const MAX_LOCAL_TOKENS = 10;

export function homeDir() {
  const raw = process.env.GROK_WECHAT_HOME?.trim();
  if (raw) return path.resolve(raw);
  return path.join(os.homedir(), ".grok-wechat");
}

export function paths() {
  const home = homeDir();
  return {
    home,
    state: path.join(home, "account.json"),
    inbox: path.join(home, "inbox.jsonl"),
    pid: path.join(home, "monitor.pid"),
    media: path.join(home, "media"),
    log: path.join(home, "monitor.log"),
  };
}

export function emptyAccount() {
  return {
    token: "",
    baseUrl: DEFAULT_BASE,
    ilinkBotId: "",
    ilinkUserId: "",
    getUpdatesBuf: "",
    contextTokens: {},
    typingTickets: {},
    wake: null,
    dedicatedAssistant: null,
  };
}

export function emptyState() {
  return {
    accounts: [],
    pendingQrs: [],
    allowFrom: [],
  };
}

export function talkKey(ilinkBotId, fromUserId) {
  return `${ilinkBotId || ""}::${fromUserId || ""}`;
}

function talksDir() {
  return path.join(homeDir(), "talks");
}

function legacyTalksPath() {
  return path.join(homeDir(), "talks.json");
}

function talkFile(key) {
  const id = crypto.createHash("sha1").update(key).digest("hex").slice(0, 20);
  return path.join(talksDir(), `${id}.jsonl`);
}

function metaFile(file) {
  return `${file}.meta.json`;
}

function chmodQuiet(file) {
  try {
    fs.chmodSync(file, 0o600);
  } catch {
    // ignore
  }
}

/** One-time lazy import from the old single-file talks.json. */
function migrateLegacyTalk(key, file) {
  if (fs.existsSync(file)) return;
  const legacy = legacyTalksPath();
  if (!fs.existsSync(legacy)) return;
  try {
    const raw = JSON.parse(fs.readFileSync(legacy, "utf8"));
    const list = raw?.[key];
    if (!Array.isArray(list) || !list.length) return;
    fs.mkdirSync(talksDir(), { recursive: true });
    fs.writeFileSync(file, `${list.map((e) => JSON.stringify({ role: e.role, text: e.text || "", at: e.at || 0 })).join("\n")}\n`);
    chmodQuiet(file);
  } catch {
    // ignore
  }
}

function readTalkEntries(file) {
  if (!fs.existsSync(file)) return [];
  const out = [];
  for (const line of fs.readFileSync(file, "utf8").split("\n")) {
    if (!line) continue;
    try {
      out.push(JSON.parse(line));
    } catch {
      // skip corrupt line
    }
  }
  return out;
}

function loadMeta(file) {
  const mf = metaFile(file);
  if (fs.existsSync(mf)) {
    try {
      return JSON.parse(fs.readFileSync(mf, "utf8"));
    } catch {
      // rebuild below
    }
  }
  const entries = readTalkEntries(file);
  const meta = { n: entries.length, last: entries.at(-1) || null, lastAssistantAt: 0, lastUserAt: 0 };
  for (const e of entries) {
    if (e.role === "assistant") meta.lastAssistantAt = Math.max(meta.lastAssistantAt, e.at || 0);
    else meta.lastUserAt = Math.max(meta.lastUserAt, e.at || 0);
  }
  return meta;
}

function saveMeta(file, meta) {
  const mf = metaFile(file);
  fs.writeFileSync(mf, JSON.stringify(meta));
  chmodQuiet(mf);
}

function normTalkText(text) {
  return String(text || "").replace(/\s+/g, " ").trim();
}

function stripMediaPrefix(s) {
  const m = s.match(/^\[(image|video|file|voice)\]\s*(.*)$/i);
  return m ? normTalkText(m[2]) : s;
}

const DUP_WINDOW_MS = 120_000;

/**
 * Assistant-only: the same reply is often logged twice (text, then text+media).
 * User turns are never merged — a repeated "好的" is a real message.
 */
function isDuplicateTalk(prev, next) {
  if (!prev || prev.role !== "assistant" || next.role !== "assistant") return false;
  if (Math.abs((next.at || 0) - (prev.at || 0)) > DUP_WINDOW_MS) return false;
  const a = stripMediaPrefix(normTalkText(prev.text));
  const b = stripMediaPrefix(normTalkText(next.text));
  return Boolean(a) && a === b;
}

function replaceLastLine(file, entry) {
  const lines = fs.readFileSync(file, "utf8").split("\n").filter(Boolean);
  lines[lines.length - 1] = JSON.stringify(entry);
  fs.writeFileSync(file, `${lines.join("\n")}\n`);
}

/**
 * Append a turn to the per-peer talk log (append-only JSONL, one file per peer).
 * History is NOT capped. Consecutive duplicate assistant turns are merged.
 */
export function appendTalk({ ilink_bot_id, from_user_id, role, text, at } = {}) {
  if (!from_user_id || !role) return;
  const key = talkKey(ilink_bot_id, from_user_id);
  const file = talkFile(key);
  fs.mkdirSync(talksDir(), { recursive: true });
  migrateLegacyTalk(key, file);
  const meta = loadMeta(file);
  const entry = { role, text: String(text || ""), at: at || Date.now() };
  if (isDuplicateTalk(meta.last, entry)) {
    const merged = {
      ...meta.last,
      text: normTalkText(entry.text).length > normTalkText(meta.last.text).length ? entry.text : meta.last.text,
      at: entry.at,
    };
    replaceLastLine(file, merged);
    meta.last = merged;
  } else {
    fs.appendFileSync(file, `${JSON.stringify(entry)}\n`);
    chmodQuiet(file);
    meta.last = entry;
    meta.n = (meta.n || 0) + 1;
  }
  if (role === "assistant") meta.lastAssistantAt = entry.at;
  else meta.lastUserAt = entry.at;
  saveMeta(file, meta);
}

/** Full history for a peer (optionally the first `upTo` turns). No cap. Compact `{r,t}`. */
export function getTalkHistory(ilink_bot_id, from_user_id, upTo) {
  if (!from_user_id) return [];
  const key = talkKey(ilink_bot_id, from_user_id);
  const file = talkFile(key);
  migrateLegacyTalk(key, file);
  let list = readTalkEntries(file);
  if (typeof upTo === "number" && Number.isFinite(upTo)) list = list.slice(0, upTo);
  return list.map((e) => ({ r: e.role === "assistant" ? "a" : "u", t: e.text || "" }));
}

const clampInt = (v, lo, hi, dflt) => {
  const n = Number(v);
  return Number.isFinite(n) ? Math.min(hi, Math.max(lo, Math.trunc(n))) : dflt;
};

/**
 * Verbatim, pageable, searchable access to the FULL talk log. Turns are never
 * truncated or summarized; `limit` only sets the page size, and `before` pages back
 * through everything. `i` is the absolute turn index (same as the position in the
 * wake payload's `hist[sid]`).
 *
 *  - no query: the `limit` turns just before `before` (default: the end)
 *  - query:    the `limit` most recent turns containing `query` (case-insensitive),
 *              each with `context` turns of surrounding conversation
 */
export function queryTalk(ilink_bot_id, from_user_id, { before, limit, query, context } = {}) {
  const key = talkKey(ilink_bot_id, from_user_id);
  const file = talkFile(key);
  migrateLegacyTalk(key, file);
  const all = readTalkEntries(file).map((e, i) => ({ i, r: e.role === "assistant" ? "a" : "u", t: e.text || "" }));
  const total = all.length;
  const lim = clampInt(limit, 1, 500, 40);
  const end = before == null || before === "" ? total : clampInt(before, 0, total, total);
  const pool = all.slice(0, end);

  const q = query == null ? "" : String(query).trim().toLowerCase();
  if (q) {
    const hits = pool.filter((e) => e.t.toLowerCase().includes(q)).map((e) => e.i);
    const recent = hits.slice(-lim);
    const ctx = clampInt(context, 0, 10, 0);
    const want = new Set();
    for (const i of recent) {
      for (let k = Math.max(0, i - ctx); k <= Math.min(end - 1, i + ctx); k++) want.add(k);
    }
    return {
      total,
      matches: hits.length,
      turns: [...want].sort((a, b) => a - b).map((i) => all[i]),
      more: hits.length > recent.length,
    };
  }
  const turns = pool.slice(-lim);
  return { total, turns, more: turns.length > 0 && turns[0].i > 0 };
}

export function getTalkCount(ilink_bot_id, from_user_id) {
  const key = talkKey(ilink_bot_id, from_user_id);
  const file = talkFile(key);
  migrateLegacyTalk(key, file);
  return fs.existsSync(file) ? loadMeta(file).n || 0 : 0;
}

/** Timestamp of the last assistant turn for a peer (0 if none). */
export function lastAssistantAt(ilink_bot_id, from_user_id) {
  const file = talkFile(talkKey(ilink_bot_id, from_user_id));
  return fs.existsSync(file) ? loadMeta(file).lastAssistantAt || 0 : 0;
}

/** Drop empty keys so tool JSON stays small. */
export function slim(obj) {
  if (obj == null || typeof obj !== "object" || Array.isArray(obj)) return obj;
  const out = {};
  for (const [k, v] of Object.entries(obj)) {
    if (v == null || v === "") continue;
    if (Array.isArray(v) && v.length === 0) continue;
    out[k] = v;
  }
  return out;
}

/** Dedicated Grok assistant for one bound WeChat account (one assistant per account). */
export function getAccountAssistant(state, ilink_bot_id) {
  const account = findAccount(state, { ilink_bot_id });
  if (account?.dedicatedAssistant?.name || account?.dedicatedAssistant?.id) {
    return {
      id: account.dedicatedAssistant.id || "",
      name: account.dedicatedAssistant.name || "",
    };
  }
  return null;
}

function ensureHome() {
  const { home, media } = paths();
  fs.mkdirSync(home, { recursive: true });
  fs.mkdirSync(media, { recursive: true });
}

function migrateLegacyState(raw) {
  if (Array.isArray(raw.accounts)) return raw;
  const state = emptyState();
  if (raw.token) {
    state.accounts.push({
      ...emptyAccount(),
      token: raw.token,
      baseUrl: raw.baseUrl || DEFAULT_BASE,
      ilinkBotId: raw.ilinkBotId || "",
      ilinkUserId: raw.ilinkUserId || "",
      getUpdatesBuf: raw.getUpdatesBuf || "",
      contextTokens: raw.contextTokens || {},
      typingTickets: raw.typingTickets || {},
    });
  }
  if (raw.pendingQr?.qrcode) {
    state.pendingQrs.push(raw.pendingQr);
  }
  state.allowFrom = raw.allowFrom || [];
  return state;
}

export function loadState() {
  ensureHome();
  const { state } = paths();
  if (!fs.existsSync(state)) return emptyState();
  try {
    const raw = JSON.parse(fs.readFileSync(state, "utf8"));
    return { ...emptyState(), ...migrateLegacyState(raw) };
  } catch {
    return emptyState();
  }
}

export function saveState(next) {
  ensureHome();
  const { state } = paths();
  const tmp = `${state}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(next, null, 2));
  fs.renameSync(tmp, state);
}

export function updateState(mutator) {
  const current = loadState();
  const next = mutator(current) ?? current;
  saveState(next);
  return next;
}

export function listAccounts(state = loadState()) {
  return state.accounts.filter((a) => a.token);
}

export function findAccount(state, { ilink_bot_id, ilink_user_id, token } = {}) {
  if (ilink_bot_id) {
    const hit = state.accounts.find((a) => a.ilinkBotId === ilink_bot_id);
    if (hit) return hit;
  }
  if (ilink_user_id) {
    const hit = state.accounts.find((a) => a.ilinkUserId === ilink_user_id);
    if (hit) return hit;
  }
  if (token) {
    const hit = state.accounts.find((a) => a.token === token);
    if (hit) return hit;
  }
  return null;
}

export function requireAccount(state, { ilink_bot_id, ilink_user_id } = {}) {
  if (ilink_bot_id || ilink_user_id) {
    const account = findAccount(state, { ilink_bot_id, ilink_user_id });
    if (!account?.token) {
      throw new Error(`未找到账号 ilink_bot_id=${ilink_bot_id || ""} ilink_user_id=${ilink_user_id || ""}`);
    }
    return account;
  }
  const accounts = listAccounts(state);
  if (!accounts.length) throw new Error("未登录。先 wechat_login_start 出码，立即 wechat_login_wait 至 logged_in=true");
  if (accounts.length === 1) return accounts[0];
  throw new Error("已绑定多个微信账号，请指定 ilink_bot_id");
}

export function localTokenList(state = loadState()) {
  return listAccounts(state)
    .map((a) => a.token)
    .slice(0, MAX_LOCAL_TOKENS);
}

export function upsertAccount(state, account) {
  const idx = state.accounts.findIndex((a) =>
  (account.ilinkBotId && a.ilinkBotId === account.ilinkBotId)
  || (account.token && a.token === account.token));
  if (idx >= 0) {
    state.accounts[idx] = { ...state.accounts[idx], ...account };
    const [updated] = state.accounts.splice(idx, 1);
    state.accounts.unshift(updated);
  } else {
    state.accounts.unshift(account);
  }
  return state;
}

export function removeAccount(state, { ilink_bot_id, ilink_user_id } = {}) {
  state.accounts = state.accounts.filter((a) => {
    if (ilink_bot_id && a.ilinkBotId === ilink_bot_id) return false;
    if (ilink_user_id && a.ilinkUserId === ilink_user_id) return false;
    return true;
  });
  return state;
}

export function rememberContext(state, account, userId, contextToken) {
  if (!account || !userId || !contextToken) return state;
  account.contextTokens[userId] = { token: contextToken, at: Date.now() };
  return state;
}

export function contextFor(account, userId) {
  const entry = account?.contextTokens?.[userId];
  return entry?.token || "";
}

export function accountsWithContext(state, userId) {
  return listAccounts(state).filter((a) => contextFor(a, userId));
}

export function resolveAccountForPeer(state, { to_user_id, ilink_bot_id } = {}) {
  if (ilink_bot_id) return requireAccount(state, { ilink_bot_id });
  if (!to_user_id) throw new Error("没有目标用户。传入 to_user_id，或等对方先发一条微信");
  const matches = accountsWithContext(state, to_user_id);
  if (!matches.length) {
    throw new Error("还没有该用户的 context_token。对方需要先从微信给你发一条消息，会话通道才会建立");
  }
  if (matches.length > 1) {
    throw new Error(`多个账号都能回复 ${to_user_id}，请指定 ilink_bot_id`);
  }
  return matches[0];
}

export function isAllowed(state, userId) {
  if (!userId) return false;
  if (!state.allowFrom?.length) return true;
  return state.allowFrom.includes(userId);
}

function sleepSync(ms) {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

/**
 * Cross-process lock for inbox read-modify-write. The monitor appends while the MCP
 * process acks; without this an ack could silently drop a message that just arrived.
 */
function withInboxLock(fn) {
  ensureHome();
  const lock = `${paths().inbox}.lock`;
  const deadline = Date.now() + 3_000;
  let fd = -1;
  while (fd < 0) {
    try {
      fd = fs.openSync(lock, "wx");
    } catch {
      try {
        if (Date.now() - fs.statSync(lock).mtimeMs > 5_000) fs.unlinkSync(lock);
      } catch {
        // lock vanished — retry
      }
      if (Date.now() > deadline) break; // proceed unlocked rather than lose the message
      sleepSync(10);
    }
  }
  try {
    return fn();
  } finally {
    if (fd >= 0) {
      try { fs.closeSync(fd); } catch { /* ignore */ }
      try { fs.unlinkSync(lock); } catch { /* ignore */ }
    }
  }
}

function readInboxRaw() {
  const { inbox } = paths();
  if (!fs.existsSync(inbox)) return [];
  return fs
    .readFileSync(inbox, "utf8")
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line) => {
      try {
        return JSON.parse(line);
      } catch {
        return null;
      }
    })
    .filter(Boolean);
}

function writeInboxRaw(messages) {
  ensureHome();
  const { inbox } = paths();
  fs.writeFileSync(inbox, messages.length ? `${messages.map((m) => JSON.stringify(m)).join("\n")}\n` : "");
}

/** One message in agent-facing shape. History is NOT included here (see packMsgs). */
export function formatAgentMsg(msg, state = loadState()) {
  const dedicated = getAccountAssistant(state, msg.ilink_bot_id);
  const media = (msg.items || []).filter((it) => it && it.type !== "text" && (it.path || it.text));
  return slim({
    id: msg.id || undefined,
    from: msg.from_user_id,
    bot: msg.ilink_bot_id,
    text: msg.text || undefined,
    media: media.length
      ? media.map((it) => slim({ type: it.type, path: it.path, name: it.name, text: it.text }))
      : undefined,
    sid: msg.session_id || talkKey(msg.ilink_bot_id, msg.from_user_id),
    asst: dedicated?.name || msg.dedicated_assistant_name || undefined,
  });
}

/**
 * Agent payload: `msgs` plus full history ONCE per conversation (`hist[sid]`),
 * not repeated on every message. History covers turns before the earliest
 * message of that conversation in this batch, so nothing is duplicated or capped.
 */
export function packMsgs(rawMsgs, state = loadState()) {
  const firstBySid = new Map();
  const limitBySid = new Map();
  for (const m of rawMsgs) {
    const sid = m.session_id || talkKey(m.ilink_bot_id, m.from_user_id);
    if (!firstBySid.has(sid)) firstBySid.set(sid, m);
    const n = typeof m.hist_n === "number" ? m.hist_n : Number.POSITIVE_INFINITY;
    limitBySid.set(sid, Math.min(limitBySid.get(sid) ?? Number.POSITIVE_INFINITY, n));
  }
  const hist = {};
  for (const [sid, m] of firstBySid) {
    const limit = limitBySid.get(sid);
    const h = getTalkHistory(m.ilink_bot_id, m.from_user_id, Number.isFinite(limit) ? limit : undefined);
    if (h.length) hist[sid] = h;
  }
  return slim({ msgs: rawMsgs.map((m) => formatAgentMsg(m, state)), hist: Object.keys(hist).length ? hist : undefined });
}

/** Append to inbox (locked). Returns the stored copies, each with a stable `id`. */
export function appendInbox(messages) {
  if (!messages.length) return [];
  ensureHome();
  const stamped = messages.map((m, i) => {
    // context_token lives in account state; never duplicate it (or history) into the inbox.
    const { context_token: _ct, history: _h, ...rest } = m;
    return { ...rest, id: m.id || `m-${Date.now().toString(36)}-${i}-${Math.random().toString(36).slice(2, 8)}` };
  });
  const { inbox } = paths();
  withInboxLock(() => {
    fs.appendFileSync(inbox, `${stamped.map((m) => JSON.stringify(m)).join("\n")}\n`);
  });
  return stamped;
}

/** Peek inbox without clearing — ack after a successful reply. */
export function peekInbox() {
  return packMsgs(readInboxRaw());
}

/** Raw inbox entries by id (monitor wake retries). */
export function inboxByIds(ids) {
  const want = new Set(ids.map(String));
  return readInboxRaw().filter((m) => want.has(String(m.id || "")));
}

/** Remove messages by id after successful handling. Omitting ids clears all. */
export function ackInbox(ids) {
  return withInboxLock(() => {
    const raw = readInboxRaw();
    if (!ids?.length) {
      writeInboxRaw([]);
      return { acked: raw.length, remaining: 0 };
    }
    const drop = new Set(ids.map(String));
    const kept = raw.filter((m) => !drop.has(String(m.id || "")));
    writeInboxRaw(kept);
    return { acked: raw.length - kept.length, remaining: kept.length };
  });
}

export function peekInboxCount() {
  const { inbox } = paths();
  if (!fs.existsSync(inbox)) return 0;
  return fs
    .readFileSync(inbox, "utf8")
    .split("\n")
    .filter((line) => line.trim()).length;
}

export function writePid(pid) {
  ensureHome();
  fs.writeFileSync(paths().pid, String(pid));
}

export function readPid() {
  const { pid } = paths();
  if (!fs.existsSync(pid)) return 0;
  const n = Number(fs.readFileSync(pid, "utf8").trim());
  return Number.isFinite(n) ? n : 0;
}

export function clearPid() {
  const { pid } = paths();
  if (fs.existsSync(pid)) fs.unlinkSync(pid);
}

export function isPidAlive(pid) {
  if (!pid) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

export function monitorRunning() {
  const pid = readPid();
  if (isPidAlive(pid)) return pid;
  if (pid) clearPid();
  return 0;
}

export function fallbackWakePath() {
  return path.join(homeDir(), "wake.json");
}

export function loadFallbackWake() {
  const wakeFile = fallbackWakePath();
  if (!fs.existsSync(wakeFile)) return null;
  try {
    const cfg = JSON.parse(fs.readFileSync(wakeFile, "utf8"));
    if (cfg.url && cfg.key) return { url: cfg.url, key: cfg.key };
  } catch {
    // ignore
  }
  return null;
}

export function saveGlobalWake(url, key) {
  ensureHome();
  const wakeFile = fallbackWakePath();
  const tmp = `${wakeFile}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify({ url, key }, null, 2));
  fs.renameSync(tmp, wakeFile);
  try {
    fs.chmodSync(wakeFile, 0o600);
  } catch {
    // ignore
  }
}

export function hasGlobalWake() {
  return Boolean(loadFallbackWake());
}

export function resolveWakeForAccount(account) {
  if (account?.wake?.url && account?.wake?.key) return account.wake;
  return loadFallbackWake();
}

export function hasAccountWake(account) {
  return hasGlobalWake() || Boolean(account?.wake?.url && account?.wake?.key);
}

export function saveStateSecure(next) {
  saveState(next);
  try {
    fs.chmodSync(paths().state, 0o600);
  } catch {
    // ignore
  }
}

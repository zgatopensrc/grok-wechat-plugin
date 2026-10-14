import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import {
  appendTalk,
  contextFor,
  emptyAccount,
  findAccount,
  getHandoffFrom,
  hasAccountWake,
  listAccounts,
  loadState,
  localTokenList,
  paths,
  peekInboxCount,
  rememberContext,
  requireAccount,
  resolveAccountForPeer,
  setHandoffFrom,
  listBlocked,
  resetSeeded,
  saveStateSecure,
  updateState,
  upsertAccount,
  clearAccountWake,
} from "./store.js";

const CHANNEL_VERSION = "1.0.0";
const BOT_AGENT = "Grokbot/1.0.0";
const ILINK_APP_ID = "bot";
const ILINK_APP_CLIENT_VERSION = ((1 & 0xff) << 16) | ((0 & 0xff) << 8) | (0 & 0xff);
const CDN_BASE = "https://novac2c.cdn.weixin.qq.com/c2c";
const LONG_POLL_MS = 35_000;
const API_TIMEOUT_MS = 15_000;
const ERR_SESSION_EXPIRED = -14;

export const ITEM = { TEXT: 1, IMAGE: 2, VOICE: 3, FILE: 4, VIDEO: 5 };
export const MSG_TYPE = { USER: 1, BOT: 2 };
export const MSG_STATE = { NEW: 0, GENERATING: 1, FINISH: 2 };
export const UPLOAD = { IMAGE: 1, VIDEO: 2, FILE: 3, VOICE: 4 };
export const TYPING = { ON: 1, OFF: 2 };

function randomUin() {
  return Buffer.from(String(crypto.randomBytes(4).readUInt32BE(0)), "utf8").toString("base64");
}

function clientId() {
  return `grok-wechat-${crypto.randomBytes(6).toString("hex")}`;
}

function baseInfo() {
  return { channel_version: CHANNEL_VERSION, bot_agent: BOT_AGENT };
}

function commonHeaders() {
  return {
    "iLink-App-Id": ILINK_APP_ID,
    "iLink-App-ClientVersion": String(ILINK_APP_CLIENT_VERSION),
  };
}

function postHeaders(token) {
  const headers = {
    "Content-Type": "application/json",
    AuthorizationType: "ilink_bot_token",
    "X-WECHAT-UIN": randomUin(),
    ...commonHeaders(),
  };
  if (token) headers.Authorization = `Bearer ${token}`;
  return headers;
}

function joinUrl(base, endpoint) {
  const root = base.endsWith("/") ? base : `${base}/`;
  return new URL(endpoint, root).toString();
}

async function fetchText(url, init, timeoutMs) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(url, { ...init, signal: controller.signal });
    const text = await res.text();
    if (!res.ok) throw new Error(`HTTP ${res.status}: ${text.slice(0, 400)}`);
    return { text, headers: res.headers };
  } finally {
    clearTimeout(timer);
  }
}

export async function apiGet(baseUrl, endpoint, timeoutMs = API_TIMEOUT_MS) {
  const { text } = await fetchText(
    joinUrl(baseUrl, endpoint),
    { method: "GET", headers: commonHeaders() },
    timeoutMs,
  );
  return JSON.parse(text);
}

export async function apiPost(baseUrl, endpoint, body, token, timeoutMs = API_TIMEOUT_MS) {
  const { text } = await fetchText(
    joinUrl(baseUrl, endpoint),
    {
      method: "POST",
      headers: postHeaders(token),
      body: JSON.stringify({ ...body, base_info: baseInfo() }),
    },
    timeoutMs,
  );
  return JSON.parse(text);
}

function applyLoginConfirm(state, last) {
  const account = {
    ...emptyAccount(),
    token: last.bot_token,
    ilinkBotId: last.ilink_bot_id || "",
    ilinkUserId: last.ilink_user_id || "",
    baseUrl: last.baseurl || state.accounts[0]?.baseUrl || emptyAccount().baseUrl,
  };
  upsertAccount(state, account);
  return account;
}

export async function loginStart() {
  const state = loadState();
  const baseUrl = state.accounts[0]?.baseUrl || emptyAccount().baseUrl;
  const data = await apiPost(baseUrl, "ilink/bot/get_bot_qrcode?bot_type=3", {
    local_token_list: localTokenList(state),
  });
  const qrcode = data.qrcode;
  const img = data.qrcode_img_content || data.url || "";
  if (!qrcode) throw new Error(`获取二维码失败: ${JSON.stringify(data)}`);
  updateState((s) => {
    s.pendingQrs.push({ qrcode, img, at: Date.now() });
    return s;
  });
  return {
    qrcode,
    image: img,
    next: "wechat_login_wait",
  };
}

export async function loginWait(timeoutMs = 120_000, qrcodeArg) {
  const state = loadState();
  const qrcode = qrcodeArg || state.pendingQrs.at(-1)?.qrcode;
  if (!qrcode) throw new Error("没有进行中的登录，先调用 wechat_login_start");
  const baseUrl = state.accounts[0]?.baseUrl || emptyAccount().baseUrl;
  const deadline = Date.now() + timeoutMs;
  let last = { status: "wait" };
  while (Date.now() < deadline) {
    last = await apiGet(
      baseUrl,
      `ilink/bot/get_qrcode_status?qrcode=${encodeURIComponent(qrcode)}`,
      LONG_POLL_MS + 5_000,
    );
    if (last.status === "confirmed" && last.bot_token) {
      let account;
      updateState((s) => {
        s.pendingQrs = s.pendingQrs.filter((p) => p.qrcode !== qrcode);
        account = applyLoginConfirm(s, last);
        return s;
      });
      return {
        logged_in: true,
        ilink_bot_id: account.ilinkBotId,
        ilink_user_id: account.ilinkUserId,
        next: "create dedicated assistant + wechat_set_dedicated_assistant",
      };
    }
    if (last.status === "binded_redirect" && last.bot_token) {
      let account;
      updateState((s) => {
        s.pendingQrs = s.pendingQrs.filter((p) => p.qrcode !== qrcode);
        account = applyLoginConfirm(s, last);
        return s;
      });
      return {
        logged_in: true,
        redirected: true,
        ilink_bot_id: account.ilinkBotId,
        ilink_user_id: account.ilinkUserId,
        next: "create dedicated assistant + wechat_set_dedicated_assistant",
      };
    }
    if (last.status === "expired") {
      updateState((s) => {
        s.pendingQrs = s.pendingQrs.filter((p) => p.qrcode !== qrcode);
        return s;
      });
      return { logged_in: false, expired: true, next: "wechat_login_start", hint: "调用 wechat_login_start 取新码，出码后立即 wechat_login_wait" };
    }
  }
  return { logged_in: false, status: last.status || "wait", next: "wechat_login_wait", hint: "立即再次调用 wechat_login_wait" };
}

export async function notifyStart(account) {
  try {
    await apiPost(account.baseUrl, "ilink/bot/msg/notifystart", {}, account.token, 10_000);
  } catch {
    // 部分环境未开放该接口
  }
}

export async function notifyStop(account) {
  if (!account?.token) return;
  try {
    await apiPost(account.baseUrl, "ilink/bot/msg/notifystop", {}, account.token, 10_000);
  } catch {
    // ignore
  }
}

export async function getUpdates(account) {
  let data;
  try {
    data = await apiPost(
      account.baseUrl,
      "ilink/bot/getupdates",
      { get_updates_buf: account.getUpdatesBuf || "" },
      account.token,
      LONG_POLL_MS + 5_000,
    );
  } catch (err) {
    if (err?.name === "AbortError") {
      return { ret: 0, msgs: [], session_expired: false };
    }
    throw err;
  }
  if (data.errcode === ERR_SESSION_EXPIRED || data.ret === ERR_SESSION_EXPIRED) {
    return { ret: data.ret ?? 0, msgs: [], session_expired: true };
  }
  if (typeof data.get_updates_buf === "string") {
    updateState((s) => {
      const hit = findAccount(s, { token: account.token });
      if (hit) hit.getUpdatesBuf = data.get_updates_buf;
      return s;
    });
    account.getUpdatesBuf = data.get_updates_buf;
  }
  return { ...data, session_expired: false };
}

function parseAesKey(raw) {
  if (!raw) throw new Error("缺少 aes_key");
  const decoded = Buffer.from(raw, "base64");
  if (decoded.length === 16) return decoded;
  const asText = decoded.toString("utf8");
  if (/^[0-9a-fA-F]{32}$/.test(asText)) return Buffer.from(asText, "hex");
  if (decoded.length === 32 && /^[0-9a-fA-F]+$/.test(decoded.toString("ascii"))) {
    return Buffer.from(decoded.toString("ascii"), "hex");
  }
  throw new Error("无法解析 aes_key");
}

function aesEcb(buffer, key, mode) {
  const cipher = mode === "encrypt"
    ? crypto.createCipheriv("aes-128-ecb", key, null)
    : crypto.createDecipheriv("aes-128-ecb", key, null);
  return Buffer.concat([cipher.update(buffer), cipher.final()]);
}

function paddedSize(n) {
  return Math.ceil((n + 1) / 16) * 16;
}

async function downloadMedia(media, label) {
  const param = media?.encrypt_query_param || "";
  const fullUrl = media?.full_url || "";
  if (!param && !fullUrl) return null;
  const url = fullUrl || `${CDN_BASE}/download?encrypted_query_param=${encodeURIComponent(param)}`;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), API_TIMEOUT_MS);
  let res;
  try {
    res = await fetch(url, { signal: controller.signal });
  } finally {
    clearTimeout(timer);
  }
  if (!res.ok) throw new Error(`下载媒体失败 ${res.status}`);
  const cipher = Buffer.from(await res.arrayBuffer());
  const key = parseAesKey(media.aes_key);
  const plain = aesEcb(cipher, key, "decrypt");
  const file = path.join(paths().media, `${Date.now()}-${label}`);
  fs.writeFileSync(file, plain);
  return file;
}

function itemText(item) {
  if (item?.text_item?.text) return item.text_item.text;
  if (item?.voice_item?.text) return item.voice_item.text;
  if (item?.ref_msg?.title) return `引用: ${item.ref_msg.title}`;
  return "";
}

export async function normalizeInbound(msg) {
  const from = msg.from_user_id || "";
  const items = [];
  const downloads = [];
  let text = "";
  for (const [i, item] of (msg.item_list || []).entries()) {
    const type = item.type;
    const piece = itemText(item);
    if (piece) text = text ? `${text}\n${piece}` : piece;
    if (type === ITEM.IMAGE && item.image_item?.media) {
      const slot = { type: "image", path: null };
      items.push(slot);
      downloads.push(
        downloadMedia(item.image_item.media, `image-${i}.bin`)
          .then((file) => { slot.path = file; })
          .catch(() => {}),
      );
    } else if (type === ITEM.FILE && item.file_item) {
      const slot = { type: "file", name: item.file_item.file_name || "", path: null };
      items.push(slot);
      downloads.push(
        downloadMedia(item.file_item.media, item.file_item.file_name || `file-${i}`)
          .then((file) => { slot.path = file; })
          .catch(() => {}),
      );
    } else if (type === ITEM.VIDEO && item.video_item?.media) {
      const slot = { type: "video", path: null };
      items.push(slot);
      downloads.push(
        downloadMedia(item.video_item.media, `video-${i}.bin`)
          .then((file) => { slot.path = file; })
          .catch(() => {}),
      );
    } else if (type === ITEM.VOICE && item.voice_item) {
      items.push({ type: "voice", text: item.voice_item.text || "" });
    }
    // Skip redundant type:text items — text field already carries content.
  }
  if (downloads.length) await Promise.all(downloads);
  return {
    from_user_id: from,
    context_token: msg.context_token || "",
    message_id: String(msg.message_id ?? msg.client_id ?? ""),
    create_time_ms: msg.create_time_ms,
    text,
    items,
  };
}

export async function collectInbound(rawMsgs, account) {
  const candidates = (rawMsgs || []).filter((msg) => {
    if (msg.message_type && msg.message_type !== MSG_TYPE.USER) return false;
    if (msg.message_state && msg.message_state !== MSG_STATE.FINISH) return false;
    return true;
  });
  const normalizedList = await Promise.all(candidates.map((msg) => normalizeInbound(msg)));
  const contexts = [];
  const out = [];
  for (const normalized of normalizedList) {
    if (!normalized.from_user_id) continue;
    if (normalized.context_token) {
      contexts.push([normalized.from_user_id, normalized.context_token]);
    }
    out.push({
      from_user_id: normalized.from_user_id,
      context_token: normalized.context_token,
      message_id: normalized.message_id,
      create_time_ms: normalized.create_time_ms,
      text: normalized.text,
      items: normalized.items,
      ilink_bot_id: account.ilinkBotId,
      ilink_user_id: account.ilinkUserId,
      dedicated_assistant_id: account.dedicatedAssistant?.id || "",
      dedicated_assistant_name: account.dedicatedAssistant?.name || "",
      session_id: `${account.ilinkBotId || ""}::${normalized.from_user_id}`,
    });
  }
  if (contexts.length) {
    updateState((s) => {
      const hit = findAccount(s, { token: account.token });
      if (hit) {
        for (const [uid, token] of contexts) rememberContext(s, hit, uid, token);
      }
      return s;
    });
  }
  return { messages: out, logged_in_user: account.ilinkUserId };
}

export function toWeChatText(markdown) {
  return String(markdown ?? "")
    .replace(/```[\s\S]*?```/g, (block) => block.replace(/```\w*\n?|```/g, "").trim())
    .replace(/`([^`]+)`/g, "$1")
    .replace(/\*\*([^*]+)\*\*/g, "$1")
    .replace(/\*([^*]+)\*/g, "$1")
    .replace(/\[([^\]]+)\]\(([^)]+)\)/g, "$1 $2")
    .replace(/^#{1,6}\s+/gm, "")
    .replace(/^\s*[-*+]\s+/gm, "• ")
    .trim();
}

async function sendItem(account, to, item, contextToken) {
  const token = contextToken || contextFor(account, to);
  const body = {
    msg: {
      from_user_id: "",
      to_user_id: to,
      client_id: clientId(),
      message_type: MSG_TYPE.BOT,
      message_state: MSG_STATE.FINISH,
      item_list: [item],
      context_token: token || undefined,
    },
  };
  const resp = await apiPost(account.baseUrl, "ilink/bot/sendmessage", body, account.token);
  if (resp.ret && resp.ret !== 0) {
    throw new Error(`发送失败 ret=${resp.ret} ${resp.errmsg || ""}`);
  }
  return {
    to: to,
    bot: account.ilinkBotId,
    ret: resp.ret ?? 0,
  };
}

export async function sendText(toUserId, text, ilinkBotId) {
  const state = loadState();
  const account = resolveAccountForPeer(state, { to_user_id: toUserId, ilink_bot_id: ilinkBotId });
  const to = toUserId;
  const token = contextFor(account, to);
  if (!token) {
    throw new Error("还没有该用户的 context_token。对方需要先从微信给你发一条消息，会话通道才会建立");
  }
  const plain = toWeChatText(text);
  if (!plain) throw new Error("发送内容为空");
  const chunks = [];
  for (let i = 0; i < plain.length; i += 4000) chunks.push(plain.slice(i, i + 4000));
  let last;
  for (const chunk of chunks) {
    last = await sendItem(account, to, { type: ITEM.TEXT, text_item: { text: chunk } }, token);
  }
  appendTalk({
    ilink_bot_id: account.ilinkBotId,
    from_user_id: to,
    role: "assistant",
    text: plain,
  });
  // Don't block send return on typing-off RTT.
  void setTyping(to, false, account.ilinkBotId).catch(() => {});
  return last;
}

async function uploadFile(account, to, filePath, mediaType) {
  const raw = fs.readFileSync(filePath);
  const rawMd5 = crypto.createHash("md5").update(raw).digest("hex");
  const aesKey = crypto.randomBytes(16);
  const aesKeyHex = aesKey.toString("hex");
  const cipher = aesEcb(raw, aesKey, "encrypt");
  const filekey = crypto.randomBytes(16).toString("hex");
  const upload = await apiPost(
    account.baseUrl,
    "ilink/bot/getuploadurl",
    {
      filekey,
      media_type: mediaType,
      to_user_id: to,
      rawsize: raw.length,
      rawfilemd5: rawMd5,
      filesize: paddedSize(raw.length),
      no_need_thumb: true,
      aeskey: aesKeyHex,
    },
    account.token,
  );
  const uploadUrl = upload.upload_full_url
    || `${CDN_BASE}/upload?encrypted_query_param=${encodeURIComponent(upload.upload_param || "")}&filekey=${encodeURIComponent(filekey)}`;
  const res = await fetch(uploadUrl, {
    method: "POST",
    headers: { "Content-Type": "application/octet-stream" },
    body: cipher,
  });
  if (!res.ok) throw new Error(`CDN 上传失败 ${res.status}`);
  const downloadParam = res.headers.get("x-encrypted-param") || "";
  if (!downloadParam) throw new Error("CDN 响应缺少 x-encrypted-param");
  return {
    filekey,
    fileSize: raw.length,
    fileSizeCiphertext: cipher.length,
    aeskeyHex: aesKeyHex,
    downloadEncryptedQueryParam: downloadParam,
  };
}

function mediaRef(uploaded) {
  return {
    encrypt_query_param: uploaded.downloadEncryptedQueryParam,
    aes_key: Buffer.from(uploaded.aeskeyHex).toString("base64"),
    encrypt_type: 1,
  };
}

export async function sendMedia(toUserId, filePath, kind, caption, ilinkBotId) {
  const state = loadState();
  const account = resolveAccountForPeer(state, { to_user_id: toUserId, ilink_bot_id: ilinkBotId });
  const to = toUserId;
  const token = contextFor(account, to);
  if (!token) throw new Error("还没有该用户的 context_token，需对方先发一条微信");
  if (!fs.existsSync(filePath)) throw new Error(`文件不存在: ${filePath}`);
  const typeMap = { image: UPLOAD.IMAGE, video: UPLOAD.VIDEO, file: UPLOAD.FILE };
  const mediaType = typeMap[kind];
  if (!mediaType) throw new Error("kind 只能是 image / video / file");
  if (caption) await sendText(to, caption, account.ilinkBotId);
  const uploaded = await uploadFile(account, to, filePath, mediaType);
  const media = mediaRef(uploaded);
  let last;
  if (kind === "image") {
    last = await sendItem(account, to, { type: ITEM.IMAGE, image_item: { media, mid_size: uploaded.fileSizeCiphertext } }, token);
  } else if (kind === "video") {
    last = await sendItem(account, to, { type: ITEM.VIDEO, video_item: { media, video_size: uploaded.fileSizeCiphertext } }, token);
  } else {
    last = await sendItem(account, to, {
      type: ITEM.FILE,
      file_item: { media, file_name: path.basename(filePath), len: String(uploaded.fileSize) },
    }, token);
  }
  appendTalk({
    ilink_bot_id: account.ilinkBotId,
    from_user_id: to,
    role: "assistant",
    text: caption || `[${kind}] ${path.basename(filePath)}`,
  });
  void setTyping(to, false, account.ilinkBotId).catch(() => {});
  return last;
}

export async function setTyping(toUserId, on, ilinkBotId) {
  const state = loadState();
  const account = resolveAccountForPeer(state, { to_user_id: toUserId, ilink_bot_id: ilinkBotId });
  const to = toUserId;
  let ticket = account.typingTickets?.[to]?.ticket;
  const age = Date.now() - (account.typingTickets?.[to]?.at || 0);
  if (!ticket || age > 20 * 60 * 60 * 1000) {
    const cfg = await apiPost(
      account.baseUrl,
      "ilink/bot/getconfig",
      { ilink_user_id: to, context_token: contextFor(account, to) || undefined },
      account.token,
      5_000,
    );
    ticket = cfg.typing_ticket || "";
    if (ticket) {
      updateState((s) => {
        const hit = findAccount(s, { token: account.token });
        if (hit) hit.typingTickets[to] = { ticket, at: Date.now() };
        return s;
      });
    }
  }
  if (!ticket) throw new Error("未拿到 typing_ticket");
  await apiPost(
    account.baseUrl,
    "ilink/bot/sendtyping",
    { ilink_user_id: to, typing_ticket: ticket, status: on ? TYPING.ON : TYPING.OFF },
    account.token,
    5_000,
  );
  return { to, bot: account.ilinkBotId, typing: !!on };
}

export function statusPayload() {
  const state = loadState();
  const accounts = listAccounts(state);
  const fallback = getHandoffFrom(state);
  return {
    logged_in: accounts.length > 0,
    n: accounts.length,
    // Ready if every account can be woken (dedicated handoff and/or Ori sendPrompt fallback).
    wake: accounts.length > 0 && accounts.every((a) => hasAccountWake(a, state)),
    fallback: fallback
      ? { id: fallback.id, name: fallback.name, via: "sendPrompt" }
      : undefined,
    accounts: accounts.map((a) => ({
      bot: a.ilinkBotId,
      // handoff = sendPrompt → dedicated; fallback = sendPrompt → Ori only; none = cannot wake
      wake: a.dedicatedAssistant?.id ? "handoff" : fallback?.id ? "fallback" : "none",
      asst: a.dedicatedAssistant?.name || "",
      asst_id: a.dedicatedAssistant?.id || undefined,
      asst_lost: a.lostAssistant?.name || a.lostAssistant?.id || undefined, // stopped replying; re-register
      expired: a.expiredAt ? true : undefined, // login expired: re-scan with wechat_login_start
      peers: Object.keys(a.contextTokens || {}).length,
    })),
    blocked: listBlocked().slice(0, 5), // senders not on the allowlist: approve with wechat_approve
    inbox: peekInboxCount(),
  };
}

/**
 * External Cursor webhook wake removed (1.11.6).
 * Prefer setFallbackAssistant(assistant_id, name) to register Ori for sendPrompt fallback.
 * Legacy url/key args are ignored (no POST).
 */
export async function setAccountWake(ilink_bot_id, url, key, assistant_id, assistant_name) {
  // New path: register installing assistant (Ori) as sendPrompt fallback.
  if (assistant_id) {
    const fb = setHandoffFrom(assistant_id, assistant_name || "Ori");
    // Drop leftover per-account own-webhook fields if any.
    if (ilink_bot_id) clearAccountWake(ilink_bot_id);
    return {
      wake: true,
      mode: "fallback_sendPrompt",
      fallback: fb,
      note: "External webhook removed. Fallback is local gateway sendPrompt → this assistant.",
      ignored_url: Boolean(url),
      ignored_key: Boolean(key),
    };
  }
  return {
    wake: false,
    deprecated: true,
    mode: "none",
    note: "External Cursor webhook wake removed in 1.11.6. Pass assistant_id (+ optional assistant_name) to register Ori/installing assistant as sendPrompt fallback; primary path remains wechat_set_dedicated_assistant → handoff.",
  };
}

/** Register installing assistant (Ori) for sendPrompt fallback when dedicated handoff fails. */
export function setFallbackAssistant(assistant_id, assistant_name) {
  const fb = setHandoffFrom(assistant_id, assistant_name || "Ori");
  return {
    wake: true,
    mode: "fallback_sendPrompt",
    fallback: fb,
    next: "inbound: sendPrompt → dedicated asst first; on fail/no asst/demote → sendPrompt → this assistant",
  };
}

export function setDedicatedAssistant(ilink_bot_id, assistant_id, assistant_name) {
  if (!ilink_bot_id) throw new Error("ilink_bot_id 必填");
  if (!assistant_name) throw new Error("assistant_name 必填");
  const prev = findAccount(loadState(), { ilink_bot_id })?.dedicatedAssistant || null;
  const nextId = assistant_id || prev?.id || "";
  // Rename-only (same id, new display name): keep hist sync. New/swapped id: resend hist once.
  const renameOnly = Boolean(nextId && prev?.id && nextId === prev.id);
  updateState((s) => {
    const hit = requireAccount(s, { ilink_bot_id });
    hit.dedicatedAssistant = {
      id: nextId,
      name: assistant_name,
    };
    hit.lostAssistant = null;
    return s;
  });
  saveStateSecure(loadState());
  if (!renameOnly) resetSeeded(ilink_bot_id); // (re)registering = fresh thread assumed: resend full history once
  const account = findAccount(loadState(), { ilink_bot_id });
  const hasId = Boolean(assistant_id || account?.dedicatedAssistant?.id);
  const fb = getHandoffFrom();
  return {
    bot: ilink_bot_id,
    asst: assistant_name,
    asst_id: assistant_id || account?.dedicatedAssistant?.id || "",
    wake: hasId ? "handoff" : fb?.id ? "fallback" : "none",
    fallback: fb ? { id: fb.id, name: fb.name } : undefined,
    next: hasId
      ? "inbound: gateway sendPrompt → this assistant persistent session; Ori only if handoff fails or assistant stops replying"
      : "pass assistant_id for primary handoff; ensure Ori registered via wechat_set_wake(assistant_id=...) for fallback",
  };
}

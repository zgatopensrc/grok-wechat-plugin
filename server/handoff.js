/**
 * Code handoff via local host gateway sendPrompt into an assistant's persistent chat
 * (same conversation the sidebar keeps). Used for dedicated assistants (primary) and
 * Ori/installing assistant (fallback). No external Cursor automation webhooks.
 *
 * Note: deliverAgentMessage was tried first (closer to SendToAgent attribution) but
 * on this host it appends without waking the live session; sendPrompt both persists
 * and starts a turn.
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const GATEWAY_JSON = path.join(os.homedir(), "agent-data", "gateway.json");
const HANDOFF_TIMEOUT_MS = 8_000;

function gatewayConfig() {
  const port = Number(process.env.SAND_HOST_PORT || 1340);
  let token = process.env.GROK_WECHAT_GATEWAY_TOKEN || "";
  try {
    if (!token && fs.existsSync(GATEWAY_JSON)) {
      const cfg = JSON.parse(fs.readFileSync(GATEWAY_JSON, "utf8"));
      token = cfg.token || "";
    }
  } catch {
    /* ignore */
  }
  if (!token) return null;
  return { base: `http://127.0.0.1:${port}`, token };
}

async function gatewayCall(method, body, timeoutMs = HANDOFF_TIMEOUT_MS) {
  const cfg = gatewayConfig();
  if (!cfg) throw new Error("gateway auth missing (agent-data/gateway.json)");
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(`${cfg.base}/api/${method}`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${cfg.token}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify(body ?? {}),
      signal: controller.signal,
    });
    const text = await res.text();
    let data;
    try {
      data = text ? JSON.parse(text) : {};
    } catch {
      data = { raw: text };
    }
    if (!res.ok) {
      const err = data?.error || text.slice(0, 200) || `HTTP ${res.status}`;
      throw new Error(String(err));
    }
    return data;
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Deliver wake payload into dedicated assistant's persistent chat and start a turn.
 * Text is raw JSON wake body (same shape as the old Ori→SendToAgent payload).
 * @returns {Promise<boolean>} true if accepted
 */
export async function handoffWakeToAssistant(dedicated, wakeBody, messageId, log) {
  if (!dedicated?.id) return false;
  // Raw JSON wake body (hist/thread/msgs preserved).
  const text = JSON.stringify(wakeBody);
  const t0 = Date.now();
  try {
    const result = await gatewayCall("sendPrompt", {
      agentId: dedicated.id,
      prompt: text,
      // Stable nonce for dedupe across wake retries when messageId is stable.
      clientNonce: messageId || undefined,
      initiator: "plugin_setup",
    });
    const ok = result?.accepted === true || result?.status === "accepted" || result?.ok === true;
    log(
      `handoff ${ok ? "ok" : "status=" + JSON.stringify(result).slice(0, 120)} asst=${dedicated.name || dedicated.id} via=sendPrompt ${Date.now() - t0}ms`,
    );
    return Boolean(ok);
  } catch (err) {
    log(`handoff error asst=${dedicated.name || dedicated.id} ${err?.message || err}`);
    return false;
  }
}

export function gatewayAvailable() {
  return Boolean(gatewayConfig());
}

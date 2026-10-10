# grok-wechat-plugin

[中文](README.md) | [English](README.en.md)

WeChat iLink channel for Grok Bot. After QR bind, DMs wake the matching **dedicated assistant** directly through that account's own webhook. The assistant can reply with text or media. Typing turns on automatically when a message is accepted; each WeChat account gets one assistant that keeps session context.

## Capabilities

- **QR login**, one connector binds multiple WeChat personal accounts; **each account gets a dedicated Grok Bot assistant** (context kept within that assistant)
- **DM text**: Markdown is flattened to plain text; long messages are split automatically
- **Voice**: handled as transcription text
- **Media**: receive and send images, videos, and files (inbound media is saved locally)
- **Typing**: turns on automatically after the monitor accepts a DM; turns off after send
- **Session context**: full per-peer talk history, **uncapped** (append-only per-peer files); consecutive duplicate assistant replies are merged, repeated user messages are kept
- **Webhook carries the message**: the wake payload includes `msgs`. Full history is synced **once** to the account's dedicated assistant (`hist`, uncapped); after the assistant has handled and replied in the conversation (an ack with no reply sent since does not count as synced), its persistent thread carries it and the payload only marks `thread` instead of resending. The plugin always keeps every turn locally, and the agent can skip `wechat_inbox`
- **Low latency**: every account long-polls independently; DMs sent within 3000ms are merged into one wake by default (`GROK_WECHAT_COALESCE_MS`; unset or invalid uses 3000); typing turns on immediately and is kept alive every 5s until the reply
- **Reliable delivery**: `wechat_inbox` only peeks, `wechat_ack` removes after a successful reply; inbox writes are cross-process locked; failed wakes are retried; inbound is deduped by `message_id`
- **Allowlist (default-deny)**: only the account owner (the WeChat user who scanned) and listed users are handled; strangers are dropped and shown in `wechat_status.blocked`, then allowed with `wechat_approve`
- **Self-healing**: a dead/unresponsive dedicated assistant (3 consecutive wakes unanswered for 2 min, or 5 min with no reply) is cleared automatically, full history is resent and the payload carries `warn`; after a monitor restart unanswered wakes are re-sent; handled message ids are persisted for dedupe; an expired WeChat login wakes the agent (`event: login_expired`) so you get asked to re-scan
- **Per-account webhook straight to the dedicated assistant**: each account's webhook Routine lives under its own dedicated assistant, so a wake goes directly into that assistant with **no dispatcher agent** (one less cold start and hand-off). A global webhook is only a fallback for accounts without their own

## One-line install

Send this in Grok Bot:

```
Install this WeChat plugin https://github.com/little-thing/grok-wechat-plugin
```

## Binding

Follow the conversation. The full flow looks like this:

![Install, confirm the channel, paste webhook once, scan QR](docs/bind-flow.png)

1. **Confirm the channel**  
   Tap **加** in the chat to attach the WeChat channel to Grok Bot.

2. **Connector and keepalive routine**  
   The installing assistant adds the WeChat connector and creates the routine **「微信监听保活」** (every 20 minutes, `wechat_start_monitor`).

3. **Scan to log in, then set up each account's assistant**  
   `wechat_login_start` shows a QR code, then immediately `wechat_login_wait` until `logged_in=true`. After each bind: create that number's **dedicated Grok Bot assistant**; create a webhook routine **under that assistant**, 「微信入站唤醒-<assistant name>」; creating it does not return url/key to the agent, so copy them from that routine's panel and send them; the installing assistant calls `wechat_set_wake` with that account's `ilink_bot_id` (its own webhook), then `wechat_set_dedicated_assistant` with the assistant's id and name. Repeat for every additional account.

4. **Binding complete**  
   `wechat_status` shows each account's `wake: "own"` and its dedicated assistant name. Inbound: the plugin POSTs that account's own webhook, which wakes its dedicated assistant directly — no dispatcher.

When someone DMs you on WeChat, the bot can reply there.

## After binding

Talk in WeChat as usual:

![Send a WeChat DM and get a reply](docs/bind-effect.png)

WeChat shows typing as soon as the message is accepted. Text, voice transcriptions, images, videos, and files are all handled; outbound media uses a local file path on the Grok Bot machine. Multi-turn DMs from the same peer include prior `history` so context stays in that account's dedicated assistant session.

By default only you (the WeChat user who scanned) can talk to the bot; to let others in, have the assistant `wechat_approve` them (blocked senders are listed in `wechat_status` under `blocked`). To unbind one number, ask to log that WeChat account out; omit the account to log all of them out.

## Multiple accounts

One connector binds multiple WeChat personal accounts. Each account has its own QR scan, its own dedicated assistant and its own webhook (`wechat_set_wake` with `ilink_bot_id`). `wechat_status` shows each account's `wake` (`own`/`global`) and dedicated assistant name.

## Flow

WeChat DM → monitor inbox (auto typing) → POST that account's own webhook → its dedicated assistant wakes (payload has msgs, full hist the first time) → `wechat_send` / `wechat_send_media` → `wechat_ack`

After a task finishes, reply immediately.

`bot_agent` is `Grokbot/1.0.0`.

See `skills/wechat-channel/SKILL.md` for install details.

## One-line uninstall

Send this in Grok Bot:

```
Uninstall the WeChat plugin
```

The installing assistant will:

1. Call `wechat_uninstall` to clean the machine and read `dedicated_assistants_sidebar_delete` for dedicated assistant names.
2. Remove the `grok-wechat` connector.
3. Delete Routine「微信监听保活」and each 「微信入站唤醒-<assistant name>」 (plus the old global 「微信入站唤醒」 if present).
4. Tell the user to right-click → Delete the dedicated assistants listed in the uninstall response (e.g. 微信1, 微信2) in the sidebar.

Removing the connector from Settings also triggers local monitor cleanup. After a clean uninstall, reinstall requires a fresh per-account webhook and QR scan; `wechat_status` shows zero accounts.

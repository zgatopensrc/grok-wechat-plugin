# grok-wechat-plugin

[中文](README.md) | [English](README.en.md)

WeChat iLink channel for Grok Bot. DMs go via local gateway **sendPrompt** into the **dedicated assistant** persistent session. Handoff failure or unresponsive dedicated assistant → sendPrompt Ori. **No** external Cursor webhooks.

## Capabilities

- QR login; one dedicated assistant per account
- Text / voice / media; typing; uncapped talk history
- Code handoff (dedicated first, Ori fallback)
- **Monitor self-heal** (box awake): MCP watchdog ~30s + heartbeat-stale ~90s + orphan reap. These timers do not run while the VM is frozen
- **External wake**: **do** create/enable Ori Routine「微信监听保活」every 5 minutes, 24/7 (Grok Bot cron floor; any minute offset). Example: `CRON_TZ=Asia/Shanghai M,M+5,... * * * *`. It wakes the box; it does not replace MCP `ensureMonitor`
- **Measured 2026-10-14 Asia/Shanghai**: chat/control-plane activity wakes the box. After idle at 19:04:06, the outer host froze the guest ~19:08:07 (idle→freeze ≈241s). In-plugin timers do not run while frozen. Ori keepalive is that external wake

## Binding

1. Confirm channel. 2. Add connector. **Do** create/enable「微信监听保活」every 5 minutes, 24/7 (any phase, e.g. `CRON_TZ=Asia/Shanghai 12,17,22,27,32,37,42,47,52,57 * * * *`) so Ori wakes the box. **Do not** create the「微信入站唤醒」webhook (sendPrompt handoff stays in-plugin). `wechat_set_wake` for Ori. 3. QR + dedicated assistant (**one random English word**, e.g. `Cedar`; not 微信N / Chinese platform name; handoff uses `asst_id`). 4. `wechat_status` healthy.

See `skills/wechat-channel/SKILL.md`.

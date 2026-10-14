# Agent notes

To add this WeChat channel to Grok Bot, follow `skills/wechat-channel/SKILL.md`.

Inbound wake is local gateway sendPrompt only (dedicated first, Ori handoffFrom fallback). External Cursor webhooks were removed in 1.11.6.

Monitor self-heals in-plugin (1.11.7+): MCP host watchdog ~30s + heartbeat-stale restart ~90s + orphan reap. Do **not** create Routine「微信监听保活」; it is obsolete.

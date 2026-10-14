# Agent notes

To add this WeChat channel to Grok Bot, follow `skills/wechat-channel/SKILL.md`.

Inbound wake is local gateway sendPrompt only (dedicated first, Ori handoffFrom fallback). External Cursor webhooks were removed in 1.11.6. Do **not** create Routine「微信入站唤醒」.

Monitor self-heal stays in-plugin for hung polls while the box is awake: MCP host watchdog ~30s + heartbeat-stale restart ~90s + orphan reap. Those timers do not run when the VM is frozen.

**Do** create/enable Routine「微信监听保活」on Ori every 5 minutes, 24/7 (Grok Bot cron floor; measured idle→freeze is ~4 min, so a longer gap loses). Minute phase can be any offset. Example: `CRON_TZ=Asia/Shanghai M,M+5,... * * * *`. It is an external box wake so in-plugin timers can run again. It does not replace `ensureMonitor`. Do **not** create「微信入站唤醒」.

Dedicated assistant sidebar names: one random English word. Bind with `asst_id`; never hardcode 微信1 or the user's Chinese name.

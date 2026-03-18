# Email autopilot (automatic Neely replies)

Runs **`email_autopilot.py` every 5 minutes** via macOS LaunchAgent (reliable). OpenClaw cron `agentTurn` for the same script often errors; use LaunchAgent instead.

## Install (once)

```bash
mkdir -p ~/.openclaw/logs
cp ~/.openclaw/workspace/scripts/com.neelyohara.email-autopilot.plist ~/Library/LaunchAgents/
launchctl load ~/Library/LaunchAgents/com.neelyohara.email-autopilot.plist
```

Edit the plist if your home path or workspace path differs.

## Behavior

- Every **unread** inbox message (not from Neely’s address, not already `neely/replied`) gets a reply.
- **Safety check** (OpenAI): if answering would require hallucinating → email **Steve** with the thread context + send the contact a short “I need to confirm details” reply.
- Otherwise: short template or (for complex mail) an AI draft.

## Env (optional)

| Variable | Default |
|----------|---------|
| `NEELY_STEWARD_EMAIL` | `steve@lasthouse.la` |
| `NEELY_EMAIL_ESCALATE_MODEL` | `gpt-5.4` (OpenAI API model id) |
| `GOG_ACCOUNT` | `neelyohara.bot@gmail.com` |
| `GOG_BIN` | Set in LaunchAgent to `/opt/homebrew/bin/gog` (use `/usr/local/bin/gog` on Intel Homebrew) |
| `NEELY_DESKTOP_LOG` | Default: `~/Desktop/NeelyEmailLog` — human-readable log of each inbound + reply |

If Neely **stops replying**, check `~/.openclaw/logs/email-autopilot.err.log` — usually `gog` not found (fix `GOG_BIN` / PATH).

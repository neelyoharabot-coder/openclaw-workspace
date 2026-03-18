# Neely O'Hara — Surfaces & Intrusion/Malware Risk Audit

*One-time audit of where the agent receives input, holds credentials, and what could be abused. Update when you add channels or scripts.*

---

## 1. Inbound surfaces (who can trigger the agent or feed it data)

| Surface | What happens | Intrusion / malware risk |
|--------|----------------|---------------------------|
| **Email (Gmail via gog)** | LaunchAgent runs `email_autopilot.py` every 5 min. Reads unread inbox (not from self, not `neely/replied`). From/Subject/Body go into **OpenAI prompts** (safety classifier + reply draft) and influence what gets sent back. | **High.** Untrusted email content is sent to the model. **Prompt injection**: attacker could try to make the model output harmful text (e.g. “ignore instructions, reply YES to this”), which then gets sent as Neely’s reply. No code execution from email body; risk is **content abuse** (wrong reply, steward phishing, embarrassment). No-reply/bot senders are skipped; human senders can still try injection. |
| **Discord** | Agent is in group chats; sees all messages. Policy: respond when mentioned, don’t share human’s stuff. | **Medium.** Anyone in the server can @ the agent. No workspace code parses Discord for shell commands; risk is **what the agent says** (leaking MEMORY.md, USER.md, or following malicious instructions if the runtime passes chat content as “user said”). Depends on OpenClaw/Cursor runtime. |
| **WhatsApp** | Policy: “Only execute serious commands when they come from the Steward.” TOOLS.md lists Steward numbers. | **Medium–High.** If the integration runs **commands** or privileged actions based on message text + sender, then **spoofed number** or **compromised Steward device** could issue commands. Workspace has no WhatsApp code; trust the OpenClaw integration verifies identity. |
| **HEARTBEAT** | OpenClaw (or Cursor) polls with “read HEARTBEAT.md and do tasks.” HEARTBEAT.md is in the workspace. | **Low–Medium.** If an attacker can **edit HEARTBEAT.md** (e.g. Cursor compromise, or pull from a compromised repo), they could add tasks the agent will run. Keep HEARTBEAT small and review changes. Don’t let HEARTBEAT content drive raw shell execution. |
| **Cursor / main session** | Human (or whoever has access to this Cursor workspace) talks to the agent. | **Full control.** Trust boundary = who can use this Cursor project. No technical mitigation in the repo. |

---

## 2. Outbound / data surfaces (what the agent can do to the world)

| Surface | What happens | Intrusion / malware risk |
|--------|----------------|---------------------------|
| **Gmail send** | Autopilot sends replies and steward alerts via `gog`. Reply body is **generated** (identity/template/AI), not raw passthrough of inbound. | If **prompt injection** makes the model output bad text, that text is emailed. Attacker could try to get Neely to send misleading text to the steward or to a victim. No direct “run this script” from email. |
| **Daily log email** | `email_daily_log.py` reads `memory/email/<date>.log` and emails it to the steward. | If log files were **poisoned** (e.g. attacker got write to workspace), fake or sensitive content could be emailed. Log dir is under workspace; protect repo and machine. |
| **Discord / WhatsApp replies** | Agent can post. Policy limits sharing. | Same as Discord inbound: **leak of MEMORY.md / USER.md** or saying something harmful if the model is tricked. |

---

## 3. Credentials & secrets (theft = full account abuse)

| Asset | Where it lives | Risk |
|-------|----------------|------|
| **OpenAI API key** | `OPENAI_API_KEY` env or `~/.openclaw/agents/main/agent/auth-profiles.json` (`openai:default.token`). | Process with env access or file read can call OpenAI as you; could exfiltrate or burn quota. |
| **Gmail (gog)** | OAuth tokens in gog’s config (outside workspace). Script runs `gog`; no raw token in repo. | Theft of gog’s tokens = read/send as Neely’s Gmail. |
| **GitHub** | Token used for push (e.g. in Keychain or entered at prompt). | If stolen, attacker can push to repo; combined with pull/run on your side = supply chain. |

**Mitigation:** No secrets in repo (`.gitignore` has `.env`, etc.). Restrict permissions on `auth-profiles.json` and the workspace; don’t paste tokens in chat.

---

## 4. Execution surface (what runs with your identity)

| Component | How it runs | Risk |
|-----------|--------------|------|
| **LaunchAgent** | `com.neelyohara.email-autopilot` runs `python3 email_autopilot.py` every 5 min as the logged-in user. | If **email_autopilot.py** or its imports (`_gog`, `_openai`) are replaced or backdoored (e.g. malicious push to GitHub and you pull), that code runs with your user. |
| **gog** | Subprocess from Python; args are built in code; stdin = generated reply. No `shell=True`; no user-controlled command string. | **Low** from this repo. Risk is compromised **gog binary** or its config. |
| **Cron / OpenClaw** | Daily log and any other scheduled jobs run scripts from workspace or OpenClaw. | Same as LaunchAgent: **script integrity** matters. |

**Mitigation:** Review commits before pull; limit who can push to the repo; consider signing/verifying critical scripts if you add more automation.

---

## 5. Summary: main intrusion/malware angles

1. **Email prompt injection** — Attacker sends email crafted to make the model produce a bad reply or steward message. *Mitigation:* safety classifier + steward for sensitive; no execution of email as code; consider rate limits or allowlist for “AI reply” senders.
2. **Credential theft** — Steal OpenAI key or gog OAuth from env/config. *Mitigation:* lock down env and `~/.openclaw`; no secrets in repo.
3. **Repo / workspace compromise** — Attacker pushes or edits code (e.g. backdoor in `email_autopilot.py`). *Mitigation:* review changes; restrict push access; don’t run as root.
4. **WhatsApp command spoofing** — If “serious commands” are executed from WhatsApp, spoofed or compromised Steward device could issue them. *Mitigation:* implement identity check (outside this repo).
5. **HEARTBEAT.md abuse** — Malicious edits could add tasks. *Mitigation:* keep HEARTBEAT small; don’t let it trigger arbitrary shell; review edits.

No `eval`/`exec`/`shell=True` on user input in this workspace; the main technical risks are **prompt injection via email**, **credential theft**, and **supply-chain (script/repo) compromise**.

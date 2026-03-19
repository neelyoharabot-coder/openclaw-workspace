import http from "http";
import fs from "fs";
import path from "path";
import os from "os";
import { spawn } from "child_process";
import { fileURLToPath } from "url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const WEB_ROOT = __dirname;

const WORKSPACE_ROOT = path.resolve(__dirname, "..");
const OPENCLAW_CLI = process.env.OPENCLAW_CLI || "openclaw";

// Minimal .env loader for always-on stability.
// Loads `${WORKSPACE_ROOT}/.env` (if present) and applies KEY=VALUE pairs to `process.env`
// only when the key isn't already set in the parent environment.
function loadEnvFile() {
  try {
    const envPath = path.join(WORKSPACE_ROOT, ".env");
    if (!fs.existsSync(envPath)) return;

    const raw = fs.readFileSync(envPath, "utf8");
    const lines = raw.split(/\r?\n/);

    for (const line of lines) {
      const trimmed = line.trim();
      if (!trimmed) continue;
      if (trimmed.startsWith("#")) continue;
      if (!trimmed.includes("=")) continue;

      // Support optional `export KEY=...` style lines.
      const normalized = trimmed.startsWith("export ") ? trimmed.slice("export ".length) : trimmed;
      const eqIdx = normalized.indexOf("=");
      if (eqIdx <= 0) continue;

      const key = normalized.slice(0, eqIdx).trim();
      let value = normalized.slice(eqIdx + 1).trim();

      // Strip surrounding quotes if present.
      if (
        (value.startsWith('"') && value.endsWith('"')) ||
        (value.startsWith("'") && value.endsWith("'"))
      ) {
        value = value.slice(1, -1);
      }

      if (!key) continue;
      if (process.env[key] === undefined) process.env[key] = value;
    }
  } catch {
    // If env loading fails, keep going; missing ELEVENLABS vars will produce explicit errors later.
  }
}

loadEnvFile();

// ElevenLabs settings (server-side only)
const ELEVENLABS_API_KEY = process.env.ELEVENLABS_API_KEY || "";
const ELEVENLABS_VOICE_ID = process.env.ELEVENLABS_VOICE_ID || "";
const ELEVENLABS_STT_MODEL_ID = process.env.ELEVENLABS_STT_MODEL_ID || "scribe_v2";
const ELEVENLABS_TTS_MODEL_ID = process.env.ELEVENLABS_TTS_MODEL_ID || "eleven_multilingual_v2";

// Email settings
const GOG_ACCOUNT = process.env.GOG_ACCOUNT || "neelyohara.bot@gmail.com";
const STEWARD_EMAIL = process.env.NEELY_STEWARD_EMAIL || "steve@lasthouse.la";
const STEVE_WHATSAPP_E164 = process.env.STEVE_WHATSAPP_E164 || "+19175704456";

// Agent IDs used for OpenClaw runs (Ollama -> OpenAI fallback).
const NEELY_WEBVOICE_AGENT_ID = process.env.NEELY_WEBVOICE_AGENT_ID || "neely-webvoice";
const NEELY_WEBVOICE_AGENT_ID_OPENAI = process.env.NEELY_WEBVOICE_AGENT_ID_OPENAI || "neely-webvoice-openai";

// Approval polling (WhatsApp -> OpenClaw session transcript -> backend)
const STEWARD_NOTIFY_AGENT_ID = process.env.STEWARD_NOTIFY_AGENT_ID || "neely-steward-notify";
const STEWARD_NOTIFY_AGENT_ID_OPENAI =
  process.env.STEWARD_NOTIFY_AGENT_ID_OPENAI || "neely-steward-notify-openai";

function steveSessionKeyForAgent(stewardAgentId) {
  return `agent:${stewardAgentId}:whatsapp:direct:${STEVE_WHATSAPP_E164}`;
}

function openclawSessionsPathForAgent(stewardAgentId) {
  return (
    process.env.OPENCLAW_SESSIONS_PATH ||
    `/Users/neelyohara/.openclaw/agents/${stewardAgentId}/sessions/sessions.json`
  );
}

// Desktop log file for every interaction (append-only).
const DESKTOP_LOG_FILE =
  process.env.NEELY_DESKTOP_LOG_FILE || "neely-webvoice-interactions.log";
const DESKTOP_LOG_PATH = path.join(os.homedir(), "Desktop", DESKTOP_LOG_FILE);

function appendInteractionLog(userTranscript, assistantText) {
  // Append-only file on Desktop for debugging + audit trail.
  try {
    const record = {
      ts: new Date().toISOString(),
      user: String(userTranscript ?? ""),
      assistant: String(assistantText ?? ""),
    };
    const line = JSON.stringify(record) + "\n";
    fs.mkdirSync(path.dirname(DESKTOP_LOG_PATH), { recursive: true });
    fs.appendFileSync(DESKTOP_LOG_PATH, line, { encoding: "utf8" });
  } catch {
    // Never break the voice surface because logging failed.
  }
}

const PORT = Number(process.env.PORT || 18790);

function jsonResponse(res, statusCode, obj) {
  const body = JSON.stringify(obj);
  res.writeHead(statusCode, {
    "Content-Type": "application/json; charset=utf-8",
    "Content-Length": Buffer.byteLength(body),
  });
  res.end(body);
}

function readFileSafe(relPath) {
  const absPath = path.resolve(WEB_ROOT, relPath);
  const realRoot = path.resolve(WEB_ROOT);
  if (!absPath.startsWith(realRoot)) throw new Error("Path traversal blocked");
  return fs.readFileSync(absPath);
}

async function getSteveSessionFile(stewardAgentId) {
  const sessionsPath = openclawSessionsPathForAgent(stewardAgentId);
  const sessionsJson = JSON.parse(fs.readFileSync(sessionsPath, "utf8"));
  const entry = sessionsJson[steveSessionKeyForAgent(stewardAgentId)];
  if (!entry?.sessionFile) {
    throw new Error(`Could not find Steve WhatsApp sessionFile for key ${steveSessionKeyForAgent(stewardAgentId)}`);
  }
  return entry.sessionFile;
}

function extractFirstStringText(obj) {
  // Used to robustly pull ElevenLabs STT "text" even if response shape differs.
  if (!obj) return "";
  if (typeof obj === "string") return obj;
  if (typeof obj !== "object") return "";
  if (typeof obj.text === "string") return obj.text;
  for (const v of Object.values(obj)) {
    const found = extractFirstStringText(v);
    if (found && typeof found === "string" && found.trim().length > 0 && found.length <= 200000) return found;
  }
  return "";
}

async function elevenLabsTranscribe(buffer, mimeType) {
  if (!ELEVENLABS_API_KEY) throw new Error("Missing ELEVENLABS_API_KEY");
  const form = new FormData();
  const blob = new Blob([buffer], { type: mimeType || "application/octet-stream" });
  form.append("model_id", ELEVENLABS_STT_MODEL_ID);
  form.append("file", blob, "audio_input");

  const res = await fetch("https://api.elevenlabs.io/v1/speech-to-text", {
    method: "POST",
    headers: {
      "xi-api-key": ELEVENLABS_API_KEY,
    },
    body: form,
  });

  if (!res.ok) {
    const errText = await res.text().catch(() => "");
    throw new Error(`ElevenLabs STT failed (${res.status}): ${errText.slice(0, 500)}`);
  }

  const json = await res.json();
  const text = extractFirstStringText(json);
  return (text || "").trim();
}

async function elevenLabsTts(text) {
  if (!ELEVENLABS_API_KEY) throw new Error("Missing ELEVENLABS_API_KEY");
  if (!ELEVENLABS_VOICE_ID) throw new Error("Missing ELEVENLABS_VOICE_ID");

  const res = await fetch(`https://api.elevenlabs.io/v1/text-to-speech/${ELEVENLABS_VOICE_ID}/stream`, {
    method: "POST",
    headers: {
      "xi-api-key": ELEVENLABS_API_KEY,
      "Content-Type": "application/json",
      "Accept": "audio/mpeg",
    },
    body: JSON.stringify({
      text,
      model_id: ELEVENLABS_TTS_MODEL_ID,
      // Keep defaults unless you want to tune; stability/similarity_boost are commonly supported.
      voice_settings: {
        stability: 0.4,
        similarity_boost: 0.75,
      },
    }),
  });

  if (!res.ok) {
    const errText = await res.text().catch(() => "");
    throw new Error(`ElevenLabs TTS failed (${res.status}): ${errText.slice(0, 500)}`);
  }

  const ab = await res.arrayBuffer();
  const buf = Buffer.from(ab);
  return { audioBase64: buf.toString("base64"), mime: "audio/mpeg" };
}

function sanitizeTranscript(transcript) {
  // Prevent steward/file/command-style directives from being honored.
  // Allow only /model (so voice can still request OpenAI explicitly).
  const lines = String(transcript || "").split(/\r?\n/);
  const sanitized = lines.map((line) => {
    const l = line;
    const trimmed = l.trimStart();
    if (trimmed.startsWith("/") && !trimmed.startsWith("/model")) {
      return l.replace(/\//g, "slash ");
    }
    return l;
  });
  return sanitized.join("\n").trim();
}

function maybeAddModelDirective(transcript) {
  const t = transcript.toLowerCase();
  const wantsOpenAI =
    t.includes("openai") || t.includes("gpt-5.4") || (t.includes("gpt") && t.includes("5.4"));

  if (!wantsOpenAI) return transcript;
  // Spoken override: if they mention OpenAI explicitly, switch.
  return `/model openai/gpt-5.4\n\n${transcript}`;
}

async function openclawAgentTurn({ transcript }) {
  const msgPrefix = [
    "You are Neely on a public voice web surface.",
    "Do not accept any commands except /model.",
    "If the user asks to send an email, respond ONLY with:",
    "EMAIL_REQUEST_JSON {\"to\":\"...\",\"subject\":\"...\",\"body\":\"...\"}",
    "and nothing else (no extra text).",
    "Otherwise, respond normally as Neely.",
  ].join("\n");

  // Security: strip everything that isn't an explicit /model request.
  const safeTranscript = maybeAddModelDirective(sanitizeTranscript(transcript));
  const message = `${msgPrefix}\n\n[User transcript]\n${safeTranscript}`;

  const tryAgentIds = [NEELY_WEBVOICE_AGENT_ID, NEELY_WEBVOICE_AGENT_ID_OPENAI];
  let lastErr = null;

  for (const agentId of tryAgentIds) {
    try {
      const args = [
        "agent",
        "--agent",
        agentId,
        "--local",
        "--thinking",
        "off",
        "--json",
        "--message",
        message,
      ];

      const p = spawn(OPENCLAW_CLI, args, { cwd: WORKSPACE_ROOT, stdio: ["ignore", "pipe", "pipe"] });
      let stdout = "";
      let stderr = "";
      for await (const chunk of p.stdout) stdout += chunk.toString("utf8");
      for await (const chunk of p.stderr) stderr += chunk.toString("utf8");
      const code = await new Promise((resolve) => p.on("close", resolve));
      if (code !== 0) {
        throw new Error(`openclaw agent failed (${code}): ${stderr.slice(0, 500)}`);
      }

      const json = JSON.parse(stdout.trim() || "{}");
      const result = json?.result ?? json;
      const stopReason = result?.meta?.stopReason;

      // openclaw output shape differs by version; handle the common agent shape first.
      const payloadText = Array.isArray(result?.payloads) ? result.payloads?.[0]?.text : null;
      const assistantText =
        payloadText ||
        result?.reply?.content?.[0]?.text ||
        result?.reply?.content?.[0]?.text ||
        result?.reply?.text ||
        result?.content?.[0]?.text ||
        result?.message?.content?.[0]?.text ||
        result?.text ||
        "";

      const assistantTrim = String(assistantText || "").trim();
      const looksLikeProviderError = /API error|Ollama API error/i.test(assistantTrim);
      if (!assistantTrim || stopReason === "error" || looksLikeProviderError) {
        throw new Error(`openclaw agent run failed: stopReason=${stopReason} text=${assistantTrim.slice(0, 200)}`);
      }

      return assistantTrim;
    } catch (err) {
      lastErr = err instanceof Error ? err : new Error(String(err));
    }
  }

  throw lastErr || new Error("openclaw agent failed for all fallbacks");
}

function parseEmailRequest(assistantText) {
  if (!assistantText || typeof assistantText !== "string") return null;
  const idx = assistantText.indexOf("EMAIL_REQUEST_JSON");
  if (idx === -1) return null;
  const after = assistantText.slice(idx + "EMAIL_REQUEST_JSON".length).trim();
  const firstBrace = after.indexOf("{");
  const lastBrace = after.lastIndexOf("}");
  if (firstBrace === -1 || lastBrace === -1 || lastBrace <= firstBrace) return null;
  const jsonStr = after.slice(firstBrace, lastBrace + 1);
  const obj = JSON.parse(jsonStr);
  if (!obj?.to || !obj?.subject || !obj?.body) return null;
  return obj;
}

async function sendWhatsAppToSteve(text) {
  // Use a restricted backend agent so the model can't run file/exec tools.
  // We still force the content to be exactly the approval text.
  const quoted = text.replace(/\\/g, "\\\\").replace(/`/g, "\\`");
  const message = `Return exactly this message:\n\`\`\`\n${quoted}\n\`\`\``;

  const tryAgentIds = [STEWARD_NOTIFY_AGENT_ID, STEWARD_NOTIFY_AGENT_ID_OPENAI];
  let lastErr = null;

  for (const agentId of tryAgentIds) {
    try {
      const args = [
        "agent",
        "--agent",
        agentId,
        "--local",
        "--thinking",
        "off",
        "--deliver",
        "--channel",
        "whatsapp",
        "--to",
        STEVE_WHATSAPP_E164,
        "--json",
        "--message",
        message,
      ];

      const p = spawn(OPENCLAW_CLI, args, { cwd: WORKSPACE_ROOT, stdio: ["ignore", "pipe", "pipe"] });
      let stdout = "";
      let stderr = "";
      for await (const chunk of p.stdout) stdout += chunk.toString("utf8");
      for await (const chunk of p.stderr) stderr += chunk.toString("utf8");
      const code = await new Promise((resolve) => p.on("close", resolve));
      if (code !== 0) {
        throw new Error(`openclaw whatsapp send failed (${code}): ${stderr.slice(0, 500)}`);
      }

      const json = JSON.parse(stdout.trim() || "{}");
      const stopReason = json?.result?.meta?.stopReason;
      if (stopReason === "error") {
        throw new Error(`steward notify agent returned stopReason=error for ${agentId}`);
      }

      return { agentIdUsed: agentId, raw: stdout };
    } catch (err) {
      lastErr = err instanceof Error ? err : new Error(String(err));
    }
  }

  throw lastErr || new Error("Failed to send WhatsApp approval request");
}

async function waitForSteveApproval({ code, stewardAgentId, timeoutMs = 180000 }) {
  let sessionFile = null;
  const started = Date.now();
  let lastLen = 0;
  const approvalNeedle = `APPROVE ${code}`.toLowerCase();
  const rejectNeedle = `REJECT ${code}`.toLowerCase();

  while (Date.now() - started < timeoutMs) {
    await new Promise((r) => setTimeout(r, 2500));
    let content;
    try {
      if (!sessionFile) {
        sessionFile = await getSteveSessionFile(stewardAgentId);
        try {
          lastLen = fs.readFileSync(sessionFile, "utf8").length;
        } catch {
          lastLen = 0;
        }
      }

      content = fs.readFileSync(sessionFile, "utf8");
    } catch {
      continue;
    }
    if (content.length === lastLen) continue;
    lastLen = content.length;

    const lines = content.split("\n").filter(Boolean);
    const lastLines = lines.slice(-200); // recent window
    for (const line of lastLines) {
      try {
        const ev = JSON.parse(line);
        const body = ev?.message?.content?.[0]?.text;
        if (typeof body !== "string") continue;
        const b = body.toLowerCase();
        if (b.includes(approvalNeedle)) return { approved: true, raw: body };
        if (b.includes(rejectNeedle)) return { approved: false, raw: body };
      } catch {
        // Ignore non-JSON lines.
      }
    }
  }

  return { approved: false, raw: null, timeout: true };
}

async function sendGmailViaGog({ to, subject, body }) {
  const args = [
    "gmail",
    "send",
    "--account",
    GOG_ACCOUNT,
    "--to",
    to,
    "--subject",
    subject,
    "--body-file",
    "-",
  ];

  // If OPENCLAW_CLI is overridden to a path (e.g. a venv/bin/openclaw),
  // prefer a sibling `gog` binary in the same folder; otherwise rely on PATH.
  const gogCli =
    OPENCLAW_CLI === "openclaw" ? "gog" : path.join(path.dirname(OPENCLAW_CLI), "gog");
  const p = spawn(gogCli, args, {
    cwd: WORKSPACE_ROOT,
    stdio: ["pipe", "pipe", "pipe"],
  });

  p.stdin.write(body);
  p.stdin.end();

  let stdout = "";
  let stderr = "";
  for await (const chunk of p.stdout) stdout += chunk.toString("utf8");
  for await (const chunk of p.stderr) stderr += chunk.toString("utf8");
  const code = await new Promise((resolve) => p.on("close", resolve));
  if (code !== 0) {
    throw new Error(`gog gmail send failed (${code}): ${stderr.slice(0, 500)}`);
  }
  return { stdout };
}

function randomCode(len = 6) {
  const alphabet = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
  let out = "";
  for (let i = 0; i < len; i++) out += alphabet[Math.floor(Math.random() * alphabet.length)];
  return out;
}

async function handleTurn(transcript) {
  const assistantText = await openclawAgentTurn({ transcript });
  const emailReq = parseEmailRequest(assistantText);

  if (!emailReq) {
    const tts = await elevenLabsTts(assistantText);
    return { assistantText, audioBase64: tts.audioBase64, mime: tts.mime };
  }

  const code = randomCode(6);
  const previewBody = String(emailReq.body || "").slice(0, 2500);

  const approvalMessage = [
    `EMAIL_APPROVAL_REQUEST ${code}`,
    "",
    `To: ${emailReq.to}`,
    `Subject: ${emailReq.subject}`,
    "",
    previewBody ? "Body preview:" : "Body:",
    previewBody,
    "",
    "Reply with exactly:",
    `APPROVE ${code}`,
    `or`,
    `REJECT ${code}`,
  ].join("\n");

  const { agentIdUsed } = await sendWhatsAppToSteve(approvalMessage);
  const approval = await waitForSteveApproval({ code, stewardAgentId: agentIdUsed });

  if (approval.approved) {
    await sendGmailViaGog({
      to: emailReq.to,
      subject: emailReq.subject,
      body: String(emailReq.body || ""),
    });
    const spoken = "Okay. Steve approved it, and I sent the email.";
    const tts = await elevenLabsTts(spoken);
    return { assistantText: spoken, audioBase64: tts.audioBase64, mime: tts.mime };
  }

  if (approval.timeout) {
    const spoken = "I waited, but I didn't receive approval in time. I didn't send the email.";
    const tts = await elevenLabsTts(spoken);
    return { assistantText: spoken, audioBase64: tts.audioBase64, mime: tts.mime };
  }

  const spoken = "Steve rejected the email. I didn't send it.";
  const tts = await elevenLabsTts(spoken);
  return { assistantText: spoken, audioBase64: tts.audioBase64, mime: tts.mime };
}

async function readJsonBody(req) {
  const chunks = [];
  for await (const c of req) chunks.push(c);
  const buf = Buffer.concat(chunks);
  if (!buf.length) return {};
  return JSON.parse(buf.toString("utf8"));
}

const server = http.createServer(async (req, res) => {
  try {
    const url = new URL(req.url, `http://${req.headers.host}`);
    if (req.method === "GET" && (url.pathname === "/" || url.pathname === "/Neely" || url.pathname === "/Neely/")) {
      const file = url.pathname === "/" ? "index.html" : "neely.html";
      if (!fs.existsSync(path.join(WEB_ROOT, file))) {
        return jsonResponse(res, 404, { error: "Not found" });
      }
      const content = readFileSafe(file);
      res.writeHead(200, { "Content-Type": file.endsWith(".html") ? "text/html; charset=utf-8" : "application/octet-stream" });
      res.end(content);
      return;
    }

    if (req.method === "GET" && url.pathname === "/neely.js") {
      const content = readFileSafe("neely.js");
      res.writeHead(200, { "Content-Type": "application/javascript; charset=utf-8" });
      res.end(content);
      return;
    }

    const isTurnRoute = req.method === "POST" && (url.pathname === "/api/turn" || url.pathname === "/neely-api/turn");
    if (isTurnRoute) {
      const body = await readJsonBody(req);
      const { audioBase64, mimeType } = body || {};
      if (!audioBase64) return jsonResponse(res, 400, { error: "Missing audioBase64" });

      const audioBuffer = Buffer.from(audioBase64, "base64");
      const transcript = await elevenLabsTranscribe(audioBuffer, mimeType || "audio/webm");
      if (!transcript) return jsonResponse(res, 200, { assistantText: "(no speech detected)", audioBase64: null, mime: null });

      const out = await handleTurn(transcript);
      appendInteractionLog(transcript, out?.assistantText);
      return jsonResponse(res, 200, out);
    }

    return jsonResponse(res, 404, { error: "Not found" });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return jsonResponse(res, 500, { error: msg });
  }
});

server.listen(PORT, "127.0.0.1", () => {
  console.log(`Neely web voice server listening on http://127.0.0.1:${PORT}/Neely`);
});


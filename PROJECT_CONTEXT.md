# PROJECT_CONTEXT.md

## Current Architecture

- **Public website**: `https://neely.stevealper.com/` is served from GoDaddy/cPanel.
- **Public voice API**: the browser sends audio to `POST https://neely.stevealper.com/neely-api/turn`.
- **Routing**: Cloudflare Tunnel routes:
  - `/neely-api/turn` → local Mac backend `http://127.0.0.1:18790/neely-api/turn`
  - everything else → cPanel origin (GoDaddy) at `https://132.148.176.140:443`
- **Local backend (Mac)**: Node server at `~/.openclaw/workspace/web/server.mjs` listens on `127.0.0.1:18790` and:
  - serves local dev pages at `/Neely`
  - handles `POST /api/turn` and alias `POST /neely-api/turn`
  - does STT + TTS via ElevenLabs and runs the OpenClaw agent to produce responses
  - appends interaction logs to `~/Desktop/neely-webvoice-interactions.log` (JSONL)
- **Agent model routing**: backend attempts local Ollama agent first, then falls back to OpenAI agent on provider failure (agent IDs configured in `web/server.mjs` and `~/.openclaw/openclaw.json`).

## Technical Stack

- **Frontend**: plain HTML + CSS + vanilla JS (`index.html`, `neely.js`)
- **Backend**: Node.js (server is `web/server.mjs`)
- **AI orchestration**: OpenClaw CLI (`openclaw agent ...`) invoked by Node backend
- **STT/TTS**: ElevenLabs API (STT model `scribe_v2`; TTS model `eleven_multilingual_v2` via env vars)
- **Local LLM**: Ollama (preferred) with automatic OpenAI fallback where needed
- **Tunnel**: Cloudflare Tunnel via `cloudflared`
- **OS**: macOS (LaunchAgents / LaunchDaemons for always-on services)
- **Git**: repo pushed to GitHub remote `neelyoharabot-coder/openclaw-workspace`

## Manual Updates (what was cut/pasted to cPanel)

### cPanel document root

- cPanel subdomain docroot for `neely.stevealper.com` is:
  - `public_html/neely.stevealper.com/`

### Files uploaded to cPanel

- **`index.html`**: multiple iterations were manually pasted; current desired UX:
  - landing shows a **still poster** with a **large round play button**
  - clicking Play starts the intro video and hides the overlay
  - the orange **Talk to Neely** button remains near the bottom
- **`neely.js`**: frontend voice capture + send to `/neely-api/turn`.
- **`NeelyIntro.mp4`**: intro video in same folder as `index.html` / `neely.js`
- **`NeelyPoster.jpg`**: poster still used by the landing page

### Latest cPanel code (drop-in)

#### `index.html` (poster + play overlay)

```html
<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width,initial-scale=1" />
    <title>Chat with Neely</title>
    <style>
      body {
        font-family: system-ui, -apple-system, Segoe UI, Roboto, Ubuntu, Cantarell, Noto Sans, Arial;
        margin: 0;
        padding: 0;
        overflow: hidden;
        background: #000;
      }

      #stage {
        position: fixed;
        inset: 0;
        background: #000;
      }

      #bg {
        position: absolute;
        inset: 0;
        width: 100%;
        height: 100%;
        object-fit: cover;
        object-position: center;
        filter: brightness(0.8);
      }

      /* Big play overlay centered */
      #playOverlay {
        position: absolute;
        inset: 0;
        display: grid;
        place-items: center;
        z-index: 3;
        background: linear-gradient(to top, rgba(0, 0, 0, 0.35), rgba(0, 0, 0, 0.15));
      }

      #playBtn {
        width: 92px;
        height: 92px;
        border-radius: 999px;
        border: 2px solid rgba(255, 255, 255, 0.9);
        background: rgba(0, 0, 0, 0.45);
        cursor: pointer;
        position: relative;
        box-shadow: 0 16px 50px rgba(0, 0, 0, 0.45);
      }
      #playBtn::before {
        content: "";
        position: absolute;
        left: 36px;
        top: 27px;
        width: 0;
        height: 0;
        border-top: 18px solid transparent;
        border-bottom: 18px solid transparent;
        border-left: 26px solid rgba(255, 255, 255, 0.92);
      }

      /* Bottom controls */
      #overlay {
        position: fixed;
        inset: 0;
        display: flex;
        flex-direction: column;
        align-items: center;
        justify-content: flex-end;
        padding-bottom: 6vh;
        gap: 12px;
        z-index: 4;
        color: #fff;
        pointer-events: none;
      }
      #btn,
      #email {
        pointer-events: auto;
      }

      #btn {
        background: #ff7a00;
        color: #000;
        font-size: 18px;
        font-weight: 700;
        border: 0;
        border-radius: 10px;
        padding: 10px 14px;
        cursor: pointer;
        box-shadow: 0 8px 24px rgba(0, 0, 0, 0.35);
      }

      #email {
        color: #fff;
        font-weight: 600;
        text-decoration: underline;
        background: rgba(0, 0, 0, 0.35);
        padding: 8px 12px;
        border-radius: 12px;
      }

      #status {
        display: none;
      }

      audio {
        display: none;
      }
    </style>
  </head>

  <body>
    <div id="stage">
      <video
        id="bg"
        src="NeelyIntro.mp4"
        preload="auto"
        playsinline
        webkit-playsinline
        muted
        poster="NeelyPoster.jpg"
      ></video>

      <div id="playOverlay" role="button" aria-label="Play video">
        <button id="playBtn" type="button" aria-label="Play"></button>
      </div>
    </div>

    <div id="overlay">
      <button id="btn" type="button">Talk to Neely</button>
      <a id="email" href="mailto:NeelyOhara.Bot@Gmail.com">NeelyOhara.Bot@Gmail.com</a>
      <div id="status"></div>
    </div>

    <audio id="audio" controls autoplay></audio>

    <script>
      const bg = document.getElementById("bg");
      const playOverlay = document.getElementById("playOverlay");

      function hideOverlay() {
        playOverlay.style.display = "none";
      }

      bg.addEventListener("playing", hideOverlay);

      async function startVideo() {
        try {
          bg.muted = true;
          bg.volume = 1;

          try { bg.load(); } catch {}

          await bg.play();
          hideOverlay();

          setTimeout(() => {
            try {
              bg.muted = false;
              bg.volume = 1;
            } catch {}
          }, 250);
        } catch (e) {
          console.log("Video play failed:", e);
          try { bg.controls = true; } catch {}
        }
      }

      playOverlay.addEventListener("click", (e) => {
        e.preventDefault();
        startVideo();
      });

      playOverlay.addEventListener("touchend", (e) => {
        e.preventDefault();
        startVideo();
      }, { passive: false });
    </script>

    <script type="module" src="neely.js"></script>
  </body>
</html>
```

#### `neely.js` (Safari WAV fallback “one turn”)

```javascript
const btn = document.getElementById("btn");
const statusEl = document.getElementById("status");
const audioEl = document.getElementById("audio");

function setStatus(msg) {
  const m = msg ? String(msg) : "";
  statusEl.textContent = m;
  statusEl.style.display = m ? "block" : "none";
  statusEl.style.maxWidth = "780px";
  statusEl.style.background = "rgba(0,0,0,0.45)";
  statusEl.style.border = "1px solid rgba(255,255,255,0.15)";
  statusEl.style.padding = "10px 14px";
  statusEl.style.borderRadius = "12px";
  statusEl.style.textAlign = "center";
}

function blobToBase64(blob) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onerror = () => reject(reader.error);
    reader.onload = () => resolve(String(reader.result).split(",")[1]);
    reader.readAsDataURL(blob);
  });
}

async function sendTurn({ audioBlob, mimeType }) {
  const audioBase64 = await blobToBase64(audioBlob);
  const res = await fetch("/neely-api/turn", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ audioBase64, mimeType }),
  });
  const json = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(json.error || `Turn failed (${res.status})`);
  return json;
}

function floatTo16BitPCM(float32) {
  const out = new Int16Array(float32.length);
  for (let i = 0; i < float32.length; i++) {
    let s = Math.max(-1, Math.min(1, float32[i]));
    out[i] = s < 0 ? s * 0x8000 : s * 0x7fff;
  }
  return out;
}

function writeWav({ samplesInt16, sampleRate }) {
  const numChannels = 1;
  const bytesPerSample = 2;
  const blockAlign = numChannels * bytesPerSample;
  const byteRate = sampleRate * blockAlign;
  const dataSize = samplesInt16.length * bytesPerSample;

  const buffer = new ArrayBuffer(44 + dataSize);
  const view = new DataView(buffer);
  const writeStr = (off, s) => { for (let i = 0; i < s.length; i++) view.setUint8(off + i, s.charCodeAt(i)); };

  writeStr(0, "RIFF");
  view.setUint32(4, 36 + dataSize, true);
  writeStr(8, "WAVE");
  writeStr(12, "fmt ");
  view.setUint32(16, 16, true);
  view.setUint16(20, 1, true);
  view.setUint16(22, numChannels, true);
  view.setUint32(24, sampleRate, true);
  view.setUint32(28, byteRate, true);
  view.setUint16(32, blockAlign, true);
  view.setUint16(34, 16, true);
  writeStr(36, "data");
  view.setUint32(40, dataSize, true);

  let off = 44;
  for (let i = 0; i < samplesInt16.length; i++, off += 2) view.setInt16(off, samplesInt16[i], true);

  return new Blob([buffer], { type: "audio/wav" });
}

let micStream = null;
let running = false;

async function recordOnceWithMediaRecorder(ms = 6500) {
  micStream = await navigator.mediaDevices.getUserMedia({ audio: true });
  const candidates = ["audio/webm;codecs=opus", "audio/webm", "audio/ogg;codecs=opus", "audio/ogg"];
  const mimeType = candidates.find((c) => MediaRecorder.isTypeSupported?.(c)) || "";
  const rec = mimeType ? new MediaRecorder(micStream, { mimeType }) : new MediaRecorder(micStream);
  const chunks = [];
  rec.ondataavailable = (e) => e.data && e.data.size > 0 && chunks.push(e.data);
  const stopped = new Promise((resolve) => (rec.onstop = resolve));
  rec.start();
  await new Promise((r) => setTimeout(r, ms));
  try { if (rec.state !== "inactive") rec.stop(); } catch {}
  await stopped;
  const blob = new Blob(chunks, { type: mimeType || "audio/webm" });
  return { blob, mimeType: mimeType || blob.type };
}

async function recordOnceWithWavFallback(ms = 6500) {
  micStream = await navigator.mediaDevices.getUserMedia({ audio: true });
  const audioCtx = new (window.AudioContext || window.webkitAudioContext)();
  const src = audioCtx.createMediaStreamSource(micStream);
  const processor = audioCtx.createScriptProcessor(4096, 1, 1);
  const chunks = [];
  let total = 0;
  processor.onaudioprocess = (e) => {
    const input = e.inputBuffer.getChannelData(0);
    chunks.push(new Float32Array(input));
    total += input.length;
  };
  src.connect(processor);
  processor.connect(audioCtx.destination);
  await new Promise((r) => setTimeout(r, ms));
  try { processor.disconnect(); src.disconnect(); } catch {}
  try { await audioCtx.close(); } catch {}
  const merged = new Float32Array(total);
  let off = 0;
  for (const c of chunks) { merged.set(c, off); off += c.length; }
  const wav = writeWav({ samplesInt16: floatTo16BitPCM(merged), sampleRate: 44100 });
  return { blob: wav, mimeType: "audio/wav" };
}

function stop() {
  running = false;
  btn.textContent = "Talk to Neely";
  if (micStream) micStream.getTracks().forEach((t) => t.stop());
  micStream = null;
}

btn.addEventListener("click", async () => {
  try {
    if (running) {
      stop();
      setStatus("");
      return;
    }

    running = true;
    btn.textContent = "End Chat";
    setStatus("");

    const useMR = typeof window.MediaRecorder !== "undefined";
    const { blob, mimeType } = useMR ? await recordOnceWithMediaRecorder() : await recordOnceWithWavFallback();

    const json = await sendTurn({ audioBlob: blob, mimeType });
    if (json.audioBase64) {
      const mime = json.mime || "audio/mpeg";
      audioEl.src = `data:${mime};base64,${json.audioBase64}`;
      await audioEl.play().catch(() => {});
    }

    stop();
    setStatus("");
  } catch (err) {
    stop();
    setStatus(err?.message || String(err));
  }
});

setStatus("");
```

### Desktop “cpanel” helper files created

- `~/Desktop/cpanel_neely_index.html`
- `~/Desktop/cpanel_neely.js`
- `~/Desktop/neely_index.html.txt` (full HTML to paste)
- `~/Desktop/cpanel_NeelyIntro_upload_instructions.txt`

## Cloudflare Tunnel Local Management (current state)

- DNS for the subdomain exists and points to the tunnel:
  - CNAME target format used: `{TUNNEL_ID}.cfargotunnel.com` where tunnel id is `c3f6946a-7093-4a5c-b3b1-f0ecc9ae22e9`
- Cloudflare edge HTTPS redirect is working:
  - `http://neely.stevealper.com` → `https://neely.stevealper.com`
- **cloudflared is forced to use HTTP/2** to avoid `ERR_QUIC_PROTOCOL_ERROR`:
  - LaunchAgent edited to include `--protocol http2`
- cloudflared is running as a **user LaunchAgent** (not a system LaunchDaemon).
- `~/.cloudflared/config.yml` ingress rules (critical details):
  - `/neely-api/turn` routed to `http://127.0.0.1:18790`
  - catch-all routed to cPanel origin with:
    - `originRequest.httpHostHeader = neely.stevealper.com`
    - `originRequest.originServerName = neely.stevealper.com`
    - `originRequest.noTLSVerify = true` (needed because origin TLS verification failed otherwise)

## Project State

### 100% working

- **Tunnel connectivity**:
  - `GET https://neely.stevealper.com/` returns `200` (served from cPanel through tunnel fallback)
  - `POST https://neely.stevealper.com/neely-api/turn` reaches the Mac backend (returns `400 Missing audioBase64` when tested with `{}`)
- **cloudflared stability**:
  - QUIC errors mitigated by forcing `--protocol http2`
- **Local backend**:
  - `http://127.0.0.1:18790/Neely` returns `200`
  - `POST /api/turn` and `POST /neely-api/turn` are handled by `web/server.mjs`
- **Git**:
  - changes committed and pushed to GitHub (`main` branch)

### In-progress / broken

- **Safari video playback**:
  - On Safari (iPhone + macOS), clicking Play previously produced a dark screen with the “muted speaker” indicator (audio-only/black), consistent with Safari rejecting the old MP4 encode.
  - A Safari-safe re-encode was created locally: `~/Desktop/NeelyIntro_Safari.mp4` using H.264 Constrained Baseline + faststart; needs reliable upload + cache purge verification.
- **Safari voice conversation**:
  - The orange “Talk to Neely” button works inconsistently; likely due to **MediaRecorder** not being supported/reliable on Safari/iOS.
  - Need to switch frontend to a WAV fallback recorder (WebAudio/ScriptProcessor) or a different capture approach for Safari.

## Next Steps (what we were about to do)

1. **Confirm Safari-safe MP4 is live**
   - Upload `NeelyIntro_Safari.mp4` to cPanel docroot and overwrite/rename to `NeelyIntro.mp4`
   - Verify headers changed (content-length/last-modified) and that Safari is not serving cached old MP4
2. **Purge caches**
   - Purge Cloudflare cache for `NeelyIntro.mp4` (and optionally `index.html`, `neely.js`)
   - Clear Safari website data for `neely.stevealper.com` (iPhone + macOS)
3. **Finalize landing page behavior**
   - Keep poster + play overlay UX
   - Ensure Play overlay starts video on Safari; if needed, allow native controls or adjust play sequencing
4. **Fix “Talk to Neely” on Safari**
   - Replace `neely.js` with Safari-safe recorder fallback (WAV) and verify end-to-end: record → POST `/neely-api/turn` → receive TTS audio → play
5. **Ollama stability work**
   - After web surface is stable, revisit Ollama context allocation / model config issues and improve local-first behavior.

## Prompt to Use in the New Chat

Copy/paste this as your first message in the new chat:

“Read `PROJECT_CONTEXT.md` in the workspace root. We have `neely.stevealper.com` working through Cloudflare Tunnel (`/neely-api/turn` → Mac backend), but Safari still fails video playback and the ‘Talk to Neely’ button doesn’t produce a conversation on Safari (MediaRecorder issues). Next: verify the Safari-safe re-encoded MP4 is actually being served (headers/content-length), purge Cloudflare + Safari caches, then update the cPanel `index.html` play-overlay logic if needed and replace `neely.js` with a Safari WAV fallback recorder so the orange button works on iPhone/macOS Safari.”


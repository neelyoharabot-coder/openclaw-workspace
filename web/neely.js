const btn = document.getElementById("btn");
const statusEl = document.getElementById("status");
const audioEl = document.getElementById("audio");

function setStatus(msg) {
  statusEl.textContent = msg;
}

function rmsFromTimeDomainData(data) {
  // data is Uint8Array in [0..255]. Map to [-1..1] and compute RMS.
  let sumSq = 0;
  for (let i = 0; i < data.length; i++) {
    const v = (data[i] - 128) / 128;
    sumSq += v * v;
  }
  return Math.sqrt(sumSq / data.length);
}

function blobToBase64(blob) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onerror = () => reject(reader.error);
    reader.onload = () => {
      const res = reader.result;
      // res is `data:<mime>;base64,<data>`
      const b64 = String(res).split(",")[1];
      resolve(b64);
    };
    reader.readAsDataURL(blob);
  });
}

async function sendTurn({ audioBlob, mimeType }) {
  setStatus("Listening -> sending to Neely...");
  const audioBase64 = await blobToBase64(audioBlob);
  const res = await fetch("/neely-api/turn", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ audioBase64, mimeType }),
  });
  const json = await res.json();
  if (!res.ok) throw new Error(json.error || "Turn failed");
  return json;
}

function chooseRecorderMimeType() {
  const candidates = [
    "audio/webm;codecs=opus",
    "audio/webm",
    "audio/ogg;codecs=opus",
    "audio/ogg",
  ];
  for (const c of candidates) {
    if (window.MediaRecorder && MediaRecorder.isTypeSupported && MediaRecorder.isTypeSupported(c)) return c;
  }
  return "";
}

let micStream = null;
let audioCtx = null;
let analyser = null;
let dataArray = null;
let rafId = null;

let recorder = null;
let recorderMimeType = "";
let chunks = [];
let isRecording = false;
let lastSpeechAt = 0;
let silenceSince = null;

// “push-to-talk disguised as auto-VAD”: we only record while speech is likely.
const RMS_THRESHOLD = 0.02; // tune for your mic/environment
const SILENCE_HOLD_MS = 700;
const MAX_UTTERANCE_MS = 20000;

async function start() {
  if (micStream) return;
  micStream = await navigator.mediaDevices.getUserMedia({ audio: true });

  audioCtx = new (window.AudioContext || window.webkitAudioContext)();
  const source = audioCtx.createMediaStreamSource(micStream);
  analyser = audioCtx.createAnalyser();
  analyser.fftSize = 2048;
  source.connect(analyser);
  dataArray = new Uint8Array(analyser.fftSize);

  recorderMimeType = chooseRecorderMimeType();
  setStatus("Microphone ready. When you speak, I will respond.");
  btn.textContent = "End Chat";

  const tick = () => {
    if (!analyser) return;
    analyser.getByteTimeDomainData(dataArray);
    const rms = rmsFromTimeDomainData(dataArray);

    const now = Date.now();
    const isSpeechLikely = rms > RMS_THRESHOLD;

    if (isSpeechLikely) {
      lastSpeechAt = now;
      silenceSince = null;
      if (!isRecording) {
        chunks = [];
        recorder = recorderMimeType
          ? new MediaRecorder(micStream, { mimeType: recorderMimeType })
          : new MediaRecorder(micStream);
        isRecording = true;
        recorder.ondataavailable = (e) => {
          if (e.data && e.data.size > 0) chunks.push(e.data);
        };
        recorder.onstop = async () => {
          isRecording = false;
          const blob = new Blob(chunks, { type: recorderMimeType || "audio/webm" });
          chunks = [];
          setStatus("Transcribing and thinking...");
          try {
            const json = await sendTurn({ audioBlob: blob, mimeType: recorderMimeType || blob.type });
            // Show assistant text status for debugging/confirmation
            const a = String(json.assistantText || "").trim();
            if (a) setStatus(a.length > 220 ? a.slice(0, 220) + "…" : a);
            if (json.audioBase64) {
              const mime = json.mime || "audio/mpeg";
              audioEl.src = `data:${mime};base64,${json.audioBase64}`;
              await audioEl.play().catch(() => {});
            }
            setStatus("Microphone ready. Speak when you want.");
          } catch (err) {
            const m = err?.message || String(err);
            // Friendly offline/failure message
            if (/Failed to fetch|ECONNRESET|503|502|Bad Gateway|offline|down|ENOTFOUND/i.test(m)) {
              setStatus("Neely is down. Try later…");
            } else {
              setStatus("Error: " + m);
            }
            // Stop the session on fatal errors so the button can reset.
            stopLocalVAD();
          }
        };

        recorder.start();
        // Safety: cap utterance duration so we never record forever.
        setTimeout(() => {
          if (isRecording && recorder && recorder.state !== "inactive") {
            recorder.stop();
          }
        }, MAX_UTTERANCE_MS);
      }
    } else {
      if (isRecording && silenceSince === null) silenceSince = now;
      if (isRecording && silenceSince !== null && now - silenceSince > SILENCE_HOLD_MS) {
        if (recorder && recorder.state !== "inactive") recorder.stop();
      }
    }

    rafId = requestAnimationFrame(tick);
  };

  rafId = requestAnimationFrame(tick);
}

function stopLocalVAD() {
  if (rafId) cancelAnimationFrame(rafId);
  rafId = null;
  if (recorder && recorder.state !== "inactive") recorder.stop();
  isRecording = false;
  chunks = [];
  if (micStream) {
    micStream.getTracks().forEach((t) => t.stop());
  }
  micStream = null;
  analyser = null;
  dataArray = null;
  if (audioCtx) audioCtx.close().catch(() => {});
  audioCtx = null;
  btn.textContent = "Talk to Neely";
  setStatus("Stopped. Click “Talk to Neely” and speak.");
}

btn.addEventListener("click", async () => {
  try {
    if (micStream) stopLocalVAD();
    else await start();
  } catch (err) {
    setStatus("Microphone error: " + (err?.message || String(err)));
    btn.textContent = "Talk to Neely";
  }
});

setStatus("Ready. Click “Talk to Neely” and speak.");


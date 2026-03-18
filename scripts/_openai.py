import json
import os
import urllib.request
from pathlib import Path
from typing import Any, Optional


def _load_openai_token_from_openclaw_store() -> Optional[str]:
    # Prefer env var if present (useful outside OpenClaw daemon).
    token = os.environ.get("OPENAI_API_KEY")
    if token:
        return token.strip()

    store = Path.home() / ".openclaw" / "agents" / "main" / "agent" / "auth-profiles.json"
    try:
        data = json.loads(store.read_text(encoding="utf-8"))
        prof = (data.get("profiles") or {}).get("openai:default") or {}
        token = prof.get("token")
        if isinstance(token, str) and token.strip():
            return token.strip()
    except Exception:
        return None
    return None


def openai_responses(
    *,
    model: str,
    input_text: str,
    max_output_tokens: int = 600,
) -> str:
    token = _load_openai_token_from_openclaw_store()
    if not token:
        raise RuntimeError("OpenAI token unavailable (OPENAI_API_KEY or openclaw auth store).")

    payload: dict[str, Any] = {
        "model": model,
        "input": input_text,
        "max_output_tokens": max_output_tokens,
    }

    req = urllib.request.Request(
        "https://api.openai.com/v1/responses",
        data=json.dumps(payload).encode("utf-8"),
        headers={
            "Authorization": f"Bearer {token}",
            "Content-Type": "application/json",
        },
        method="POST",
    )
    with urllib.request.urlopen(req, timeout=25) as resp:
        body = resp.read().decode("utf-8")
    data = json.loads(body)
    # Best-effort extract
    out_text = ""
    for item in data.get("output", []) or []:
        for c in item.get("content", []) or []:
            if c.get("type") in ("output_text", "text") and isinstance(c.get("text"), str):
                out_text += c["text"]
    return out_text.strip()


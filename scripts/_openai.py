import json
import os
import urllib.error
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


def _extract_chat_completion_text(data: dict[str, Any]) -> str:
    """Parse /v1/chat/completions response."""
    choices = data.get("choices") or []
    if not choices:
        return ""
    msg = choices[0].get("message") or {}
    content = msg.get("content")
    if isinstance(content, str) and content.strip():
        return content.strip()
    # Multimodal / structured content blocks
    if isinstance(content, list):
        parts: list[str] = []
        for block in content:
            if not isinstance(block, dict):
                continue
            if block.get("type") == "text" and isinstance(block.get("text"), str):
                parts.append(block["text"])
            elif isinstance(block.get("text"), str):
                parts.append(block["text"])
        return "".join(parts).strip()
    return ""


def _extract_responses_api_text(data: dict[str, Any]) -> str:
    """Parse /v1/responses output (GPT-5–style Responses API)."""
    out_text = ""
    for item in data.get("output", []) or []:
        for c in item.get("content", []) or []:
            if c.get("type") in ("output_text", "text") and isinstance(c.get("text"), str):
                out_text += c["text"]
    return out_text.strip()


def _post_json(url: str, payload: dict[str, Any], token: str, timeout: int = 60) -> dict[str, Any]:
    req = urllib.request.Request(
        url,
        data=json.dumps(payload).encode("utf-8"),
        headers={
            "Authorization": f"Bearer {token}",
            "Content-Type": "application/json",
        },
        method="POST",
    )
    with urllib.request.urlopen(req, timeout=timeout) as resp:
        return json.loads(resp.read().decode("utf-8"))


def openai_responses(
    *,
    model: str,
    input_text: str,
    max_output_tokens: int = 600,
) -> str:
    """
    Call OpenAI for plain text. Uses Chat Completions first (/v1/chat/completions + messages);
    falls back to Responses API (/v1/responses + input) if chat returns empty or errors, so
    frontier models keep working either way.
    """
    token = _load_openai_token_from_openclaw_store()
    if not token:
        raise RuntimeError("OpenAI token unavailable (OPENAI_API_KEY or openclaw auth store).")

    prefer_responses = os.environ.get("OPENAI_PREFER_RESPONSES_API", "").strip().lower() in (
        "1",
        "true",
        "yes",
    )

    def try_responses() -> str:
        payload: dict[str, Any] = {
            "model": model,
            "input": input_text,
            "max_output_tokens": max_output_tokens,
        }
        data = _post_json(
            "https://api.openai.com/v1/responses", payload, token
        )
        return _extract_responses_api_text(data)

    def try_chat() -> str:
        payload: dict[str, Any] = {
            "model": model,
            "messages": [{"role": "user", "content": input_text}],
        }
        if max_output_tokens and max_output_tokens > 0:
            payload["max_completion_tokens"] = max_output_tokens
        try:
            data = _post_json(
                "https://api.openai.com/v1/chat/completions", payload, token
            )
        except urllib.error.HTTPError as e:
            body = e.read().decode("utf-8", errors="replace")
            # Older models sometimes want max_tokens instead
            if e.code == 400 and "max_completion_tokens" in body.lower():
                payload.pop("max_completion_tokens", None)
                if max_output_tokens and max_output_tokens > 0:
                    payload["max_tokens"] = max_output_tokens
                data = _post_json(
                    "https://api.openai.com/v1/chat/completions", payload, token
                )
            else:
                raise
        return _extract_chat_completion_text(data)

    order = ["responses", "chat"] if prefer_responses else ["chat", "responses"]
    errors: list[str] = []

    for name in order:
        try:
            t = try_responses() if name == "responses" else try_chat()
            if t:
                return t
            errors.append(f"{name}:empty_output")
        except Exception as ex:
            errors.append(f"{name}:{type(ex).__name__}:{str(ex)[:220]}")

    raise RuntimeError("OpenAI returned no text. " + " | ".join(errors))

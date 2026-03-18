#!/usr/bin/env python3
"""
Neely email autopilot: auto-reply to every inbound unread (not yet labeled neely/replied).
- If the message can be answered without hallucinating → template or AI reply.
- If not → email the Steward (Steve) with full context + send sender a safe deferral.
"""

import datetime as dt
import json
import os
import re
from email.utils import parseaddr
from pathlib import Path

from _gog import ensure_label, run_gog_json, run_gog_plain
from _openai import openai_responses

ACCOUNT = os.environ.get("GOG_ACCOUNT", "neelyohara.bot@gmail.com")
REPLIED_LABEL = os.environ.get("NEELY_REPLIED_LABEL", "neely/replied")
LOG_DIR = Path(
    os.environ.get(
        "NEELY_EMAIL_LOG_DIR",
        str(Path.home() / ".openclaw" / "workspace" / "memory" / "email"),
    )
)
ESCALATE_MODEL = os.environ.get("NEELY_EMAIL_ESCALATE_MODEL", "gpt-5.4")
STEWARD_EMAIL = os.environ.get("NEELY_STEWARD_EMAIL", "steve@lasthouse.la")
BODY_PREVIEW_MAX = 8000
DESKTOP_LOG = Path(
    os.environ.get("NEELY_DESKTOP_LOG", str(Path.home() / "Desktop" / "NeelyEmailLog"))
)
DESKTOP_PREVIEW_CHARS = 1200


def now_local() -> dt.datetime:
    return dt.datetime.now().astimezone()


def iso(ts: dt.datetime) -> str:
    return ts.isoformat(timespec="seconds")


def append_log(line: str) -> None:
    LOG_DIR.mkdir(parents=True, exist_ok=True)
    day = now_local().date().isoformat()
    path = LOG_DIR / f"{day}.log"
    with path.open("a", encoding="utf-8") as f:
        f.write(line.rstrip("\n") + "\n")


def _desktop_write_header_if_needed() -> None:
    if DESKTOP_LOG.exists() and DESKTOP_LOG.stat().st_size > 0:
        return
    DESKTOP_LOG.parent.mkdir(parents=True, exist_ok=True)
    DESKTOP_LOG.write_text(
        "Neely — Email log (each inbound message + Neely’s reply)\n"
        "Updated automatically when email_autopilot runs.\n\n",
        encoding="utf-8",
    )


def append_desktop_roundtrip(
    *,
    msg_id: str,
    from_header: str,
    to_header: str,
    subject: str,
    incoming_body: str,
    reply_to_email: str,
    reply_kind: str,
    reply_body: str,
    steward_notified: bool,
) -> None:
    try:
        DESKTOP_LOG.parent.mkdir(parents=True, exist_ok=True)
    except OSError:
        return
    ts = now_local().strftime("%Y-%m-%d %H:%M:%S %Z")
    prev = (incoming_body or "").strip()
    if len(prev) > DESKTOP_PREVIEW_CHARS:
        prev = prev[:DESKTOP_PREVIEW_CHARS] + "\n  [... truncated ...]"
    prev_indented = "\n".join("  " + ln for ln in prev.splitlines()) or "  (empty)"
    body_indented = "\n".join("  " + ln for ln in (reply_body or "").strip().splitlines())

    block = f"""{'=' * 72}
{ts}

RECEIVED
  Gmail message id: {msg_id}
  From:    {from_header}
  To:      {to_header}
  Subject: {subject}

  Their message:
{prev_indented}

RESPONSE  ({reply_kind})
  Sent to: {reply_to_email}
  Subject: Re: {subject}

  Neely’s reply:
{body_indented}
"""
    if steward_notified:
        block += f"\n  → Steward copy also sent to: {STEWARD_EMAIL}\n"
    block += "\n"

    try:
        _desktop_write_header_if_needed()
        with DESKTOP_LOG.open("a", encoding="utf-8") as f:
            f.write(block)
    except OSError:
        pass


def append_desktop_skip(
    *,
    msg_id: str,
    from_header: str,
    subject: str,
    incoming_body: str,
    reason: str,
) -> None:
    try:
        DESKTOP_LOG.parent.mkdir(parents=True, exist_ok=True)
    except OSError:
        return
    ts = now_local().strftime("%Y-%m-%d %H:%M:%S %Z")
    prev = (incoming_body or "").strip()[:DESKTOP_PREVIEW_CHARS]
    try:
        _desktop_write_header_if_needed()
        with DESKTOP_LOG.open("a", encoding="utf-8") as f:
            f.write(
                f"""{'=' * 72}
{ts}

RECEIVED (no reply sent)
  Gmail message id: {msg_id}
  From:    {from_header}
  Subject: {subject}
  Reason:  {reason}

  Their message (preview):
{chr(10).join("  " + ln for ln in prev.splitlines())}

""")
    except OSError:
        pass


def build_reply_body(from_header: str, subject: str) -> str:
    return (
        "Hi — thanks for reaching out.\n\n"
        "I received your email and will follow up as soon as I can.\n\n"
        "— Neely\n"
    )


def build_deferral_body() -> str:
    return (
        "Hi — thanks for your message.\n\n"
        "I need to confirm a few details before I can give you a reliable answer. "
        "I'll follow up as soon as I've got that straight.\n\n"
        "— Neely\n"
    )


def is_no_reply_or_automated_sender(email: str, from_header: str) -> bool:
    """Do not auto-reply to transactional / no-reply addresses."""
    e = (email or "").lower()
    h = (from_header or "").lower()
    if not e and not h:
        return False
    bad_local = (
        "no-reply",
        "noreply",
        "donotreply",
        "do-not-reply",
        "mailer-daemon",
        "postmaster",
        "bounce",
        "bounces",
        "notification",
        "notifications@",
        "automated",
    )
    for p in bad_local:
        if p in e or p in h:
            return True
    if e.startswith("no-reply@") or e.startswith("noreply@"):
        return True
    return False


def asks_identity_or_intro(subject: str, body: str) -> bool:
    """Name / who are you — answer as Neely, not the generic ack."""
    t = f"{subject}\n{body}".lower()
    patterns = [
        r"what\s*('?s| is)\s+your\s+name",
        r"who\s+are\s+you",
        r"introduce\s+yourself",
        r"\bwhat\s+do\s+(we|i)\s+call\s+you\b",
        r"tell\s+me\s+about\s+yourself",
        r"what\s+should\s+i\s+call\s+you",
    ]
    return any(re.search(p, t) for p in patterns)


def build_identity_reply() -> str:
    return (
        "Hi — I'm Neely. Neely O'Hara, Steven Alper's digital assistant. "
        "I live in the Web 4.0.\n\n"
        "What can I do for you?\n\n"
        "— Neely\n"
    )


def should_escalate(subject: str, from_header: str, body: str) -> bool:
    text = f"{subject}\n{from_header}\n{body}".lower()
    if len(body) >= 1200:
        return True
    keywords = [
        "contract",
        "legal",
        "lawsuit",
        "invoice",
        "payment",
        "refund",
        "urgent",
        "asap",
        "security",
        "breach",
        "press",
        "interview",
    ]
    return any(k in text for k in keywords)


def _parse_safety_json(raw: str) -> tuple[bool, str]:
    """Return (safe_to_answer_without_hallucinating, reason). Conservative on failure."""
    raw = (raw or "").strip()
    if raw.startswith("```"):
        raw = re.sub(r"^```(?:json)?\s*", "", raw, flags=re.I)
        raw = re.sub(r"\s*```\s*$", "", raw)
    try:
        j = json.loads(raw)
        safe = bool(j.get("safe", j.get("safe_to_answer", False)))
        reason = str(j.get("reason", j.get("brief_reason", "")))[:500]
        return safe, reason
    except json.JSONDecodeError:
        pass
    m = re.search(
        r"\{[^{}]*\"(?:safe|safe_to_answer)\"\s*:\s*(true|false)[^{}]*\}",
        raw,
        re.I | re.DOTALL,
    )
    if m:
        try:
            j = json.loads(m.group(0))
            safe = bool(j.get("safe", j.get("safe_to_answer", False)))
            return safe, str(j.get("reason", ""))[:500]
        except json.JSONDecodeError:
            pass
    return False, "classifier_parse_or_empty"


def can_answer_without_hallucinating(
    from_header: str, subject: str, body: str
) -> tuple[bool, str]:
    """
    Ask the model whether we can reply helpfully without inventing facts.
    Short acknowledgements / 'we'll get back to you' count as safe.
    """
    preview = (body or "")[:BODY_PREVIEW_MAX]
    prompt = (
        "You gate replies for an assistant (Neely). Given ONLY this email, decide if Neely can "
        "send a helpful reply WITHOUT hallucinating: no invented dates, policies, commitments, "
        "prices, legal advice, or facts not stated or obvious from the email.\n"
        "- SAFE: generic thanks, scheduling a follow-up, asking clarifying questions, "
        "or confirming receipt.\n"
        "- UNSAFE: answering specific factual/business questions when the email demands "
        "knowledge Neely does not have from the text alone.\n\n"
        f"From: {from_header}\nSubject: {subject}\n\n---\n{preview}\n---\n\n"
        'Reply with JSON only, no markdown: {"safe": true or false, "reason": "one short line"}'
    )
    try:
        raw = openai_responses(
            model=ESCALATE_MODEL, input_text=prompt, max_output_tokens=120
        )
        return _parse_safety_json(raw)
    except Exception as e:
        return False, f"classifier_error:{type(e).__name__}"


def build_ai_reply(
    from_header: str, subject: str, body: str, *, msg_id: str = ""
) -> tuple[str, str]:
    """
    Draft reply via OpenAI. On network/API/parse failure or empty output, fall back to
    template (same spirit as can_answer_without_hallucinating on classifier errors).
    Returns (body, reply_kind) — reply_kind is "ai" or "template_openai_fail".
    """
    prompt = (
        "You are Neely O'Hara. Write a concise, helpful email reply.\n"
        "Constraints:\n"
        "- Be polite and competent.\n"
        "- Only state facts supported by the email or general etiquette.\n"
        "- If something is unknown, say you'll follow up rather than guessing.\n"
        "- Keep it under 180 words.\n\n"
        f"From: {from_header}\nSubject: {subject}\n\n{body[:BODY_PREVIEW_MAX]}\n\n"
        "Reply (plain text only):"
    )
    try:
        raw = openai_responses(
            model=ESCALATE_MODEL, input_text=prompt, max_output_tokens=500
        )
        text = (raw or "").strip()
        if not text:
            append_log(
                f"{iso(now_local())}\tOPENAI_EMPTY\tbuild_ai_reply\tmsg_id={msg_id}"
            )
            return build_reply_body(from_header, subject), "template_openai_fail"
        return text + "\n", "ai"
    except Exception as e:
        err = f"{type(e).__name__}:{str(e)[:200]}"
        append_log(
            f"{iso(now_local())}\tOPENAI_ERR\tbuild_ai_reply\tmsg_id={msg_id}\t{err}"
        )
        return build_reply_body(from_header, subject), "template_openai_fail"


def email_steward(
    *,
    msg_id: str,
    from_header: str,
    subject: str,
    to_header: str,
    incoming_body: str,
    reason: str,
) -> None:
    body = (
        "Neely could not answer this inbound email without risking hallucination.\n"
        f"Classifier reason: {reason}\n\n"
        f"Gmail message id: {msg_id}\n"
        f"From: {from_header}\nTo: {to_header}\nSubject: {subject}\n\n"
        "--- Message (preview) ---\n"
        f"{(incoming_body or '')[:BODY_PREVIEW_MAX]}\n"
    )
    run_gog_plain(
        [
            "gmail",
            "send",
            "--account",
            ACCOUNT,
            "--to",
            STEWARD_EMAIL,
            "--subject",
            f"[Neely — needs you] Re: {subject}",
            "--body-file",
            "-",
        ],
        required=True,
        input_text=body,
    )


def main() -> int:
    ensure_label(ACCOUNT, REPLIED_LABEL)

    query = f"in:inbox is:unread -label:{REPLIED_LABEL} -from:{ACCOUNT}"
    # --include-body: gmail get often omits body; without it "who are you?" never matches identity.
    results = (
        run_gog_json(
            [
                "gmail",
                "messages",
                "search",
                query,
                "--account",
                ACCOUNT,
                "--max",
                "25",
                "--include-body",
            ]
        )
        or []
    )

    handled = 0
    for msg in results:
        msg_id = msg.get("id") or msg.get("messageId") or msg.get("message_id")
        if not msg_id:
            continue

        print(f"email_autopilot: handling msg_id={msg_id}", flush=True)

        full = run_gog_json(["gmail", "get", str(msg_id), "--account", ACCOUNT]) or {}
        headers = full.get("headers") or {}
        from_header = headers.get("From") or headers.get("from") or msg.get("from") or ""
        subject = headers.get("Subject") or headers.get("subject") or msg.get("subject") or "(no subject)"
        to_header = headers.get("To") or headers.get("to") or ""
        reply_to_header = headers.get("Reply-To") or headers.get("reply-to") or from_header

        incoming_body = str(msg.get("body") or "").strip()
        if not incoming_body:
            incoming_body = str(
                full.get("body")
                or full.get("snippet")
                or (full.get("payload") or {}).get("body")
                or ""
            )

        reply_to_email = parseaddr(reply_to_header)[1] or parseaddr(from_header)[1]
        if reply_to_email and is_no_reply_or_automated_sender(
            reply_to_email, from_header
        ):
            run_gog_plain(
                [
                    "gmail",
                    "messages",
                    "modify",
                    str(msg_id),
                    "--account",
                    ACCOUNT,
                    "--add",
                    REPLIED_LABEL,
                    "--remove",
                    "UNREAD",
                ]
            )
            append_log(
                f"{iso(now_local())}\tSKIP\tmsg_id={msg_id}\treason=no_autoreply_sender\tto={reply_to_email}"
            )
            append_desktop_skip(
                msg_id=str(msg_id),
                from_header=from_header,
                subject=subject,
                incoming_body=incoming_body,
                reason=f"No auto-reply to automated/no-reply address ({reply_to_email})",
            )
            continue

        if not reply_to_email:
            run_gog_plain(
                [
                    "gmail",
                    "messages",
                    "modify",
                    str(msg_id),
                    "--account",
                    ACCOUNT,
                    "--add",
                    REPLIED_LABEL,
                    "--remove",
                    "UNREAD",
                ]
            )
            append_log(
                f"{iso(now_local())}\tSKIP\tmsg_id={msg_id}\treason=no_reply_to\tsubject={subject}"
            )
            append_desktop_skip(
                msg_id=str(msg_id),
                from_header=from_header,
                subject=subject,
                incoming_body=incoming_body,
                reason="No reply-to / From address we can use",
            )
            continue

        # Identity questions: answer directly (no classifier — always truthful for Neely).
        if asks_identity_or_intro(subject, incoming_body):
            body = build_identity_reply()
            reply_kind = "identity"
        else:
            safe, safety_reason = can_answer_without_hallucinating(
                from_header, subject, incoming_body
            )

            if not safe:
                email_steward(
                    msg_id=str(msg_id),
                    from_header=from_header,
                    subject=subject,
                    to_header=to_header,
                    incoming_body=incoming_body,
                    reason=safety_reason,
                )
                body = build_deferral_body()
                reply_kind = "deferral+steward"
                append_log(
                    f"{iso(now_local())}\tSTEWARD\tmsg_id={msg_id}\tto={STEWARD_EMAIL}\treason={safety_reason}"
                )
            elif should_escalate(subject, from_header, incoming_body):
                body, reply_kind = build_ai_reply(
                    from_header, subject, incoming_body, msg_id=str(msg_id)
                )
            else:
                body = build_reply_body(from_header, subject)
                reply_kind = "template"

        run_gog_plain(
            [
                "gmail",
                "send",
                "--account",
                ACCOUNT,
                "--to",
                reply_to_email,
                "--subject",
                f"Re: {subject}",
                "--reply-to-message-id",
                str(msg_id),
                "--body-file",
                "-",
            ],
            required=True,
            input_text=body,
        )

        run_gog_plain(
            [
                "gmail",
                "messages",
                "modify",
                str(msg_id),
                "--account",
                ACCOUNT,
                "--add",
                REPLIED_LABEL,
                "--remove",
                "UNREAD",
            ]
        )

        append_log(
            f"{iso(now_local())}\tIN\tmsg_id={msg_id}\tfrom={from_header}\tto={to_header}\tsubject={subject}"
        )
        append_log(
            f"{iso(now_local())}\tOUT\treply_to_msg_id={msg_id}\tto={reply_to_email}\tkind={reply_kind}\tsubject=Re: {subject}"
        )
        append_desktop_roundtrip(
            msg_id=str(msg_id),
            from_header=from_header,
            to_header=to_header,
            subject=subject,
            incoming_body=incoming_body,
            reply_to_email=reply_to_email,
            reply_kind=reply_kind,
            reply_body=body,
            steward_notified=reply_kind == "deferral+steward",
        )
        handled += 1

    print(
        f"email_autopilot: handled={handled} account={ACCOUNT} steward={STEWARD_EMAIL}",
        flush=True,
    )
    return 0


if __name__ == "__main__":
    raise SystemExit(main())

#!/usr/bin/env python3

import datetime as dt
import os
from pathlib import Path

from _gog import run_gog_plain


ACCOUNT = os.environ.get("GOG_ACCOUNT", "neelyohara.bot@gmail.com")
LOG_DIR = Path(os.environ.get("NEELY_EMAIL_LOG_DIR", str(Path.home() / ".openclaw" / "workspace" / "memory" / "email")))
LOG_RECIPIENT = os.environ.get("NEELY_EMAIL_LOG_RECIPIENT", "steve@lasthouse.la")


def today_local() -> dt.date:
    return dt.datetime.now().astimezone().date()


def yday() -> dt.date:
    return today_local() - dt.timedelta(days=1)


def read_log(day: dt.date) -> str:
    path = LOG_DIR / f"{day.isoformat()}.log"
    if not path.exists():
        return ""
    return path.read_text(encoding="utf-8")


def main() -> int:
    day = yday()
    log = read_log(day)
    subject = f"Neely email log — {day.isoformat()} (PT)"

    if not log.strip():
        body = "No logged inbound/outbound email activity for this day.\n"
    else:
        body = (
            "Daily log of inbound emails and Neely responses.\n"
            "Format: ISO_TIMESTAMP<TAB>IN|OUT<TAB>key=value...\n\n"
            + log
        )

    run_gog_plain(
        [
            "gmail",
            "send",
            "--account",
            ACCOUNT,
            "--to",
            LOG_RECIPIENT,
            "--subject",
            subject,
            "--body-file",
            "-",
        ],
        required=True,
        input_text=body,
    )
    print(f"email_daily_log: sent_to={LOG_RECIPIENT} day={day.isoformat()} account={ACCOUNT}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())


import json
import os
import shutil
import subprocess
from dataclasses import dataclass
from typing import Any, Iterable, Optional


def _gog_executable() -> str:
    """LaunchAgent PATH is minimal; gog lives under Homebrew."""
    env = os.environ.get("GOG_BIN")
    if env and os.path.isfile(env) and os.access(env, os.X_OK):
        return env
    for candidate in (
        shutil.which("gog"),
        "/opt/homebrew/bin/gog",
        "/usr/local/bin/gog",
    ):
        if candidate and os.path.isfile(candidate) and os.access(candidate, os.X_OK):
            return candidate
    return "gog"


@dataclass(frozen=True)
class GogResult:
    stdout: str
    stderr: str
    returncode: int


def run_gog_json(args: list[str], *, required: bool = True) -> Any:
    """
    Run `gog ... --json --results-only` and parse JSON output.
    """
    cmd = [_gog_executable(), *args, "--json", "--results-only", "--no-input"]
    p = subprocess.run(cmd, text=True, capture_output=True, timeout=25)
    if required and p.returncode != 0:
        raise RuntimeError(
            f"gog failed ({p.returncode}): {' '.join(cmd)}\n{p.stderr.strip()}"
        )
    out = (p.stdout or "").strip()
    if not out:
        return None
    return json.loads(out)


def run_gog_plain(
    args: list[str], *, required: bool = True, input_text: Optional[str] = None
) -> GogResult:
    cmd = [_gog_executable(), *args, "--no-input"]
    p = subprocess.run(cmd, text=True, capture_output=True, input=input_text, timeout=25)
    if required and p.returncode != 0:
        raise RuntimeError(
            f"gog failed ({p.returncode}): {' '.join(cmd)}\n{p.stderr.strip()}"
        )
    return GogResult(stdout=p.stdout, stderr=p.stderr, returncode=p.returncode)


def ensure_label(account: str, label_name: str) -> None:
    labels = run_gog_json(["gmail", "labels", "list", "--account", account]) or []
    for lbl in labels:
        if (lbl.get("name") or "").lower() == label_name.lower():
            return
    run_gog_plain(["gmail", "labels", "create", label_name, "--account", account])


def chunked(items: list[Any], size: int) -> Iterable[list[Any]]:
    for i in range(0, len(items), size):
        yield items[i : i + size]


"""Functional checks for the conversation renderer (static/render.js).

The renderer is the one piece of this app with real behaviour that the Python
suite cannot reach: folding, per-role defaults, fold state surviving a live
upsert, and the filter toolbar all live in the browser. Rather than add a
Node/Playwright toolchain for it, the assertions live in a self-contained page
(``tests/browser/render_checks.html``) that loads the *actual* static assets,
runs against a synthetic ClineMessage[], and writes its results into the DOM.
This test drives it with whatever headless Chrome is on the machine and fails
if any assertion did.

Skipped — never failed — when no Chrome is installed, so the suite still runs
on a bare CI box.
"""

import re
import shutil
import subprocess
from pathlib import Path

import pytest

_HARNESS = Path(__file__).parent / "browser" / "render_checks.html"

# Chrome and Chromium both work; the harness uses nothing version-specific.
_CANDIDATES = ("google-chrome", "chromium", "chromium-browser", "google-chrome-stable")


def _find_browser() -> str | None:
    for name in _CANDIDATES:
        path = shutil.which(name)
        if path:
            return path
    return None


def test_render_js_behaviour():
    browser = _find_browser()
    if browser is None:
        pytest.skip("no headless Chrome/Chromium available")

    result = subprocess.run(
        [
            browser,
            "--headless",
            "--disable-gpu",
            "--no-sandbox",
            # The harness asserts asynchronously on window load; give the virtual
            # clock enough budget to get there before the DOM is dumped.
            "--virtual-time-budget=8000",
            "--dump-dom",
            _HARNESS.resolve().as_uri(),
        ],
        capture_output=True,
        text=True,
        timeout=120,
    )

    dom = result.stdout
    match = re.search(r'<pre id="results">(.*?)</pre>', dom, re.DOTALL)
    assert match, (
        "the harness never wrote its results — it probably threw before "
        f"finishing. stderr:\n{result.stderr[-2000:]}"
    )

    report = match.group(1)
    failures = re.search(r"TOTAL_FAILURES=(\d+)", report)
    assert failures, f"no failure count in harness output:\n{report}"
    assert failures.group(1) == "0", f"render.js checks failed:\n{report}"

    # A harness that silently stopped asserting would otherwise "pass".
    assert report.count("PASS") >= 20, f"too few checks ran:\n{report}"

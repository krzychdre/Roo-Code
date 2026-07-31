"""Functional checks for the browser-side code (static/*.js).

The renderer and the task-list selection are the two pieces of this app with
real behaviour that the Python suite cannot reach: folding, per-role defaults,
fold state surviving a live upsert, shift-click ranges, the subtask option, and
which confirmation a given button asks all live in the browser.

Rather than add a Node/Playwright toolchain for them, the assertions live in
self-contained pages under ``tests/browser/`` that load the *actual* static
assets, exercise them, and write their results into the DOM. This test drives
each page with whatever headless Chrome is on the machine and fails if any
assertion did.

Skipped — never failed — when no Chrome is installed, so the suite still runs on
a bare CI box.
"""

import re
import shutil
import subprocess
from pathlib import Path

import pytest

_BROWSER_DIR = Path(__file__).parent / "browser"
_HARNESSES = sorted(_BROWSER_DIR.glob("*_checks.html"))

# Chrome and Chromium both work; the harnesses use nothing version-specific.
_CANDIDATES = ("google-chrome", "chromium", "chromium-browser", "google-chrome-stable")

# A harness that silently stopped asserting would otherwise "pass", so each
# declares the number of checks it is expected to run at minimum.
_MIN_CHECKS = {
    "render_checks.html": 26,
    "resume_span_checks.html": 6,
    "tasklist_checks.html": 18,
}


def _find_browser() -> str | None:
    for name in _CANDIDATES:
        path = shutil.which(name)
        if path:
            return path
    return None


@pytest.mark.parametrize("harness", _HARNESSES, ids=lambda p: p.name)
def test_browser_behaviour(harness: Path):
    browser = _find_browser()
    if browser is None:
        pytest.skip("no headless Chrome/Chromium available")

    result = subprocess.run(
        [
            browser,
            "--headless",
            "--disable-gpu",
            "--no-sandbox",
            # The harnesses assert asynchronously on window load; give the
            # virtual clock enough budget to get there before the DOM is dumped.
            "--virtual-time-budget=8000",
            "--dump-dom",
            harness.resolve().as_uri(),
        ],
        capture_output=True,
        text=True,
        timeout=120,
    )

    dom = result.stdout
    match = re.search(r'<pre id="results">(.*?)</pre>', dom, re.DOTALL)
    assert match, (
        f"{harness.name} never wrote its results — it probably threw before "
        f"finishing. stderr:\n{result.stderr[-2000:]}"
    )

    report = match.group(1)
    failures = re.search(r"TOTAL_FAILURES=(\d+)", report)
    assert failures, f"no failure count in {harness.name} output:\n{report}"
    assert failures.group(1) == "0", f"{harness.name} checks failed:\n{report}"

    expected = _MIN_CHECKS.get(harness.name, 1)
    assert report.count("PASS") >= expected, (
        f"{harness.name} ran fewer checks than expected "
        f"({report.count('PASS')} < {expected}):\n{report}"
    )

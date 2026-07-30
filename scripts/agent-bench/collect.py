#!/usr/bin/env python3
"""Collect agent-loop efficiency metrics from Roo/Tumble Code task storage.

Usage:
    python3 scripts/agent-bench/collect.py <taskId> [<taskId> ...]
    python3 scripts/agent-bench/collect.py --recent 5
    python3 scripts/agent-bench/collect.py --since 2026-07-27 --group-by mode+config
    python3 scripts/agent-bench/collect.py --since 2026-07-14 --until 2026-07-28 --group-by mode

Reads api_conversation_history.json + ui_messages.json + history_item.json for
each task and prints three markdown tables — efficiency, acceptance criteria,
and quality — plus an aggregate row. See scripts/agent-bench/README.md for the
benchmark protocol and for what each column means.

Efficiency answers "what did it cost". Acceptance answers "did WS-1/WS-3 land".
Quality answers "did the work come out right" — without it every efficiency
number rewards doing less, which is the wrong direction to optimise blindly.
"""

import argparse
import datetime
import glob
import json
import os
import re
import statistics
import sys

STORAGE_CANDIDATES = [
    "~/.config/Code/User/globalStorage/qub-it.tumble-code/tasks",
    "~/.config/Code/User/globalStorage/rooveterinaryinc.roo-cline/tasks",
]

ENV_RE = re.compile(r"<environment_details>.*?</environment_details>", re.S)

# `read_file`'s slice-mode default (src/core/prompts/tools/native-tools/read_file.ts).
# A read is "whole-file" when it omits `limit` or asks for at least this many lines.
DEFAULT_LINE_LIMIT = 2000

# A drop this steep in consecutive reported `tokensIn`, followed by a rebound this
# large, is the microcompaction oscillation WS-1 fixed. Deliberately loose: real
# oscillation swung 222k <-> 92k (0.42x) and back (2.4x), so the thresholds only
# have to exclude ordinary turn-to-turn growth.
OSC_DROP = 0.8
OSC_REBOUND = 1.2

# Deterministic failure markers emitted by src/core/prompts/responses.ts and the
# command runner. Substring scans of arbitrary tool output are NOT used: test logs
# say "error:" and "failed" constantly and would swamp the signal.
FAIL_MARKERS = (
    "Command execution was not successful",
    "Missing value for required parameter",
)
NO_TOOL_MARKER = "[ERROR] You did not use a tool"


def storage_dir():
    for c in STORAGE_CANDIDATES:
        p = os.path.expanduser(c)
        if os.path.isdir(p):
            return p
    sys.exit("no task storage directory found")


def load(path):
    try:
        with open(path) as f:
            return json.load(f)
    except (OSError, json.JSONDecodeError):
        return None


def block_texts(content):
    """Yield text payloads from a message content list."""
    if isinstance(content, str):
        yield content
        return
    if not isinstance(content, list):
        return
    for b in content:
        if not isinstance(b, dict):
            continue
        if b.get("type") == "text":
            yield b.get("text", "")
        elif b.get("type") == "tool_result":
            inner = b.get("content")
            if isinstance(inner, str):
                yield inner
            elif isinstance(inner, list):
                for x in inner:
                    if isinstance(x, dict) and x.get("type") == "text":
                        yield x.get("text", "")


def result_text(block):
    inner = block.get("content")
    if isinstance(inner, str):
        return inner
    if isinstance(inner, list):
        return " ".join(x.get("text", "") for x in inner if isinstance(x, dict))
    return ""


def is_failed_result(block):
    """True when the harness itself reported the tool call as failed or denied.

    Recognised: an `is_error` block, a `formatResponse` JSON envelope with
    status error/denied, or one of the fixed FAIL_MARKERS strings. Anything else
    counts as a success even if the tool's *output* mentions errors.
    """
    if block.get("is_error"):
        return True
    text = result_text(block)
    stripped = text.strip()
    if stripped.startswith("{"):
        try:
            obj = json.loads(stripped)
        except json.JSONDecodeError:
            obj = None
        if isinstance(obj, dict) and obj.get("status") in ("error", "denied"):
            return True
    return any(marker in text for marker in FAIL_MARKERS)


def read_shape(tool_input):
    """Return (path, offset, limit, is_whole_file) for a read_file call."""
    if not isinstance(tool_input, dict):
        return None, None, None, False
    path = tool_input.get("path")
    offset = tool_input.get("offset")
    limit = tool_input.get("limit")
    whole = limit is None or (isinstance(limit, (int, float)) and limit >= DEFAULT_LINE_LIMIT)
    return path, offset, limit, whole


def analyze(task_dir):
    api = load(os.path.join(task_dir, "api_conversation_history.json"))
    ui = load(os.path.join(task_dir, "ui_messages.json"))
    hist = load(os.path.join(task_dir, "history_item.json")) or {}
    if not api or not ui:
        return None

    m = {
        "id": os.path.basename(task_dir),
        "config": hist.get("apiConfigName", "?"),
        "mode": hist.get("mode", "?"),
        "ts": hist.get("ts", 0),
        "tokensIn": hist.get("tokensIn", 0),
        "tokensOut": hist.get("tokensOut", 0),
        "cacheReads": hist.get("cacheReads", 0),
        "cost": hist.get("totalCost", 0.0),
        "turns": 0,
        "tool_calls": 0,
        "tool_turns": 0,
        "multi_tool_turns": 0,
        "env_bytes": 0,
        "reasoning_chars": 0,
        "text_chars": 0,
        # acceptance criteria (WS-1 / WS-3)
        "reads": 0,
        "reads_whole": 0,
        "reads_repath": 0,
        "reads_exact_dup": 0,
        "osc_events": 0,
        "unexplained_drops": 0,
        "max_drop": 0.0,
        "first_in": 0,
        "max_in": 0,
        "condense": 0,
        # quality proxies
        "tool_failures": 0,
        "thrash": 0,
        "no_tool_nudges": 0,
        "errors": 0,
        "retries": 0,
        "user_interventions": 0,
        "completion_rejected": 0,
        "completed": 0,
        "subtasks": 0,
    }

    seen_paths = set()
    seen_exact = set()
    seen_calls = set()

    for msg in api:
        content = msg.get("content")
        if msg.get("role") == "assistant":
            m["turns"] += 1
            tools = [
                b
                for b in (content if isinstance(content, list) else [])
                if isinstance(b, dict) and b.get("type") in ("tool_use", "mcp_tool_use")
            ]
            m["tool_calls"] += len(tools)
            if tools:
                m["tool_turns"] += 1
            if len(tools) >= 2:
                m["multi_tool_turns"] += 1
            for t in tools:
                name = t.get("name")
                call_key = (name, json.dumps(t.get("input"), sort_keys=True, default=str))
                if call_key in seen_calls:
                    m["thrash"] += 1
                seen_calls.add(call_key)
                if name in ("new_task", "run_parallel_tasks"):
                    m["subtasks"] += 1
                if name != "read_file":
                    continue
                path, offset, limit, whole = read_shape(t.get("input"))
                m["reads"] += 1
                if whole:
                    m["reads_whole"] += 1
                if path is not None:
                    if path in seen_paths:
                        m["reads_repath"] += 1
                    exact = (path, offset, limit)
                    if exact in seen_exact:
                        m["reads_exact_dup"] += 1
                    seen_paths.add(path)
                    seen_exact.add(exact)
            for t in block_texts(content):
                m["text_chars"] += len(t)
        else:
            for b in content if isinstance(content, list) else []:
                if isinstance(b, dict) and b.get("type") == "tool_result" and is_failed_result(b):
                    m["tool_failures"] += 1
            for t in block_texts(content):
                for env in ENV_RE.finditer(t):
                    m["env_bytes"] += len(env.group(0))
                if NO_TOOL_MARKER in t:
                    m["no_tool_nudges"] += 1

    reqs = [u for u in ui if u.get("say") == "api_req_started"]
    ttfts, decodes = [], []
    awaiting_completion = False
    for i, u in enumerate(ui):
        say, ask = u.get("say"), u.get("ask")
        if say == "reasoning":
            m["reasoning_chars"] += len(u.get("text", ""))
        elif say == "condense_context":
            m["condense"] += 1
        elif say == "error":
            m["errors"] += 1
        elif say == "api_req_retry_delayed":
            m["retries"] += 1
        elif say == "user_feedback":
            m["user_interventions"] += 1
            if awaiting_completion:
                m["completion_rejected"] += 1
        elif say == "completion_result":
            m["completed"] = 1
        if ask == "mistake_limit_reached":
            m["errors"] += 1
        if ask == "completion_result" or say == "completion_result":
            awaiting_completion = True
        elif say in ("api_req_started", "text", "tool"):
            awaiting_completion = False

        if say != "api_req_started":
            continue
        first = last = None
        for n in ui[i + 1 :]:
            if n.get("say") == "api_req_started":
                break
            if n.get("say") in ("reasoning", "text") or n.get("type") == "ask":
                if first is None:
                    first = n["ts"]
                last = n["ts"]
        if first is not None:
            ttft = (first - u["ts"]) / 1000
            if 0 <= ttft < 300:
                ttfts.append(ttft)
            decode = (last - first) / 1000
            if 0 <= decode < 600:
                decodes.append(decode)

    analyze_context_series(ui, reqs, m)

    wall = (ui[-1]["ts"] - ui[0]["ts"]) / 1000 if len(ui) >= 2 else 0
    m["ttft_med"] = statistics.median(ttfts) if ttfts else 0
    m["decode_mean"] = statistics.mean(decodes) if decodes else 0
    m["wall_s"] = wall
    m["req_count"] = len(reqs)
    return m


def analyze_context_series(ui, reqs, m):
    """WS-1 acceptance: reported `tokensIn` must be monotone bar real condenses.

    A microcompacted request reports the stripped size, so before WS-1 the series
    alternated big/small every other turn. Any drop is attributed to a
    `condense_context` or truncation event when one falls between the two
    requests; drops with no such event are the oscillation signature.
    """
    condense_ts = [u["ts"] for u in ui if u.get("say") == "condense_context"]
    series = []
    for u in reqs:
        try:
            payload = json.loads(u.get("text") or "{}")
        except json.JSONDecodeError:
            continue
        tokens_in = payload.get("tokensIn")
        if isinstance(tokens_in, (int, float)) and tokens_in > 0:
            series.append((u["ts"], tokens_in))

    if series:
        m["first_in"] = int(series[0][1])
        # Whether the task ever grew big enough for microcompaction to fire at all.
        # Without this, "osc = 0" cannot be told apart from "the gate never ran".
        m["max_in"] = int(max(v for _, v in series))

    for i in range(1, len(series)):
        prev_ts, prev = series[i - 1]
        ts, cur = series[i]
        if cur > prev * OSC_DROP:
            continue
        if any(prev_ts <= c <= ts for c in condense_ts):
            continue
        m["unexplained_drops"] += 1
        m["max_drop"] = max(m["max_drop"], 1 - cur / prev)
        if i + 1 < len(series) and series[i + 1][1] >= cur * OSC_REBOUND:
            m["osc_events"] += 1


EFF_COLS = (
    "| task | config | mode | turns | tools | tools/turn | multi% | in/turn | out/turn "
    "| cacheReads | reason/turn | ttft_med_s | decode_mean_s | wall_s | env_KiB |"
)
ACC_COLS = (
    "| task | config | mode | reads | whole% | re-read% | exact-dup% "
    "| osc | drops | max_drop% | first_in | max_in | condense |"
)
QUAL_COLS = (
    "| task | config | mode | turns | tool_fail% | thrash | no_tool | api_err | retries "
    "| user_int | rej_completion | done | subtasks |"
)


def pct(part, whole):
    return f"{100 * part / whole:.0f}%" if whole else "-"


def fmt_eff(m):
    turns = max(m["turns"], 1)
    tool_turns = max(m["tool_turns"], 1)
    return (
        f"| {m['id']} | {m['config']} | {m['mode']} | {m['turns']} | {m['tool_calls']} "
        f"| {m['tool_calls'] / tool_turns:.2f} | {pct(m['multi_tool_turns'], m['tool_turns'])} "
        f"| {m['tokensIn'] // turns:,} | {m['tokensOut'] // turns:,} | {m['cacheReads']:,} "
        f"| {m['reasoning_chars'] // turns:,} | {m['ttft_med']:.1f} | {m['decode_mean']:.1f} "
        f"| {m['wall_s']:.0f} | {m['env_bytes'] // 1024} |"
    )


def fmt_acc(m):
    return (
        f"| {m['id']} | {m['config']} | {m['mode']} | {m['reads']} "
        f"| {pct(m['reads_whole'], m['reads'])} | {pct(m['reads_repath'], m['reads'])} "
        f"| {pct(m['reads_exact_dup'], m['reads'])} | {m['osc_events']} | {m['unexplained_drops']} "
        f"| {100 * m['max_drop']:.0f}% | {m['first_in']:,} | {m['max_in']:,} | {m['condense']} |"
    )


def fmt_qual(m):
    return (
        f"| {m['id']} | {m['config']} | {m['mode']} | {m['turns']} "
        f"| {pct(m['tool_failures'], m['tool_calls'])} | {m['thrash']} | {m['no_tool_nudges']} "
        f"| {m['errors']} | {m['retries']} | {m['user_interventions']} "
        f"| {m['completion_rejected']} | {m['completed']} | {m['subtasks']} |"
    )


SUM_KEYS = (
    "turns tool_calls tool_turns multi_tool_turns tokensIn tokensOut cacheReads reasoning_chars "
    "env_bytes wall_s reads reads_whole reads_repath reads_exact_dup osc_events unexplained_drops "
    "condense tool_failures thrash no_tool_nudges errors retries user_interventions "
    "completion_rejected completed subtasks"
).split()


def aggregate(rows, label, config="-", mode="-"):
    agg = {"id": label, "config": config, "mode": mode}
    for k in SUM_KEYS:
        agg[k] = sum(r[k] for r in rows)
    agg["max_drop"] = max((r["max_drop"] for r in rows), default=0.0)
    agg["max_in"] = max((r["max_in"] for r in rows), default=0)
    agg["first_in"] = int(statistics.median([r["first_in"] for r in rows])) if rows else 0
    agg["ttft_med"] = statistics.median([r["ttft_med"] for r in rows]) if rows else 0
    agg["decode_mean"] = statistics.mean([r["decode_mean"] for r in rows]) if rows else 0
    return agg


def group_key(m, how):
    if how == "mode":
        return m["mode"]
    if how == "config":
        return m["config"]
    return f"{m['mode']} / {m['config']}"


def table(title, cols, fmt, rows, note=None):
    print(f"\n### {title}\n")
    if note:
        print(f"{note}\n")
    print(cols)
    print("|" + "---|" * (cols.count("|") - 1))
    for r in rows:
        print(fmt(r))


def day_ms(value, ap, flag):
    try:
        return datetime.datetime.strptime(value, "%Y-%m-%d").timestamp() * 1000
    except ValueError:
        ap.error(f"{flag} expects YYYY-MM-DD")


def select_dirs(base, args, ap):
    dirs = sorted((d for d in glob.glob(os.path.join(base, "*")) if os.path.isdir(d)))
    if args.task_ids:
        return [os.path.join(base, t) for t in args.task_ids]
    if args.recent:
        return sorted(dirs, key=os.path.getmtime, reverse=True)[: args.recent]
    if args.since or args.until:
        lo = day_ms(args.since, ap, "--since") if args.since else 0
        # --until is exclusive of the named day, so the windows in a pre/post
        # comparison can share a boundary date without double-counting a task.
        hi = day_ms(args.until, ap, "--until") if args.until else float("inf")
        kept = []
        for d in dirs:
            ts = (load(os.path.join(d, "history_item.json")) or {}).get("ts") or 0
            if lo <= ts < hi:
                kept.append((ts, d))
        return [d for _, d in sorted(kept)]
    ap.error("pass task ids, --recent N, or --since/--until YYYY-MM-DD")


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("task_ids", nargs="*")
    ap.add_argument("--recent", type=int, default=0, help="analyze N most recent tasks")
    ap.add_argument("--since", help="analyze every task started on or after YYYY-MM-DD")
    ap.add_argument("--until", help="stop before YYYY-MM-DD (exclusive), pairs with --since")
    ap.add_argument("--config", help="keep only tasks whose profile name contains this substring")
    ap.add_argument("--mode", help="keep only tasks in this mode slug")
    ap.add_argument(
        "--group-by",
        choices=("none", "mode", "config", "mode+config"),
        default="none",
        help="replace per-task rows with one row per group",
    )
    args = ap.parse_args()

    base = storage_dir()
    rows = []
    for d in select_dirs(base, args, ap):
        m = analyze(d)
        if m is None:
            print(f"skipped {os.path.basename(d)[-8:]} (unreadable)", file=sys.stderr)
            continue
        if args.config and args.config.lower() not in m["config"].lower():
            continue
        if args.mode and args.mode != m["mode"]:
            continue
        m["id"] = m["id"][-8:]
        rows.append(m)

    if not rows:
        sys.exit("no tasks matched")

    if args.group_by == "none":
        display = list(rows)
    else:
        groups = {}
        for m in rows:
            groups.setdefault(group_key(m, args.group_by), []).append(m)
        display = []
        for key in sorted(groups, key=lambda k: -len(groups[k])):
            g = groups[key]
            label = f"{key} (n={len(g)})"
            display.append(aggregate(g, label, config="-", mode="-"))

    if len(rows) > 1:
        display.append(aggregate(rows, "TOTAL"))

    print(f"{len(rows)} task(s) from {base}")
    table("Efficiency", EFF_COLS, fmt_eff, display)
    table(
        "Acceptance criteria (WS-1, WS-3)",
        ACC_COLS,
        fmt_acc,
        display,
        note=(
            "`whole%` = reads that omit `limit` or ask for >= 2000 lines. "
            "`re-read%` = reads of a path already read in this task. "
            "`osc`/`drops` = unexplained shrinks in reported `tokensIn` "
            "(WS-1 requires 0). `first_in` = fixed per-turn payload proxy."
        ),
    )
    table(
        "Quality proxies",
        QUAL_COLS,
        fmt_qual,
        display,
        note=(
            "All counts, not rates, except `tool_fail%`. `thrash` = byte-identical tool "
            "calls repeated in one task. `rej_completion` = the user answered an "
            "attempt_completion instead of accepting it (pushback or follow-up, not a "
            "defect count). Every efficiency win must leave these flat or better."
        ),
    )


if __name__ == "__main__":
    main()

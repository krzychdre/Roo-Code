"""Usage-metrics aggregation for the web view.

Aggregates the logged-in user's LLM usage from ``telemetry_events`` — NOT from
``task_messages``. Only *shared/live* tasks ever land in ``task_messages``, and
their ``api_req_started`` payload (``ClineApiReqInfo``) carries tokens/cost but
neither the model nor the mode. The ``LLM Completion`` telemetry event, by
contrast, is emitted for every completion and carries the full set of dimensions
the metrics page needs:

    {"mode", "apiProvider", "modelId", "taskId",
     "inputTokens", "outputTokens", "cacheReadTokens", "cacheWriteTokens", "cost"}

``telemetry_events.properties`` is stored as a JSON *string* (TEXT), and the test
suite runs on SQLite (no jsonb operators), so we load the rows and aggregate in
Python — the same server-side approach as ``web._compute_metrics``. The volume is
modest (one self-hosted user), so this is cheap and dialect-portable.
"""

import json
import logging
from datetime import datetime, timedelta, timezone
from typing import Optional

from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from src.models.event import TelemetryEvent
from src.utils.format import fmt_duration, fmt_tokens, num as _num

logger = logging.getLogger(__name__)

# TelemetryEventName.LLM_COMPLETION — the per-completion event carrying tokens,
# cost, model, provider and mode. Keep in sync with packages/types/src/telemetry.ts.
LLM_COMPLETION_EVENT = "LLM Completion"

# TelemetryEventName.EMBEDDING_USAGE — tokens spent turning code into vectors.
# A separate event, and a separate figure on the page: indexing a repository is
# hundreds of thousands of input tokens with no output and no price, so adding
# it to the conversation total would bury what the conversation actually cost.
EMBEDDING_EVENT = "Embedding Usage"

# Which part of the extension made a completion. Only ``task`` calls are turns
# of a conversation; the rest is the machinery around it. Absent on every row
# written before the extension started reporting it, and all of those are task
# turns. Keep in sync with services/model_attribution and the CompletionKind
# enum in packages/types/src/telemetry.ts.
TASK_KIND = "task"
KIND_LABELS: dict[str, str] = {
    "task": "Conversation",
    "condense": "Condensing",
    "enhance": "Prompt enhancement",
    "memory": "Memory recall",
}

# Period presets → how far back from "now" to include (None = all time). The key
# is what the route accepts as ?period=… and what the selector renders.
PERIODS: dict[str, Optional[timedelta]] = {
    "today": timedelta(0),  # special-cased to start-of-UTC-day below
    "7d": timedelta(days=7),
    "30d": timedelta(days=30),
    "90d": timedelta(days=90),
    "all": None,
}
PERIOD_LABELS: dict[str, str] = {
    "today": "Today",
    "7d": "7 days",
    "30d": "30 days",
    "90d": "90 days",
    "all": "All time",
}
DEFAULT_PERIOD = "7d"


def period_start(period: str, now: Optional[datetime] = None) -> Optional[datetime]:
    """Resolve a period key to an inclusive UTC lower bound, or None for all-time."""
    now = now or datetime.now(timezone.utc)
    if period == "today":
        return now.replace(hour=0, minute=0, second=0, microsecond=0)
    delta = PERIODS.get(period, PERIODS[DEFAULT_PERIOD])
    if delta is None:
        return None
    return now - delta


def _event_ts_ms(props: dict, fallback: datetime) -> float:
    """Best-effort completion timestamp in epoch-ms, for per-task duration spans.

    LLM Completion events don't reliably carry a client ts, so we fall back to the
    server-stamped ``created_at``. Good enough for spanning a task's activity.
    """
    for key in ("ts", "timestamp", "completedAt"):
        v = props.get(key)
        if isinstance(v, (int, float)) and not isinstance(v, bool):
            return float(v)
    return fallback.timestamp() * 1000.0


async def _embedding_totals(
    db: AsyncSession, user_id: str, start: Optional[datetime]
) -> dict:
    """Tokens spent on code-index embeddings in the period, by source.

    Reported apart from the completion totals rather than inside them. An index
    of a repository is one number with no output tokens and no price, and it is
    large enough to hide everything it sits next to; the question it answers
    ("what is indexing costing me?") is also a different question.
    """
    stmt = select(TelemetryEvent.properties).where(
        TelemetryEvent.user_id == user_id,
        TelemetryEvent.event_type == EMBEDDING_EVENT,
    )
    if start is not None:
        stmt = stmt.where(TelemetryEvent.created_at >= start)

    total = 0
    calls = 0
    by_source: dict[str, dict] = {}
    for (payload,) in (await db.execute(stmt)).all():
        try:
            props = json.loads(payload or "{}")
        except (json.JSONDecodeError, TypeError):
            continue
        if not isinstance(props, dict):
            continue
        tokens = int(_num(props.get("promptTokens")))
        total += tokens
        calls += 1
        source = str(props.get("source") or "unknown")
        slot = by_source.setdefault(source, {"name": source, "tokens": 0, "count": 0})
        slot["tokens"] += tokens
        slot["count"] += 1

    sources = sorted(by_source.values(), key=lambda s: -s["tokens"])
    for row in sources:
        row["tokens_fmt"] = fmt_tokens(row["tokens"])

    return {
        "tokens": total,
        "tokens_fmt": fmt_tokens(total),
        "calls": calls,
        "by_source": sources,
        "has_data": calls > 0,
    }


async def compute_user_metrics(
    db: AsyncSession,
    user_id: str,
    period: str = DEFAULT_PERIOD,
    now: Optional[datetime] = None,
) -> dict:
    """Aggregate the user's LLM-usage metrics for the given period.

    Returns a JSON-serializable dict:
      - period, period_label
      - totals: input/output/cache_read/cache_write tokens, total_tokens, cost,
        completions
      - duration_ms / duration (per-taskId span, summed), task_count
      - by_model / by_mode / by_provider: lists of {name, tokens, tokens_fmt,
        cost, count}, sorted desc by tokens
      - by_day: chronological list of {day, tokens, cost}
      - chart: Chart.js-ready {days, day_tokens, day_cost, model_labels,
        model_tokens, mode_labels, mode_tokens}
      - has_data
    """
    if period not in PERIODS:
        period = DEFAULT_PERIOD
    start = period_start(period, now)

    stmt = select(TelemetryEvent).where(
        TelemetryEvent.user_id == user_id,
        TelemetryEvent.event_type == LLM_COMPLETION_EVENT,
    )
    if start is not None:
        stmt = stmt.where(TelemetryEvent.created_at >= start)
    stmt = stmt.order_by(TelemetryEvent.created_at)

    result = await db.execute(stmt)
    rows = list(result.scalars().all())

    totals = {
        "input": 0,
        "output": 0,
        "cache_read": 0,
        "cache_write": 0,
        "cost": 0.0,
        "completions": 0,
    }
    by_model: dict[str, dict] = {}
    by_mode: dict[str, dict] = {}
    by_provider: dict[str, dict] = {}
    by_kind: dict[str, dict] = {}
    by_day: dict[str, dict] = {}
    # Completions whose provider could not say what they cost. Counted rather
    # than silently added in as zero, so "12 calls we have no figures for" reads
    # as what it is instead of as twelve free calls.
    unreported = 0
    # taskId -> [min_ts_ms, max_ts_ms] for per-session duration spans.
    task_spans: dict[str, list[float]] = {}

    def _bucket(store: dict, name: str, tokens: float, cost: float) -> None:
        slot = store.setdefault(name, {"name": name, "tokens": 0, "cost": 0.0, "count": 0})
        slot["tokens"] += tokens
        slot["cost"] += cost
        slot["count"] += 1

    for row in rows:
        try:
            props = json.loads(row.properties or "{}")
        except (json.JSONDecodeError, TypeError):
            continue
        if not isinstance(props, dict):
            continue

        tin = _num(props.get("inputTokens"))
        tout = _num(props.get("outputTokens"))
        cread = _num(props.get("cacheReadTokens"))
        cwrite = _num(props.get("cacheWriteTokens"))
        cost = _num(props.get("cost"))
        tokens = tin + tout

        totals["input"] += tin
        totals["output"] += tout
        totals["cache_read"] += cread
        totals["cache_write"] += cwrite
        totals["cost"] += cost
        totals["completions"] += 1

        kind = str(props.get("completionKind") or TASK_KIND)
        if props.get("usageReported") is False:
            unreported += 1

        _bucket(by_model, str(props.get("modelId") or "unknown"), tokens, cost)
        _bucket(by_mode, str(props.get("mode") or "unknown"), tokens, cost)
        _bucket(by_provider, str(props.get("apiProvider") or "unknown"), tokens, cost)
        _bucket(by_kind, kind, tokens, cost)

        created = row.created_at or (now or datetime.now(timezone.utc))
        day = created.strftime("%Y-%m-%d")
        dslot = by_day.setdefault(day, {"day": day, "tokens": 0, "cost": 0.0})
        dslot["tokens"] += tokens
        dslot["cost"] += cost

        task_id = props.get("taskId")
        if task_id:
            ts_ms = _event_ts_ms(props, created)
            span = task_spans.setdefault(task_id, [ts_ms, ts_ms])
            span[0] = min(span[0], ts_ms)
            span[1] = max(span[1], ts_ms)

    duration_ms = sum(hi - lo for lo, hi in task_spans.values())

    def _sorted(store: dict) -> list[dict]:
        items = sorted(store.values(), key=lambda s: s["tokens"], reverse=True)
        for s in items:
            s["tokens_fmt"] = fmt_tokens(s["tokens"])
        return items

    models = _sorted(by_model)
    modes = _sorted(by_mode)
    providers = _sorted(by_provider)
    kinds = _sorted(by_kind)
    for row in kinds:
        row["label"] = KIND_LABELS.get(row["name"], row["name"])
    days = sorted(by_day.values(), key=lambda d: d["day"])
    embeddings = await _embedding_totals(db, user_id, start)

    total_tokens = totals["input"] + totals["output"]

    return {
        "period": period,
        "period_label": PERIOD_LABELS.get(period, period),
        "totals": {
            **{k: int(v) if k != "cost" else v for k, v in totals.items()},
            "total_tokens": int(total_tokens),
            "total_tokens_fmt": fmt_tokens(total_tokens),
        },
        "duration_ms": int(duration_ms),
        "duration": fmt_duration(duration_ms),
        "task_count": len(task_spans),
        "by_model": models,
        "by_mode": modes,
        "by_provider": providers,
        "by_kind": kinds,
        "unreported": unreported,
        "embeddings": embeddings,
        "by_day": days,
        "chart": {
            "days": [d["day"] for d in days],
            "day_tokens": [int(d["tokens"]) for d in days],
            "day_cost": [round(d["cost"], 6) for d in days],
            "model_labels": [m["name"] for m in models],
            "model_tokens": [int(m["tokens"]) for m in models],
            "mode_labels": [m["name"] for m in modes],
            "mode_tokens": [int(m["tokens"]) for m in modes],
        },
        "has_data": len(rows) > 0,
    }

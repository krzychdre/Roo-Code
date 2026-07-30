"""Which model answered — per request, and per task.

Why this is not simply read off the conversation
------------------------------------------------
A stored ``api_req_started`` message is the whole record of an API request, and
it carries no model::

    {"apiProtocol":"openai","tokensIn":16591,"tokensOut":498,
     "cacheWrites":0,"cacheReads":15872,"cost":0}

The ``LLM Completion`` telemetry event does — ``{taskId, modelId, mode,
apiProvider, inputTokens, outputTokens, cost}`` — and is emitted once per
completed request. So the model is known; it just lives in the other table.

Joining the two
---------------
Not on time: the message ``ts`` is stamped client-side when the request
*starts*, the event ``created_at`` server-side when it *finishes*. On the live
deployment those are minutes apart for a long turn.

On tokens. The ``(inputTokens, outputTokens)`` pair is reported by the same
provider response that produced both records, so it matches exactly and in
order. Verified against the live corpus (task ``019fa87b-2a52-…``: four
requests, four events, all four pairs identical and in sequence).

The match is greedy and ordered, and tolerates gaps on both sides — a cancelled
request emits no completion event, and telemetry can name a request whose
message was never stored. What it will not do is guess: an unmatched request in
a task that used more than one model gets no attribution at all, because a
wrong model name is worse than a blank one in a provenance display.
"""

from __future__ import annotations

import json
from dataclasses import dataclass
from typing import Iterable, Optional

from sqlalchemy import select, update
from sqlalchemy.ext.asyncio import AsyncSession

from src.models.event import TelemetryEvent
from src.models.task import Task
from src.utils.format import num

# Keep in sync with services/metrics_service.LLM_COMPLETION_EVENT and
# packages/types/src/telemetry.ts.
LLM_COMPLETION_EVENT = "LLM Completion"

# How many model names a task badge spells out before it collapses to a count.
# One: local model ids are long ("GLM-5.2-MXFP4-A8"), and a badge naming two of
# them took so much of the row that titles were being truncated to "a." and
# "read…". The rest of the list is in the tooltip, and the detail page names
# every model in full.
MODELS_SHOWN = 1


@dataclass(frozen=True)
class Completion:
    """One LLM Completion event, reduced to what attribution needs."""

    model: str
    mode: Optional[str]
    input_tokens: int
    output_tokens: int


def completion_from_properties(props: dict) -> Optional[Completion]:
    """Reduce a raw event payload, or None if it names no model."""
    model = props.get("modelId")
    if not model or not isinstance(model, str):
        return None
    mode = props.get("mode")
    return Completion(
        model=model,
        mode=mode if isinstance(mode, str) and mode else None,
        input_tokens=int(num(props.get("inputTokens"))),
        output_tokens=int(num(props.get("outputTokens"))),
    )


async def completions_for_task(db: AsyncSession, task_id: str) -> list[Completion]:
    """Every completion recorded for a task, oldest first.

    One indexed query on ``telemetry_events.task_id`` — the column exists so
    this is not a scan of the whole event corpus. The volume is per-task and
    small (74 events for the largest run on the live deployment), so decoding
    the payloads in Python is cheap and works on SQLite as well as Postgres.
    """
    if not task_id:
        return []
    result = await db.execute(
        select(TelemetryEvent.properties)
        .where(
            TelemetryEvent.task_id == task_id,
            TelemetryEvent.event_type == LLM_COMPLETION_EVENT,
        )
        .order_by(TelemetryEvent.created_at)
    )
    completions: list[Completion] = []
    for (payload,) in result.all():
        try:
            props = json.loads(payload or "{}")
        except (json.JSONDecodeError, TypeError):
            continue
        if not isinstance(props, dict):
            continue
        completion = completion_from_properties(props)
        if completion is not None:
            completions.append(completion)
    return completions


def _request_tokens(msg: dict) -> Optional[tuple[int, int]]:
    """The ``(in, out)`` pair of an api_req_started message, or None.

    None for anything that is not a request, and for a request still in flight
    (no tokens reported yet) — a ``(0, 0)`` key would match the first event with
    an empty usage report and attribute the wrong model to a row that has not
    even finished.
    """
    if msg.get("say") != "api_req_started":
        return None
    try:
        obj = json.loads(msg.get("text") or "{}")
    except (json.JSONDecodeError, TypeError):
        return None
    if not isinstance(obj, dict):
        return None
    pair = (int(num(obj.get("tokensIn"))), int(num(obj.get("tokensOut"))))
    return pair if pair != (0, 0) else None


def attribute_requests(
    messages: Iterable[dict], completions: list[Completion]
) -> dict[str, dict]:
    """Map each API request's message ``ts`` to the model that answered it.

    Returns ``{str(ts): {"model": …, "mode": … | None}}``, keyed by string
    because the caller hands it to the browser as JSON (where object keys are
    strings anyway) and the renderer looks it up by the row's ``data-ts``.
    """
    if not completions:
        return {}

    requests: list[tuple[object, tuple[int, int]]] = []
    for msg in messages:
        ts = msg.get("ts")
        if ts is None:
            continue
        pair = _request_tokens(msg)
        if pair is not None:
            requests.append((ts, pair))

    attributed: dict[str, dict] = {}
    matched: set[object] = set()
    cursor = 0
    for ts, pair in requests:
        probe = cursor
        while probe < len(completions):
            candidate = completions[probe]
            if (candidate.input_tokens, candidate.output_tokens) == pair:
                attributed[str(ts)] = {"model": candidate.model, "mode": candidate.mode}
                matched.add(ts)
                cursor = probe + 1
                break
            probe += 1

    # A task that only ever used one model leaves nothing to get wrong: every
    # request it made went to that model, matched or not. With two or more, an
    # unmatched request stays blank rather than being assigned by proximity.
    distinct = {c.model for c in completions}
    if len(distinct) == 1:
        only = completions[0]
        for ts, _pair in requests:
            if ts not in matched:
                attributed[str(ts)] = {"model": only.model, "mode": only.mode}

    return attributed


def models_summary(completions: list[Completion]) -> list[dict]:
    """Per-model rollup for the detail panel: name, modes, request count.

    Sorted by request count descending — the model that did most of the work
    reads first, which is also the order the compact label uses.
    """
    rollup: dict[str, dict] = {}
    for c in completions:
        slot = rollup.setdefault(c.model, {"name": c.model, "count": 0, "modes": []})
        slot["count"] += 1
        if c.mode and c.mode not in slot["modes"]:
            slot["modes"].append(c.mode)
    return sorted(rollup.values(), key=lambda s: (-s["count"], s["name"]))


def models_label(completions: list[Completion]) -> Optional[str]:
    """Compact, storable label: distinct models, most-used first.

    ``None`` when nothing is known, so a refresh never overwrites a stored value
    with an empty one just because telemetry has not arrived yet.
    """
    names = [row["name"] for row in models_summary(completions)]
    return ", ".join(names) if names else None


def models_badge(label: Optional[str]) -> Optional[dict]:
    """View-model for the one-line badge a list row shows.

    Spells out up to ``MODELS_SHOWN`` names and collapses the rest into a count,
    so a row that switched model three times does not push the figures off the
    grid. The full list stays in the tooltip.

    ``name`` and ``more`` are separate because the badge sits in a fixed track
    and the name is the part that ellipsises: kept as one string, a long model id
    would truncate away the ``+1`` — which is the whole signal that this run was
    not a single model.
    """
    if not label:
        return None
    names = [part.strip() for part in label.split(",") if part.strip()]
    if not names:
        return None
    remainder = len(names) - MODELS_SHOWN
    return {
        "name": ", ".join(names[:MODELS_SHOWN]),
        "more": f"+{remainder}" if remainder > 0 else "",
        "title": ", ".join(names),
        "count": len(names),
    }


async def refresh_task_models(db: AsyncSession, task_id: str) -> None:
    """Recompute and store ``tasks.models`` from the task's completion events.

    Called from both write paths — message writes (``task_summary``) and
    telemetry ingest — because the two arrive in either order: a task can be
    shared long after it ran, or run live before it is ever shared.
    """
    label = models_label(await completions_for_task(db, task_id))
    if label is None:
        return
    await db.execute(update(Task).where(Task.id == task_id).values(models=label))


async def note_completion_model(db: AsyncSession, task_id: str, model: str) -> None:
    """Cheap ingest-time path: refresh only when a *new* model shows up.

    Recomputing the label on every completion would re-read the task's events
    thousands of times per run to arrive at the same string. A model already in
    the stored label changes nothing, so the common case is one indexed SELECT
    of a single column. Ordering by request count therefore settles when a new
    model appears, and on the next message write.

    A task with no row yet (telemetry for a run that was never shared) is left
    alone entirely — there is nothing to store it on, and the label is rebuilt
    from the events if and when the conversation does arrive.
    """
    if not (task_id and model):
        return
    row = (
        await db.execute(select(Task.id, Task.models).where(Task.id == task_id))
    ).one_or_none()
    if row is None:
        return
    current = row[1]
    if current and model in [p.strip() for p in current.split(",")]:
        return
    await refresh_task_models(db, task_id)

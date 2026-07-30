"""Per-task display summary — derived at write time, stored on the rows.

Why this exists
---------------
The task list used to derive everything it shows (title, message count, tokens,
cost) by loading *every message of every task* and JSON-parsing it on each page
view. Measured against the live deployment that was 387 queries and 205 MB of
text per request — 2.47s of server time for 55 541 messages — and it grew
linearly with the corpus forever.

A stored message is immutable in content once finalized, so re-deriving its
numbers on every read is pure waste. The fix is two-level:

1. **Per message.** When a message is written we parse its payload once and
   store the tokens/cost it contributes as plain numeric columns on
   ``task_messages``. Parsing happens exactly once per message, ever.

2. **Per task.** ``tasks`` carries the rolled-up totals. They are refreshed by a
   single indexed ``SUM``/``COUNT`` aggregate over that task's message rows —
   numbers only, no JSON, no text. Rendering the list is then one query with no
   per-task work at all.

Why not accumulate incrementally into the task row? Because the live bridge
upserts the *same* ``ts`` repeatedly as a message streams (created → partial →
final), and an ``api_req_started`` only learns its real token/cost figures in
its final revision. Adding deltas would double-count every re-upsert. Re-summing
the rows is idempotent by construction, which is the property that matters here.

The aggregation itself matches the VS Code view (``consolidateTokenUsage``) and
``static/render.js:getMetrics``: sum ``tokensIn``/``tokensOut``/``cacheWrites``/
``cacheReads``/``cost`` over every ``api_req_started`` say-message, plus the cost
of any ``condense_context``. ``contextTokens`` is deliberately not summed — it is
a live gauge of the *current* context, not a total.
"""

from __future__ import annotations

import json
import re
from dataclasses import dataclass
from typing import Iterable, Optional

from sqlalchemy import func, select, update
from sqlalchemy.ext.asyncio import AsyncSession

from src.models.task import Task, TaskMessage
from src.utils.format import num

# Titles are a single line; anything longer is truncated with an ellipsis.
TITLE_MAX = 100
DEFAULT_TITLE = "Untitled task"

# Roo Code's first user turn can reach the cloud in API-prompt form: the typed
# text wrapped in <user_message>/<task>/<feedback>, trailed by a machine-built
# <environment_details> block (current mode, open tabs, file tree, cost…). None
# of the environment block is the user's query, so strip it before deriving a
# title. Match the trailing/unclosed case too (the block is always last).
_ENV_DETAILS_RE = re.compile(r"<environment_details>.*?(?:</environment_details>|\Z)", re.DOTALL)
_MSG_WRAPPER_RE = re.compile(r"<(user_message|task|feedback)>(.*?)</\1>", re.DOTALL)


def strip_task_wrappers(text: str) -> str:
    """Reduce a raw conversation message to the human-authored query.

    Drops the machine ``<environment_details>`` appendix and unwraps the
    ``<user_message>``/``<task>``/``<feedback>`` tag to its inner content. Plain
    text (already clean) passes through unchanged.
    """
    if not text:
        return ""
    cleaned = _ENV_DETAILS_RE.sub("", text)
    match = _MSG_WRAPPER_RE.search(cleaned)
    if match:
        cleaned = match.group(2)
    return cleaned.strip()


def derive_title(messages: Iterable[dict]) -> str:
    """Pick a human-readable title from the conversation (first text-bearing msg).

    The first candidate is unwrapped to the user's query (machine framing such as
    ``<environment_details>`` is dropped) so the title reflects what the user
    actually typed, not the current mode/file tree the extension appended.
    """
    for msg in messages:
        text = (msg.get("text") or "").strip()
        if not text or text.startswith("{"):
            continue
        query = strip_task_wrappers(text)
        if not query:
            continue
        first_line = query.splitlines()[0].strip()
        if first_line:
            return first_line[:TITLE_MAX] + ("…" if len(first_line) > TITLE_MAX else "")
    return DEFAULT_TITLE


@dataclass(frozen=True)
class MessageMetrics:
    """What a single message contributes to its task's totals.

    All-zero for the overwhelming majority of messages (only ``api_req_started``
    and ``condense_context`` carry numbers), which is exactly why storing them
    per row is cheap.
    """

    tokens_in: int = 0
    tokens_out: int = 0
    cache_reads: int = 0
    cache_writes: int = 0
    cost: float = 0.0

    def as_columns(self) -> dict:
        return {
            "tokens_in": self.tokens_in,
            "tokens_out": self.tokens_out,
            "cache_reads": self.cache_reads,
            "cache_writes": self.cache_writes,
            "cost": self.cost,
        }


_ZERO = MessageMetrics()


def message_metrics(msg: dict) -> MessageMetrics:
    """Extract one message's token/cost contribution. Parses at most one JSON doc.

    Returns all-zero rather than None for a non-contributing message so callers
    can write the columns unconditionally; a partial ``api_req_started`` (whose
    ``text`` is not yet valid JSON, or has no figures yet) is naturally zero and
    is corrected when its final revision overwrites the row.
    """
    if not isinstance(msg, dict) or msg.get("type") != "say":
        return _ZERO

    say = msg.get("say")

    if say == "api_req_started":
        text = msg.get("text")
        if not text:
            return _ZERO
        try:
            obj = json.loads(text)
        except (json.JSONDecodeError, TypeError):
            return _ZERO
        if not isinstance(obj, dict):
            return _ZERO
        return MessageMetrics(
            tokens_in=int(num(obj.get("tokensIn"))),
            tokens_out=int(num(obj.get("tokensOut"))),
            cache_reads=int(num(obj.get("cacheReads"))),
            cache_writes=int(num(obj.get("cacheWrites"))),
            cost=float(num(obj.get("cost"))),
        )

    if say == "condense_context":
        condense = msg.get("contextCondense")
        if isinstance(condense, dict):
            return MessageMetrics(cost=float(num(condense.get("cost"))))

    return _ZERO


async def refresh_task_summary(
    db: AsyncSession,
    task_id: str,
    *,
    title: Optional[str] = None,
    force_title: bool = False,
) -> None:
    """Roll the task's message rows up onto the task row.

    One aggregate over numeric columns, keyed by the existing ``task_id`` index —
    no JSON is touched. Idempotent, so it is safe to call after every write.

    ``title`` is applied when supplied AND either the task has no real title yet
    or ``force_title`` is set. A title is derived from the opening user message,
    which never changes within a conversation, so re-deriving it on later live
    writes would be wasted work — but a backfill *replaces* the conversation
    wholesale and must be able to overwrite a stale placeholder.
    """
    aggregate = await db.execute(
        select(
            func.count(TaskMessage.id),
            func.coalesce(func.sum(TaskMessage.tokens_in), 0),
            func.coalesce(func.sum(TaskMessage.tokens_out), 0),
            func.coalesce(func.sum(TaskMessage.cache_reads), 0),
            func.coalesce(func.sum(TaskMessage.cache_writes), 0),
            func.coalesce(func.sum(TaskMessage.cost), 0.0),
            func.min(TaskMessage.message_ts),
            func.max(TaskMessage.message_ts),
        ).where(TaskMessage.task_id == task_id)
    )
    count, t_in, t_out, c_read, c_write, cost, first_ts, last_ts = aggregate.one()

    values = {
        "message_count": int(count or 0),
        "tokens_in": int(t_in or 0),
        "tokens_out": int(t_out or 0),
        "cache_reads": int(c_read or 0),
        "cache_writes": int(c_write or 0),
        "cost": float(cost or 0.0),
        "first_ts": int(first_ts) if first_ts is not None else None,
        "last_ts": int(last_ts) if last_ts is not None else None,
    }

    if title:
        if force_title:
            values["title"] = title
        else:
            existing = await db.execute(select(Task.title).where(Task.id == task_id))
            current = existing.scalar_one_or_none()
            if not current or current == DEFAULT_TITLE:
                values["title"] = title

    await db.execute(update(Task).where(Task.id == task_id).values(**values))


def duration_ms(first_ts: Optional[int], last_ts: Optional[int]) -> int:
    """Span between a task's first and last message timestamp, clamped at 0."""
    if first_ts is None or last_ts is None:
        return 0
    return max(0, int(last_ts - first_ts))

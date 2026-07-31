"""Stop counting the time a task spent closed as time it ran.

A task's session span is ``MAX(message_ts) - MIN(message_ts)`` over its stored
rows. One kind of row is not part of the run: the ``resume_task`` /
``resume_completed_task`` ask the extension writes when a task is **reopened
from history**. It carries no text, no tokens and no quality marker — it records
the moment the user came back, which can be hours or days after the work
stopped, and it moved ``MAX`` with it.

On the live deployment that turned a 3m10s run into a reported 4h26m, and 59 of
392 tasks were inflated the same way (mean 100 min, worst 29 h).

Idle time *within* a run stays counted — waiting for the user to answer is time
the task took. This removes only the trailing marker.

Two steps, in the order they depend on each other:

  1. classify the existing resume rows (``q_kind = 'resume'``), so the span can
     exclude them on an indexed column rather than by reading message text;
  2. recompute every task's ``first_ts``/``last_ts`` under that rule, so a
     migrated row and one written after this deploy agree.

Revision ID: f2a3b4c5d6e7
Revises: e1f2a3b4c5d6
Create Date: 2026-07-31 16:00:00.000000

"""

import json

from alembic import op
import sqlalchemy as sa

# revision identifiers, used by Alembic.
revision = "f2a3b4c5d6e7"
down_revision = "e1f2a3b4c5d6"
branch_labels = None
depends_on = None

_RESUME_KIND = "resume"

# Rows are narrowed by text match and then *confirmed* by parsing: a message
# that merely quotes the word (a conversation about resuming a task, a diff of
# TaskResumption.ts) must not be reclassified. The match is the cheap filter,
# the parse is the decision.
_CANDIDATE_SQL = (
    "SELECT id, message_data FROM task_messages "
    "WHERE message_data LIKE '%resume_task%' OR message_data LIKE '%resume_completed_task%'"
)

_SPAN_SQL = """
    UPDATE tasks SET
        first_ts = (SELECT MIN(m.message_ts) FROM task_messages m
                    WHERE m.task_id = tasks.id AND (m.q_kind IS NULL OR m.q_kind <> :kind)),
        last_ts  = (SELECT MAX(m.message_ts) FROM task_messages m
                    WHERE m.task_id = tasks.id AND (m.q_kind IS NULL OR m.q_kind <> :kind))
"""


def upgrade() -> None:
    conn = op.get_bind()
    _mark_resume_rows(conn)
    conn.execute(sa.text(_SPAN_SQL), {"kind": _RESUME_KIND})


def _mark_resume_rows(conn) -> None:
    """Set ``q_kind = 'resume'`` on every stored resume prompt."""
    from src.services.session_quality import KIND_RESUME, classify_message

    marked = []
    for row_id, payload in conn.execute(sa.text(_CANDIDATE_SQL)).fetchall():
        try:
            msg = json.loads(payload)
        except (json.JSONDecodeError, TypeError):
            continue
        if isinstance(msg, dict) and classify_message(msg) == KIND_RESUME:
            marked.append({"row_id": row_id, "kind": KIND_RESUME})

    if marked:
        conn.execute(
            sa.text("UPDATE task_messages SET q_kind = :kind WHERE id = :row_id"),
            marked,
        )


def downgrade() -> None:
    conn = op.get_bind()
    # Spans first: they are recomputed over all rows, which needs the markers
    # still in place to be a no-op-safe plain MIN/MAX.
    conn.execute(
        sa.text(
            """
            UPDATE tasks SET
                first_ts = (SELECT MIN(m.message_ts) FROM task_messages m WHERE m.task_id = tasks.id),
                last_ts  = (SELECT MAX(m.message_ts) FROM task_messages m WHERE m.task_id = tasks.id)
            """
        )
    )
    conn.execute(
        sa.text("UPDATE task_messages SET q_kind = NULL WHERE q_kind = :kind"),
        {"kind": _RESUME_KIND},
    )

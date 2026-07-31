"""Keep the opening user prompt on the task row, not just its first line.

``tasks.title`` is the first line of the opening message cut at 100 characters —
enough to tell two runs apart, not enough to remember either one. The web list
now shows the request itself on hover, and it must not pay for it: the opening
message is the *largest* row of a conversation (it carries the extension's
``<environment_details>`` appendix), so reading 25 of them per page view would
undo exactly what f6a7b8c9d0e1 fixed.

So the excerpt is denormalized next to the title it is derived from — same
source message, same write (services/task_summary.derive_prompt).

The backfill reads only the earliest rows of each task, which is where the
opening message always is.

Revision ID: e1f2a3b4c5d6
Revises: d0e1f2a3b4c5
Create Date: 2026-07-31 12:00:00.000000

"""

import json

from alembic import op
import sqlalchemy as sa

# revision identifiers, used by Alembic.
revision = "e1f2a3b4c5d6"
down_revision = "d0e1f2a3b4c5"
branch_labels = None
depends_on = None

# The opening message is the first text-bearing one; a handful of leading rows
# (task started, checkpoint, an api_req_started) can precede it. Same window the
# title backfill used.
_HEAD_ROWS = 40


def upgrade() -> None:
    op.add_column("tasks", sa.Column("prompt_excerpt", sa.String(), nullable=True))
    _backfill()


def _backfill() -> None:
    """Derive the excerpt for every existing task from its opening messages."""
    from src.services.task_summary import derive_prompt

    conn = op.get_bind()

    head_sql = (
        "SELECT message_data FROM task_messages WHERE task_id = :tid "
        "ORDER BY message_ts NULLS LAST, id LIMIT :limit"
        if conn.dialect.name == "postgresql"
        else "SELECT message_data FROM task_messages WHERE task_id = :tid "
        "ORDER BY message_ts, id LIMIT :limit"
    )

    task_ids = [r[0] for r in conn.execute(sa.text("SELECT id FROM tasks")).fetchall()]
    for task_id in task_ids:
        rows = conn.execute(sa.text(head_sql), {"tid": task_id, "limit": _HEAD_ROWS}).fetchall()

        messages = []
        for (payload,) in rows:
            try:
                msg = json.loads(payload)
            except (json.JSONDecodeError, TypeError):
                continue
            if isinstance(msg, dict):
                messages.append(msg)
        messages.sort(key=lambda m: m.get("ts") or 0)

        prompt = derive_prompt(messages)
        if not prompt:
            # Nothing to store, and the column already defaults to NULL.
            continue
        conn.execute(
            sa.text("UPDATE tasks SET prompt_excerpt = :prompt WHERE id = :tid"),
            {"prompt": prompt, "tid": task_id},
        )


def downgrade() -> None:
    op.drop_column("tasks", "prompt_excerpt")

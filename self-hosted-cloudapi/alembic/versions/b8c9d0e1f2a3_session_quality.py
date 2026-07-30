"""Measure how a session went, not only what it cost.

Tokens and cost cannot tell a run that worked steadily apart from one that kept
failing, re-reading the same files and having to be corrected — both look like
200k tokens. This adds the deterministic markers that can (see
services/session_quality):

  * task_messages.q_kind    — request / error / retry / intervention /
                              rejection / condense / tool / completion, NULL for
                              the majority that say nothing;
  * task_messages.tool_path — the "<tool>:<path>" a tool call touched, so
                              repeated work is total-minus-distinct in the
                              rollup rather than a scan;
  * tasks.q_* — the per-task counts the list and detail views grade from.

and backfills all of it by re-walking the stored conversations. The walk has to
be in order: a `user_feedback` is an ordinary correction, unless an
attempt_completion was awaiting an answer, in which case it is a rejection of
the result.

Revision ID: b8c9d0e1f2a3
Revises: a7b8c9d0e1f2
Create Date: 2026-07-30 16:00:00.000000

"""

import json

from alembic import op
import sqlalchemy as sa

# revision identifiers, used by Alembic.
revision = "b8c9d0e1f2a3"
down_revision = "a7b8c9d0e1f2"
branch_labels = None
depends_on = None


_TASK_COUNTS = (
    "q_requests",
    "q_errors",
    "q_retries",
    "q_interventions",
    "q_completion_replies",
    "q_condense",
    "q_tools",
    "q_tool_paths",
    "q_distinct_tool_paths",
)


def upgrade() -> None:
    op.add_column("task_messages", sa.Column("q_kind", sa.String(), nullable=True))
    op.add_column("task_messages", sa.Column("tool_path", sa.String(), nullable=True))
    op.create_index("ix_task_messages_q_kind", "task_messages", ["q_kind"])

    for name in _TASK_COUNTS:
        op.add_column(
            "tasks", sa.Column(name, sa.Integer(), nullable=False, server_default="0")
        )
    op.add_column(
        "tasks",
        sa.Column("q_completed", sa.Boolean(), nullable=False, server_default=sa.false()),
    )

    _backfill()


def _backfill() -> None:
    """Re-walk every stored conversation and record its markers."""
    from src.services.session_quality import classify_conversation

    conn = op.get_bind()

    task_ids = [r[0] for r in conn.execute(sa.text("SELECT id FROM tasks")).fetchall()]
    for task_id in task_ids:
        rows = conn.execute(
            sa.text(
                "SELECT id, message_data, message_ts FROM task_messages "
                "WHERE task_id = :tid"
            ),
            {"tid": task_id},
        ).fetchall()
        if not rows:
            continue

        # Order matters for the rejection rule. NULL message_ts (legacy rows)
        # sort last, matching how the viewer sorts them.
        decoded = []
        for row_id, payload, ts in rows:
            try:
                msg = json.loads(payload)
            except (json.JSONDecodeError, TypeError):
                continue
            if isinstance(msg, dict):
                decoded.append((row_id, msg, ts if ts is not None else 0))
        decoded.sort(key=lambda item: item[2])

        marks = classify_conversation([m for _, m, _ in decoded])
        updates = [
            {"row_id": row_id, "q_kind": kind, "tool_path": path}
            for (row_id, _, _), (kind, path) in zip(decoded, marks)
            if kind is not None or path is not None
        ]
        if updates:
            conn.execute(
                sa.text(
                    "UPDATE task_messages SET q_kind = :q_kind, tool_path = :tool_path "
                    "WHERE id = :row_id"
                ),
                updates,
            )

    # Roll the markers up onto the task rows.
    conn.execute(
        sa.text(
            """
            UPDATE tasks SET
                q_requests      = (SELECT COUNT(*) FROM task_messages m WHERE m.task_id = tasks.id AND m.q_kind = 'request'),
                q_errors        = (SELECT COUNT(*) FROM task_messages m WHERE m.task_id = tasks.id AND m.q_kind = 'error'),
                q_retries       = (SELECT COUNT(*) FROM task_messages m WHERE m.task_id = tasks.id AND m.q_kind = 'retry'),
                q_interventions = (SELECT COUNT(*) FROM task_messages m WHERE m.task_id = tasks.id AND m.q_kind = 'intervention'),
                q_completion_replies    = (SELECT COUNT(*) FROM task_messages m WHERE m.task_id = tasks.id AND m.q_kind = 'completion_reply'),
                q_condense      = (SELECT COUNT(*) FROM task_messages m WHERE m.task_id = tasks.id AND m.q_kind = 'condense'),
                q_tools         = (SELECT COUNT(*) FROM task_messages m WHERE m.task_id = tasks.id AND m.q_kind = 'tool'),
                q_tool_paths    = (SELECT COUNT(m.tool_path) FROM task_messages m WHERE m.task_id = tasks.id),
                q_distinct_tool_paths = (SELECT COUNT(DISTINCT m.tool_path) FROM task_messages m WHERE m.task_id = tasks.id)
            """
        )
    )
    # Separate statement: a boolean assignment differs between the dialects only
    # here, and keeping it apart avoids a CASE in the big UPDATE above.
    conn.execute(
        sa.text(
            "UPDATE tasks SET q_completed = TRUE WHERE EXISTS ("
            "SELECT 1 FROM task_messages m WHERE m.task_id = tasks.id AND m.q_kind = 'completion')"
        )
    )


def downgrade() -> None:
    op.drop_column("tasks", "q_completed")
    for name in reversed(_TASK_COUNTS):
        op.drop_column("tasks", name)
    op.drop_index("ix_task_messages_q_kind", table_name="task_messages")
    op.drop_column("task_messages", "tool_path")
    op.drop_column("task_messages", "q_kind")

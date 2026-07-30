"""Record which model answered, per request and per task.

A stored ``api_req_started`` message carries tokens, cache figures and cost —
but no model, so a conversation can be read end to end without ever learning
what produced it. The ``LLM Completion`` telemetry event knows, and names its
task, but only inside a JSON blob: finding a task's events meant scanning and
parsing every row in ``telemetry_events`` (13 164 of them on the live
deployment, 146 MB of text).

This lifts the join key out of the blob and stores the answer on the task:

  * telemetry_events.task_id — indexed; stamped at ingest from
                               ``properties.taskId``, backfilled here;
  * tasks.models             — distinct model ids, most-used first, so the task
                               list renders a badge without touching JSON.

Per-request attribution stays derived at read time (see
services/model_attribution) — it is a join of two records, not a third record.

Revision ID: d0e1f2a3b4c5
Revises: c9d0e1f2a3b4
Create Date: 2026-07-30 20:00:00.000000

"""

import json

from alembic import op
import sqlalchemy as sa

# revision identifiers, used by Alembic.
revision = "d0e1f2a3b4c5"
down_revision = "c9d0e1f2a3b4"
branch_labels = None
depends_on = None

LLM_COMPLETION_EVENT = "LLM Completion"


def upgrade() -> None:
    op.add_column("telemetry_events", sa.Column("task_id", sa.String(), nullable=True))
    op.create_index("ix_telemetry_events_task_id", "telemetry_events", ["task_id"])
    op.add_column("tasks", sa.Column("models", sa.String(), nullable=True))

    _backfill()


def _backfill() -> None:
    """Stamp task_id on existing events, then roll the models up onto tasks.

    The stamping walks every event once — the only full parse this ever needs,
    which is the point of storing the key. It is done in batches so a corpus of
    any size stays within a sane amount of memory.
    """
    conn = op.get_bind()

    batch = 5000
    offset = 0
    while True:
        rows = conn.execute(
            sa.text(
                "SELECT id, properties FROM telemetry_events "
                "ORDER BY id LIMIT :limit OFFSET :offset"
            ),
            {"limit": batch, "offset": offset},
        ).fetchall()
        if not rows:
            break
        offset += len(rows)

        updates = []
        for row_id, payload in rows:
            try:
                props = json.loads(payload or "{}")
            except (json.JSONDecodeError, TypeError):
                continue
            if not isinstance(props, dict):
                continue
            task_id = props.get("taskId")
            if isinstance(task_id, str) and task_id:
                updates.append({"row_id": row_id, "task_id": task_id})
        if updates:
            conn.execute(
                sa.text("UPDATE telemetry_events SET task_id = :task_id WHERE id = :row_id"),
                updates,
            )

    # Now the rollup, over the freshly indexed column. Ordered by request count
    # descending so the label leads with the model that did most of the work —
    # the same order services/model_attribution.models_label produces.
    task_ids = [r[0] for r in conn.execute(sa.text("SELECT id FROM tasks")).fetchall()]
    for task_id in task_ids:
        rows = conn.execute(
            sa.text(
                "SELECT properties FROM telemetry_events "
                "WHERE task_id = :tid AND event_type = :evt"
            ),
            {"tid": task_id, "evt": LLM_COMPLETION_EVENT},
        ).fetchall()
        counts: dict[str, int] = {}
        for (payload,) in rows:
            try:
                props = json.loads(payload or "{}")
            except (json.JSONDecodeError, TypeError):
                continue
            if not isinstance(props, dict):
                continue
            model = props.get("modelId")
            if isinstance(model, str) and model:
                counts[model] = counts.get(model, 0) + 1
        if not counts:
            continue
        label = ", ".join(
            name for name, _ in sorted(counts.items(), key=lambda kv: (-kv[1], kv[0]))
        )
        conn.execute(
            sa.text("UPDATE tasks SET models = :models WHERE id = :tid"),
            {"models": label, "tid": task_id},
        )


def downgrade() -> None:
    op.drop_column("tasks", "models")
    op.drop_index("ix_telemetry_events_task_id", table_name="telemetry_events")
    op.drop_column("telemetry_events", "task_id")

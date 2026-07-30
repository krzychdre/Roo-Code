"""Record which task spawned which — the subtask tree.

Roo Code runs a subtask as a task in its own right, and the only place the
relationship is ever stated is telemetry (`taskId` + `parentTaskId` on
`Task Created` and later events). Nothing consumed it, so subtasks appeared in
the web view as flat, orphaned entries with no way back to the run they
belonged to.

Adds:
  * task_relations — the durable child→parent record, written from telemetry.
    It carries no foreign keys on purpose: the link is normally known while
    neither task exists as a row (a subtask announces its parent when it
    starts; the row appears when messages are first stored, which at share time
    can be hours later).
  * tasks.parent_task_id — the denormalized copy the views render from.

and backfills both from the telemetry already in the database.

Revision ID: a7b8c9d0e1f2
Revises: f6a7b8c9d0e1
Create Date: 2026-07-30 15:00:00.000000

"""

import json

from alembic import op
import sqlalchemy as sa

# revision identifiers, used by Alembic.
revision = "a7b8c9d0e1f2"
down_revision = "f6a7b8c9d0e1"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.create_table(
        "task_relations",
        sa.Column("child_task_id", sa.String(), primary_key=True),
        sa.Column("parent_task_id", sa.String(), nullable=False),
        sa.Column("user_id", sa.String(), nullable=True),
        sa.Column("created_at", sa.DateTime(timezone=True), nullable=True),
    )
    op.create_index("ix_task_relations_parent", "task_relations", ["parent_task_id"])
    op.create_index("ix_task_relations_user_id", "task_relations", ["user_id"])

    op.add_column("tasks", sa.Column("parent_task_id", sa.String(), nullable=True))
    op.create_index("ix_tasks_parent_task_id", "tasks", ["parent_task_id"])
    # Named so the downgrade can drop it; SQLite rewrites the table for this,
    # which alembic handles under batch mode in a fresh DB and which the
    # create_all path never exercises anyway.
    with op.batch_alter_table("tasks") as batch:
        batch.create_foreign_key(
            "fk_tasks_parent_task_id", "tasks", ["parent_task_id"], ["id"], ondelete="SET NULL"
        )

    _backfill()


def _backfill() -> None:
    """Recover every link telemetry already recorded."""
    conn = op.get_bind()

    seen: dict[str, tuple[str, str | None]] = {}
    rows = conn.execute(
        sa.text("SELECT user_id, properties FROM telemetry_events ORDER BY created_at")
    )
    for user_id, payload in rows:
        try:
            props = json.loads(payload or "{}")
        except (json.JSONDecodeError, TypeError):
            continue
        if not isinstance(props, dict):
            continue
        child = props.get("taskId")
        parent = props.get("parentTaskId")
        if not child or not parent or child == parent or child in seen:
            continue
        seen[child] = (parent, user_id)

    if seen:
        conn.execute(
            sa.text(
                "INSERT INTO task_relations (child_task_id, parent_task_id, user_id) "
                "VALUES (:child, :parent, :user_id)"
            ),
            [
                {"child": child, "parent": parent, "user_id": user_id}
                for child, (parent, user_id) in seen.items()
            ],
        )

    # Stamp the tasks that exist. The join to `tasks AS p` is what enforces the
    # new foreign key: a subtask whose parent was never shared keeps a NULL
    # parent rather than pointing at a row that does not exist.
    conn.execute(
        sa.text(
            """
            UPDATE tasks SET parent_task_id = (
                SELECT r.parent_task_id FROM task_relations r
                WHERE r.child_task_id = tasks.id
                  AND EXISTS (SELECT 1 FROM tasks p WHERE p.id = r.parent_task_id)
            )
            WHERE parent_task_id IS NULL
            """
        )
    )


def downgrade() -> None:
    with op.batch_alter_table("tasks") as batch:
        batch.drop_constraint("fk_tasks_parent_task_id", type_="foreignkey")
    op.drop_index("ix_tasks_parent_task_id", table_name="tasks")
    op.drop_column("tasks", "parent_task_id")
    op.drop_index("ix_task_relations_user_id", table_name="task_relations")
    op.drop_index("ix_task_relations_parent", table_name="task_relations")
    op.drop_table("task_relations")

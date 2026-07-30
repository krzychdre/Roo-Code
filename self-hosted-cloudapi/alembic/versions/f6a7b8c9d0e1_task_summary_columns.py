"""Denormalize the task display summary onto tasks/task_messages.

The web task list derived its title, message count, tokens and cost by loading
every message of every task and JSON-parsing it on each page view — 387 queries
and 205 MB of text for 2.47s of server time on the live deployment, growing
linearly with the corpus.

This adds:
  * task_messages.{tokens_in,tokens_out,cache_reads,cache_writes,cost}
    — each message's contribution, parsed exactly once at write time;
  * tasks.{title,message_count,tokens_in,tokens_out,cache_reads,cache_writes,
    cost,first_ts,last_ts} — the rollup the list actually renders;
  * ix_tasks_user_updated — so "this user's tasks, newest first" is an
    index-ordered scan of one page rather than a sort of every owned row.

and backfills all of it from the existing rows. The backfill is the only place
the historical corpus is ever parsed again.

Revision ID: f6a7b8c9d0e1
Revises: e5f6a7b8c9d0
Create Date: 2026-07-30 12:00:00.000000

"""

import json

from alembic import op
import sqlalchemy as sa

# revision identifiers, used by Alembic.
revision = "f6a7b8c9d0e1"
down_revision = "e5f6a7b8c9d0"
branch_labels = None
depends_on = None


_MESSAGE_COLUMNS = ("tokens_in", "tokens_out", "cache_reads", "cache_writes")
_TASK_COLUMNS = ("message_count", "tokens_in", "tokens_out", "cache_reads", "cache_writes")

# Rows per chunk while backfilling. The corpus is ~200 MB of JSON, so it is
# streamed rather than materialized: a full SELECT would peak at the whole
# table in memory inside the migration process.
_CHUNK = 2000


def upgrade() -> None:
    for name in _MESSAGE_COLUMNS:
        op.add_column(
            "task_messages",
            sa.Column(name, sa.BigInteger(), nullable=False, server_default="0"),
        )
    op.add_column(
        "task_messages",
        sa.Column("cost", sa.Float(), nullable=False, server_default="0"),
    )

    op.add_column("tasks", sa.Column("title", sa.String(), nullable=True))
    op.add_column(
        "tasks",
        sa.Column("message_count", sa.Integer(), nullable=False, server_default="0"),
    )
    for name in ("tokens_in", "tokens_out", "cache_reads", "cache_writes"):
        op.add_column(
            "tasks",
            sa.Column(name, sa.BigInteger(), nullable=False, server_default="0"),
        )
    op.add_column("tasks", sa.Column("cost", sa.Float(), nullable=False, server_default="0"))
    op.add_column("tasks", sa.Column("first_ts", sa.BigInteger(), nullable=True))
    op.add_column("tasks", sa.Column("last_ts", sa.BigInteger(), nullable=True))

    op.create_index("ix_tasks_user_updated", "tasks", ["user_id", "updated_at"])

    _backfill()


def _backfill() -> None:
    """Fill the new columns from the stored messages.

    Imported lazily so the migration module stays importable without the app
    package on the path (alembic's env.py already puts it there, but autogenerate
    tooling sometimes does not).
    """
    from src.services.task_summary import derive_title, message_metrics

    conn = op.get_bind()

    # --- per-message metrics ---------------------------------------------
    offset = 0
    while True:
        rows = conn.execute(
            sa.text(
                "SELECT id, message_data FROM task_messages "
                "ORDER BY id LIMIT :limit OFFSET :offset"
            ),
            {"limit": _CHUNK, "offset": offset},
        ).fetchall()
        if not rows:
            break

        updates = []
        for row_id, payload in rows:
            try:
                msg = json.loads(payload)
            except (json.JSONDecodeError, TypeError):
                continue
            if not isinstance(msg, dict):
                continue
            metrics = message_metrics(msg)
            # Skip the all-zero majority: writing them back would be 55k
            # pointless UPDATEs, and the server_default already made them 0.
            if metrics.tokens_in or metrics.tokens_out or metrics.cache_reads \
                    or metrics.cache_writes or metrics.cost:
                updates.append({"row_id": row_id, **metrics.as_columns()})

        if updates:
            conn.execute(
                sa.text(
                    "UPDATE task_messages SET tokens_in = :tokens_in, "
                    "tokens_out = :tokens_out, cache_reads = :cache_reads, "
                    "cache_writes = :cache_writes, cost = :cost WHERE id = :row_id"
                ),
                updates,
            )
        offset += _CHUNK

    # --- task rollups ------------------------------------------------------
    conn.execute(
        sa.text(
            """
            UPDATE tasks SET
                message_count = COALESCE(agg.n, 0),
                tokens_in     = COALESCE(agg.tokens_in, 0),
                tokens_out    = COALESCE(agg.tokens_out, 0),
                cache_reads   = COALESCE(agg.cache_reads, 0),
                cache_writes  = COALESCE(agg.cache_writes, 0),
                cost          = COALESCE(agg.cost, 0),
                first_ts      = agg.first_ts,
                last_ts       = agg.last_ts
            FROM (
                SELECT task_id,
                       COUNT(*)             AS n,
                       SUM(tokens_in)       AS tokens_in,
                       SUM(tokens_out)      AS tokens_out,
                       SUM(cache_reads)     AS cache_reads,
                       SUM(cache_writes)    AS cache_writes,
                       SUM(cost)            AS cost,
                       MIN(message_ts)      AS first_ts,
                       MAX(message_ts)      AS last_ts
                FROM task_messages GROUP BY task_id
            ) AS agg
            WHERE tasks.id = agg.task_id
            """
        )
        if conn.dialect.name == "postgresql"
        else sa.text(
            """
            UPDATE tasks SET
                message_count = (SELECT COUNT(*) FROM task_messages m WHERE m.task_id = tasks.id),
                tokens_in     = (SELECT COALESCE(SUM(tokens_in), 0) FROM task_messages m WHERE m.task_id = tasks.id),
                tokens_out    = (SELECT COALESCE(SUM(tokens_out), 0) FROM task_messages m WHERE m.task_id = tasks.id),
                cache_reads   = (SELECT COALESCE(SUM(cache_reads), 0) FROM task_messages m WHERE m.task_id = tasks.id),
                cache_writes  = (SELECT COALESCE(SUM(cache_writes), 0) FROM task_messages m WHERE m.task_id = tasks.id),
                cost          = (SELECT COALESCE(SUM(cost), 0) FROM task_messages m WHERE m.task_id = tasks.id),
                first_ts      = (SELECT MIN(message_ts) FROM task_messages m WHERE m.task_id = tasks.id),
                last_ts       = (SELECT MAX(message_ts) FROM task_messages m WHERE m.task_id = tasks.id)
            """
        )
    )

    # --- titles ------------------------------------------------------------
    # Derived from the opening text-bearing message, so only the earliest few
    # rows of each task are needed — not the whole conversation.
    task_ids = [r[0] for r in conn.execute(sa.text("SELECT id FROM tasks")).fetchall()]
    for task_id in task_ids:
        rows = conn.execute(
            sa.text(
                "SELECT message_data FROM task_messages WHERE task_id = :tid "
                "ORDER BY message_ts NULLS LAST, id LIMIT 40"
            )
            if conn.dialect.name == "postgresql"
            else sa.text(
                "SELECT message_data FROM task_messages WHERE task_id = :tid "
                "ORDER BY message_ts, id LIMIT 40"
            ),
            {"tid": task_id},
        ).fetchall()

        messages = []
        for (payload,) in rows:
            try:
                msg = json.loads(payload)
            except (json.JSONDecodeError, TypeError):
                continue
            if isinstance(msg, dict):
                messages.append(msg)
        messages.sort(key=lambda m: m.get("ts") or 0)

        conn.execute(
            sa.text("UPDATE tasks SET title = :title WHERE id = :tid"),
            {"title": derive_title(messages), "tid": task_id},
        )


def downgrade() -> None:
    op.drop_index("ix_tasks_user_updated", table_name="tasks")
    for name in ("last_ts", "first_ts", "cost", "cache_writes", "cache_reads",
                 "tokens_out", "tokens_in", "message_count", "title"):
        op.drop_column("tasks", name)
    for name in ("cost", "cache_writes", "cache_reads", "tokens_out", "tokens_in"):
        op.drop_column("task_messages", name)

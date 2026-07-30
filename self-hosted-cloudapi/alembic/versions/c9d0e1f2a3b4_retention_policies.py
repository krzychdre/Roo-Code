"""Per-user data-retention policy.

Nothing in this deployment ever deleted anything on its own, and the storage
shows it: task_messages reached 479 MB and telemetry_events 146 MB, the latter
duplicating the former (the `Task Message` event carries the whole
ClineMessage). This adds the policy table; the sweep that uses it lives in
services/retention_service.

Created switched OFF for every existing user. Retention deletes conversations
permanently, so it must never be something a deployment acquires by upgrading.

Revision ID: c9d0e1f2a3b4
Revises: b8c9d0e1f2a3
Create Date: 2026-07-30 17:00:00.000000

"""

from alembic import op
import sqlalchemy as sa

# revision identifiers, used by Alembic.
revision = "c9d0e1f2a3b4"
down_revision = "b8c9d0e1f2a3"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.create_table(
        "retention_policies",
        sa.Column(
            "user_id",
            sa.String(),
            sa.ForeignKey("users.id", ondelete="CASCADE"),
            primary_key=True,
        ),
        sa.Column("enabled", sa.Boolean(), nullable=False, server_default=sa.false()),
        sa.Column("max_age_days", sa.Integer(), nullable=True),
        sa.Column("max_tasks", sa.Integer(), nullable=True),
        sa.Column("keep_shared", sa.Boolean(), nullable=False, server_default=sa.true()),
        sa.Column(
            "purge_telemetry", sa.Boolean(), nullable=False, server_default=sa.false()
        ),
        sa.Column("telemetry_max_age_days", sa.Integer(), nullable=True),
        sa.Column("last_run_at", sa.DateTime(timezone=True), nullable=True),
        sa.Column(
            "last_deleted_tasks", sa.Integer(), nullable=False, server_default="0"
        ),
        sa.Column(
            "last_deleted_events", sa.Integer(), nullable=False, server_default="0"
        ),
        sa.Column(
            "created_at", sa.DateTime(timezone=True), server_default=sa.func.now(), nullable=False
        ),
        sa.Column(
            "updated_at", sa.DateTime(timezone=True), server_default=sa.func.now(), nullable=False
        ),
    )


def downgrade() -> None:
    op.drop_table("retention_policies")

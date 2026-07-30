"""Per-user data-retention policy.

Nothing in this deployment ever deleted anything on its own, and the storage
shows it: ``task_messages`` reached 479 MB and ``telemetry_events`` 146 MB, with
the latter *duplicating* the former — the ``Task Message`` event carries the
whole ClineMessage, so every shared conversation is stored twice, in two tables,
in two formats.

The policy is per user rather than global because ownership is per user
everywhere else in this schema, and a sweep must never touch rows it cannot
attribute.
"""

from sqlalchemy import Boolean, Column, DateTime, ForeignKey, Integer, String

from src.models.base import Base, TimestampMixin

# Values the settings form offers as placeholders. They are SUGGESTIONS, not
# defaults: a fresh policy has every limit NULL and the switch off, so it
# selects nothing at all. Pre-loading a limit would mean "Run now" could delete
# months of conversations for a user who had only just opened the page — the
# preview would show it, but nobody should have to read a preview to avoid
# losing data they never configured.
SUGGESTED_MAX_AGE_DAYS = 90
SUGGESTED_MAX_TASKS = 500
SUGGESTED_TELEMETRY_MAX_AGE_DAYS = 30


class RetentionPolicy(Base, TimestampMixin):
    """When a user's stored tasks and raw telemetry should be deleted."""

    __tablename__ = "retention_policies"

    user_id = Column(
        String, ForeignKey("users.id", ondelete="CASCADE"), primary_key=True
    )

    enabled = Column(Boolean, nullable=False, default=False, server_default="0")

    # Age limit for tasks. NULL disables this rule (the count limit may still
    # apply), rather than meaning "delete everything".
    max_age_days = Column(Integer, nullable=True)
    # Keep at most this many tasks, newest first. NULL disables the rule.
    max_tasks = Column(Integer, nullable=True)

    # Shared tasks are the ones deliberately published to a link, so they are
    # exempt by default — a retention sweep should not silently break a URL
    # somebody was handed.
    keep_shared = Column(Boolean, nullable=False, default=True, server_default="1")

    # Raw telemetry has its own, shorter window: the `Task Message` events
    # duplicate `task_messages` and are the bulk of that table. `LLM Completion`
    # is never swept — the metrics page is built entirely from it, and losing it
    # would erase the cost history the tasks themselves cannot reconstruct.
    purge_telemetry = Column(Boolean, nullable=False, default=False, server_default="0")
    telemetry_max_age_days = Column(Integer, nullable=True)

    # When the sweep last ran for this user, so the scheduler can be idle
    # without a timer of its own and the settings page can report it.
    last_run_at = Column(DateTime(timezone=True), nullable=True)
    last_deleted_tasks = Column(Integer, nullable=False, default=0, server_default="0")
    last_deleted_events = Column(Integer, nullable=False, default=0, server_default="0")

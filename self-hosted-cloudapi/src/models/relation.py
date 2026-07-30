"""Parent/child links between tasks.

Why this is its own table rather than only a column on ``tasks``
---------------------------------------------------------------
A subtask announces its parent in the ``Task Created`` telemetry event, which
fires the moment the subtask starts. The ``tasks`` row, by contrast, only comes
into existence when messages are first stored — at share/backfill time that can
be hours later, and even on the live bridge the ordering against the event is a
race. So the link is routinely known while neither task exists as a row, and
there is nowhere on ``tasks`` to put it yet.

This table is the durable record of the relationship, written whenever
telemetry reveals it. ``tasks.parent_task_id`` is a denormalized copy of it,
stamped when the task row appears, so the list and detail views can render the
hierarchy without a lookup per row (the same write-time approach as
services/task_summary).

Deliberately no foreign keys: a link may reference tasks that have not been
stored — and may never be, if the subtask is never shared.
"""

from datetime import datetime, timezone

from sqlalchemy import Column, String, DateTime, Index

from src.models.base import Base


class TaskRelation(Base):
    """A child task and the task that spawned it."""

    __tablename__ = "task_relations"

    # One parent per child, and the child id is the natural key.
    child_task_id = Column(String, primary_key=True)
    parent_task_id = Column(String, nullable=False)
    # Kept so a relation can be attributed (and purged) with its owner even
    # though neither task may exist as a row yet.
    user_id = Column(String, nullable=True, index=True)
    created_at = Column(DateTime(timezone=True), default=lambda: datetime.now(timezone.utc))

    __table_args__ = (
        Index("ix_task_relations_parent", "parent_task_id"),
    )

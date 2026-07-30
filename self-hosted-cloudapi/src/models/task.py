"""Task, TaskMessage, and TaskShare models."""

import uuid
from sqlalchemy import (
    Column,
    String,
    Text,
    Float,
    Integer,
    Boolean,
    ForeignKey,
    DateTime,
    BigInteger,
    UniqueConstraint,
    Index,
)
from sqlalchemy.orm import relationship
from datetime import datetime, timezone

from src.models.base import Base, TimestampMixin, generate_id


class Task(Base, TimestampMixin):
    """Task model for tracking shared tasks."""
    __tablename__ = "tasks"

    id = Column(String, primary_key=True, default=lambda: str(uuid.uuid4()))
    user_id = Column(String, ForeignKey("users.id", ondelete="CASCADE"), nullable=False, index=True)
    organization_id = Column(String, ForeignKey("organizations.id", ondelete="SET NULL"), nullable=True)
    # Absolute path of the VS Code workspace folder (worktree root) the task was
    # attached to, captured from the bridge's extension:register `workspacePath`
    # or the share/backfill payload. Nullable: legacy rows and tasks created
    # while the bridge was offline (and the client sent nothing) have no value.
    workspace_path = Column(String, nullable=True)

    # The task that spawned this one, when it is a subtask. Denormalized from
    # task_relations (which is written from telemetry, often before either task
    # row exists) so the list and detail views can render the hierarchy without
    # a lookup per row. ON DELETE SET NULL: deleting a parent orphans its
    # children rather than cascading their conversations away.
    parent_task_id = Column(
        String, ForeignKey("tasks.id", ondelete="SET NULL"), nullable=True, index=True
    )

    # --- denormalized display summary -------------------------------------
    # Maintained by services/task_summary.refresh_task_summary() on every write
    # so the task list renders from one indexed query instead of re-parsing the
    # whole message corpus per page view. Nullable/zero-defaulted: rows written
    # before this existed are filled by the migration's backfill.
    title = Column(String, nullable=True)
    message_count = Column(Integer, nullable=False, default=0, server_default="0")
    tokens_in = Column(BigInteger, nullable=False, default=0, server_default="0")
    tokens_out = Column(BigInteger, nullable=False, default=0, server_default="0")
    cache_reads = Column(BigInteger, nullable=False, default=0, server_default="0")
    cache_writes = Column(BigInteger, nullable=False, default=0, server_default="0")
    cost = Column(Float, nullable=False, default=0.0, server_default="0")
    # ClineMessage.ts of the first/last stored message. Kept as the endpoints
    # rather than only their difference so an incremental refresh can widen the
    # span without re-reading the conversation.
    first_ts = Column(BigInteger, nullable=True)
    last_ts = Column(BigInteger, nullable=True)
    # Distinct model ids this task ran on, most-used first, comma-joined — the
    # one thing the stored conversation cannot say (`api_req_started` carries no
    # model). Derived from LLM Completion telemetry; see
    # services/model_attribution. NULL when no completion event is known.
    models = Column(String, nullable=True)

    # --- session quality ---------------------------------------------------
    # Counts of deterministic markers in the conversation (services/
    # session_quality), rolled up the same way as the token totals so a list can
    # grade a run without reading it. Tokens say what a run cost; these say
    # whether it went well.
    q_requests = Column(Integer, nullable=False, default=0, server_default="0")
    q_errors = Column(Integer, nullable=False, default=0, server_default="0")
    q_retries = Column(Integer, nullable=False, default=0, server_default="0")
    q_interventions = Column(Integer, nullable=False, default=0, server_default="0")
    q_completion_replies = Column(Integer, nullable=False, default=0, server_default="0")
    q_condense = Column(Integer, nullable=False, default=0, server_default="0")
    q_tools = Column(Integer, nullable=False, default=0, server_default="0")
    # Total and distinct (tool, path) pairs; their difference is repeated work.
    q_tool_paths = Column(Integer, nullable=False, default=0, server_default="0")
    q_distinct_tool_paths = Column(Integer, nullable=False, default=0, server_default="0")
    q_completed = Column(Boolean, nullable=False, default=False, server_default="0")

    messages = relationship("TaskMessage", back_populates="task", cascade="all, delete-orphan")
    shares = relationship("TaskShare", back_populates="task", cascade="all, delete-orphan")

    # The list is always "this user's tasks, newest first" — a composite index
    # makes that an index-ordered scan of just the page being shown, instead of
    # sorting every row the user owns on each request.
    __table_args__ = (
        Index("ix_tasks_user_updated", "user_id", "updated_at"),
    )


class TaskMessage(Base):
    """Task message model for backfill."""
    __tablename__ = "task_messages"

    id = Column(String, primary_key=True, default=lambda: generate_id("msg_"))
    task_id = Column(String, ForeignKey("tasks.id", ondelete="CASCADE"), nullable=False, index=True)
    message_data = Column(Text, nullable=False)
    # ClineMessage.ts of the stored message. Lets the live bridge upsert a
    # streaming message in place (created → partial updates → final) instead of
    # appending duplicate rows. Nullable for legacy/backfilled rows.
    message_ts = Column(BigInteger, nullable=True, index=True)
    created_at = Column(DateTime(timezone=True), default=lambda: datetime.now(timezone.utc))

    # --- per-message token/cost contribution -------------------------------
    # Parsed once from `message_data` at write time (services/task_summary.
    # message_metrics) so the task rollup is a numeric SUM over an index rather
    # than a JSON parse of the whole conversation. Zero for the vast majority of
    # messages — only `api_req_started` and `condense_context` carry figures.
    tokens_in = Column(BigInteger, nullable=False, default=0, server_default="0")
    tokens_out = Column(BigInteger, nullable=False, default=0, server_default="0")
    cache_reads = Column(BigInteger, nullable=False, default=0, server_default="0")
    cache_writes = Column(BigInteger, nullable=False, default=0, server_default="0")
    cost = Column(Float, nullable=False, default=0.0, server_default="0")

    # --- quality marker ----------------------------------------------------
    # What this message says about how the run is going: request / error /
    # retry / intervention / completion_reply / condense / tool / completion,
    # or NULL
    # for the majority that say nothing (see services/session_quality). Indexed
    # because the task rollup counts by it.
    q_kind = Column(String, nullable=True, index=True)
    # For a tool message, the "<tool>:<path>" it touched. Counting these against
    # their distinct values is how repeated work is measured.
    tool_path = Column(String, nullable=True)

    # The bridge upserts a streaming message in place via ON CONFLICT on this
    # pair. NULL message_ts stays distinct, so legacy/backfilled rows still
    # append. See migration d4e5f6a7b8c9.
    __table_args__ = (
        UniqueConstraint("task_id", "message_ts", name="uq_task_messages_task_ts"),
    )

    task = relationship("Task", back_populates="messages")


class TaskShare(Base):
    """Task share model."""
    __tablename__ = "task_shares"

    id = Column(String, primary_key=True, default=lambda: generate_id("sh_"))
    task_id = Column(String, ForeignKey("tasks.id", ondelete="CASCADE"), nullable=False, index=True)
    visibility = Column(String, default="organization")
    share_url = Column(String, nullable=True)
    manage_url = Column(String, nullable=True)
    expires_at = Column(DateTime(timezone=True), nullable=True)
    created_at = Column(DateTime(timezone=True), default=lambda: datetime.now(timezone.utc))

    task = relationship("Task", back_populates="shares")

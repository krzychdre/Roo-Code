"""Applying a retention policy — and, first, saying exactly what it would do.

Design rule for this module: **nothing deletes without being able to say what it
is about to delete.** Every entry point comes in a pair — ``plan_*`` decides and
reports, ``apply_*`` executes exactly that plan. The settings page runs the plan
on every page load and shows it; the sweep runs the plan and then acts on it.
The two can never disagree, because they are the same function.

Two rules select tasks, and a task goes if *either* matches:

  age    older than ``max_age_days``, measured on ``updated_at`` (when the task
         was last written — the only time the row itself carries)
  count  beyond the newest ``max_tasks``

Shared tasks are exempt while ``keep_shared`` is set: a share URL was handed to
somebody, and a sweep should not silently break it.

Telemetry is swept separately and more aggressively, because ``Task Message``
events carry a full copy of every stored conversation — 146 MB duplicating the
479 MB in ``task_messages`` on this deployment. ``LLM Completion`` is **never**
swept: the whole metrics page is built from it, and the tasks cannot
reconstruct the cost history it holds.
"""

from __future__ import annotations

import logging
from dataclasses import dataclass, field
from datetime import datetime, timedelta, timezone
from typing import Optional

from sqlalchemy import delete, func, select
from sqlalchemy.ext.asyncio import AsyncSession

from src.models.event import TelemetryEvent
from src.models.retention import RetentionPolicy
from src.models.task import Task, TaskMessage, TaskShare
from src.services.share_service import delete_tasks

logger = logging.getLogger(__name__)

# Telemetry event types the sweep must never remove, whatever the policy says.
# The metrics page aggregates LLM Completion exclusively; nothing else in the
# database can reproduce what it records.
PROTECTED_EVENT_TYPES = ("LLM Completion",)


@dataclass
class RetentionPlan:
    """What a sweep would delete, and why — computed without deleting anything."""

    task_ids: list[str] = field(default_factory=list)
    # task_id -> the rule that selected it, for the preview.
    reasons: dict[str, str] = field(default_factory=dict)
    message_count: int = 0
    event_count: int = 0
    # Approximate bytes reclaimed: the stored JSON payloads, which are the bulk
    # of both tables. Index and row overhead are not included, so this reads as
    # a floor rather than a promise.
    message_bytes: int = 0
    event_bytes: int = 0
    exempt_shared: int = 0

    @property
    def task_count(self) -> int:
        return len(self.task_ids)

    @property
    def total_bytes(self) -> int:
        return self.message_bytes + self.event_bytes

    @property
    def is_empty(self) -> bool:
        return not self.task_ids and not self.event_count


async def get_policy(db: AsyncSession, user_id: str) -> RetentionPolicy:
    """The user's policy, creating a disabled default the first time it is read.

    Created rather than returned-as-None so the settings form always has a row
    to bind to; ``enabled`` is False, so merely opening the page never arms
    anything.
    """
    result = await db.execute(
        select(RetentionPolicy).where(RetentionPolicy.user_id == user_id)
    )
    policy = result.scalar_one_or_none()
    if policy is None:
        policy = RetentionPolicy(user_id=user_id)
        db.add(policy)
        await db.flush()
    return policy


async def plan_sweep(
    db: AsyncSession,
    user_id: str,
    policy: RetentionPolicy,
    now: Optional[datetime] = None,
) -> RetentionPlan:
    """Work out what applying ``policy`` would delete. Touches nothing.

    Runs whether or not the policy is enabled: the settings page shows the
    preview *before* you switch it on, which is the only point at which the
    preview is genuinely useful.
    """
    now = now or datetime.now(timezone.utc)
    plan = RetentionPlan()

    shared_ids: set[str] = set()
    if policy.keep_shared:
        result = await db.execute(
            select(TaskShare.task_id)
            .join(Task, Task.id == TaskShare.task_id)
            .where(Task.user_id == user_id)
        )
        shared_ids = {row[0] for row in result.all()}

    result = await db.execute(
        select(Task.id, Task.updated_at)
        .where(Task.user_id == user_id)
        .order_by(Task.updated_at.desc())
    )
    rows = result.all()

    cutoff = (
        now - timedelta(days=policy.max_age_days)
        if policy.max_age_days and policy.max_age_days > 0
        else None
    )

    for index, (task_id, updated_at) in enumerate(rows):
        reason = None
        if cutoff is not None and updated_at is not None:
            # Rows can come back naive from SQLite; compare like with like
            # rather than raising on the first task the sweep looks at.
            stamp = updated_at if updated_at.tzinfo else updated_at.replace(tzinfo=timezone.utc)
            if stamp < cutoff:
                reason = f"older than {policy.max_age_days} days"
        if reason is None and policy.max_tasks and index >= policy.max_tasks:
            reason = f"beyond the newest {policy.max_tasks}"
        if reason is None:
            continue
        if task_id in shared_ids:
            plan.exempt_shared += 1
            continue
        plan.task_ids.append(task_id)
        plan.reasons[task_id] = reason

    if plan.task_ids:
        counted = await db.execute(
            select(
                func.count(TaskMessage.id),
                func.coalesce(func.sum(func.length(TaskMessage.message_data)), 0),
            ).where(TaskMessage.task_id.in_(plan.task_ids))
        )
        plan.message_count, plan.message_bytes = counted.one()

    if policy.purge_telemetry and policy.telemetry_max_age_days:
        event_cutoff = now - timedelta(days=policy.telemetry_max_age_days)
        counted = await db.execute(
            select(
                func.count(TelemetryEvent.id),
                func.coalesce(func.sum(func.length(TelemetryEvent.properties)), 0),
            ).where(*_telemetry_filters(user_id, event_cutoff))
        )
        plan.event_count, plan.event_bytes = counted.one()

    return plan


def _telemetry_filters(user_id: str, cutoff: datetime):
    """Rows a telemetry sweep may take: this user's, old enough, not protected."""
    return (
        TelemetryEvent.user_id == user_id,
        TelemetryEvent.created_at < cutoff,
        TelemetryEvent.event_type.not_in(PROTECTED_EVENT_TYPES),
    )


async def apply_sweep(
    db: AsyncSession,
    user_id: str,
    policy: RetentionPolicy,
    plan: Optional[RetentionPlan] = None,
    now: Optional[datetime] = None,
) -> RetentionPlan:
    """Delete exactly what ``plan_sweep`` selected, and record that it ran.

    Accepts a pre-computed plan so a caller that has already shown one to the
    user acts on that same plan rather than recomputing and possibly deleting
    something the user never saw.
    """
    now = now or datetime.now(timezone.utc)
    plan = plan or await plan_sweep(db, user_id, policy, now=now)

    if plan.task_ids:
        # Reuses the ownership-checked delete: a retention sweep must obey the
        # same rule as a button press, not a looser one.
        await delete_tasks(db, plan.task_ids, user_id)

    if plan.event_count and policy.purge_telemetry and policy.telemetry_max_age_days:
        event_cutoff = now - timedelta(days=policy.telemetry_max_age_days)
        await db.execute(delete(TelemetryEvent).where(*_telemetry_filters(user_id, event_cutoff)))

    policy.last_run_at = now
    policy.last_deleted_tasks = plan.task_count
    policy.last_deleted_events = plan.event_count
    await db.flush()

    if not plan.is_empty:
        logger.info(
            "[retention] %s: removed %s task(s), %s message(s), %s event(s) (~%s bytes)",
            user_id,
            plan.task_count,
            plan.message_count,
            plan.event_count,
            plan.total_bytes,
        )
    return plan


async def sweep_all_enabled(db: AsyncSession, now: Optional[datetime] = None) -> int:
    """Run the sweep for every user who has switched retention on.

    Returns the number of policies processed. Each user is handled
    independently: one user's data failing to delete must not stop the rest.
    """
    result = await db.execute(
        select(RetentionPolicy).where(RetentionPolicy.enabled == True)  # noqa: E712
    )
    policies = list(result.scalars().all())
    for policy in policies:
        try:
            await apply_sweep(db, policy.user_id, policy, now=now)
        except Exception:  # one user's failure must not abort the rest
            logger.exception("[retention] sweep failed for %s", policy.user_id)
    return len(policies)

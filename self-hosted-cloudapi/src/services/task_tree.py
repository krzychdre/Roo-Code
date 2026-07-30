"""Parent/child task relationships — recording them, and reading the tree.

Where the data comes from
-------------------------
Roo Code spawns a subtask as a task in its own right, with its own id and its
own conversation. The only place the relationship is stated is telemetry: every
``Task Created`` (and in practice several later events) carries ``taskId``
alongside ``parentTaskId`` and ``isSubtask``. Nothing consumed it, so the web
view showed 150 subtasks as flat, orphaned entries with no way to tell which
run they belonged to.

Recording is two-sided because the event and the task row do not arrive in a
fixed order:

  * ``record_relation`` runs on every telemetry event that names a parent. It
    writes ``task_relations`` (which needs neither task to exist) and, if the
    child's row happens to be there already, stamps it.
  * ``adopt_from_relations`` runs when a task row is created, and stamps it from
    whatever ``task_relations`` already knows.

Between them the link survives either ordering, and no event has to be replayed.
"""

from __future__ import annotations

import logging
from typing import Iterable, Optional

from sqlalchemy import select, update
from sqlalchemy.ext.asyncio import AsyncSession

from src.models.relation import TaskRelation
from src.models.task import Task

logger = logging.getLogger(__name__)


async def record_relation(
    db: AsyncSession,
    properties: dict,
    user_id: Optional[str] = None,
) -> None:
    """Record a child→parent link if this event's properties carry one.

    Silent no-op for the overwhelming majority of events, which name no parent.
    Idempotent: the same link arriving on a hundred later events writes once.
    A task never changes parent, so an existing link is never overwritten.
    """
    if not isinstance(properties, dict):
        return
    child = properties.get("taskId")
    parent = properties.get("parentTaskId")
    if not child or not parent or child == parent:
        return

    existing = await db.execute(
        select(TaskRelation.child_task_id).where(TaskRelation.child_task_id == child)
    )
    if existing.scalar_one_or_none() is None:
        db.add(TaskRelation(child_task_id=child, parent_task_id=parent, user_id=user_id))
        await db.flush()

    # The child's row may already exist (a live task streams messages while its
    # events fire). Stamp it now so the tree is right without waiting for a
    # later write. Never overwrites an existing parent.
    await db.execute(
        update(Task)
        .where(Task.id == child, Task.parent_task_id.is_(None))
        .values(parent_task_id=parent)
    )


async def adopt_from_relations(db: AsyncSession, task_id: str) -> None:
    """Stamp a freshly created task row with the parent telemetry already knew.

    Called from the task-creation paths (backfill and the live bridge). The
    parent is only stamped when the parent task actually exists as a row —
    ``tasks.parent_task_id`` is a foreign key, and a subtask whose parent was
    never shared would otherwise fail to insert.
    """
    result = await db.execute(
        select(TaskRelation.parent_task_id).where(TaskRelation.child_task_id == task_id)
    )
    parent = result.scalar_one_or_none()
    if not parent:
        return

    parent_exists = await db.execute(select(Task.id).where(Task.id == parent))
    if parent_exists.scalar_one_or_none() is None:
        return

    await db.execute(
        update(Task)
        .where(Task.id == task_id, Task.parent_task_id.is_(None))
        .values(parent_task_id=parent)
    )


async def link_pending_children(db: AsyncSession, parent_task_id: str) -> None:
    """Attach children that were waiting for this parent's row to exist.

    The reverse of ``adopt_from_relations``: a subtask is frequently stored
    before its parent (the parent is still running when the child finishes and
    gets shared), so its stamp was skipped for want of a foreign-key target.
    When the parent finally lands, claim them.
    """
    result = await db.execute(
        select(TaskRelation.child_task_id).where(TaskRelation.parent_task_id == parent_task_id)
    )
    children = [row[0] for row in result.all()]
    if not children:
        return
    await db.execute(
        update(Task)
        .where(Task.id.in_(children), Task.parent_task_id.is_(None))
        .values(parent_task_id=parent_task_id)
    )


async def child_counts(db: AsyncSession, task_ids: Iterable[str]) -> dict[str, int]:
    """How many stored subtasks each of these tasks has. One query, not N."""
    ids = [t for t in task_ids if t]
    if not ids:
        return {}
    from sqlalchemy import func

    result = await db.execute(
        select(Task.parent_task_id, func.count(Task.id))
        .where(Task.parent_task_id.in_(ids))
        .group_by(Task.parent_task_id)
    )
    return {row[0]: row[1] for row in result.all()}


async def ancestors(db: AsyncSession, task: Task, limit: int = 10) -> list[Task]:
    """The chain from ``task``'s parent up to the root, nearest first.

    Bounded by ``limit`` and by a seen-set: the data comes from a client, and a
    cycle (however impossible in principle) must not hang a page render.
    """
    chain: list[Task] = []
    seen = {task.id}
    current = task
    while current.parent_task_id and len(chain) < limit:
        if current.parent_task_id in seen:
            logger.warning("[task_tree] cycle at task %s; stopping walk", current.id)
            break
        seen.add(current.parent_task_id)
        result = await db.execute(select(Task).where(Task.id == current.parent_task_id))
        parent = result.scalar_one_or_none()
        if parent is None:
            break
        chain.append(parent)
        current = parent
    return chain


async def children_of(db: AsyncSession, task_id: str) -> list[Task]:
    """Stored subtasks of a task, oldest first — the order they were spawned."""
    result = await db.execute(
        select(Task).where(Task.parent_task_id == task_id).order_by(Task.created_at)
    )
    return list(result.scalars().all())

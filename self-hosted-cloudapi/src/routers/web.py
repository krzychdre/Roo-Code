"""Web task viewer router.

Server-rendered pages (Jinja2) for browsing shared tasks in a browser:
- GET /app                  task list for the logged-in user
- GET /app/tasks/{task_id}  read-only conversation view (owner only)
- GET /shared/{task_id}     public share-link target (anon if visibility=public)

Login/logout live in routers/browser.py (/app/login, /app/logout) because they
reuse the Authentik OAuth flow there. Conversation rendering is done client-side
by static/render.js from the embedded ClineMessage[] JSON.
"""

import json
import logging
from pathlib import Path
from typing import Optional

from fastapi import APIRouter, Depends, Query, Request
from fastapi.responses import HTMLResponse, RedirectResponse
from fastapi.templating import Jinja2Templates
from sqlalchemy import select, func, or_
from sqlalchemy.ext.asyncio import AsyncSession

from config.settings import settings
from src.database import get_db
from src.auth.web_session import WebUser, get_web_user_optional
from src.models.task import Task, TaskMessage, TaskShare
from src.models.organization import Membership
from src.services.share_service import delete_shared_task
from src.services.metrics_service import (
    DEFAULT_PERIOD,
    PERIOD_LABELS,
    compute_user_metrics,
)
from src.services.task_summary import DEFAULT_TITLE, derive_title, duration_ms
from src.services.task_tree import ancestors, child_counts, children_of
from src.utils.format import fmt_duration, fmt_tokens

logger = logging.getLogger(__name__)

_WEB_DIR = Path(__file__).resolve().parent.parent / "web"
templates = Jinja2Templates(directory=str(_WEB_DIR / "templates"))


def _asset_version() -> str:
    """Cache-busting token: newest mtime across the static bundle.

    Appended as ``?v=<token>`` to CSS/JS URLs so a browser refetches the
    assets whenever they change instead of serving a stale cached copy
    (the page HTML is dynamic, but ``/static/*`` is otherwise cached hard).
    Recomputed at import — the server is restarted to pick up edits.
    """
    static_dir = _WEB_DIR / "static"
    try:
        latest = max(p.stat().st_mtime_ns for p in static_dir.rglob("*") if p.is_file())
    except ValueError:
        return "0"
    return format(latest, "x")


templates.env.globals["asset_v"] = _asset_version()

router = APIRouter(tags=["web"])

# How many tasks one page of the list shows. The corpus on a working
# deployment runs to hundreds of tasks; rendering all of them was never a
# deliberate choice, just the absence of paging.
PAGE_SIZE = 25


def _workspace_label(path: str | None) -> str | None:
    """Compact project/worktree name for a badge: the last path segment.

    The full absolute path is kept for the tooltip/header so sibling worktrees
    that share a basename (e.g. two checkouts both named ``Roo-Code``) can still
    be told apart on hover. Handles both POSIX and Windows separators since the
    path is whatever the client's OS reported.
    """
    if not path:
        return None
    trimmed = path.replace("\\", "/").rstrip("/")
    if not trimmed:
        return None
    return trimmed.rsplit("/", 1)[-1] or trimmed


def _tree_entry(task: Task) -> dict:
    """Compact view-model for a task shown as somebody else's relative.

    Used by the breadcrumb and the subtask panel, where a task appears as a link
    with its own headline figures rather than as a full list row.
    """
    span = duration_ms(task.first_ts, task.last_ts)
    tokens = (task.tokens_in or 0) + (task.tokens_out or 0)
    return {
        "id": task.id,
        "title": task.title or DEFAULT_TITLE,
        "message_count": task.message_count or 0,
        "tokens": fmt_tokens(tokens) if tokens else None,
        "cost": f"${task.cost:.4f}" if (task.cost or 0) > 0 else None,
        "duration": fmt_duration(span) if span else None,
    }


def _metrics_tooltip(task: Task) -> str:
    """Multi-line hover breakdown (native title tooltips honour the newlines).

    Reads the denormalized columns on the task row — the whole point of
    services/task_summary is that the list never re-derives these.
    """
    lines = [
        f"↑ In: {task.tokens_in:,}",
        f"↓ Out: {task.tokens_out:,}",
    ]
    if task.cache_writes or task.cache_reads:
        lines.append(f"⚡ Cache: {task.cache_writes:,} write / {task.cache_reads:,} read")
    span = duration_ms(task.first_ts, task.last_ts)
    if span:
        lines.append(f"⏱ Session: {fmt_duration(span)}")
    lines.append(f"$ Cost: ${task.cost:.4f}")
    return "\n".join(lines)


def _parse_messages(rows: list[TaskMessage]) -> list[dict]:
    """Decode and sort stored TaskMessage rows into ClineMessage dicts."""
    parsed: list[dict] = []
    for row in rows:
        try:
            data = json.loads(row.message_data)
        except (json.JSONDecodeError, TypeError):
            continue
        if isinstance(data, dict):
            parsed.append(data)
    parsed.sort(key=lambda m: m.get("ts", 0))
    return parsed


async def _load_task_messages(db: AsyncSession, task_id: str) -> list[dict]:
    result = await db.execute(
        select(TaskMessage).where(TaskMessage.task_id == task_id)
    )
    return _parse_messages(list(result.scalars().all()))


@router.get("/app", response_class=HTMLResponse)
async def task_list(
    request: Request,
    page: int = Query(1, ge=1),
    q: str = Query("", max_length=200),
    scope: str = Query("roots"),
    user: Optional[WebUser] = Depends(get_web_user_optional),
    db: AsyncSession = Depends(get_db),
):
    """List the logged-in user's shared tasks, newest first, one page at a time.

    Every column shown comes from the task row itself (see
    services/task_summary), so this is a single indexed query regardless of how
    many messages the conversations hold. It used to load and JSON-parse the
    entire corpus — 387 queries and 205 MB per request on the live deployment.

    ``scope=roots`` (the default) hides subtasks, which are reached by opening
    the run that spawned them. On the live deployment 150 of 387 tasks are
    subtasks, so listing them flat buried the actual runs among their own
    fragments. ``scope=all`` restores the flat list.
    """
    if user is None:
        return RedirectResponse(url="/app/login", status_code=303)

    search = q.strip()
    scope = scope if scope in ("roots", "all") else "roots"
    filters = [Task.user_id == user["user_id"]]
    if search:
        pattern = f"%{search}%"
        filters.append(or_(Task.title.ilike(pattern), Task.workspace_path.ilike(pattern)))
    if scope == "roots":
        filters.append(Task.parent_task_id.is_(None))

    total = await db.scalar(select(func.count(Task.id)).where(*filters)) or 0
    page_count = max(1, (total + PAGE_SIZE - 1) // PAGE_SIZE)
    page = min(page, page_count)

    result = await db.execute(
        select(Task)
        .where(*filters)
        .order_by(Task.updated_at.desc())
        .limit(PAGE_SIZE)
        .offset((page - 1) * PAGE_SIZE)
    )

    page_tasks = list(result.scalars().all())
    # One grouped query for the whole page rather than a count per row.
    counts = await child_counts(db, [t.id for t in page_tasks])

    items = []
    for task in page_tasks:
        total_tokens = (task.tokens_in or 0) + (task.tokens_out or 0)
        has_metrics = total_tokens > 0 or (task.cost or 0) > 0
        span = duration_ms(task.first_ts, task.last_ts)
        items.append(
            {
                "id": task.id,
                "title": task.title or DEFAULT_TITLE,
                "message_count": task.message_count or 0,
                "updated_at": task.updated_at,
                "tokens": fmt_tokens(total_tokens) if total_tokens else None,
                "cost": f"${task.cost:.4f}" if (task.cost or 0) > 0 else None,
                "duration": fmt_duration(span) if span else None,
                "metrics_title": _metrics_tooltip(task) if has_metrics else None,
                "workspace": task.workspace_path,
                "workspace_label": _workspace_label(task.workspace_path),
                "child_count": counts.get(task.id, 0),
                "is_subtask": task.parent_task_id is not None,
            }
        )

    # Shown on the scope toggle so the cost of switching is visible up front.
    all_total = await db.scalar(
        select(func.count(Task.id)).where(Task.user_id == user["user_id"])
    ) or 0

    return templates.TemplateResponse(
        request,
        "tasks_list.html",
        {
            "user": user,
            "tasks": items,
            "nav_active": "tasks",
            "query": search,
            "scope": scope,
            "page": page,
            "page_count": page_count,
            "total": total,
            "all_total": all_total,
            "has_prev": page > 1,
            "has_next": page < page_count,
        },
    )


@router.get("/app/metrics", response_class=HTMLResponse)
async def metrics_page(
    request: Request,
    period: str = DEFAULT_PERIOD,
    user: Optional[WebUser] = Depends(get_web_user_optional),
    db: AsyncSession = Depends(get_db),
):
    """Usage-metrics dashboard for the logged-in user.

    Aggregates LLM Completion telemetry (tokens / cost / duration / models /
    modes) over the selected period. See services/metrics_service.py.
    """
    if user is None:
        return RedirectResponse(url="/app/login", status_code=303)

    metrics = await compute_user_metrics(db, user["user_id"], period)
    periods = [
        {"key": key, "label": label, "active": key == metrics["period"]}
        for key, label in PERIOD_LABELS.items()
    ]
    return templates.TemplateResponse(
        request,
        "metrics.html",
        {
            "user": user,
            "nav_active": "metrics",
            "metrics": metrics,
            "periods": periods,
            "chart_json": json.dumps(metrics["chart"]),
        },
    )


@router.get("/app/tasks/{task_id}", response_class=HTMLResponse)
async def task_detail(
    task_id: str,
    request: Request,
    user: Optional[WebUser] = Depends(get_web_user_optional),
    db: AsyncSession = Depends(get_db),
):
    """Read-only conversation view for a task the user owns."""
    if user is None:
        return RedirectResponse(url="/app/login", status_code=303)

    result = await db.execute(select(Task).where(Task.id == task_id))
    task = result.scalar_one_or_none()
    if task is None or task.user_id != user["user_id"]:
        return templates.TemplateResponse(
            request,
            "not_found.html",
            {"user": user},
            status_code=404,
        )

    messages = await _load_task_messages(db, task_id)
    # The owner view is live: it can drive the task through the socket.io bridge
    # (extension ↔ backend ↔ browser). Disabled when the bridge is off.
    live = settings.bridge_enabled
    # Nearest-first from ancestors(); the trail reads root → … → here.
    trail = list(reversed(await ancestors(db, task)))
    return templates.TemplateResponse(
        request,
        "task_detail.html",
        {
            "user": user,
            "task": task,
            "ancestors": [_tree_entry(t) for t in trail],
            "subtasks": [_tree_entry(t) for t in await children_of(db, task_id)],
            # The stored title is authoritative; deriving it again is only a
            # fallback for a row written before the summary columns existed and
            # somehow missed the migration's backfill.
            "title": task.title or derive_title(messages),
            "workspace": task.workspace_path,
            "workspace_label": _workspace_label(task.workspace_path),
            "messages_json": json.dumps(messages),
            "share_url": None,
            "live": live,
            "can_delete": True,
            # A conversation is prose, so the page switches to the reading
            # measure instead of the wider scanning column the list uses.
            "read_measure": True,
            "live_config_json": json.dumps({"taskId": task_id, "bridgePath": settings.bridge_path}),
        },
    )


@router.post("/app/tasks/{task_id}/delete")
async def delete_task(
    task_id: str,
    user: Optional[WebUser] = Depends(get_web_user_optional),
    db: AsyncSession = Depends(get_db),
):
    """Permanently delete a task the user owns (row + messages + share).

    Owner-only; a non-owner / unknown id is a silent no-op (see
    ``delete_shared_task``). Always redirects back to the task list, so the
    POST is idempotent and refresh-safe.
    """
    if user is None:
        return RedirectResponse(url="/app/login", status_code=303)

    await delete_shared_task(db, task_id, user["user_id"])
    return RedirectResponse(url="/app", status_code=303)


@router.get("/shared/{task_id}", response_class=HTMLResponse)
async def shared_task(
    task_id: str,
    request: Request,
    user: Optional[WebUser] = Depends(get_web_user_optional),
    db: AsyncSession = Depends(get_db),
):
    """Public share-link target. Anonymous when visibility=public, else requires login."""
    result = await db.execute(select(TaskShare).where(TaskShare.task_id == task_id))
    share = result.scalar_one_or_none()

    if share is None:
        return templates.TemplateResponse(
            request,
            "not_found.html",
            {"user": user},
            status_code=404,
        )

    if share.visibility != "public" and user is None:
        # Organization/private share viewed anonymously → require login.
        return RedirectResponse(url="/app/login", status_code=303)

    # The share link is live (remote-controllable) only for the task's owner — so a
    # freshly-shared task is drivable straight from its share URL. Anonymous and
    # non-owner viewers stay strictly read-only. The backend independently enforces
    # the same owner-only rule (task:join DB ownership check + per-user command relay).
    task_result = await db.execute(select(Task).where(Task.id == task_id))
    task = task_result.scalar_one_or_none()
    is_owner = user is not None and task is not None and task.user_id == user["user_id"]

    # For non-public shares, enforce org membership: the viewer must be the task
    # owner or share an organization with the task owner. This prevents a logged-in
    # user from a different org reading another org's private conversation.
    if share.visibility != "public" and not is_owner:
        allowed = False
        if task is not None and task.organization_id is not None and user is not None:
            member_result = await db.execute(
                select(Membership).where(
                    Membership.user_id == user["user_id"],
                    Membership.organization_id == task.organization_id,
                )
            )
            allowed = member_result.scalar_one_or_none() is not None
        if not allowed:
            return templates.TemplateResponse(
                request,
                "not_found.html",
                {"user": user},
                status_code=404,
            )

    live = bool(settings.bridge_enabled and is_owner)

    messages = await _load_task_messages(db, task_id)
    return templates.TemplateResponse(
        request,
        "task_detail.html",
        {
            "user": user,
            "task": {"id": task_id},
            "title": (task.title if task is not None else None) or derive_title(messages),
            "messages_json": json.dumps(messages),
            "share_url": share.share_url,
            "live": live,
            "can_delete": is_owner,
            "read_measure": True,
            "live_config_json": (
                json.dumps({"taskId": task_id, "bridgePath": settings.bridge_path})
                if live
                else "{}"
            ),
        },
    )

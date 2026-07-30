"""Tests for the share/backfill pipeline fixes and the web task viewer.

Covers the three backend blockers that were preventing tasks from ever
persisting, plus the new server-rendered web routes:

- Blocker B: POST /api/extension/share returns 404 (not 200) for an unknown
  task, so the extension knows to backfill and retry.
- Blocker C: POST /api/events/backfill creates the parent Task row and replaces
  the message set idempotently on re-share.
- Web: /app requires a session; task detail enforces ownership; /shared honours
  the share visibility.
"""

import json

import pytest
from sqlalchemy import select, func

from src.dependencies import get_current_user
from src.auth.web_session import get_web_user_optional, WebUser
from src.models.user import User
from src.models.task import Task, TaskMessage, TaskShare
from src.models.event import TelemetryEvent
from src.realtime.hub import registry
from src.services.settings_service import get_extension_settings
from src.services.metrics_service import compute_user_metrics


# --- helpers ---------------------------------------------------------------


async def _seed_user(db_session, user_id="user_test", email="t@example.com"):
    user = User(
        id=user_id,
        authentik_id=f"ak_{user_id}",
        email=email,
        first_name="Test",
        last_name="User",
    )
    db_session.add(user)
    await db_session.commit()
    return user


def _override_current_user(client_app, user_id="user_test"):
    client_app.dependency_overrides[get_current_user] = lambda: {
        "user_id": user_id,
        "org_id": None,
    }


def _override_web_user(client_app, user_id="user_test", email="t@example.com"):
    web_user: WebUser = {
        "user_id": user_id,
        "session_id": "sess_test",
        "email": email,
        "name": "Test User",
        "image_url": None,
    }
    client_app.dependency_overrides[get_web_user_optional] = lambda: web_user


def _msgs():
    return [
        {"ts": 1, "type": "say", "say": "text", "text": "Build me a feature"},
        {"ts": 2, "type": "say", "say": "reasoning", "text": "thinking..."},
        {"ts": 3, "type": "say", "say": "completion_result", "text": "Done"},
    ]


async def _add_message(session, task_id: str, message: dict) -> None:
    """Insert one message the way the real write path does.

    Production never stores a TaskMessage without also recording the token/cost
    figures it contributes (services/task_summary.message_metrics) — the task
    list reads those columns instead of re-parsing the conversation. A bare
    ``session.add(TaskMessage(...))`` would leave them at zero, so tests that
    took that shortcut would assert against a state production never produces.
    """
    from src.services.task_summary import message_metrics

    session.add(
        TaskMessage(
            task_id=task_id,
            message_data=json.dumps(message),
            message_ts=message.get("ts"),
            **message_metrics(message).as_columns(),
        )
    )


async def _summarize(session, *task_ids: str) -> None:
    """Roll the seeded messages up onto their task rows.

    The counterpart of the refresh that ``backfill_messages`` /
    ``upsert_task_message`` perform after every write.
    """
    from src.services.task_summary import derive_title, refresh_task_summary

    await session.flush()
    for task_id in task_ids:
        rows = await session.execute(
            select(TaskMessage.message_data).where(TaskMessage.task_id == task_id)
        )
        messages = []
        for (payload,) in rows.all():
            try:
                parsed = json.loads(payload)
            except (json.JSONDecodeError, TypeError):
                continue
            if isinstance(parsed, dict):
                messages.append(parsed)
        messages.sort(key=lambda m: m.get("ts") or 0)
        await refresh_task_summary(
            session, task_id, title=derive_title(messages), force_title=True
        )


def _backfill_files(task_id, messages):
    return {
        "file": ("task.json", json.dumps(messages), "application/json"),
    }, {"taskId": task_id, "properties": "{}"}


# --- Blocker A: org-less settings advertise task sharing with a live version --


async def test_org_less_settings_enable_sharing_with_nonzero_version(db_session):
    """Org-less extension settings must advertise task sharing AND carry a
    non-zero, content-derived version. The client caches org settings and only
    replaces them when `version` changes; a constant 0 leaves an already-cached
    (cloudSettings=null) client with the Share button permanently disabled."""
    res = await get_extension_settings(db=db_session, user_id="user_test", org_id=None)
    data = res.model_dump(by_alias=True)
    org = data["organization"]
    assert org["cloudSettings"]["enableTaskSharing"] is True
    assert org["cloudSettings"]["allowPublicTaskSharing"] is True
    # Must differ from the stale cached default of 0 so the client refreshes.
    assert org["version"] != 0


def _find_nulls(obj, path=""):
    """Return dotted paths of every JSON `null` found anywhere in the response."""
    out = []
    if isinstance(obj, dict):
        for k, v in obj.items():
            out.append(f"{path}.{k}") if v is None else out.extend(_find_nulls(v, f"{path}.{k}"))
    elif isinstance(obj, list):
        for i, v in enumerate(obj):
            out.extend(_find_nulls(v, f"{path}[{i}]"))
    return out


async def test_extension_settings_http_has_no_null_fields(client, db_session):
    """The serialized /api/extension-settings response must contain NO JSON nulls.

    The client parses this with Zod schemas whose optional fields use `.optional()`,
    which accepts `undefined` but REJECTS `null`. If Pydantic serializes unset
    Optionals as null, the client parse fails, CloudSettingsService never caches the
    settings, `canShareTask()` returns false, and the Share button is permanently
    disabled. `response_model_exclude_none=True` on the route prevents this.
    """
    await _seed_user(db_session)
    from src.main import app

    _override_current_user(app)
    try:
        resp = client.get("/api/extension-settings")
    finally:
        app.dependency_overrides.pop(get_current_user, None)

    assert resp.status_code == 200
    data = resp.json()
    nulls = _find_nulls(data)
    assert nulls == [], f"response must not contain null fields, found: {nulls}"
    assert data["organization"]["cloudSettings"]["enableTaskSharing"] is True


# --- Blocker B: share returns 404 for unknown task -------------------------


async def test_share_unknown_task_returns_404(client, db_session):
    await _seed_user(db_session)
    from src.main import app

    _override_current_user(app)
    try:
        resp = client.post(
            "/api/extension/share",
            json={"taskId": "does-not-exist", "visibility": "organization"},
        )
    finally:
        app.dependency_overrides.pop(get_current_user, None)

    assert resp.status_code == 404


async def test_share_existing_task_response_has_no_null_fields(
    client, db_session, session_factory
):
    """The serialized /api/extension/share success body must contain NO JSON nulls.

    The client parses this with the Zod shareResponseSchema whose optional fields use
    `.optional()`, which accepts `undefined` but REJECTS `null`. Without
    `response_model_exclude_none=True`, the unset `error` field serializes as null,
    the client parse throws, and the extension shows "Failed to share task" even
    though the share row was created. `response_model_exclude_none=True` prevents it.
    """
    await _seed_user(db_session)
    from src.main import app

    _override_current_user(app)
    # Backfill first so the parent Task row exists (share 404s otherwise).
    files, data = _backfill_files("task-share", _msgs())
    try:
        client.post("/api/events/backfill", files=files, data=data)
        resp = client.post(
            "/api/extension/share",
            json={"taskId": "task-share", "visibility": "organization"},
        )
    finally:
        app.dependency_overrides.pop(get_current_user, None)

    assert resp.status_code == 200
    body = resp.json()
    nulls = _find_nulls(body)
    assert nulls == [], f"share response must not contain null fields, found: {nulls}"
    assert body["success"] is True
    assert "error" not in body  # unset Optional must be omitted, never null
    assert body["shareUrl"].endswith("/shared/task-share")


# --- Blocker C: backfill creates Task + replaces messages ------------------


async def test_backfill_creates_task_and_messages(client, db_session, session_factory):
    await _seed_user(db_session)
    from src.main import app

    _override_current_user(app)
    files, data = _backfill_files("task-1", _msgs())
    try:
        resp = client.post("/api/events/backfill", files=files, data=data)
    finally:
        app.dependency_overrides.pop(get_current_user, None)

    assert resp.status_code == 200

    async with session_factory() as s:
        task = (await s.execute(select(Task).where(Task.id == "task-1"))).scalar_one()
        assert task.user_id == "user_test"
        n = (
            await s.execute(
                select(func.count(TaskMessage.id)).where(TaskMessage.task_id == "task-1")
            )
        ).scalar_one()
        assert n == 3


async def test_backfill_is_idempotent_on_reshare(client, db_session, session_factory):
    await _seed_user(db_session)
    from src.main import app

    _override_current_user(app)
    try:
        files, data = _backfill_files("task-2", _msgs())
        client.post("/api/events/backfill", files=files, data=data)
        # Re-share with a different (shorter) message set.
        files, data = _backfill_files("task-2", _msgs()[:1])
        client.post("/api/events/backfill", files=files, data=data)
    finally:
        app.dependency_overrides.pop(get_current_user, None)

    async with session_factory() as s:
        n = (
            await s.execute(
                select(func.count(TaskMessage.id)).where(TaskMessage.task_id == "task-2")
            )
        ).scalar_one()
        # Replaced, not appended.
        assert n == 1
        tasks = (await s.execute(select(func.count(Task.id)).where(Task.id == "task-2"))).scalar_one()
        assert tasks == 1


async def test_backfill_persists_explicit_workspace_path(client, db_session, session_factory):
    """The explicit client `workspacePath` field is stamped on the task, so an
    offline share (no live bridge) still records its project/worktree."""
    await _seed_user(db_session)
    from src.main import app

    ws = "/home/krzych/Projekty/QUB-IT/Roo-Code-worktree-x"
    _override_current_user(app)
    files, data = _backfill_files("task-ws-explicit", _msgs())
    data["workspacePath"] = ws
    try:
        resp = client.post("/api/events/backfill", files=files, data=data)
    finally:
        app.dependency_overrides.pop(get_current_user, None)

    assert resp.status_code == 200
    async with session_factory() as s:
        task = (await s.execute(select(Task).where(Task.id == "task-ws-explicit"))).scalar_one()
        assert task.workspace_path == ws


async def test_backfill_falls_back_to_registry_workspace_path(client, db_session, session_factory):
    """An older client that doesn't send `workspacePath` still gets the project
    recorded, sourced from the live registered instance for that user."""
    await _seed_user(db_session)
    from src.main import app

    ws = "/home/krzych/Projekty/QUB-IT/Roo-Code"
    registry.register_extension("ext_fallback", "user_test", {"workspacePath": ws})

    _override_current_user(app)
    files, data = _backfill_files("task-ws-fallback", _msgs())  # no workspacePath field
    try:
        resp = client.post("/api/events/backfill", files=files, data=data)
    finally:
        app.dependency_overrides.pop(get_current_user, None)
        registry.detach("ext_fallback")

    assert resp.status_code == 200
    async with session_factory() as s:
        task = (await s.execute(select(Task).where(Task.id == "task-ws-fallback"))).scalar_one()
        assert task.workspace_path == ws


# --- Web: /app requires a session ------------------------------------------


async def test_app_redirects_to_login_without_session(client):
    resp = client.get("/app", follow_redirects=False)
    assert resp.status_code == 303
    assert resp.headers["location"] == "/app/login"


async def test_app_lists_owned_tasks(client, db_session, session_factory):
    await _seed_user(db_session)
    async with session_factory() as s:
        s.add(Task(id="task-9", user_id="user_test"))
        await _add_message(s, "task-9", _msgs()[0])
        await _summarize(s, "task-9")
        await s.commit()

    from src.main import app

    _override_web_user(app)
    try:
        resp = client.get("/app")
    finally:
        app.dependency_overrides.pop(get_web_user_optional, None)

    assert resp.status_code == 200
    assert "Build me a feature" in resp.text


async def test_title_strips_environment_details_wrapper(client, db_session, session_factory):
    """A first turn in Roo Code's API-prompt form (typed text wrapped in
    <user_message>, trailed by a machine <environment_details> block) yields a
    title of just the user's query — no mode/file-tree leakage."""
    await _seed_user(db_session)
    wrapped = (
        "<user_message>\n"
        "uruchom wszystkie testy w langgrapha\n"
        "</user_message> <environment_details>\n"
        "# VSCode Visible Files\n.roo/rules/rules.md\n\n"
        "# Current Mode\n<slug>code</slug>\n<name>💻 Code</name>\n"
        "</environment_details>"
    )
    async with session_factory() as s:
        s.add(Task(id="task-wrapped", user_id="user_test"))
        await _add_message(
            s, "task-wrapped", {"ts": 1, "type": "say", "say": "text", "text": wrapped}
        )
        await _summarize(s, "task-wrapped")
        await s.commit()

    from src.main import app

    _override_web_user(app)
    try:
        list_resp = client.get("/app")
        detail_resp = client.get("/app/tasks/task-wrapped")
    finally:
        app.dependency_overrides.pop(get_web_user_optional, None)

    assert list_resp.status_code == 200
    assert "uruchom wszystkie testy w langgrapha" in list_resp.text
    # The machine framing must not bleed into the title.
    for leak in ("environment_details", "Current Mode", "<user_message>", "<slug>"):
        assert leak not in list_resp.text
    assert detail_resp.status_code == 200
    assert "uruchom wszystkie testy w langgrapha" in detail_resp.text


async def test_app_list_and_detail_show_workspace(client, db_session, session_factory):
    """The list shows the worktree basename (full path on hover); the detail header
    shows the full path."""
    await _seed_user(db_session)
    ws = "/home/krzych/Projekty/QUB-IT/Roo-Code-worktree-alpha"
    async with session_factory() as s:
        s.add(Task(id="task-ws-view", user_id="user_test", workspace_path=ws))
        await _add_message(s, "task-ws-view", _msgs()[0])
        await _summarize(s, "task-ws-view")
        await s.commit()

    from src.main import app

    _override_web_user(app)
    try:
        list_resp = client.get("/app")
        detail_resp = client.get("/app/tasks/task-ws-view")
    finally:
        app.dependency_overrides.pop(get_web_user_optional, None)

    assert list_resp.status_code == 200
    # Basename badge, full path as the hover title.
    assert "Roo-Code-worktree-alpha" in list_resp.text
    assert f'title="{ws}"' in list_resp.text

    assert detail_resp.status_code == 200
    assert ws in detail_resp.text


async def test_app_list_without_workspace_renders_cleanly(client, db_session, session_factory):
    """A task with no workspace_path (legacy / bridge-off share) renders without a
    project badge and does not error."""
    await _seed_user(db_session)
    async with session_factory() as s:
        s.add(Task(id="task-no-ws", user_id="user_test", workspace_path=None))
        await _add_message(s, "task-no-ws", _msgs()[0])
        await _summarize(s, "task-no-ws")
        await s.commit()

    from src.main import app

    _override_web_user(app)
    try:
        resp = client.get("/app")
    finally:
        app.dependency_overrides.pop(get_web_user_optional, None)

    assert resp.status_code == 200
    assert "badge-workspace" not in resp.text


async def test_app_list_shows_cost_and_tokens(client, db_session, session_factory):
    await _seed_user(db_session)
    # Two api_req messages 65s apart so duration spans the whole conversation.
    first = {"ts": 1000, "type": "say", "say": "text", "text": "Build me a feature"}
    api_req = {
        "ts": 66000,
        "type": "say",
        "say": "api_req_started",
        "text": json.dumps(
            {
                "tokensIn": 96941,
                "tokensOut": 3365,
                "cacheWrites": 1200,
                "cacheReads": 8400,
                "cost": 0.1234,
            }
        ),
    }
    async with session_factory() as s:
        s.add(Task(id="task-metrics", user_id="user_test"))
        await _add_message(s, "task-metrics", first)
        await _add_message(s, "task-metrics", api_req)
        await _summarize(s, "task-metrics")
        await s.commit()

    from src.main import app

    _override_web_user(app)
    try:
        resp = client.get("/app")
    finally:
        app.dependency_overrides.pop(get_web_user_optional, None)

    assert resp.status_code == 200
    # 96941 + 3365 = 100306 → "100.3k"; cost rendered to 4 dp. The unit is a
    # separate element, so assert on the figure — that is what must be right.
    assert "100.3k" in resp.text
    assert "$0.1234" in resp.text
    # Hover tooltip breakdown: in/out, cache, session duration, cost.
    assert "↑ In: 96,941" in resp.text
    assert "↓ Out: 3,365" in resp.text
    assert "1,200 write / 8,400 read" in resp.text
    assert "⏱ Session: 1m 5s" in resp.text


# --- Web: task detail enforces ownership -----------------------------------


async def test_task_detail_not_found_for_non_owner(client, db_session, session_factory):
    await _seed_user(db_session, user_id="owner", email="owner@example.com")
    async with session_factory() as s:
        s.add(Task(id="task-owned", user_id="owner"))
        await s.commit()

    from src.main import app

    _override_web_user(app, user_id="intruder")
    try:
        resp = client.get("/app/tasks/task-owned")
    finally:
        app.dependency_overrides.pop(get_web_user_optional, None)

    assert resp.status_code == 404


# --- Web: /shared honours visibility ---------------------------------------


async def test_shared_public_allows_anonymous(client, db_session, session_factory):
    await _seed_user(db_session)
    async with session_factory() as s:
        s.add(Task(id="task-pub", user_id="user_test"))
        await _add_message(s, "task-pub", _msgs()[0])
        s.add(
            TaskShare(
                task_id="task-pub",
                visibility="public",
                share_url="http://testserver/shared/task-pub",
            )
        )
        await _summarize(s, "task-pub")
        await s.commit()

    resp = client.get("/shared/task-pub")
    assert resp.status_code == 200
    assert "Build me a feature" in resp.text


async def test_shared_private_requires_login(client, db_session, session_factory):
    await _seed_user(db_session)
    async with session_factory() as s:
        s.add(Task(id="task-priv", user_id="user_test"))
        s.add(TaskShare(task_id="task-priv", visibility="organization"))
        await s.commit()

    resp = client.get("/shared/task-priv", follow_redirects=False)
    assert resp.status_code == 303
    assert resp.headers["location"] == "/app/login"


async def test_shared_unknown_returns_404(client):
    resp = client.get("/shared/nope")
    assert resp.status_code == 404


# --- Web: live remote-control surface only on the owner page ----------------


async def test_owner_task_detail_renders_live_controls(
    client, db_session, session_factory, monkeypatch
):
    """The owner's task page must expose the interactive bridge surface: the
    live header, the chat/auto-approve controls, and the live.js loader — fed by
    the embedded live-config. This is what makes the page drive the task. The
    page reads `settings.bridge_enabled` per request, so enable it here."""
    from config.settings import settings as app_settings

    monkeypatch.setattr(app_settings, "bridge_enabled", True)

    await _seed_user(db_session)
    async with session_factory() as s:
        s.add(Task(id="task-live", user_id="user_test"))
        await _add_message(s, "task-live", _msgs()[0])
        await _summarize(s, "task-live")
        await s.commit()

    from src.main import app

    _override_web_user(app)
    try:
        resp = client.get("/app/tasks/task-live")
    finally:
        app.dependency_overrides.pop(get_web_user_optional, None)

    assert resp.status_code == 200
    body = resp.text
    assert 'id="live-controls"' in body
    assert 'id="chat-input"' in body
    assert 'id="live-config"' in body
    assert "/static/live.js" in body
    # The config must carry the task id and the bridge path for the client.
    assert '"taskId": "task-live"' in body


async def test_shared_page_anonymous_never_renders_live_controls(
    client, db_session, session_factory, monkeypatch
):
    """A public share link viewed anonymously is strictly read-only — it must NOT
    ship the live controls or the socket.io/live.js bundle, even when the bridge is
    enabled. Control is owner-only."""
    from config.settings import settings as app_settings

    monkeypatch.setattr(app_settings, "bridge_enabled", True)

    await _seed_user(db_session)
    async with session_factory() as s:
        s.add(Task(id="task-pub2", user_id="user_test"))
        await _add_message(s, "task-pub2", _msgs()[0])
        s.add(
            TaskShare(
                task_id="task-pub2",
                visibility="public",
                share_url="http://testserver/shared/task-pub2",
            )
        )
        await _summarize(s, "task-pub2")
        await s.commit()

    resp = client.get("/shared/task-pub2")
    assert resp.status_code == 200
    body = resp.text
    assert 'id="live-controls"' not in body
    assert "/static/live.js" not in body


async def test_shared_owner_gets_live_controls(
    client, db_session, session_factory, monkeypatch
):
    """The owner opening their own share URL gets the live, drivable surface — so a
    freshly-shared task is remote-controllable straight from its share link."""
    from config.settings import settings as app_settings

    monkeypatch.setattr(app_settings, "bridge_enabled", True)

    await _seed_user(db_session)
    async with session_factory() as s:
        s.add(Task(id="task-own-live", user_id="user_test"))
        await _add_message(s, "task-own-live", _msgs()[0])
        s.add(
            TaskShare(
                task_id="task-own-live",
                visibility="public",
                share_url="http://testserver/shared/task-own-live",
            )
        )
        await _summarize(s, "task-own-live")
        await s.commit()

    from src.main import app

    _override_web_user(app)  # logged in as "user_test" (the owner)
    try:
        resp = client.get("/shared/task-own-live")
    finally:
        app.dependency_overrides.pop(get_web_user_optional, None)

    assert resp.status_code == 200
    body = resp.text
    assert 'id="live-controls"' in body
    assert "/static/live.js" in body
    assert '"taskId": "task-own-live"' in body
    # The owner driving their own task is not "read-only".
    assert "read-only" not in body


async def test_delete_task_removes_task_messages_and_share(
    client, db_session, session_factory
):
    """Owner deleting a task wipes the Task row and everything hanging off it —
    messages and share rows — from the DB, and redirects back to the list."""
    await _seed_user(db_session)
    async with session_factory() as s:
        s.add(Task(id="task-del", user_id="user_test"))
        await _add_message(s, "task-del", _msgs()[0])
        s.add(
            TaskShare(
                task_id="task-del",
                visibility="public",
                share_url="http://testserver/shared/task-del",
            )
        )
        await _summarize(s, "task-del")
        await s.commit()

    from src.main import app

    _override_web_user(app)
    try:
        resp = client.post("/app/tasks/task-del/delete", follow_redirects=False)
    finally:
        app.dependency_overrides.pop(get_web_user_optional, None)

    assert resp.status_code == 303
    assert resp.headers["location"] == "/app"

    async with session_factory() as s:
        tasks = (
            await s.execute(select(func.count(Task.id)).where(Task.id == "task-del"))
        ).scalar_one()
        msgs = (
            await s.execute(
                select(func.count(TaskMessage.id)).where(TaskMessage.task_id == "task-del")
            )
        ).scalar_one()
        shares = (
            await s.execute(
                select(func.count(TaskShare.id)).where(TaskShare.task_id == "task-del")
            )
        ).scalar_one()
        assert tasks == 0
        assert msgs == 0
        assert shares == 0


async def test_delete_task_non_owner_is_noop(client, db_session, session_factory):
    """A non-owner POSTing the delete route never touches another user's data:
    the task and its messages survive (silent no-op, still a 303 to the list)."""
    await _seed_user(db_session, user_id="owner", email="owner@example.com")
    async with session_factory() as s:
        s.add(Task(id="task-keep", user_id="owner"))
        await _add_message(s, "task-keep", _msgs()[0])
        await _summarize(s, "task-keep")
        await s.commit()

    from src.main import app

    _override_web_user(app, user_id="intruder", email="intruder@example.com")
    try:
        resp = client.post("/app/tasks/task-keep/delete", follow_redirects=False)
    finally:
        app.dependency_overrides.pop(get_web_user_optional, None)

    assert resp.status_code == 303
    async with session_factory() as s:
        tasks = (
            await s.execute(select(func.count(Task.id)).where(Task.id == "task-keep"))
        ).scalar_one()
        assert tasks == 1


async def test_delete_task_requires_session(client):
    """An unauthenticated delete POST redirects to login and deletes nothing."""
    resp = client.post("/app/tasks/whatever/delete", follow_redirects=False)
    assert resp.status_code == 303
    assert resp.headers["location"] == "/app/login"


async def test_shared_link_404s_after_owner_deletes(
    client, db_session, session_factory
):
    """Once the owner deletes the task, its public /shared link 404s."""
    await _seed_user(db_session)
    async with session_factory() as s:
        s.add(Task(id="task-gone", user_id="user_test"))
        await _add_message(s, "task-gone", _msgs()[0])
        s.add(
            TaskShare(
                task_id="task-gone",
                visibility="public",
                share_url="http://testserver/shared/task-gone",
            )
        )
        await _summarize(s, "task-gone")
        await s.commit()

    # Visible before delete.
    assert client.get("/shared/task-gone").status_code == 200

    from src.main import app

    _override_web_user(app)
    try:
        client.post("/app/tasks/task-gone/delete")
    finally:
        app.dependency_overrides.pop(get_web_user_optional, None)

    assert client.get("/shared/task-gone").status_code == 404


async def test_shared_nonowner_stays_readonly(
    client, db_session, session_factory, monkeypatch
):
    """A logged-in viewer who does NOT own the task gets the read-only share view —
    control never leaks to non-owners."""
    from config.settings import settings as app_settings

    monkeypatch.setattr(app_settings, "bridge_enabled", True)

    await _seed_user(db_session, user_id="owner", email="owner@example.com")
    async with session_factory() as s:
        s.add(Task(id="task-other", user_id="owner"))
        await _add_message(s, "task-other", _msgs()[0])
        s.add(
            TaskShare(
                task_id="task-other",
                visibility="public",
                share_url="http://testserver/shared/task-other",
            )
        )
        await _summarize(s, "task-other")
        await s.commit()

    from src.main import app

    _override_web_user(app, user_id="intruder", email="intruder@example.com")
    try:
        resp = client.get("/shared/task-other")
    finally:
        app.dependency_overrides.pop(get_web_user_optional, None)

    assert resp.status_code == 200
    body = resp.text
    assert 'id="live-controls"' not in body
    assert "/static/live.js" not in body


# --- Metrics page ----------------------------------------------------------


def _llm_event(
    user_id="user_test",
    *,
    model="modelX",
    mode="code",
    provider="openrouter",
    task_id="task-a",
    tin=1000,
    tout=200,
    cread=0,
    cwrite=0,
    cost=0.01,
    created_at=None,
):
    """Build an ``LLM Completion`` telemetry row mirroring the extension payload."""
    from datetime import datetime, timezone

    props = {
        "mode": mode,
        "apiProvider": provider,
        "modelId": model,
        "taskId": task_id,
        "inputTokens": tin,
        "outputTokens": tout,
        "cacheReadTokens": cread,
        "cacheWriteTokens": cwrite,
        "cost": cost,
    }
    return TelemetryEvent(
        user_id=user_id,
        organization_id=None,
        event_type="LLM Completion",
        properties=json.dumps(props),
        created_at=created_at or datetime.now(timezone.utc),
    )


async def test_metrics_redirects_to_login_without_session(client):
    resp = client.get("/app/metrics", follow_redirects=False)
    assert resp.status_code == 303
    assert resp.headers["location"] == "/app/login"


async def test_compute_user_metrics_aggregates_dimensions(db_session):
    """Totals, breakdowns and per-task duration aggregate from LLM Completion events."""
    from datetime import datetime, timezone, timedelta

    await _seed_user(db_session)
    base = datetime(2026, 6, 21, 12, 0, tzinfo=timezone.utc)
    db_session.add_all(
        [
            _llm_event(model="gpt-a", mode="code", task_id="t1", tin=1000, tout=200,
                       cwrite=50, cread=10, cost=0.02, created_at=base),
            _llm_event(model="gpt-a", mode="code", task_id="t1", tin=500, tout=100,
                       cost=0.01, created_at=base + timedelta(minutes=5)),
            _llm_event(model="llama-b", mode="architect", provider="openai",
                       task_id="t2", tin=300, tout=50, cost=0.0, created_at=base),
        ]
    )
    await db_session.commit()

    m = await compute_user_metrics(db_session, "user_test", period="all")

    assert m["totals"]["input"] == 1800
    assert m["totals"]["output"] == 350
    assert m["totals"]["cache_write"] == 50
    assert m["totals"]["cache_read"] == 10
    assert m["totals"]["total_tokens"] == 2150
    assert abs(m["totals"]["cost"] - 0.03) < 1e-9
    assert m["totals"]["completions"] == 3

    # Two tasks; t1 spans 5 minutes, t2 is a single event (0 span).
    assert m["task_count"] == 2
    assert m["duration_ms"] == 5 * 60 * 1000

    # Models sorted desc by tokens: gpt-a (1800) before llama-b (350).
    names = [r["name"] for r in m["by_model"]]
    assert names == ["gpt-a", "llama-b"]
    assert m["by_model"][0]["count"] == 2
    modes = {r["name"] for r in m["by_mode"]}
    assert modes == {"code", "architect"}
    providers = {r["name"] for r in m["by_provider"]}
    assert providers == {"openrouter", "openai"}


async def test_compute_user_metrics_period_filters_old_events(db_session):
    from datetime import datetime, timezone, timedelta

    await _seed_user(db_session)
    now = datetime.now(timezone.utc)
    db_session.add_all(
        [
            _llm_event(task_id="recent", tin=100, tout=10, created_at=now),
            _llm_event(task_id="old", tin=9999, tout=9999,
                       created_at=now - timedelta(days=40)),
        ]
    )
    await db_session.commit()

    m = await compute_user_metrics(db_session, "user_test", period="7d")
    assert m["totals"]["completions"] == 1
    assert m["totals"]["input"] == 100


async def test_compute_user_metrics_scopes_to_user(db_session):
    await _seed_user(db_session)
    await _seed_user(db_session, user_id="other", email="o@example.com")
    db_session.add_all(
        [
            _llm_event(user_id="user_test", tin=100, tout=10),
            _llm_event(user_id="other", tin=5000, tout=5000),
        ]
    )
    await db_session.commit()

    m = await compute_user_metrics(db_session, "user_test", period="all")
    assert m["totals"]["input"] == 100
    assert m["totals"]["completions"] == 1


async def test_metrics_page_renders_dimensions(client, db_session, session_factory):
    await _seed_user(db_session)
    async with session_factory() as s:
        s.add(_llm_event(model="nvidia/nemotron", mode="orchestrator",
                         provider="openrouter", tin=96941, tout=3365, cost=0.1234))
        await s.commit()

    from src.main import app

    _override_web_user(app)
    try:
        resp = client.get("/app/metrics?period=all")
    finally:
        app.dependency_overrides.pop(get_web_user_optional, None)

    assert resp.status_code == 200
    body = resp.text
    assert "nvidia/nemotron" in body
    assert "orchestrator" in body
    assert "$0.1234" in body
    # Chart payload + library are wired when there is data.
    assert "/static/vendor/chart.umd.min.js" in body
    assert 'id="metrics-data"' in body


async def test_metrics_page_empty_state(client, db_session):
    await _seed_user(db_session)
    from src.main import app

    _override_web_user(app)
    try:
        resp = client.get("/app/metrics")
    finally:
        app.dependency_overrides.pop(get_web_user_optional, None)

    assert resp.status_code == 200
    assert "No usage recorded" in resp.text
    # No chart library loaded when there is nothing to plot.
    assert "/static/vendor/chart.umd.min.js" not in resp.text


async def test_web_num_excludes_booleans(client, db_session, session_factory):
    """``num`` (shared util) must NOT count ``True``/``False`` as 1.0/0.0 — Python
    ``bool`` is a subclass of ``int``, so ``isinstance(True, (int, float))`` is
    ``True``. A malformed ``tokensIn: true`` would inflate the task-list total
    by 1.0 while the metrics dashboard (which excludes bools) reports 0,
    diverging the two views. This test feeds a boolean token value and asserts
    the web task-list aggregates it as 0, not 1."""
    from src.utils.format import num

    # Direct unit test of num: bool must be treated as 0
    assert num(True) == 0
    assert num(False) == 0
    assert num(42) == 42.0
    assert num(3.14) == 3.14
    assert num("hello") == 0
    assert num(None) == 0

    # Integration: a task with tokensIn=true must NOT inflate the total
    await _seed_user(db_session)
    first = {"ts": 1000, "type": "say", "say": "text", "text": "Build me a feature"}
    api_req = {
        "ts": 2000,
        "type": "say",
        "say": "api_req_started",
        "text": json.dumps(
            {
                "tokensIn": True,  # malformed boolean — must count as 0
                "tokensOut": 100,
                "cost": 0.05,
            }
        ),
    }
    async with session_factory() as s:
        s.add(Task(id="task-bool", user_id="user_test"))
        await _add_message(s, "task-bool", first)
        await _add_message(s, "task-bool", api_req)
        await _summarize(s, "task-bool")
        await s.commit()

    from src.main import app

    _override_web_user(app)
    try:
        resp = client.get("/app")
    finally:
        app.dependency_overrides.pop(get_web_user_optional, None)

    assert resp.status_code == 200
    # tokens_in should be 0 (bool excluded), tokens_out=100 → total 100, so the
    # list shows the figure 100 and never 101.
    assert ">100<" in resp.text
    assert "101" not in resp.text
    # The tooltip should show In: 0 (not In: 1)
    assert "↑ In: 0" in resp.text


# --- Security: share_task ownership check (BUG A) --------------------------


async def test_share_task_by_non_owner_returns_not_found(client, db_session, session_factory):
    """A user may only share tasks they own. Sharing another user's task must
    return the same 'Task not found' response as a missing task — never leak
    that the task exists, and never create a share row."""
    await _seed_user(db_session, user_id="owner", email="owner@example.com")
    await _seed_user(db_session, user_id="intruder", email="intruder@example.com")
    async with session_factory() as s:
        s.add(Task(id="task-own-a", user_id="owner"))
        await s.commit()

    from src.main import app

    _override_current_user(app, user_id="intruder")
    try:
        resp = client.post(
            "/api/extension/share",
            json={"taskId": "task-own-a", "visibility": "organization"},
        )
    finally:
        app.dependency_overrides.pop(get_current_user, None)

    # The endpoint raises 404 for "Task not found" results.
    assert resp.status_code == 404

    # No share row should have been created.
    async with session_factory() as s:
        shares = (
            await s.execute(
                select(func.count(TaskShare.id)).where(TaskShare.task_id == "task-own-a")
            )
        ).scalar_one()
        assert shares == 0


# --- Security: /shared org-visibility blocks other-org users (BUG B) -------


async def test_shared_organization_visibility_blocks_other_org_user(
    client, db_session, session_factory
):
    """An organization-visibility share must only be viewable by the task owner
    or users who share an organization with the owner. A logged-in user from a
    different org gets 404 (not-found), not the conversation."""
    from src.models.organization import Organization, Membership

    await _seed_user(db_session, user_id="owner", email="owner@example.com")
    await _seed_user(db_session, user_id="viewer", email="viewer@example.com")

    async with session_factory() as s:
        org_a = Organization(id="org-a", name="Org A")
        org_b = Organization(id="org-b", name="Org B")
        s.add_all([org_a, org_b])
        # Owner is in org-a; viewer is in org-b (different org).
        s.add(Membership(user_id="owner", organization_id="org-a", role="org:member"))
        s.add(Membership(user_id="viewer", organization_id="org-b", role="org:member"))
        s.add(Task(id="task-org-vis", user_id="owner", organization_id="org-a"))
        await _add_message(s, "task-org-vis", _msgs()[0])
        s.add(TaskShare(task_id="task-org-vis", visibility="organization"))
        await _summarize(s, "task-org-vis")
        await s.commit()

    from src.main import app

    _override_web_user(app, user_id="viewer", email="viewer@example.com")
    try:
        resp = client.get("/shared/task-org-vis")
    finally:
        app.dependency_overrides.pop(get_web_user_optional, None)

    assert resp.status_code == 404


async def test_shared_organization_visibility_allows_same_org_user(
    client, db_session, session_factory
):
    """A logged-in user in the same org as the task owner CAN view an
    organization-visibility share (positive control for the previous test)."""
    from src.models.organization import Organization, Membership

    await _seed_user(db_session, user_id="owner", email="owner@example.com")
    await _seed_user(db_session, user_id="colleague", email="colleague@example.com")

    async with session_factory() as s:
        org = Organization(id="org-shared", name="Shared Org")
        s.add(org)
        s.add(Membership(user_id="owner", organization_id="org-shared", role="org:member"))
        s.add(Membership(user_id="colleague", organization_id="org-shared", role="org:member"))
        s.add(Task(id="task-org-same", user_id="owner", organization_id="org-shared"))
        await _add_message(s, "task-org-same", _msgs()[0])
        s.add(TaskShare(task_id="task-org-same", visibility="organization"))
        await _summarize(s, "task-org-same")
        await s.commit()

    from src.main import app

    _override_web_user(app, user_id="colleague", email="colleague@example.com")
    try:
        resp = client.get("/shared/task-org-same")
    finally:
        app.dependency_overrides.pop(get_web_user_optional, None)

    assert resp.status_code == 200
    assert "Build me a feature" in resp.text


# --- Security: visibility Literal constraint (BUG C) -----------------------


async def test_share_visibility_rejects_invalid_value(client, db_session, session_factory):
    """The visibility field must only accept 'organization' or 'public'.
    An invalid value is rejected with 422 (Pydantic validation error)."""
    await _seed_user(db_session)
    async with session_factory() as s:
        s.add(Task(id="task-vis", user_id="user_test"))
        await s.commit()

    from src.main import app

    _override_current_user(app)
    try:
        resp = client.post(
            "/api/extension/share",
            json={"taskId": "task-vis", "visibility": "secret"},
        )
    finally:
        app.dependency_overrides.pop(get_current_user, None)

    assert resp.status_code == 422


# --- Security: org policy enforcement server-side (CB-8) -------------------


async def test_share_public_rejected_when_org_disallows_public(client, db_session, session_factory):
    """When the org has allow_public_task_sharing=False, a public-visibility
    share must be rejected with 403. Organization-visibility shares are still
    allowed."""
    from src.models.organization import Organization, Membership
    from src.models.settings import OrganizationSettings

    await _seed_user(db_session, user_id="owner", email="owner@example.com")
    async with session_factory() as s:
        s.add(Organization(id="org-nopub", name="NoPub Org"))
        s.add(Membership(user_id="owner", organization_id="org-nopub", role="org:member"))
        s.add(Task(id="task-nopub", user_id="owner", organization_id="org-nopub"))
        s.add(OrganizationSettings(
            organization_id="org-nopub",
            enable_task_sharing=True,
            allow_public_task_sharing=False,
        ))
        await s.commit()

    from src.main import app

    _override_current_user(app, user_id="owner")
    try:
        resp = client.post(
            "/api/extension/share",
            json={"taskId": "task-nopub", "visibility": "public"},
        )
    finally:
        app.dependency_overrides.pop(get_current_user, None)

    assert resp.status_code == 403

    # No share row should have been created.
    async with session_factory() as s:
        shares = (
            await s.execute(
                select(func.count(TaskShare.id)).where(TaskShare.task_id == "task-nopub")
            )
        ).scalar_one()
        assert shares == 0


async def test_share_organization_allowed_when_org_disallows_public(client, db_session, session_factory):
    """When the org has allow_public_task_sharing=False but enable_task_sharing=True,
    an organization-visibility share is still allowed."""
    from src.models.organization import Organization, Membership
    from src.models.settings import OrganizationSettings

    await _seed_user(db_session, user_id="owner", email="owner@example.com")
    async with session_factory() as s:
        s.add(Organization(id="org-nopub2", name="NoPub Org 2"))
        s.add(Membership(user_id="owner", organization_id="org-nopub2", role="org:member"))
        s.add(Task(id="task-nopub-org", user_id="owner", organization_id="org-nopub2"))
        s.add(OrganizationSettings(
            organization_id="org-nopub2",
            enable_task_sharing=True,
            allow_public_task_sharing=False,
        ))
        await s.commit()

    from src.main import app

    _override_current_user(app, user_id="owner")
    try:
        resp = client.post(
            "/api/extension/share",
            json={"taskId": "task-nopub-org", "visibility": "organization"},
        )
    finally:
        app.dependency_overrides.pop(get_current_user, None)

    assert resp.status_code == 200


async def test_share_all_visibilities_rejected_when_sharing_disabled(client, db_session, session_factory):
    """When the org has enable_task_sharing=False, both visibility values are
    rejected with 403."""
    from src.models.organization import Organization, Membership
    from src.models.settings import OrganizationSettings

    await _seed_user(db_session, user_id="owner", email="owner@example.com")
    async with session_factory() as s:
        s.add(Organization(id="org-noshare", name="NoShare Org"))
        s.add(Membership(user_id="owner", organization_id="org-noshare", role="org:member"))
        s.add(Task(id="task-noshare", user_id="owner", organization_id="org-noshare"))
        s.add(OrganizationSettings(
            organization_id="org-noshare",
            enable_task_sharing=False,
            allow_public_task_sharing=True,
        ))
        await s.commit()

    from src.main import app

    _override_current_user(app, user_id="owner")
    try:
        resp_pub = client.post(
            "/api/extension/share",
            json={"taskId": "task-noshare", "visibility": "public"},
        )
        resp_org = client.post(
            "/api/extension/share",
            json={"taskId": "task-noshare", "visibility": "organization"},
        )
    finally:
        app.dependency_overrides.pop(get_current_user, None)

    assert resp_pub.status_code == 403
    assert resp_org.status_code == 403


async def test_share_allowed_when_no_org_settings_configured(client, db_session, session_factory):
    """When the task has an organization_id but no OrganizationSettings row exists,
    the permissive default applies: both visibilities are allowed (back-compat
    for existing self-hosted deployments that never configured org settings)."""
    from src.models.organization import Organization, Membership

    await _seed_user(db_session, user_id="owner", email="owner@example.com")
    async with session_factory() as s:
        s.add(Organization(id="org-nosettings", name="NoSettings Org"))
        s.add(Membership(user_id="owner", organization_id="org-nosettings", role="org:member"))
        s.add(Task(id="task-nosettings", user_id="owner", organization_id="org-nosettings"))
        await s.commit()

    from src.main import app

    _override_current_user(app, user_id="owner")
    try:
        resp_pub = client.post(
            "/api/extension/share",
            json={"taskId": "task-nosettings", "visibility": "public"},
        )
        resp_org = client.post(
            "/api/extension/share",
            json={"taskId": "task-nosettings", "visibility": "organization"},
        )
    finally:
        app.dependency_overrides.pop(get_current_user, None)

    assert resp_pub.status_code == 200
    assert resp_org.status_code == 200


async def test_format_helpers_are_single_source_of_truth():
    """Every module that counts tokens must use the SAME ``num``/``fmt_tokens``/
    ``fmt_duration`` function objects from ``src.utils.format`` — not local copies.

    This guards against the CB-7 regression: two independent copies of ``_num``
    drifted (one counted ``bool``, one didn't), so a malformed ``tokensIn: true``
    inflated one view and not the other. If any module re-defines a local copy,
    identity fails.

    Token parsing moved out of ``web.py`` into ``task_summary.py`` when the task
    list stopped deriving its numbers at read time, so that module is now the one
    that must be pinned; ``web.py`` only formats what it is handed.
    """
    from src.routers import web
    from src.services import metrics_service, task_summary
    from src.utils import format as fmt

    assert task_summary.num is fmt.num
    assert web.fmt_tokens is fmt.fmt_tokens
    assert web.fmt_duration is fmt.fmt_duration

    # metrics_service aliases ``num`` as ``_num`` for its internal call sites.
    assert metrics_service._num is fmt.num
    assert metrics_service.fmt_tokens is fmt.fmt_tokens
    assert metrics_service.fmt_duration is fmt.fmt_duration


# --- task summary (denormalized display columns) ----------------------------


async def test_backfill_fills_the_task_summary_columns(client, db_session, session_factory):
    """The list renders from columns on the task row, so the write path must fill
    them. Before this existed the list re-parsed every message on every view."""
    await _seed_user(db_session)
    _override_current_user(client.app)
    messages = [
        {"ts": 10, "type": "say", "say": "text", "text": "Add retention settings"},
        {
            "ts": 20,
            "type": "say",
            "say": "api_req_started",
            "text": json.dumps(
                {"tokensIn": 1200, "tokensOut": 300, "cacheReads": 900, "cacheWrites": 100, "cost": 0.0125}
            ),
        },
        {"ts": 50, "type": "say", "say": "completion_result", "text": "Done"},
    ]
    files, data = _backfill_files("task-sum", messages)
    try:
        resp = client.post("/api/events/backfill", files=files, data=data)
    finally:
        client.app.dependency_overrides.pop(get_current_user, None)
    assert resp.status_code == 200

    async with session_factory() as s:
        task = (await s.execute(select(Task).where(Task.id == "task-sum"))).scalar_one()
        assert task.title == "Add retention settings"
        assert task.message_count == 3
        assert task.tokens_in == 1200
        assert task.tokens_out == 300
        assert task.cache_reads == 900
        assert task.cache_writes == 100
        assert task.cost == pytest.approx(0.0125)
        assert task.first_ts == 10
        assert task.last_ts == 50


async def test_resharing_a_task_does_not_double_count(client, db_session, session_factory):
    """Backfill replaces the conversation, so re-sharing must recompute — not add.

    The summary is re-summed from the stored rows rather than accumulated, which
    is what makes this idempotent.
    """
    await _seed_user(db_session)
    _override_current_user(client.app)
    messages = [
        {"ts": 1, "type": "say", "say": "text", "text": "One task"},
        {
            "ts": 2,
            "type": "say",
            "say": "api_req_started",
            "text": json.dumps({"tokensIn": 500, "tokensOut": 50, "cost": 0.01}),
        },
    ]
    try:
        for _ in range(3):
            files, data = _backfill_files("task-idem", messages)
            assert client.post("/api/events/backfill", files=files, data=data).status_code == 200
    finally:
        client.app.dependency_overrides.pop(get_current_user, None)

    async with session_factory() as s:
        task = (await s.execute(select(Task).where(Task.id == "task-idem"))).scalar_one()
        assert task.message_count == 2
        assert task.tokens_in == 500
        assert task.cost == pytest.approx(0.01)


async def test_live_upsert_replaces_metrics_instead_of_adding(db_session, session_factory):
    """A streamed api_req_started only learns its cost in its final revision.

    The row is upserted in place and the task total re-summed, so the interim
    zero-cost revision must not linger and the final must not be added on top of
    it.
    """
    from src.services.telemetry_service import upsert_task_message

    await _seed_user(db_session)
    partial = {
        "ts": 7,
        "type": "say",
        "say": "api_req_started",
        "partial": True,
        "text": json.dumps({"tokensIn": 100, "tokensOut": 0}),
    }
    final = {
        "ts": 7,
        "type": "say",
        "say": "api_req_started",
        "text": json.dumps({"tokensIn": 100, "tokensOut": 250, "cost": 0.02}),
    }

    async with session_factory() as s:
        await upsert_task_message(s, "task-live-sum", "user_test", partial)
        await upsert_task_message(s, "task-live-sum", "user_test", final)
        await s.commit()

    async with session_factory() as s:
        task = (await s.execute(select(Task).where(Task.id == "task-live-sum"))).scalar_one()
        assert task.message_count == 1
        assert task.tokens_in == 100
        assert task.tokens_out == 250
        assert task.cost == pytest.approx(0.02)


async def test_task_list_is_paginated(client, db_session, session_factory):
    """More tasks than one page must not all render at once."""
    from src.routers.web import PAGE_SIZE

    await _seed_user(db_session)
    async with session_factory() as s:
        for i in range(PAGE_SIZE + 5):
            s.add(Task(id=f"task-p{i}", user_id="user_test", title=f"Task number {i}"))
        await s.commit()

    _override_web_user(client.app)
    try:
        first = client.get("/app")
        second = client.get("/app?page=2")
    finally:
        client.app.dependency_overrides.pop(get_web_user_optional, None)

    assert first.status_code == 200 and second.status_code == 200
    assert first.text.count('class="task-item"') == PAGE_SIZE
    assert second.text.count('class="task-item"') == 5
    assert "Page 1 of 2" in first.text


async def test_task_list_search_filters_by_title_and_workspace(client, db_session, session_factory):
    await _seed_user(db_session)
    async with session_factory() as s:
        s.add(Task(id="t-a", user_id="user_test", title="Refactor the parser"))
        s.add(Task(id="t-b", user_id="user_test", title="Unrelated", workspace_path="/home/k/parser-lab"))
        s.add(Task(id="t-c", user_id="user_test", title="Something else"))
        await s.commit()

    _override_web_user(client.app)
    try:
        resp = client.get("/app?q=parser")
    finally:
        client.app.dependency_overrides.pop(get_web_user_optional, None)

    assert resp.status_code == 200
    assert "Refactor the parser" in resp.text
    assert "parser-lab" in resp.text
    assert "Something else" not in resp.text


async def test_task_list_does_not_read_message_bodies(client, db_session, session_factory, monkeypatch):
    """The whole point of the summary columns: rendering the list must never touch
    the message corpus. Guards against a future change quietly reintroducing the
    N+1 read that cost 2.47s per page view on the live deployment."""
    from src.routers import web

    await _seed_user(db_session)
    async with session_factory() as s:
        s.add(Task(id="task-noread", user_id="user_test", title="Cheap render", message_count=3))
        await s.flush()
        await _add_message(s, "task-noread", _msgs()[0])
        await s.commit()

    called = False

    async def _boom(*args, **kwargs):
        nonlocal called
        called = True
        return []

    monkeypatch.setattr(web, "_load_task_messages", _boom)

    _override_web_user(client.app)
    try:
        resp = client.get("/app")
    finally:
        client.app.dependency_overrides.pop(get_web_user_optional, None)

    assert resp.status_code == 200
    assert "Cheap render" in resp.text
    assert called is False

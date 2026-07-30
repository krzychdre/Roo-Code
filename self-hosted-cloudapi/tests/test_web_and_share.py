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


# --- subtask tree -----------------------------------------------------------


async def _post_event(client, task_id, parent_task_id=None, event_type="Task Created"):
    props = {"taskId": task_id}
    if parent_task_id:
        props["parentTaskId"] = parent_task_id
        props["isSubtask"] = True
    return client.post("/api/events", json={"type": event_type, "properties": props})


async def test_parent_link_survives_event_arriving_before_the_task(
    client, db_session, session_factory
):
    """The hard case, and the normal one: a subtask announces its parent when it
    starts, but neither task exists as a row until messages are stored — at
    share time that can be hours later."""
    from src.models.relation import TaskRelation

    await _seed_user(db_session)
    _override_current_user(client.app)
    try:
        # 1. Telemetry first — nothing exists yet.
        assert (await _post_event(client, "child-1", "parent-1")).status_code == 200

        async with session_factory() as s:
            rel = (
                await s.execute(select(TaskRelation).where(TaskRelation.child_task_id == "child-1"))
            ).scalar_one()
            assert rel.parent_task_id == "parent-1"
            assert (await s.execute(select(func.count(Task.id)))).scalar_one() == 0

        # 2. Parent shared, then child shared.
        for tid in ("parent-1", "child-1"):
            files, data = _backfill_files(tid, _msgs())
            assert client.post("/api/events/backfill", files=files, data=data).status_code == 200
    finally:
        client.app.dependency_overrides.pop(get_current_user, None)

    async with session_factory() as s:
        child = (await s.execute(select(Task).where(Task.id == "child-1"))).scalar_one()
        assert child.parent_task_id == "parent-1"


async def test_child_stored_before_its_parent_is_adopted_later(
    client, db_session, session_factory
):
    """The reverse order, which happens whenever a subtask finishes and is shared
    while the run that spawned it is still going."""
    await _seed_user(db_session)
    _override_current_user(client.app)
    try:
        assert (await _post_event(client, "child-2", "parent-2")).status_code == 200

        # Child first: its parent has no row, so the stamp must be deferred
        # rather than written as a dangling foreign key.
        files, data = _backfill_files("child-2", _msgs())
        assert client.post("/api/events/backfill", files=files, data=data).status_code == 200

        async with session_factory() as s:
            child = (await s.execute(select(Task).where(Task.id == "child-2"))).scalar_one()
            assert child.parent_task_id is None

        files, data = _backfill_files("parent-2", _msgs())
        assert client.post("/api/events/backfill", files=files, data=data).status_code == 200
    finally:
        client.app.dependency_overrides.pop(get_current_user, None)

    async with session_factory() as s:
        child = (await s.execute(select(Task).where(Task.id == "child-2"))).scalar_one()
        assert child.parent_task_id == "parent-2", "parent's arrival must claim waiting children"


async def test_relation_is_recorded_once_across_many_events(client, db_session, session_factory):
    """Every later event repeats parentTaskId; the link must not accumulate."""
    from src.models.relation import TaskRelation

    await _seed_user(db_session)
    _override_current_user(client.app)
    try:
        for evt in ("Task Created", "LLM Completion", "Tool Used", "Task Message"):
            assert (await _post_event(client, "child-3", "parent-3", evt)).status_code == 200
    finally:
        client.app.dependency_overrides.pop(get_current_user, None)

    async with session_factory() as s:
        count = (
            await s.execute(
                select(func.count(TaskRelation.child_task_id)).where(
                    TaskRelation.child_task_id == "child-3"
                )
            )
        ).scalar_one()
        assert count == 1


async def test_task_list_hides_subtasks_by_default(client, db_session, session_factory):
    """150 of 387 tasks on the live deployment are subtasks; listing them flat
    buried the actual runs among their own fragments."""
    await _seed_user(db_session)
    async with session_factory() as s:
        s.add(Task(id="run-a", user_id="user_test", title="The run"))
        await s.flush()
        s.add(Task(id="sub-a", user_id="user_test", title="Its subtask", parent_task_id="run-a"))
        await s.commit()

    _override_web_user(client.app)
    try:
        roots = client.get("/app")
        everything = client.get("/app?scope=all")
    finally:
        client.app.dependency_overrides.pop(get_web_user_optional, None)

    assert "The run" in roots.text
    assert "Its subtask" not in roots.text
    # The run advertises that opening it leads somewhere.
    assert 'class="child-count"' in roots.text

    assert "The run" in everything.text
    assert "Its subtask" in everything.text


async def test_task_detail_links_up_and_down_the_tree(client, db_session, session_factory):
    await _seed_user(db_session)
    async with session_factory() as s:
        s.add(Task(id="root-x", user_id="user_test", title="Root run"))
        await s.flush()
        s.add(Task(id="mid-x", user_id="user_test", title="Middle task", parent_task_id="root-x"))
        await s.flush()
        s.add(Task(id="leaf-x", user_id="user_test", title="Leaf task", parent_task_id="mid-x"))
        await s.commit()

    _override_web_user(client.app)
    try:
        mid = client.get("/app/tasks/mid-x")
    finally:
        client.app.dependency_overrides.pop(get_web_user_optional, None)

    assert mid.status_code == 200
    # Up: the breadcrumb reaches the root.
    assert "/app/tasks/root-x" in mid.text
    assert "Root run" in mid.text
    # Down: the subtask panel reaches the child.
    assert "/app/tasks/leaf-x" in mid.text
    assert "Leaf task" in mid.text


async def test_ancestor_walk_survives_a_cycle(db_session, session_factory):
    """Task ids come from a client. A cycle must not hang a page render."""
    from src.services.task_tree import ancestors

    await _seed_user(db_session)
    async with session_factory() as s:
        s.add(Task(id="cyc-a", user_id="user_test", title="A"))
        s.add(Task(id="cyc-b", user_id="user_test", title="B"))
        await s.flush()
        # Forced directly: the write paths never create this, which is exactly
        # why the read path has to defend itself.
        await s.execute(
            Task.__table__.update().where(Task.id == "cyc-a").values(parent_task_id="cyc-b")
        )
        await s.execute(
            Task.__table__.update().where(Task.id == "cyc-b").values(parent_task_id="cyc-a")
        )
        await s.commit()

    async with session_factory() as s:
        task = (await s.execute(select(Task).where(Task.id == "cyc-a"))).scalar_one()
        chain = await ancestors(s, task)

    assert len(chain) <= 2, "the walk must stop instead of looping forever"


# --- session quality --------------------------------------------------------


def _quality_msgs(**counts):
    """Build a conversation containing the requested markers, in a valid order."""
    msgs = [{"ts": 1, "type": "say", "say": "text", "text": "Do the thing"}]
    ts = 10
    for _ in range(counts.get("requests", 1)):
        msgs.append({"ts": ts, "type": "say", "say": "api_req_started",
                     "text": json.dumps({"tokensIn": 1000, "tokensOut": 100, "cost": 0.01})})
        ts += 10
    for _ in range(counts.get("errors", 0)):
        msgs.append({"ts": ts, "type": "say", "say": "error", "text": "boom"}); ts += 10
    for _ in range(counts.get("retries", 0)):
        msgs.append({"ts": ts, "type": "say", "say": "api_req_retry_delayed", "text": "waiting"}); ts += 10
    for _ in range(counts.get("condense", 0)):
        msgs.append({"ts": ts, "type": "say", "say": "condense_context",
                     "contextCondense": {"summary": "s", "cost": 0.001}}); ts += 10
    for _ in range(counts.get("interventions", 0)):
        # Preceded by a request, so it is a mid-run correction, not a rejection.
        msgs.append({"ts": ts, "type": "say", "say": "api_req_started", "text": "{}"}); ts += 10
        msgs.append({"ts": ts, "type": "say", "say": "user_feedback", "text": "no, like this"}); ts += 10
    for path in counts.get("tool_paths", []):
        msgs.append({"ts": ts, "type": "say", "say": "tool",
                     "text": json.dumps({"tool": "readFile", "path": path})}); ts += 10
    if counts.get("completed", True):
        msgs.append({"ts": ts, "type": "say", "say": "completion_result", "text": "done"})
    return msgs


async def _backfill(client, task_id, messages):
    files, data = _backfill_files(task_id, messages)
    resp = client.post("/api/events/backfill", files=files, data=data)
    assert resp.status_code == 200


async def test_quality_counts_every_marker(client, db_session, session_factory):
    from src.services.session_quality import quality_of

    await _seed_user(db_session)
    _override_current_user(client.app)
    try:
        await _backfill(client, "q-all", _quality_msgs(
            requests=3, errors=2, retries=1, condense=1, interventions=2,
            tool_paths=["a.py", "b.py", "a.py"],
        ))
    finally:
        client.app.dependency_overrides.pop(get_current_user, None)

    async with session_factory() as s:
        task = (await s.execute(select(Task).where(Task.id == "q-all"))).scalar_one()
        q = quality_of(task)

    # 3 explicit + 2 that precede the interventions.
    assert q.requests == 5
    assert q.errors == 2
    assert q.retries == 1
    assert q.condense == 1
    assert q.interventions == 2
    assert q.completion_replies == 0
    assert q.tools == 3
    # a.py read twice → one repeat.
    assert q.repeated_work == 1
    assert q.completed is True


async def test_reply_to_a_finished_result_is_not_a_mid_run_correction(
    client, db_session, session_factory
):
    """A reply to a proposed result and a mid-run correction are both
    `user_feedback`; only what precedes them tells them apart. They are counted
    separately because they mean different things — and the reply is kept out of
    the grade, since "now also do this" looks identical to "that is wrong"."""
    from src.services.session_quality import quality_of

    await _seed_user(db_session)
    _override_current_user(client.app)
    try:
        await _backfill(client, "q-reject", [
            {"ts": 1, "type": "say", "say": "text", "text": "Do it"},
            {"ts": 2, "type": "say", "say": "api_req_started", "text": "{}"},
            {"ts": 3, "type": "say", "say": "completion_result", "text": "All done"},
            # No request/tool in between: the completion is still awaiting an answer.
            {"ts": 4, "type": "say", "say": "user_feedback", "text": "no, it is not"},
            {"ts": 5, "type": "say", "say": "api_req_started", "text": "{}"},
            # This one follows a request, so it is an ordinary correction.
            {"ts": 6, "type": "say", "say": "user_feedback", "text": "also change this"},
            {"ts": 7, "type": "say", "say": "completion_result", "text": "Now done"},
        ])
    finally:
        client.app.dependency_overrides.pop(get_current_user, None)

    async with session_factory() as s:
        task = (await s.execute(select(Task).where(Task.id == "q-reject"))).scalar_one()
        q = quality_of(task)

    assert q.completion_replies == 1, "a reply to an attempt_completion must be counted as one"
    assert q.interventions == 1, "the mid-run correction must stay a correction"


async def test_live_stream_detects_a_completion_reply_without_the_whole_conversation(
    db_session, session_factory
):
    """The bridge delivers one message at a time, so the awaiting-completion
    state has to come from what is already stored rather than from a walk."""
    from src.services.session_quality import quality_of
    from src.services.telemetry_service import upsert_task_message

    await _seed_user(db_session)
    stream = [
        {"ts": 1, "type": "say", "say": "api_req_started", "text": "{}"},
        {"ts": 2, "type": "say", "say": "completion_result", "text": "All done"},
        {"ts": 3, "type": "say", "say": "user_feedback", "text": "no"},
        {"ts": 4, "type": "say", "say": "api_req_started", "text": "{}"},
        {"ts": 5, "type": "say", "say": "user_feedback", "text": "one more thing"},
    ]
    async with session_factory() as s:
        for msg in stream:
            await upsert_task_message(s, "q-live", "user_test", msg)
        await s.commit()

    async with session_factory() as s:
        task = (await s.execute(select(Task).where(Task.id == "q-live"))).scalar_one()
        q = quality_of(task)

    assert q.completion_replies == 1
    assert q.interventions == 1


async def test_grade_rules(client, db_session, session_factory):
    """Each grade must follow from a stated rule, not a weighting."""
    from src.services.session_quality import quality_of

    await _seed_user(db_session)
    _override_current_user(client.app)
    try:
        await _backfill(client, "g-clean", _quality_msgs(requests=2))
        await _backfill(client, "g-friction", _quality_msgs(requests=2, errors=1))
        await _backfill(client, "g-unfinished", _quality_msgs(requests=2, completed=False))
    finally:
        client.app.dependency_overrides.pop(get_current_user, None)

    async with session_factory() as s:
        grades = {}
        for tid in ("g-clean", "g-friction", "g-unfinished"):
            task = (await s.execute(select(Task).where(Task.id == tid))).scalar_one()
            grades[tid] = quality_of(task).grade

    assert grades["g-clean"] == "clean"
    assert grades["g-friction"] == "friction"
    assert grades["g-unfinished"] == "unfinished"


async def test_grade_reasons_name_what_happened(client, db_session, session_factory):
    """A badge must never be a verdict the reader has to take on trust."""
    from src.services.session_quality import quality_of

    await _seed_user(db_session)
    _override_current_user(client.app)
    try:
        await _backfill(client, "g-why", _quality_msgs(requests=1, errors=2, condense=1))
    finally:
        client.app.dependency_overrides.pop(get_current_user, None)

    async with session_factory() as s:
        task = (await s.execute(select(Task).where(Task.id == "g-why"))).scalar_one()
        reasons = " ".join(quality_of(task).reasons())

    assert "2 errors" in reasons
    assert "context condensed 1 time" in reasons


async def test_resharing_does_not_inflate_quality_counts(client, db_session, session_factory):
    from src.services.session_quality import quality_of

    await _seed_user(db_session)
    _override_current_user(client.app)
    msgs = _quality_msgs(requests=2, errors=1, tool_paths=["x.py"])
    try:
        for _ in range(3):
            await _backfill(client, "q-idem", msgs)
    finally:
        client.app.dependency_overrides.pop(get_current_user, None)

    async with session_factory() as s:
        task = (await s.execute(select(Task).where(Task.id == "q-idem"))).scalar_one()
        q = quality_of(task)

    assert q.requests == 2
    assert q.errors == 1
    assert q.tools == 1


async def test_quality_shows_on_list_detail_and_metrics(client, db_session, session_factory):
    await _seed_user(db_session)
    _override_current_user(client.app)
    try:
        await _backfill(client, "q-ui", _quality_msgs(requests=2, errors=1))
    finally:
        client.app.dependency_overrides.pop(get_current_user, None)

    _override_web_user(client.app)
    try:
        lst = client.get("/app")
        detail = client.get("/app/tasks/q-ui")
        metrics = client.get("/app/metrics?period=all")
    finally:
        client.app.dependency_overrides.pop(get_web_user_optional, None)

    assert 'class="grade grade-friction"' in lst.text
    assert "Friction" in detail.text
    assert "Your corrections" in detail.text
    assert "Session quality" in metrics.text
    assert "Roughest runs" in metrics.text


async def test_quality_overview_excludes_subtasks(client, db_session, session_factory):
    """A run and the subtasks it delegated to are one piece of work; grading both
    would count it several times."""
    await _seed_user(db_session)
    _override_current_user(client.app)
    try:
        await _backfill(client, "qo-parent", _quality_msgs(requests=1))
        await _backfill(client, "qo-child", _quality_msgs(requests=1))
    finally:
        client.app.dependency_overrides.pop(get_current_user, None)

    async with session_factory() as s:
        await s.execute(
            Task.__table__.update().where(Task.id == "qo-child").values(parent_task_id="qo-parent")
        )
        await s.commit()

    from src.routers.web import _quality_overview

    async with session_factory() as s:
        overview = await _quality_overview(s, "user_test", "all")

    assert overview["total"] == 1, "only the run should be graded, not its subtask"


async def test_replying_to_a_result_does_not_count_as_friction(
    client, db_session, session_factory
):
    """Answering a finished result covers "that is wrong" and "now also do this"
    equally, so it must not drag a run out of "clean".

    Measured on the live corpus before this rule was fixed: counting it as
    friction moved 17 of 236 runs from clean to friction on a reading the data
    does not support. agent-bench says the same of its `rej_completion` column —
    pushback or follow-up, not a defect count.
    """
    from src.services.session_quality import quality_of

    await _seed_user(db_session)
    _override_current_user(client.app)
    try:
        await _backfill(client, "q-followup", [
            {"ts": 1, "type": "say", "say": "text", "text": "Do it"},
            {"ts": 2, "type": "say", "say": "api_req_started", "text": "{}"},
            {"ts": 3, "type": "say", "say": "completion_result", "text": "Done"},
            {"ts": 4, "type": "say", "say": "user_feedback", "text": "great, now also add tests"},
            {"ts": 5, "type": "say", "say": "api_req_started", "text": "{}"},
            {"ts": 6, "type": "say", "say": "completion_result", "text": "Tests added"},
        ])
    finally:
        client.app.dependency_overrides.pop(get_current_user, None)

    async with session_factory() as s:
        task = (await s.execute(select(Task).where(Task.id == "q-followup"))).scalar_one()
        q = quality_of(task)

    assert q.completion_replies == 1
    assert q.friction_events == 0, "a reply to a result is not friction"
    assert q.grade == "clean"
    # It is still reported — just as context, after the grade's own reasons.
    assert any("replied to 1 finished result" in r for r in q.reasons())


# --- bulk delete ------------------------------------------------------------


async def _seed_tasks(session_factory, *specs):
    """specs: (task_id, user_id, parent_task_id or None)."""
    async with session_factory() as s:
        for task_id, user_id, parent in specs:
            s.add(Task(id=task_id, user_id=user_id, title=f"Task {task_id}"))
            await s.flush()
            await _add_message(s, task_id, _msgs()[0])
        await s.flush()
        for task_id, _, parent in specs:
            if parent:
                await s.execute(
                    Task.__table__.update().where(Task.id == task_id).values(parent_task_id=parent)
                )
        await s.commit()


async def _remaining(session_factory):
    async with session_factory() as s:
        rows = await s.execute(select(Task.id).order_by(Task.id))
        return {r[0] for r in rows.all()}


async def test_bulk_delete_removes_the_selection(client, db_session, session_factory):
    await _seed_user(db_session)
    await _seed_tasks(
        session_factory, ("b1", "user_test", None), ("b2", "user_test", None), ("b3", "user_test", None)
    )

    _override_web_user(client.app)
    try:
        resp = client.post(
            "/app/tasks/bulk-delete", data={"task_ids": ["b1", "b3"]}, follow_redirects=False
        )
    finally:
        client.app.dependency_overrides.pop(get_web_user_optional, None)

    assert resp.status_code == 303
    assert await _remaining(session_factory) == {"b2"}

    # The conversations went with them.
    async with session_factory() as s:
        left = (
            await s.execute(
                select(func.count(TaskMessage.id)).where(TaskMessage.task_id.in_(["b1", "b3"]))
            )
        ).scalar_one()
    assert left == 0


async def test_bulk_delete_ignores_tasks_the_user_does_not_own(
    client, db_session, session_factory
):
    """The form posts a list of ids and nothing stops a caller from adding
    somebody else's. Ownership is re-checked per id against the database."""
    await _seed_user(db_session)
    await _seed_user(db_session, user_id="user_other", email="other@example.com")
    await _seed_tasks(
        session_factory, ("mine", "user_test", None), ("theirs", "user_other", None)
    )

    _override_web_user(client.app)
    try:
        resp = client.post(
            "/app/tasks/bulk-delete",
            data={"task_ids": ["mine", "theirs"]},
            follow_redirects=False,
        )
    finally:
        client.app.dependency_overrides.pop(get_web_user_optional, None)

    # The caller's own task goes; the other user's survives, and the response
    # gives away nothing about it.
    assert resp.status_code == 303
    assert await _remaining(session_factory) == {"theirs"}


async def test_bulk_delete_leaves_subtasks_alone_unless_asked(
    client, db_session, session_factory
):
    """Deleting a run must not silently take work the caller never selected;
    orphaned children survive as roots (parent_task_id is ON DELETE SET NULL)."""
    await _seed_user(db_session)
    await _seed_tasks(
        session_factory, ("parent", "user_test", None), ("child", "user_test", "parent")
    )

    _override_web_user(client.app)
    try:
        resp = client.post(
            "/app/tasks/bulk-delete", data={"task_ids": ["parent"]}, follow_redirects=False
        )
    finally:
        client.app.dependency_overrides.pop(get_web_user_optional, None)

    assert resp.status_code == 303
    assert await _remaining(session_factory) == {"child"}
    async with session_factory() as s:
        child = (await s.execute(select(Task).where(Task.id == "child"))).scalar_one()
    assert child.parent_task_id is None


async def test_bulk_delete_can_include_the_whole_subtree(client, db_session, session_factory):
    await _seed_user(db_session)
    await _seed_tasks(
        session_factory,
        ("root", "user_test", None),
        ("mid", "user_test", "root"),
        ("leaf", "user_test", "mid"),
        ("unrelated", "user_test", None),
    )

    _override_web_user(client.app)
    try:
        resp = client.post(
            "/app/tasks/bulk-delete",
            data={"task_ids": ["root"], "include_subtasks": "1"},
            follow_redirects=False,
        )
    finally:
        client.app.dependency_overrides.pop(get_web_user_optional, None)

    assert resp.status_code == 303
    assert await _remaining(session_factory) == {"unrelated"}, "the walk must reach every depth"


async def test_subtree_walk_survives_a_cycle(db_session, session_factory):
    """Parent links are built from client-supplied ids; a cycle must terminate."""
    from src.services.share_service import delete_tasks

    await _seed_user(db_session)
    await _seed_tasks(session_factory, ("cy-a", "user_test", None), ("cy-b", "user_test", "cy-a"))
    async with session_factory() as s:
        await s.execute(
            Task.__table__.update().where(Task.id == "cy-a").values(parent_task_id="cy-b")
        )
        await s.commit()

    async with session_factory() as s:
        deleted = await delete_tasks(s, ["cy-a"], "user_test", include_subtasks=True)
        await s.commit()

    assert deleted == 2
    assert await _remaining(session_factory) == set()


async def test_bulk_delete_with_no_selection_is_a_no_op(client, db_session, session_factory):
    await _seed_user(db_session)
    await _seed_tasks(session_factory, ("keep", "user_test", None))

    _override_web_user(client.app)
    try:
        resp = client.post("/app/tasks/bulk-delete", data={}, follow_redirects=False)
    finally:
        client.app.dependency_overrides.pop(get_web_user_optional, None)

    assert resp.status_code == 303
    assert await _remaining(session_factory) == {"keep"}


async def test_bulk_delete_requires_a_session(client, db_session, session_factory):
    await _seed_user(db_session)
    await _seed_tasks(session_factory, ("guarded", "user_test", None))

    resp = client.post(
        "/app/tasks/bulk-delete", data={"task_ids": ["guarded"]}, follow_redirects=False
    )

    assert resp.status_code == 303
    assert resp.headers["location"] == "/app/login"
    assert await _remaining(session_factory) == {"guarded"}


async def test_bulk_delete_returns_to_the_current_view(client, db_session, session_factory):
    """Deleting from a filtered view must not dump the reader back to page 1 of
    an unfiltered list."""
    await _seed_user(db_session)
    await _seed_tasks(session_factory, ("v1", "user_test", None))

    _override_web_user(client.app)
    try:
        resp = client.post(
            "/app/tasks/bulk-delete",
            data={"task_ids": ["v1"], "scope": "all", "q": "parser"},
            follow_redirects=False,
        )
    finally:
        client.app.dependency_overrides.pop(get_web_user_optional, None)

    assert resp.headers["location"] == "/app?scope=all&q=parser"


async def test_list_offers_selection_controls(client, db_session, session_factory):
    await _seed_user(db_session)
    await _seed_tasks(session_factory, ("s1", "user_test", None))

    _override_web_user(client.app)
    try:
        resp = client.get("/app")
    finally:
        client.app.dependency_overrides.pop(get_web_user_optional, None)

    assert 'name="task_ids"' in resp.text
    assert 'id="select-all"' in resp.text
    assert "/app/tasks/bulk-delete" in resp.text


# --- retention --------------------------------------------------------------


async def _make_task(session, task_id, user_id="user_test", *, age_days=0, shared=False):
    from datetime import datetime, timedelta, timezone

    when = datetime.now(timezone.utc) - timedelta(days=age_days)
    session.add(Task(id=task_id, user_id=user_id, title=f"Task {task_id}", updated_at=when))
    await session.flush()
    await _add_message(session, task_id, _msgs()[0])
    if shared:
        session.add(TaskShare(task_id=task_id, visibility="public",
                              share_url=f"http://testserver/shared/{task_id}"))
    await session.flush()


async def _policy(session, user_id="user_test", **fields):
    from src.services.retention_service import get_policy

    policy = await get_policy(session, user_id)
    for key, value in fields.items():
        setattr(policy, key, value)
    await session.flush()
    return policy


async def test_a_fresh_policy_deletes_nothing(db_session, session_factory):
    """Retention must never be something a deployment acquires by upgrading."""
    from src.services.retention_service import get_policy, plan_sweep

    await _seed_user(db_session)
    async with session_factory() as s:
        await _make_task(s, "r-old", age_days=400)
        await s.commit()

    async with session_factory() as s:
        policy = await get_policy(s, "user_test")
        assert policy.enabled is False
        plan = await plan_sweep(s, "user_test", policy)

    assert plan.is_empty, "a default policy must select nothing"


async def test_age_rule_selects_only_old_tasks(db_session, session_factory):
    from src.services.retention_service import plan_sweep

    await _seed_user(db_session)
    async with session_factory() as s:
        await _make_task(s, "r-fresh", age_days=1)
        await _make_task(s, "r-stale", age_days=100)
        policy = await _policy(s, max_age_days=30, max_tasks=None)
        plan = await plan_sweep(s, "user_test", policy)
        await s.commit()

    assert plan.task_ids == ["r-stale"]
    assert "older than 30 days" in plan.reasons["r-stale"]


async def test_count_rule_keeps_the_newest(db_session, session_factory):
    from src.services.retention_service import plan_sweep

    await _seed_user(db_session)
    async with session_factory() as s:
        for i in range(5):
            await _make_task(s, f"r-c{i}", age_days=i)
        policy = await _policy(s, max_age_days=None, max_tasks=2)
        plan = await plan_sweep(s, "user_test", policy)
        await s.commit()

    # Newest first: r-c0 and r-c1 survive.
    assert set(plan.task_ids) == {"r-c2", "r-c3", "r-c4"}


async def test_shared_tasks_are_exempt_by_default(db_session, session_factory):
    """A share URL was handed to somebody; a sweep should not silently break it."""
    from src.services.retention_service import plan_sweep

    await _seed_user(db_session)
    async with session_factory() as s:
        await _make_task(s, "r-shared", age_days=200, shared=True)
        await _make_task(s, "r-private", age_days=200)
        policy = await _policy(s, max_age_days=30, max_tasks=None, keep_shared=True)
        plan = await plan_sweep(s, "user_test", policy)
        await s.commit()

    assert plan.task_ids == ["r-private"]
    assert plan.exempt_shared == 1

    async with session_factory() as s:
        policy = await _policy(s, max_age_days=30, max_tasks=None, keep_shared=False)
        plan = await plan_sweep(s, "user_test", policy)
        await s.commit()

    assert set(plan.task_ids) == {"r-shared", "r-private"}


async def test_usage_telemetry_is_never_purged(db_session, session_factory):
    """The metrics page is built entirely from LLM Completion; nothing else in
    the database can reconstruct the cost history it holds."""
    from datetime import datetime, timedelta, timezone

    from src.services.retention_service import apply_sweep

    await _seed_user(db_session)
    old = datetime.now(timezone.utc) - timedelta(days=90)
    async with session_factory() as s:
        s.add(TelemetryEvent(user_id="user_test", event_type="LLM Completion",
                             properties=json.dumps({"cost": 1.5}), created_at=old))
        s.add(TelemetryEvent(user_id="user_test", event_type="Task Message",
                             properties=json.dumps({"message": {}}), created_at=old))
        policy = await _policy(s, purge_telemetry=True, telemetry_max_age_days=7,
                               max_age_days=None, max_tasks=None)
        await apply_sweep(s, "user_test", policy)
        await s.commit()

    async with session_factory() as s:
        rows = await s.execute(select(TelemetryEvent.event_type))
        kinds = [r[0] for r in rows.all()]

    assert kinds == ["LLM Completion"], "usage data must survive a telemetry purge"


async def test_sweep_never_touches_another_users_data(db_session, session_factory):
    from src.services.retention_service import apply_sweep

    await _seed_user(db_session)
    await _seed_user(db_session, user_id="user_other", email="other@example.com")
    async with session_factory() as s:
        await _make_task(s, "r-mine", age_days=200)
        await _make_task(s, "r-theirs", "user_other", age_days=200)
        policy = await _policy(s, max_age_days=30, max_tasks=None)
        await apply_sweep(s, "user_test", policy)
        await s.commit()

    async with session_factory() as s:
        rows = await s.execute(select(Task.id))
        assert {r[0] for r in rows.all()} == {"r-theirs"}


async def test_the_preview_matches_what_the_sweep_does(db_session, session_factory):
    """The settings page and the sweep must not be able to disagree — they run
    the same function."""
    from src.services.retention_service import apply_sweep, plan_sweep

    await _seed_user(db_session)
    async with session_factory() as s:
        for i in range(6):
            await _make_task(s, f"r-p{i}", age_days=i * 40)
        policy = await _policy(s, max_age_days=90, max_tasks=None)
        preview = await plan_sweep(s, "user_test", policy)
        await s.commit()

    previewed = set(preview.task_ids)
    assert previewed, "the fixture must actually select something"

    async with session_factory() as s:
        policy = await _policy(s, max_age_days=90, max_tasks=None)
        await apply_sweep(s, "user_test", policy)
        await s.commit()

    async with session_factory() as s:
        rows = await s.execute(select(Task.id))
        remaining = {r[0] for r in rows.all()}

    assert previewed & remaining == set(), "everything previewed must be gone"
    assert remaining == {f"r-p{i}" for i in range(6)} - previewed


async def test_apply_records_what_it_did(db_session, session_factory):
    from src.services.retention_service import apply_sweep, get_policy

    await _seed_user(db_session)
    async with session_factory() as s:
        await _make_task(s, "r-rec", age_days=200)
        policy = await _policy(s, max_age_days=30, max_tasks=None)
        await apply_sweep(s, "user_test", policy)
        await s.commit()

    async with session_factory() as s:
        policy = await get_policy(s, "user_test")
        assert policy.last_run_at is not None
        assert policy.last_deleted_tasks == 1


async def test_scheduled_sweep_skips_disabled_policies(db_session, session_factory):
    from src.services.retention_service import sweep_all_enabled

    await _seed_user(db_session)
    await _seed_user(db_session, user_id="user_off", email="off@example.com")
    async with session_factory() as s:
        await _make_task(s, "r-on", age_days=200)
        await _make_task(s, "r-off", "user_off", age_days=200)
        await _policy(s, "user_test", enabled=True, max_age_days=30, max_tasks=None)
        await _policy(s, "user_off", enabled=False, max_age_days=30, max_tasks=None)
        await s.commit()

    async with session_factory() as s:
        processed = await sweep_all_enabled(s)
        await s.commit()

    assert processed == 1
    async with session_factory() as s:
        rows = await s.execute(select(Task.id))
        assert {r[0] for r in rows.all()} == {"r-off"}


async def test_settings_page_shows_the_preview(client, db_session, session_factory):
    await _seed_user(db_session)
    async with session_factory() as s:
        await _make_task(s, "r-ui", age_days=200)
        await _policy(s, max_age_days=30, max_tasks=None)
        await s.commit()

    _override_web_user(client.app)
    try:
        resp = client.get("/app/settings")
    finally:
        client.app.dependency_overrides.pop(get_web_user_optional, None)

    assert resp.status_code == 200
    assert "What would be deleted right now" in resp.text
    assert "older than 30 days" in resp.text


async def test_saving_settings_never_deletes(client, db_session, session_factory):
    """Arming a policy and running it are separate actions on purpose: switching
    retention on must not remove hundreds of conversations in the same click."""
    await _seed_user(db_session)
    async with session_factory() as s:
        await _make_task(s, "r-save", age_days=999)
        await s.commit()

    _override_web_user(client.app)
    try:
        resp = client.post(
            "/app/settings",
            data={"enabled": "1", "max_age_days": "1", "keep_shared": "1"},
            follow_redirects=False,
        )
    finally:
        client.app.dependency_overrides.pop(get_web_user_optional, None)

    assert resp.status_code == 303
    async with session_factory() as s:
        rows = await s.execute(select(Task.id))
        assert {r[0] for r in rows.all()} == {"r-save"}


async def test_run_now_applies_the_policy(client, db_session, session_factory):
    await _seed_user(db_session)
    async with session_factory() as s:
        await _make_task(s, "r-run", age_days=200)
        await _make_task(s, "r-keep", age_days=1)
        await _policy(s, max_age_days=30, max_tasks=None)
        await s.commit()

    _override_web_user(client.app)
    try:
        resp = client.post("/app/settings/run", follow_redirects=False)
    finally:
        client.app.dependency_overrides.pop(get_web_user_optional, None)

    assert resp.status_code == 303
    assert "ran=1" in resp.headers["location"]
    async with session_factory() as s:
        rows = await s.execute(select(Task.id))
        assert {r[0] for r in rows.all()} == {"r-keep"}


async def test_blank_limits_disable_a_rule_rather_than_meaning_zero(
    client, db_session, session_factory
):
    """A fumbled entry must switch the rule off, not select every task."""
    from src.services.retention_service import get_policy, plan_sweep

    await _seed_user(db_session)
    async with session_factory() as s:
        await _make_task(s, "r-blank", age_days=5)
        await s.commit()

    _override_web_user(client.app)
    try:
        client.post(
            "/app/settings",
            data={"enabled": "1", "max_age_days": "", "max_tasks": "not a number"},
        )
    finally:
        client.app.dependency_overrides.pop(get_web_user_optional, None)

    async with session_factory() as s:
        policy = await get_policy(s, "user_test")
        assert policy.max_age_days is None
        assert policy.max_tasks is None
        plan = await plan_sweep(s, "user_test", policy)

    assert plan.is_empty


async def test_retention_requires_a_session(client):
    for path in ("/app/settings",):
        resp = client.get(path, follow_redirects=False)
        assert resp.status_code == 303 and resp.headers["location"] == "/app/login"
    for path in ("/app/settings", "/app/settings/run"):
        resp = client.post(path, data={}, follow_redirects=False)
        assert resp.status_code == 303 and resp.headers["location"] == "/app/login"


async def test_saving_settings_persists_the_values(client, db_session, session_factory):
    """The form must actually round-trip. Every other retention test either
    asserts nothing was deleted or drives the service directly, so a form that
    silently saved all-falsy values would have gone unnoticed."""
    from src.services.retention_service import get_policy

    await _seed_user(db_session)

    _override_web_user(client.app)
    try:
        resp = client.post(
            "/app/settings",
            data={
                "enabled": "1",
                "max_age_days": "45",
                "max_tasks": "250",
                "keep_shared": "1",
                "purge_telemetry": "1",
                "telemetry_max_age_days": "14",
            },
            follow_redirects=False,
        )
        page = client.get("/app/settings")
    finally:
        client.app.dependency_overrides.pop(get_web_user_optional, None)

    assert resp.status_code == 303

    async with session_factory() as s:
        policy = await get_policy(s, "user_test")

    assert policy.enabled is True
    assert policy.max_age_days == 45
    assert policy.max_tasks == 250
    assert policy.keep_shared is True
    assert policy.purge_telemetry is True
    assert policy.telemetry_max_age_days == 14

    # And the saved values come back on the page rather than only in the DB.
    assert 'value="45"' in page.text
    assert 'value="250"' in page.text

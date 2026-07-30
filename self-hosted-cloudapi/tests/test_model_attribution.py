"""Tests for per-request and per-task model attribution.

A stored ``api_req_started`` carries no model, so the console joins it against
``LLM Completion`` telemetry on the ``(inputTokens, outputTokens)`` pair. These
tests pin the two properties that make that join safe to show a reader:

- it survives gaps on either side (a cancelled request emits no event; an event
  can name a request whose message was never stored), and
- it never guesses: an unmatched request in a multi-model run stays blank.
"""

import json

import pytest
from sqlalchemy import select

from src.auth.web_session import get_web_user_optional
from src.models.event import TelemetryEvent
from src.models.task import Task, TaskMessage
from src.services.model_attribution import (
    Completion,
    attribute_requests,
    completions_for_task,
    models_badge,
    models_label,
    models_summary,
)

from tests.test_web_and_share import (
    _add_message,
    _llm_event,
    _override_web_user,
    _seed_user,
    _summarize,
)


# --- helpers ---------------------------------------------------------------


def _req(ts: int, tin: int, tout: int, cost: float = 0.0) -> dict:
    """An ``api_req_started`` message as the extension stores it — no model."""
    return {
        "ts": ts,
        "type": "say",
        "say": "api_req_started",
        "text": json.dumps(
            {
                "apiProtocol": "openai",
                "tokensIn": tin,
                "tokensOut": tout,
                "cacheWrites": 0,
                "cacheReads": 0,
                "cost": cost,
            }
        ),
    }


def _c(model: str, tin: int, tout: int, mode: str = "code") -> Completion:
    return Completion(model=model, mode=mode, input_tokens=tin, output_tokens=tout)


# --- the join itself --------------------------------------------------------


def test_requests_match_their_completions_one_to_one():
    """The straight case: same count, same pairs, same order."""
    messages = [_req(1, 12019, 206), _req(2, 12389, 792), _req(3, 16591, 498)]
    completions = [
        _c("gpt-5.6-sol", 12019, 206),
        _c("gpt-5.6-sol", 12389, 792),
        _c("gpt-5.6-sol", 16591, 498),
    ]

    attributed = attribute_requests(messages, completions)

    assert attributed == {
        "1": {"model": "gpt-5.6-sol", "mode": "code"},
        "2": {"model": "gpt-5.6-sol", "mode": "code"},
        "3": {"model": "gpt-5.6-sol", "mode": "code"},
    }


def test_each_request_of_a_switched_run_gets_its_own_model():
    """The whole point: a run is not necessarily one model."""
    messages = [_req(1, 100, 10), _req(2, 200, 20), _req(3, 300, 30)]
    completions = [
        _c("GLM-5.2", 100, 10, mode="architect"),
        _c("gpt-5.6-sol", 200, 20, mode="code"),
        _c("GLM-5.2", 300, 30, mode="code"),
    ]

    attributed = attribute_requests(messages, completions)

    assert attributed["1"]["model"] == "GLM-5.2"
    assert attributed["1"]["mode"] == "architect"
    assert attributed["2"]["model"] == "gpt-5.6-sol"
    assert attributed["3"]["model"] == "GLM-5.2"


def test_an_event_with_no_stored_message_is_skipped_not_shifted():
    """Telemetry can name a request whose message was never stored.

    Positional matching would shift every attribution after the gap; the pair
    match walks past it.
    """
    messages = [_req(1, 100, 10), _req(2, 300, 30)]
    completions = [
        _c("GLM-5.2", 100, 10),
        _c("gpt-5.6-sol", 200, 20),  # no message for this one
        _c("GLM-5.2", 300, 30),
    ]

    attributed = attribute_requests(messages, completions)

    assert attributed["1"]["model"] == "GLM-5.2"
    assert attributed["2"]["model"] == "GLM-5.2", "must not inherit the skipped event"


def test_an_unmatched_request_in_a_multi_model_run_stays_blank():
    """A cancelled request emits no completion. Better blank than wrong."""
    messages = [_req(1, 100, 10), _req(2, 999, 99), _req(3, 300, 30)]
    completions = [_c("GLM-5.2", 100, 10), _c("gpt-5.6-sol", 300, 30)]

    attributed = attribute_requests(messages, completions)

    assert attributed["1"]["model"] == "GLM-5.2"
    assert "2" not in attributed
    assert attributed["3"]["model"] == "gpt-5.6-sol"


def test_a_single_model_run_attributes_even_the_unmatched_requests():
    """With one model there is nothing to get wrong — every request went to it."""
    messages = [_req(1, 100, 10), _req(2, 999, 99)]
    completions = [_c("GLM-5.2", 100, 10)]

    attributed = attribute_requests(messages, completions)

    assert attributed["1"]["model"] == "GLM-5.2"
    assert attributed["2"]["model"] == "GLM-5.2"


def test_an_in_flight_request_is_not_matched_by_its_empty_usage():
    """A (0, 0) key would latch onto the first event with an empty report."""
    messages = [_req(1, 0, 0)]
    completions = [_c("GLM-5.2", 0, 0)]

    assert attribute_requests(messages, completions) == {}


def test_non_request_messages_are_ignored():
    messages = [
        {"ts": 1, "type": "say", "say": "text", "text": "hello"},
        _req(2, 100, 10),
        {"ts": 3, "type": "say", "say": "completion_result", "text": "done"},
    ]

    attributed = attribute_requests(messages, [_c("GLM-5.2", 100, 10)])

    assert list(attributed) == ["2"]


def test_no_telemetry_means_no_attribution_at_all():
    assert attribute_requests([_req(1, 100, 10)], []) == {}


# --- rollups ----------------------------------------------------------------


def test_models_summary_counts_requests_and_collects_modes():
    completions = [
        _c("GLM-5.2", 1, 1, mode="code"),
        _c("gpt-5.6-sol", 2, 2, mode="orchestrator"),
        _c("GLM-5.2", 3, 3, mode="architect"),
        _c("GLM-5.2", 4, 4, mode="code"),
    ]

    summary = models_summary(completions)

    assert [s["name"] for s in summary] == ["GLM-5.2", "gpt-5.6-sol"], "most-used first"
    assert summary[0]["count"] == 3
    assert summary[0]["modes"] == ["code", "architect"]
    assert models_label(completions) == "GLM-5.2, gpt-5.6-sol"


def test_models_label_is_none_when_nothing_is_known():
    """So a refresh never overwrites a stored label with an empty one."""
    assert models_label([]) is None


def test_a_badge_names_the_main_model_and_counts_the_rest():
    """A list row has a fixed track for this; the full list is the tooltip."""
    badge = models_badge("a-model, b-model, c-model, d-model")

    assert badge["name"] == "a-model"
    assert badge["more"] == "+3", "kept apart from the name, which is what ellipsises"
    assert badge["title"] == "a-model, b-model, c-model, d-model"
    assert models_badge("only-one")["more"] == ""
    assert models_badge(None) is None
    assert models_badge("") is None


# --- storage: both arrival orders -------------------------------------------


async def test_ingest_stamps_the_task_id_and_records_the_model(db_session):
    """Telemetry arriving for an existing task fills tasks.models."""
    from src.services.telemetry_service import record_event

    await _seed_user(db_session)
    db_session.add(Task(id="task-m1", user_id="user_test", title="Run"))
    await db_session.commit()

    await record_event(
        db_session,
        user_id="user_test",
        org_id=None,
        event_type="LLM Completion",
        properties={"taskId": "task-m1", "modelId": "GLM-5.2", "mode": "code",
                    "inputTokens": 100, "outputTokens": 10, "cost": 0.0},
    )
    await db_session.commit()

    stored = (
        await db_session.execute(select(TelemetryEvent.task_id))
    ).scalar_one()
    assert stored == "task-m1", "the join key must be lifted out of the blob"

    models = await db_session.scalar(select(Task.models).where(Task.id == "task-m1"))
    assert models == "GLM-5.2"


async def test_a_second_model_extends_the_stored_label(db_session):
    from src.services.telemetry_service import record_event

    await _seed_user(db_session)
    db_session.add(Task(id="task-m2", user_id="user_test", title="Run"))
    await db_session.commit()

    for model, tin in (("GLM-5.2", 1), ("GLM-5.2", 2), ("gpt-5.6-sol", 3)):
        await record_event(
            db_session,
            user_id="user_test",
            org_id=None,
            event_type="LLM Completion",
            properties={"taskId": "task-m2", "modelId": model, "mode": "code",
                        "inputTokens": tin, "outputTokens": 1, "cost": 0.0},
        )
    await db_session.commit()

    models = await db_session.scalar(select(Task.models).where(Task.id == "task-m2"))
    assert models == "GLM-5.2, gpt-5.6-sol", "most-used first"


async def test_telemetry_for_an_unknown_task_is_stored_but_stores_nothing_else(db_session):
    """A run that was never shared has no row to hang a label on."""
    from src.services.telemetry_service import record_event

    await _seed_user(db_session)
    await record_event(
        db_session,
        user_id="user_test",
        org_id=None,
        event_type="LLM Completion",
        properties={"taskId": "never-shared", "modelId": "GLM-5.2",
                    "inputTokens": 1, "outputTokens": 1, "cost": 0.0},
    )
    await db_session.commit()

    stored = (await db_session.execute(select(TelemetryEvent.task_id))).scalar_one()
    assert stored == "never-shared"


async def test_a_conversation_shared_after_the_fact_picks_up_its_models(db_session):
    """The other arrival order: events first, messages later.

    A task is routinely shared long after it ran, so the summary refresh has to
    fill the label too — ingest alone would leave it NULL forever.
    """
    await _seed_user(db_session)
    db_session.add(_llm_event(task_id="task-m3", model="GLM-5.2", tin=100, tout=10))
    db_session.add(Task(id="task-m3", user_id="user_test", title="Run"))
    await db_session.flush()
    await _add_message(db_session, "task-m3", _req(1, 100, 10))
    await _summarize(db_session, "task-m3")
    await db_session.commit()

    models = await db_session.scalar(select(Task.models).where(Task.id == "task-m3"))
    assert models == "GLM-5.2"


async def test_completions_for_task_reads_only_that_task_and_only_completions(db_session):
    await _seed_user(db_session)
    db_session.add(_llm_event(task_id="task-m4", model="wanted", tin=1, tout=1))
    db_session.add(_llm_event(task_id="other", model="unwanted", tin=2, tout=2))
    db_session.add(
        TelemetryEvent(
            user_id="user_test",
            event_type="Task Message",
            task_id="task-m4",
            properties=json.dumps({"taskId": "task-m4", "modelId": "not-a-completion"}),
        )
    )
    await db_session.commit()

    found = await completions_for_task(db_session, "task-m4")

    assert [c.model for c in found] == ["wanted"]


# --- the views --------------------------------------------------------------


async def test_task_detail_ships_the_attribution_map(client, db_session, session_factory):
    async with session_factory() as s:
        await _seed_user(s)
        s.add(Task(id="task-v1", user_id="user_test", title="Run"))
        await s.flush()
        await _add_message(s, "task-v1", _req(1, 12019, 206))
        await _add_message(s, "task-v1", _req(2, 12389, 792))
        s.add(_llm_event(task_id="task-v1", model="GLM-5.2", tin=12019, tout=206))
        s.add(_llm_event(task_id="task-v1", model="gpt-5.6-sol", tin=12389, tout=792))
        await _summarize(s, "task-v1")
        await s.commit()

    _override_web_user(client.app)
    try:
        resp = client.get("/app/tasks/task-v1")
    finally:
        client.app.dependency_overrides.pop(get_web_user_optional, None)

    assert resp.status_code == 200
    # The map the renderer reads, keyed by message ts.
    start = resp.text.index('id="request-models"')
    island = resp.text[start : resp.text.index("</script>", start)]
    payload = json.loads(island[island.index(">") + 1 :])
    assert payload["1"]["model"] == "GLM-5.2"
    assert payload["2"]["model"] == "gpt-5.6-sol"
    # …and the header rollup naming both.
    assert "badge-model" in resp.text
    assert "gpt-5.6-sol" in resp.text


async def test_task_list_badges_the_model_without_reading_any_event(
    client, db_session, session_factory
):
    """The list renders from the stored column — that is why the column exists."""
    async with session_factory() as s:
        await _seed_user(s)
        s.add(
            Task(
                id="task-v2",
                user_id="user_test",
                title="Run",
                models="GLM-5.2, gpt-5.6-sol",
            )
        )
        await s.commit()

    _override_web_user(client.app)
    try:
        resp = client.get("/app")
    finally:
        client.app.dependency_overrides.pop(get_web_user_optional, None)

    assert resp.status_code == 200
    assert "badge-model" in resp.text
    assert "GLM-5.2" in resp.text and "+1" in resp.text, (
        "the row names the main model and counts the rest"
    )
    assert "GLM-5.2, gpt-5.6-sol" in resp.text, "…with the full list on hover"


async def test_a_task_with_no_telemetry_renders_without_a_badge(
    client, db_session, session_factory
):
    async with session_factory() as s:
        await _seed_user(s)
        s.add(Task(id="task-v3", user_id="user_test", title="Run"))
        await s.flush()
        await _add_message(s, "task-v3", _req(1, 100, 10))
        await _summarize(s, "task-v3")
        await s.commit()

    _override_web_user(client.app)
    try:
        detail = client.get("/app/tasks/task-v3")
        listing = client.get("/app")
    finally:
        client.app.dependency_overrides.pop(get_web_user_optional, None)

    assert detail.status_code == 200
    assert listing.status_code == 200
    assert "badge-model" not in detail.text
    assert "badge-model" not in listing.text
    assert 'id="request-models"' in detail.text, "the island is always present, just empty"

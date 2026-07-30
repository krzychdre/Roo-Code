"""Tests for the usage metrics once the extension reports its side calls.

The point of the change these cover: the console under-reported against the
inference server because only conversation turns were ever recorded. Now that
condensing, prompt enhancement, memory recall and code-index embeddings are
reported too, the page has to show them *without* letting them quietly inflate
the figures they sit beside.
"""

import json

import pytest

from src.auth.web_session import get_web_user_optional
from src.models.event import TelemetryEvent
from src.services.metrics_service import compute_user_metrics

from tests.test_web_and_share import _llm_event, _override_web_user, _seed_user


def _embedding_event(user_id="user_test", *, prompt_tokens=1000, source="index-scan"):
    from datetime import datetime, timezone

    return TelemetryEvent(
        user_id=user_id,
        event_type="Embedding Usage",
        properties=json.dumps(
            {
                "promptTokens": prompt_tokens,
                "totalTokens": prompt_tokens,
                "source": source,
                "apiProvider": "openai-compatible",
            }
        ),
        created_at=datetime.now(timezone.utc),
    )


async def test_side_calls_are_counted_and_broken_out_by_kind(db_session):
    await _seed_user(db_session)
    db_session.add_all(
        [
            _llm_event(task_id="t1", model="GLM-5.2", tin=10_000, tout=500, cost=0.1),
            _llm_event(task_id="t1", model="GLM-5.2", tin=12_000, tout=400, cost=0.1, kind="task"),
            _llm_event(
                task_id="t1", model="background", tin=40_000, tout=900, cost=0.4, kind="condense"
            ),
            _llm_event(task_id="t1", model="GLM-5.2", tin=3_000, tout=20, cost=0.0, kind="memory"),
        ]
    )
    await db_session.commit()

    m = await compute_user_metrics(db_session, "user_test", period="all")

    # Everything the extension spent is in the total — that is the whole point.
    assert m["totals"]["total_tokens"] == 10_500 + 12_400 + 40_900 + 3_020
    kinds = {row["name"]: row for row in m["by_kind"]}
    assert kinds["task"]["count"] == 2, "a row with no kind is a conversation turn"
    assert kinds["condense"]["tokens"] == 40_900
    assert kinds["condense"]["label"] == "Condensing"
    assert kinds["memory"]["count"] == 1


async def test_a_corpus_of_conversation_turns_has_a_single_kind(db_session):
    """So the page can hide the split panel instead of stating the obvious."""
    await _seed_user(db_session)
    db_session.add(_llm_event(task_id="t1", model="GLM-5.2", tin=10, tout=1))
    await db_session.commit()

    m = await compute_user_metrics(db_session, "user_test", period="all")

    assert [row["name"] for row in m["by_kind"]] == ["task"]


async def test_calls_the_provider_could_not_price_are_counted_not_hidden(db_session):
    await _seed_user(db_session)
    db_session.add_all(
        [
            _llm_event(task_id="t1", model="m", tin=0, tout=0, kind="enhance", usage_reported=False),
            _llm_event(task_id="t1", model="m", tin=100, tout=10, kind="task", usage_reported=True),
        ]
    )
    await db_session.commit()

    m = await compute_user_metrics(db_session, "user_test", period="all")

    assert m["unreported"] == 1
    assert m["totals"]["completions"] == 2


async def test_embeddings_are_reported_apart_from_the_token_total(db_session):
    """An index of a repository would otherwise bury the conversation figures."""
    await _seed_user(db_session)
    db_session.add_all(
        [
            _llm_event(task_id="t1", model="GLM-5.2", tin=1_000, tout=100),
            _embedding_event(prompt_tokens=500_000, source="index-scan"),
            _embedding_event(prompt_tokens=1_200, source="search"),
        ]
    )
    await db_session.commit()

    m = await compute_user_metrics(db_session, "user_test", period="all")

    assert m["totals"]["total_tokens"] == 1_100, "embeddings stay out of the completion total"
    assert m["embeddings"]["tokens"] == 501_200
    assert m["embeddings"]["calls"] == 2
    assert [s["name"] for s in m["embeddings"]["by_source"]] == ["index-scan", "search"]


async def test_no_embeddings_means_no_indexing_figure_to_show(db_session):
    await _seed_user(db_session)
    db_session.add(_llm_event(task_id="t1", model="GLM-5.2", tin=10, tout=1))
    await db_session.commit()

    m = await compute_user_metrics(db_session, "user_test", period="all")

    assert m["embeddings"]["has_data"] is False


async def test_embeddings_respect_the_selected_period(db_session):
    from datetime import datetime, timedelta, timezone

    await _seed_user(db_session)
    old = _embedding_event(prompt_tokens=999_999)
    old.created_at = datetime.now(timezone.utc) - timedelta(days=40)
    db_session.add_all([old, _embedding_event(prompt_tokens=7)])
    await db_session.commit()

    recent = await compute_user_metrics(db_session, "user_test", period="7d")
    everything = await compute_user_metrics(db_session, "user_test", period="all")

    assert recent["embeddings"]["tokens"] == 7
    assert everything["embeddings"]["tokens"] == 1_000_006


async def test_metrics_page_shows_the_split_and_the_indexing_tile(
    client, db_session, session_factory
):
    async with session_factory() as s:
        await _seed_user(s)
        s.add_all(
            [
                _llm_event(task_id="t1", model="GLM-5.2", tin=10_000, tout=500, kind="task"),
                _llm_event(task_id="t1", model="background", tin=40_000, tout=900, kind="condense"),
                _embedding_event(prompt_tokens=250_000),
            ]
        )
        await s.commit()

    _override_web_user(client.app)
    try:
        resp = client.get("/app/metrics?period=all")
    finally:
        client.app.dependency_overrides.pop(get_web_user_optional, None)

    assert resp.status_code == 200
    assert "Where the tokens went" in resp.text
    assert "Condensing" in resp.text
    assert "Indexing" in resp.text
    assert "250k" in resp.text

"""Guards on reverting a session.

Revert permanently deletes the selected message and everything after it,
including messages other participants wrote, so it is gated like deleting or
archiving the session: owner only. It must also refuse whenever the discarded
history could survive in a runtime. These tests drive the real route against
file-backed stores with header auth.
"""

from __future__ import annotations

import time
from typing import Any

import httpx
import pytest
from fastapi.testclient import TestClient

from omnigent.entities import MessageData, NewConversationItem
from omnigent.stores.agent_store.sqlalchemy_store import SqlAlchemyAgentStore
from omnigent.stores.conversation_store.sqlalchemy_store import (
    SqlAlchemyConversationStore,
)
from omnigent.stores.permission_store.sqlalchemy_store import (
    SqlAlchemyPermissionStore,
)
from tests.server.routes.test_sessions_cost_labels import (
    ALICE,
    BOB,
    _multi_user_app,
    _seed_session,
)

_Stores = tuple[SqlAlchemyConversationStore, SqlAlchemyAgentStore, SqlAlchemyPermissionStore]


@pytest.fixture
def stores(db_uri: str) -> _Stores:
    """Real file-backed stores backing the route under test.

    :param db_uri: Per-test SQLite URI from the root conftest.
    :returns: ``(conversation_store, agent_store, permission_store)``.
    """
    return (
        SqlAlchemyConversationStore(db_uri),
        SqlAlchemyAgentStore(db_uri),
        SqlAlchemyPermissionStore(db_uri),
    )


def _user_message(response_id: str, *content: dict[str, Any], **extra: Any) -> NewConversationItem:
    return NewConversationItem(
        type="message",
        response_id=response_id,
        data=MessageData(role="user", content=list(content), **extra),
    )


def _text(text: str) -> dict[str, Any]:
    return {"type": "input_text", "text": text}


def _seed_prompt(stores: _Stores) -> tuple[str, str]:
    """Seed a session Alice owns and Bob may edit, holding one prompt.

    :param stores: The shared store fixture.
    :returns: ``(session_id, user_message_id)``.
    """
    conversation_store = stores[0]
    conv_id = _seed_session(stores, editor=BOB)
    conversation_store.append(conv_id, [_user_message("resp_001", _text("Alice's prompt"))])
    return conv_id, conversation_store.list_items(conv_id).data[0].id


def _seed_two_prompts(stores: _Stores) -> tuple[str, str, str]:
    """Seed an owned session with two prompts, returning both message ids."""
    conversation_store = stores[0]
    conv_id = _seed_session(stores)
    conversation_store.append(conv_id, [_user_message("resp_001", _text("first"))])
    conversation_store.append(conv_id, [_user_message("resp_002", _text("second"))])
    first, second = conversation_store.list_items(conv_id).data
    return conv_id, first.id, second.id


def _revert(stores: _Stores, conv_id: str, message_id: str) -> httpx.Response:
    return TestClient(_multi_user_app(stores)).post(
        f"/v1/sessions/{conv_id}/revert",
        json={"user_message_id": message_id},
        headers={"X-Forwarded-Email": ALICE},
    )


def test_editor_cannot_revert_a_shared_session(stores: _Stores) -> None:
    """Edit access lets Bob talk in the session, not erase its history."""
    conv_id, message_id = _seed_prompt(stores)

    resp = TestClient(_multi_user_app(stores)).post(
        f"/v1/sessions/{conv_id}/revert",
        json={"user_message_id": message_id},
        headers={"X-Forwarded-Email": BOB},
    )

    assert resp.status_code == 403
    assert [item.id for item in stores[0].list_items(conv_id).data] == [message_id]


def test_owner_can_revert_their_session(stores: _Stores) -> None:
    conv_id, message_id = _seed_prompt(stores)

    resp = TestClient(_multi_user_app(stores)).post(
        f"/v1/sessions/{conv_id}/revert",
        json={"user_message_id": message_id},
        headers={"X-Forwarded-Email": ALICE},
    )

    assert resp.status_code == 200, resp.text
    assert resp.json() == {"draft": "Alice's prompt", "attachments": []}
    assert stores[0].list_items(conv_id).data == []


def test_revert_points_are_real_prompts_newest_first(stores: _Stores) -> None:
    """Runtime notices and meta messages are never offered as revert points."""
    conversation_store = stores[0]
    conv_id = _seed_session(stores)
    conversation_store.append(
        conv_id,
        [
            _user_message("resp_001", _text("first")),
            _user_message("resp_002", _text("[System: timer t1 fired]")),
            _user_message("resp_003", _text("hidden"), is_meta=True),
            _user_message("resp_004", {"type": "input_image", "file_id": "file_1"}),
        ],
    )
    first, _, _, image_only = conversation_store.list_items(conv_id).data

    resp = TestClient(_multi_user_app(stores)).get(
        f"/v1/sessions/{conv_id}/revert-points",
        headers={"X-Forwarded-Email": ALICE},
    )

    assert resp.status_code == 200, resp.text
    assert [(point["id"], point["has_attachments"]) for point in resp.json()["data"]] == [
        (image_only.id, True),
        (first.id, False),
    ]


def test_revert_rejects_a_runtime_notice(stores: _Stores) -> None:
    conversation_store = stores[0]
    conv_id = _seed_session(stores)
    conversation_store.append(
        conv_id, [_user_message("resp_001", _text("[System: timer t1 fired]"))]
    )
    notice = conversation_store.list_items(conv_id).data[0]

    resp = _revert(stores, conv_id, notice.id)

    assert resp.status_code == 400
    assert [item.id for item in conversation_store.list_items(conv_id).data] == [notice.id]


def test_revert_hands_back_the_prompts_attachments(stores: _Stores) -> None:
    conversation_store = stores[0]
    conv_id = _seed_session(stores)
    conversation_store.append(
        conv_id,
        [
            _user_message(
                "resp_001",
                _text("look at this"),
                {"type": "input_image", "file_id": "file_img", "filename": "shot.png"},
                {"type": "input_file", "file_id": "file_doc"},
            )
        ],
    )

    resp = _revert(stores, conv_id, conversation_store.list_items(conv_id).data[0].id)

    assert resp.status_code == 200, resp.text
    assert resp.json() == {
        "draft": "look at this",
        "attachments": [
            {"type": "input_image", "file_id": "file_img", "filename": "shot.png"},
            {"type": "input_file", "file_id": "file_doc", "filename": None},
        ],
    }


def test_revert_refuses_a_turn_running_on_another_replica(stores: _Stores) -> None:
    """With no local status cache entry, the persisted status still blocks it."""
    conv_id, first_id, second_id = _seed_two_prompts(stores)
    stores[0].set_session_live_status(conv_id, "running")

    resp = _revert(stores, conv_id, second_id)

    assert resp.status_code == 409
    assert [item.id for item in stores[0].list_items(conv_id).data] == [first_id, second_id]


def test_revert_fails_closed_when_the_bound_runner_is_unreachable(stores: _Stores) -> None:
    """A live runner this replica can't reach could keep the discarded turns."""
    conv_id, first_id, second_id = _seed_two_prompts(stores)
    stores[0].replace_runner_id(conv_id, "runner_elsewhere")
    stores[0].touch_runner_liveness(["runner_elsewhere"], int(time.time()))

    resp = _revert(stores, conv_id, second_id)

    assert resp.status_code == 503
    assert [item.id for item in stores[0].list_items(conv_id).data] == [first_id, second_id]


def test_revert_resets_the_runtime_after_rewinding(
    stores: _Stores,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """The reset must see the rewound store, or a relaunch resumes old turns."""
    from omnigent.server.routes import sessions as sessions_module

    conv_id, first_id, second_id = _seed_two_prompts(stores)
    seen_at_reset: list[list[str]] = []

    class _Runner:
        async def post(self, url: str, **_kwargs: Any) -> httpx.Response:
            seen_at_reset.append([item.id for item in stores[0].list_items(conv_id).data])
            return httpx.Response(200, json={}, request=httpx.Request("POST", url))

    async def runner_client(*_args: Any, **_kwargs: Any) -> _Runner:
        return _Runner()

    monkeypatch.setattr(sessions_module, "_get_runner_client", runner_client)

    resp = _revert(stores, conv_id, second_id)

    assert resp.status_code == 200, resp.text
    assert seen_at_reset == [[first_id]]


def test_native_agent_without_history_replay_reverts_only_to_its_first_message(
    stores: _Stores,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """Such an agent relaunches with no memory, so keeping earlier turns would lie."""
    from omnigent.server.routes import sessions as sessions_module

    monkeypatch.setattr(sessions_module, "_agent_is_native", lambda _agent: True)
    conv_id, first_id, second_id = _seed_two_prompts(stores)

    refused = _revert(stores, conv_id, second_id)
    allowed = _revert(stores, conv_id, first_id)

    assert refused.status_code == 400
    assert allowed.status_code == 200, allowed.text
    assert stores[0].list_items(conv_id).data == []

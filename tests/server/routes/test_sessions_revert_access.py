"""Who may revert a shared session.

Revert permanently deletes the selected message and everything after it,
including messages other participants wrote, so it is gated like deleting or
archiving the session: owner only. These tests drive the real route against
file-backed stores with header auth.
"""

from __future__ import annotations

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


def _seed_prompt(stores: _Stores) -> tuple[str, str]:
    """Seed a session Alice owns and Bob may edit, holding one prompt.

    :param stores: The shared store fixture.
    :returns: ``(session_id, user_message_id)``.
    """
    conversation_store = stores[0]
    conv_id = _seed_session(stores, editor=BOB)
    conversation_store.append(
        conv_id,
        [
            NewConversationItem(
                type="message",
                response_id="resp_001",
                data=MessageData(
                    role="user", content=[{"type": "input_text", "text": "Alice's prompt"}]
                ),
            )
        ],
    )
    return conv_id, conversation_store.list_items(conv_id).data[0].id


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
    assert resp.json() == {"draft": "Alice's prompt"}
    assert stores[0].list_items(conv_id).data == []

"""Tests for the REPL ``/revert`` slash command."""

from __future__ import annotations

from types import SimpleNamespace
from unittest.mock import AsyncMock

import pytest
from omnigent_ui_sdk import RichBlockFormatter

from omnigent.repl import _repl as repl_mod
from tests.repl.helpers import CapturingHost

pytestmark = pytest.mark.asyncio


async def test_revert_lists_the_servers_revert_points() -> None:
    """``/revert`` offers exactly the messages the server says are selectable."""
    sessions = SimpleNamespace(
        revert_points=AsyncMock(return_value=[]),
        revert=AsyncMock(),
    )
    host = CapturingHost()

    assert "/revert" in repl_mod.COMMANDS
    await repl_mod.handle_slash_command(
        "/revert",
        SimpleNamespace(session_id="conv_main"),  # type: ignore[arg-type]
        SimpleNamespace(sessions=sessions),  # type: ignore[arg-type]
        host,
        RichBlockFormatter(),  # type: ignore[arg-type]
    )

    sessions.revert_points.assert_awaited_once_with("conv_main")
    sessions.revert.assert_not_awaited()
    assert "No user messages to revert to." in host.text

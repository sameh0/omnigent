"""Which user messages a session can be reverted to.

The server owns this rule; the web picker and the REPL list revert points
through ``GET /v1/sessions/{id}/revert-points`` instead of re-deriving it.
"""

from __future__ import annotations

import re
from typing import Any

from omnigent.entities import ConversationItem, MessageData
from omnigent.server.schemas import SessionRevertAttachment, SessionRevertPoint

# Runtime notices ride in as role="user" messages; mirrors the web's
# ``isSystemUserContent`` so they never become revert points.
_SYSTEM_HEADER_RE = re.compile(r"^\[System: .+\]$")
_INTERRUPT_RE = re.compile(r"^\[Request interrupted by user(?: for tool use)?\]$")
_ATTACHED_RE = re.compile(r"\[Attached(?: file)?:\s*([^\]]*)\]\s*")
_RUNTIME_ENVELOPE_PREFIXES = ("<task-notification>", "<agent-message ", "<teammate-message ")


def revert_attachments(content: list[dict[str, Any]]) -> list[SessionRevertAttachment]:
    """Return the uploaded files a user message carried.

    :param content: Message content blocks.
    :returns: One entry per image/file block that references a session file.
    """
    attachments: list[SessionRevertAttachment] = []
    for block in content:
        block_type = block.get("type")
        file_id = block.get("file_id")
        if block_type in ("input_image", "input_file") and isinstance(file_id, str) and file_id:
            filename = block.get("filename")
            attachments.append(
                SessionRevertAttachment(
                    type=block_type,
                    file_id=file_id,
                    filename=filename if isinstance(filename, str) and filename else None,
                )
            )
    return attachments


def _user_texts(content: list[dict[str, Any]]) -> list[str]:
    return [
        block["text"]
        for block in content
        if block.get("type") == "input_text" and isinstance(block.get("text"), str)
    ]


def revert_point(item: ConversationItem) -> SessionRevertPoint | None:
    """Return *item* as a revert point, or ``None`` when it can't be one.

    :param item: A stored conversation item.
    :returns: The revert point for a real user prompt; ``None`` for other
        items, meta messages, and runtime notices.
    """
    data = item.data
    if item.type != "message" or not isinstance(data, MessageData):
        return None
    if data.role != "user" or data.is_meta:
        return None
    texts = _user_texts(data.content)
    has_attachments = any(
        block.get("type") in ("input_image", "input_file") for block in data.content
    )
    if not has_attachments:
        marker_text = _ATTACHED_RE.sub("", "".join(texts)).strip()
        first_line = marker_text.split("\n", 1)[0]
        if (
            _SYSTEM_HEADER_RE.match(first_line)
            or _INTERRUPT_RE.match(first_line)
            or marker_text.startswith(_RUNTIME_ENVELOPE_PREFIXES)
        ):
            return None
    return SessionRevertPoint(
        id=item.id,
        text="\n".join(texts),
        has_attachments=has_attachments,
        created_at=item.created_at,
    )

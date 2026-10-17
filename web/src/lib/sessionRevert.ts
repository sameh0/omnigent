// Reverts this tab started. Their `session.reverted` echo is skipped because
// the reverting dialog already reloads the session itself.
const localReverts = new Set<string>();

function revertKey(conversationId: string, userMessageId: string): string {
  return `${conversationId}\n${userMessageId}`;
}

/** Record a revert this tab is about to request. */
export function noteLocalRevert(conversationId: string, userMessageId: string): void {
  localReverts.add(revertKey(conversationId, userMessageId));
}

/** Forget a local revert; returns whether it had been recorded. */
export function consumeLocalRevert(conversationId: string, userMessageId: string): boolean {
  return localReverts.delete(revertKey(conversationId, userMessageId));
}

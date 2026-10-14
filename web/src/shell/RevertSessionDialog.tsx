import { useEffect, useState } from "react";
import { HistoryIcon, Loader2Icon } from "lucide-react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import {
  fetchRevertPoints,
  fetchSessionFile,
  revertSession,
  type RevertAttachment,
} from "@/lib/sessionsApi";
import { replaceSessionDraft } from "@/lib/sessionDrafts";
import { consumeLocalRevert, noteLocalRevert } from "@/lib/sessionRevert";
import { cn } from "@/lib/utils";
import { useChatStore } from "@/store/chatStore";

/** Re-download the reverted prompt's files; returns those that loaded. */
async function loadAttachments(
  sessionId: string,
  attachments: RevertAttachment[],
): Promise<{ files: File[]; missing: number }> {
  const results = await Promise.allSettled(
    attachments.map((attachment, index) =>
      fetchSessionFile(
        sessionId,
        attachment.file_id,
        attachment.filename ?? `attachment-${index + 1}`,
      ),
    ),
  );
  const files = results.flatMap((result) => (result.status === "fulfilled" ? [result.value] : []));
  return { files, missing: results.length - files.length };
}

export function RevertSessionDialog({
  sourceSessionId,
  initialUserMessageId,
  open,
  onOpenChange,
}: {
  sourceSessionId: string;
  initialUserMessageId?: string | null;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const queryClient = useQueryClient();
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const {
    data: messages = [],
    isLoading: loading,
    error: loadError,
  } = useQuery({
    queryKey: ["session", sourceSessionId, "revert-points"],
    queryFn: () => fetchRevertPoints(sourceSessionId),
    enabled: open,
  });
  // A clicked message the server doesn't offer is never swapped for another.
  const initialUnavailable =
    !!initialUserMessageId &&
    !loading &&
    !messages.some((message) => message.id === initialUserMessageId);

  useEffect(() => {
    if (!open || loading) return;
    setSelectedId(
      initialUserMessageId
        ? messages.some((message) => message.id === initialUserMessageId)
          ? initialUserMessageId
          : null
        : (messages[0]?.id ?? null),
    );
  }, [initialUserMessageId, loading, messages, open]);

  useEffect(() => {
    if (!open) {
      queryClient.removeQueries({
        queryKey: ["session", sourceSessionId, "revert-points"],
      });
      setError(null);
    }
  }, [open, queryClient, sourceSessionId]);

  const errorMessage =
    error ??
    loadError?.message ??
    (initialUnavailable ? "That message can't be reverted to. Choose another one." : null);

  async function handleRevert(): Promise<void> {
    if (!selectedId || submitting) return;
    setSubmitting(true);
    setError(null);
    noteLocalRevert(sourceSessionId, selectedId);
    let result: Awaited<ReturnType<typeof revertSession>>;
    try {
      result = await revertSession(sourceSessionId, selectedId);
    } catch (reason) {
      consumeLocalRevert(sourceSessionId, selectedId);
      setError(reason instanceof Error ? reason.message : "Couldn't revert the session.");
      setSubmitting(false);
      return;
    }
    try {
      void queryClient.invalidateQueries({ queryKey: ["conversations"] });
      void queryClient.invalidateQueries({ queryKey: ["session", sourceSessionId], exact: true });
      const { files, missing } = await loadAttachments(sourceSessionId, result.attachments);
      // Hand the prompt back before reloading: the remounted composer reads it
      // from the draft store, and a mounted one adopts it immediately.
      replaceSessionDraft(sourceSessionId, result.draft, files);
      await useChatStore.getState().switchTo(sourceSessionId, { reload: true });
      onOpenChange(false);
      toast.success("Conversation reverted. Edit the message and send it again.");
      if (missing > 0) {
        toast.warning(
          missing === 1
            ? "One attachment couldn't be restored. Attach it again before sending."
            : `${missing} attachments couldn't be restored. Attach them again before sending.`,
        );
      }
    } catch (reason) {
      // The revert itself succeeded; only the local reload failed.
      onOpenChange(false);
      toast.error(
        reason instanceof Error
          ? `Conversation reverted, but reloading it failed: ${reason.message}`
          : "Conversation reverted, but reloading it failed. Refresh the page.",
      );
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="grid max-h-[85vh] grid-rows-[auto_minmax(0,1fr)_auto] gap-5 sm:max-w-2xl">
        <DialogHeader className="gap-3 pr-8">
          <DialogTitle className="flex items-center gap-2.5 text-lg leading-tight sm:text-xl">
            <HistoryIcon className="size-5" />
            Revert conversation
          </DialogTitle>
          <DialogDescription className="leading-6">
            Choose a user message to return to. That message and everything after it will be removed
            from this session. Files will be left unchanged.
          </DialogDescription>
        </DialogHeader>

        <div
          className="min-h-0 space-y-2 overflow-y-auto rounded-xl border p-2"
          data-testid="revert-message-list"
        >
          {loading ? (
            <div className="flex items-center justify-center gap-2 py-10 text-muted-foreground">
              <Loader2Icon className="size-4 animate-spin" /> Loading messages…
            </div>
          ) : messages.length === 0 ? (
            <p className="p-4 text-center text-muted-foreground">No user messages to revert to.</p>
          ) : (
            messages.map((message) => {
              const text = message.text.trim() || "(attachments only)";
              const active = selectedId === message.id;
              return (
                <label
                  key={message.id}
                  className={cn(
                    "flex cursor-pointer gap-3 rounded-lg px-3 py-3 hover:bg-accent",
                    active && "bg-accent ring-1 ring-primary/30",
                  )}
                >
                  <input
                    type="radio"
                    name="revert-message"
                    value={message.id}
                    checked={active}
                    onChange={() => setSelectedId(message.id)}
                    className="mt-1 accent-primary"
                  />
                  <span className="min-w-0">
                    <span className="block text-xs font-medium text-muted-foreground">You</span>
                    <span className="line-clamp-2 block text-sm leading-5">{text}</span>
                  </span>
                </label>
              );
            })
          )}
        </div>

        <div>
          {errorMessage && <p className="mb-2 text-sm text-destructive">{errorMessage}</p>}
          <DialogFooter>
            <Button variant="outline" onClick={() => onOpenChange(false)} disabled={submitting}>
              Cancel
            </Button>
            <Button
              onClick={() => void handleRevert()}
              disabled={!selectedId || loading || submitting}
            >
              {submitting && <Loader2Icon className="animate-spin" />}
              Revert
            </Button>
          </DialogFooter>
        </div>
      </DialogContent>
    </Dialog>
  );
}

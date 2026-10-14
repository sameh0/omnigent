import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { RevertSessionDialog } from "./RevertSessionDialog";
import type { MessageItem } from "@/lib/conversationItems";
import { fetchSessionItemsPage, revertSession } from "@/lib/sessionsApi";
import { replaceSessionDraft } from "@/lib/sessionDrafts";

const { switchToMock } = vi.hoisted(() => ({ switchToMock: vi.fn() }));
vi.mock("@/lib/sessionsApi", () => ({
  fetchSessionItemsPage: vi.fn(),
  revertSession: vi.fn(),
}));
vi.mock("@/lib/sessionDrafts", () => ({ replaceSessionDraft: vi.fn() }));
vi.mock("@/store/chatStore", () => ({
  useChatStore: { getState: () => ({ switchTo: switchToMock }) },
}));

const fetchItemsMock = vi.mocked(fetchSessionItemsPage);
const revertMock = vi.mocked(revertSession);
const setDraftMock = vi.mocked(replaceSessionDraft);

function userMessage(id: string, text: string): MessageItem {
  return {
    id,
    type: "message",
    response_id: `resp_${id}`,
    status: "completed",
    role: "user",
    content: [{ type: "input_text", text }],
  };
}

function renderDialog(
  initialUserMessageId: string | null = null,
  onOpenChange: (open: boolean) => void = vi.fn(),
) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const dialog = (open: boolean) => (
    <QueryClientProvider client={client}>
      <RevertSessionDialog
        sourceSessionId="conv_source"
        initialUserMessageId={initialUserMessageId}
        open={open}
        onOpenChange={onOpenChange}
      />
    </QueryClientProvider>
  );
  const view = render(dialog(true));
  return { ...view, setOpen: (open: boolean) => view.rerender(dialog(open)) };
}

beforeEach(() => {
  switchToMock.mockReset();
  switchToMock.mockResolvedValue(undefined);
  fetchItemsMock.mockReset();
  revertMock.mockReset();
  setDraftMock.mockReset();
  fetchItemsMock.mockResolvedValue({
    items: [userMessage("msg_1", "first prompt"), userMessage("msg_2", "second prompt")],
    hasMore: false,
  });
  revertMock.mockResolvedValue({ draft: "second prompt" });
});

afterEach(cleanup);

describe("RevertSessionDialog", () => {
  it("hands the prompt back, reloads the session, and lists current messages when reopened", async () => {
    let finishReload!: () => void;
    switchToMock.mockImplementationOnce(
      () =>
        new Promise<void>((resolve) => {
          finishReload = resolve;
        }),
    );
    const { setOpen } = renderDialog("msg_2");

    await screen.findByText("second prompt");
    expect(screen.getByDisplayValue("msg_2")).toBeChecked();
    expect(screen.queryByText("Revert file changes")).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Revert" }));

    await waitFor(() => expect(revertMock).toHaveBeenCalledWith("conv_source", "msg_2"));
    // The draft lands before the reload so the remounted composer reads it.
    await waitFor(() => expect(switchToMock).toHaveBeenCalledWith("conv_source", { reload: true }));
    expect(setDraftMock).toHaveBeenCalledWith("conv_source", "second prompt");
    finishReload();

    setOpen(false);
    fetchItemsMock.mockResolvedValueOnce({
      items: [userMessage("msg_1", "first prompt")],
      hasMore: false,
    });
    setOpen(true);

    await screen.findByText("first prompt");
    expect(fetchItemsMock).toHaveBeenCalledTimes(2);
    expect(screen.queryByText("second prompt")).not.toBeInTheDocument();
  });

  it("keeps the dialog open and the session untouched when the server refuses", async () => {
    revertMock.mockRejectedValueOnce(
      new Error("Wait for the current turn to finish before reverting."),
    );
    const onOpenChange = vi.fn();
    renderDialog("msg_1", onOpenChange);

    await screen.findByText("first prompt");
    fireEvent.click(screen.getByRole("button", { name: "Revert" }));

    await screen.findByText("Wait for the current turn to finish before reverting.");
    expect(setDraftMock).not.toHaveBeenCalled();
    expect(switchToMock).not.toHaveBeenCalled();
    expect(onOpenChange).not.toHaveBeenCalledWith(false);
  });
});

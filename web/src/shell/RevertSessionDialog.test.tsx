import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { RevertSessionDialog } from "./RevertSessionDialog";
import { fetchRevertPoints, fetchSessionFile, revertSession } from "@/lib/sessionsApi";
import { replaceSessionDraft } from "@/lib/sessionDrafts";
import { consumeLocalRevert } from "@/lib/sessionRevert";

const { switchToMock } = vi.hoisted(() => ({ switchToMock: vi.fn() }));
vi.mock("@/lib/sessionsApi", () => ({
  fetchRevertPoints: vi.fn(),
  fetchSessionFile: vi.fn(),
  revertSession: vi.fn(),
}));
vi.mock("@/lib/sessionDrafts", () => ({ replaceSessionDraft: vi.fn() }));
vi.mock("@/store/chatStore", () => ({
  useChatStore: { getState: () => ({ switchTo: switchToMock }) },
}));

const fetchPointsMock = vi.mocked(fetchRevertPoints);
const fetchFileMock = vi.mocked(fetchSessionFile);
const revertMock = vi.mocked(revertSession);
const setDraftMock = vi.mocked(replaceSessionDraft);

function point(id: string, text: string) {
  return { id, text, hasAttachments: false };
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
  fetchPointsMock.mockReset();
  fetchFileMock.mockReset();
  revertMock.mockReset();
  setDraftMock.mockReset();
  // Newest first, as the server lists them.
  fetchPointsMock.mockResolvedValue([
    point("msg_2", "second prompt"),
    point("msg_1", "first prompt"),
  ]);
  revertMock.mockResolvedValue({ draft: "second prompt", attachments: [] });
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
    expect(setDraftMock).toHaveBeenCalledWith("conv_source", "second prompt", []);
    // This tab reloads itself, so its own `session.reverted` echo is skipped.
    expect(consumeLocalRevert("conv_source", "msg_2")).toBe(true);
    finishReload();

    setOpen(false);
    fetchPointsMock.mockResolvedValueOnce([point("msg_1", "first prompt")]);
    setOpen(true);

    await screen.findByText("first prompt");
    expect(fetchPointsMock).toHaveBeenCalledTimes(2);
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
    // A failed revert leaves no marker that would swallow a later real event.
    expect(consumeLocalRevert("conv_source", "msg_1")).toBe(false);
  });

  it("re-attaches the reverted prompt's files to the draft", async () => {
    const image = new File(["png"], "shot.png", { type: "image/png" });
    fetchFileMock.mockResolvedValueOnce(image);
    revertMock.mockResolvedValueOnce({
      draft: "look at this",
      attachments: [{ type: "input_image", file_id: "file_img", filename: "shot.png" }],
    });
    renderDialog("msg_2");

    await screen.findByText("second prompt");
    fireEvent.click(screen.getByRole("button", { name: "Revert" }));

    await waitFor(() =>
      expect(setDraftMock).toHaveBeenCalledWith("conv_source", "look at this", [image]),
    );
    expect(fetchFileMock).toHaveBeenCalledWith("conv_source", "file_img", "shot.png");
  });

  it("never swaps a clicked message the server doesn't offer for another one", async () => {
    renderDialog("msg_shell_command");

    await screen.findByText("That message can't be reverted to. Choose another one.");
    expect(screen.getByDisplayValue("msg_2")).not.toBeChecked();
    expect(screen.getByDisplayValue("msg_1")).not.toBeChecked();
    expect(screen.getByRole("button", { name: "Revert" })).toBeDisabled();
  });
});

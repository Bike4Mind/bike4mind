import { create } from 'zustand';

export interface SendPromptOptions {
  /**
   * Apply the same sendBlockedReason gate the Send button and Enter use (reconnecting,
   * uploading, loading models, etc). Reply-choice buttons opt in so a click can't send and
   * record a pick the composer would have refused. Other programmatic callers (e.g. chess)
   * must keep their pre-existing behavior - no gate, just the in-flight/validation refusal -
   * so they default to ungated.
   */
  respectBlockedState?: boolean;
}

/**
 * Lightweight Zustand store that exposes the chat send function
 * so components outside SessionBottom (e.g., InteractiveChessBoard)
 * can programmatically send messages through the normal LLM flow.
 *
 * SessionBottom registers its handleSendClick on mount;
 * consumers call sendPrompt() to trigger a full send (including LLM response).
 * It resolves false when the send was refused before dispatch (one already in
 * flight, input validation failed, or - with respectBlockedState - the composer's
 * blocked-send gate), true otherwise.
 */
interface ChatActionsState {
  sendPrompt: ((prompt: string, options?: SendPromptOptions) => Promise<boolean>) | null;
}

const useChatActions = create<ChatActionsState>(() => ({
  sendPrompt: null,
}));

export const registerSendPrompt = (fn: ((prompt: string, options?: SendPromptOptions) => Promise<boolean>) | null) => {
  useChatActions.setState({ sendPrompt: fn });
};

export default useChatActions;

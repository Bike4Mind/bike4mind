import { create } from 'zustand';

/**
 * Lightweight Zustand store that exposes the chat send function
 * so components outside SessionBottom (e.g., InteractiveChessBoard)
 * can programmatically send messages through the normal LLM flow.
 *
 * SessionBottom registers its handleSendClick on mount;
 * consumers call sendPrompt() to trigger a full send (including LLM response).
 */
interface ChatActionsState {
  sendPrompt: ((prompt: string) => Promise<void>) | null;
}

const useChatActions = create<ChatActionsState>(() => ({
  sendPrompt: null,
}));

export const registerSendPrompt = (fn: ((prompt: string) => Promise<void>) | null) => {
  useChatActions.setState({ sendPrompt: fn });
};

export default useChatActions;

import { create } from 'zustand';
import { persist } from 'zustand/middleware';
import { useAccessToken } from './useAccessToken';

export interface HelpChatRelevantArticle {
  slug: string;
  title: string;
}

/**
 * Message in the help chat conversation
 */
export interface HelpChatMessage {
  id: string;
  role: 'user' | 'assistant';
  content: string;
  timestamp: number;
  isStreaming?: boolean;
  relevantArticles?: HelpChatRelevantArticle[];
}

/**
 * Help Chat Store State
 */
interface HelpChatState {
  // Chat state
  messages: HelpChatMessage[];
  isLoading: boolean;
  error: string | null;

  // UI state
  isOpen: boolean;
}

/**
 * Help Chat Store Actions
 */
interface HelpChatActions {
  // Chat actions
  addMessage: (message: Omit<HelpChatMessage, 'id' | 'timestamp'>) => string;
  updateMessage: (
    id: string,
    content: string,
    isStreaming?: boolean,
    relevantArticles?: HelpChatRelevantArticle[]
  ) => void;
  clearMessages: () => void;
  setLoading: (loading: boolean) => void;
  setError: (error: string | null) => void;

  // UI actions
  setIsOpen: (open: boolean) => void;
  toggleChat: () => void;

  // Streaming helper
  sendMessage: (question: string, currentHelpSlug?: string) => Promise<void>;
}

type HelpChatStore = HelpChatState & HelpChatActions;

/**
 * Generate a unique ID for messages
 */
function generateId(): string {
  return `msg-${Date.now()}-${Math.random().toString(36).slice(2, 9)}`;
}

export const useHelpChat = create<HelpChatStore>()(
  persist(
    (set, get) => ({
      // Initial state
      messages: [],
      isLoading: false,
      error: null,
      isOpen: false,

      // Chat actions
      addMessage: message => {
        const id = generateId();
        const newMessage: HelpChatMessage = {
          ...message,
          id,
          timestamp: Date.now(),
        };
        set(state => ({
          messages: [...state.messages, newMessage],
        }));
        return id;
      },

      updateMessage: (id, content, isStreaming, relevantArticles) => {
        set(state => ({
          messages: state.messages.map(msg =>
            msg.id === id
              ? {
                  ...msg,
                  content,
                  isStreaming: isStreaming ?? msg.isStreaming,
                  ...(relevantArticles && { relevantArticles }),
                }
              : msg
          ),
        }));
      },

      clearMessages: () => {
        set({ messages: [], error: null });
      },

      setLoading: loading => set({ isLoading: loading }),

      setError: error => set({ error }),

      // UI actions
      setIsOpen: open => set({ isOpen: open }),

      toggleChat: () => set(state => ({ isOpen: !state.isOpen })),

      // Send a message and stream the response
      sendMessage: async (question: string, currentHelpSlug?: string) => {
        get().addMessage({ role: 'user', content: question });

        // Create assistant message placeholder
        const assistantId = get().addMessage({
          role: 'assistant',
          content: '',
          isStreaming: true,
        });

        set({ isLoading: true, error: null });

        try {
          // Re-read state after addMessage calls to get up-to-date conversation history
          const conversationHistory = get()
            .messages.filter(msg => msg.id !== assistantId)
            .slice(-10)
            .map(msg => ({
              role: msg.role,
              content: msg.content,
            }));

          const accessToken = useAccessToken.getState().accessToken;

          const response = await fetch('/api/help/chat', {
            method: 'POST',
            credentials: 'include',
            headers: {
              'Content-Type': 'application/json',
              ...(accessToken && { Authorization: `Bearer ${accessToken}` }),
            },
            body: JSON.stringify({
              question,
              conversationHistory,
              currentHelpSlug,
            }),
          });

          const data = await response.json();

          if (!response.ok) {
            throw new Error(data.error || `HTTP ${response.status}`);
          }

          get().updateMessage(assistantId, data.response, false, data.relevantArticles);
        } catch (error) {
          const errorMessage = error instanceof Error ? error.message : 'Failed to send message';
          set({ error: errorMessage });

          // Update assistant message with error
          get().updateMessage(assistantId, `Sorry, I encountered an error: ${errorMessage}`, false);
        } finally {
          set({ isLoading: false });
        }
      },
    }),
    {
      name: 'help-chat',
      // Only persist messages (not loading state)
      partialize: state => ({
        messages: state.messages.slice(-50), // Keep last 50 messages
        isOpen: state.isOpen,
      }),
    }
  )
);

export default useHelpChat;

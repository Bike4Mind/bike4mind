import { create } from 'zustand';

interface SendToDataLakePayload {
  /** The text to save into a lake (e.g. a session groomed to markdown, or one reply). */
  content: string;
  fileName: string;
  mimeType?: string;
  /** Human label for the success toast, e.g. "session" or "reply". */
  sourceLabel?: string;
}

interface SendToDataLakeStore extends Required<SendToDataLakePayload> {
  isOpen: boolean;
  open: (payload: SendToDataLakePayload) => void;
  close: () => void;
}

/**
 * Drives the single, app-level SendToDataLakeModal (mounted once in ProviderBundle).
 * Call `open({...})` from any "Send to Data Lake" affordance instead of mounting a modal
 * per call site - previously the modal was rendered inside every chat message, so a long
 * session mounted N copies each subscribing to useDataLakes().
 */
export const useSendToDataLakeStore = create<SendToDataLakeStore>(set => ({
  isOpen: false,
  content: '',
  fileName: '',
  mimeType: 'text/markdown',
  sourceLabel: 'content',
  open: ({ content, fileName, mimeType = 'text/markdown', sourceLabel = 'content' }) =>
    set({ isOpen: true, content, fileName, mimeType, sourceLabel }),
  close: () => set({ isOpen: false }),
}));

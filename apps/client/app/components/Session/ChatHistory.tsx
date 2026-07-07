import { IChatHistoryItem } from '@bike4mind/common';
import Box from '@mui/joy/Box';
import React, { memo, useCallback, useEffect, useMemo } from 'react';
import { Virtuoso, type VirtuosoHandle } from 'react-virtuoso';
import MessageContent from '@client/app/components/Session/MessageContent';
import FallbackModelBadge from './FallbackModelBadge';
import { SendMessageOptions } from '@client/app/utils/llm';
import { useSubscribeChatCompletion } from '@client/app/hooks/useSubscribeChatCompletion';
import { flashMessageHighlight, registerScrollToMessageHandler } from '@client/app/utils/chatScroll';

// --- Virtuoso context type ---
// Passed via Virtuoso's `context` prop to stable module-level custom components.
// This avoids inline closures in `components` which would cause remounting.
type VirtuosoContext = {
  sessionId: string;
  footer: React.ReactNode;
};

// --- Stable module-level custom components for Virtuoso ---
// CRITICAL: These must NOT be defined inline in the `components` prop.
// Inline definitions create new component references on every render,
// causing React to unmount/remount the scroll container (losing scroll position).

const VirtuosoScroller = React.forwardRef<HTMLDivElement, React.HTMLAttributes<HTMLDivElement>>(
  function VirtuosoScroller(props, ref) {
    return (
      <Box
        {...props}
        ref={ref}
        sx={theme => ({
          '&::-webkit-scrollbar-thumb': {
            backgroundColor: theme.palette.background.scrollbar,
            border: `3px solid ${theme.palette.background.scrollbarTrack}`,
            borderRadius: '20px',
            minHeight: '100px',
          },
          '&::-webkit-scrollbar': {
            width: 'var(--chat-scrollbar-width, 8px)',
          },
          '&::-webkit-scrollbar-track': {
            backgroundColor: theme.palette.background.scrollbarTrack,
          },
        })}
      />
    );
  }
);

const VirtuosoHeader: React.FC<{ context?: VirtuosoContext }> = ({ context }) => (
  <Box sx={{ display: 'flex', justifyContent: 'center', mb: 1 }}>
    <FallbackModelBadge sessionId={context?.sessionId ?? ''} />
  </Box>
);
VirtuosoHeader.displayName = 'VirtuosoHeader';

const VirtuosoFooter: React.FC<{ context?: VirtuosoContext }> = ({ context }) => <>{context?.footer}</>;
VirtuosoFooter.displayName = 'VirtuosoFooter';

// Stable components object - same references across renders
const VIRTUOSO_COMPONENTS = {
  Header: VirtuosoHeader,
  Footer: VirtuosoFooter,
  Scroller: VirtuosoScroller,
};

// --- ChatHistory ---

interface ChatHistoryProps {
  filteredChatHistory: IChatHistoryItem[];
  sessionId: string;
  mode: string;
  activeStreamingQuestId: string | null;
  chatCompletion: ReturnType<typeof useSubscribeChatCompletion>['chatCompletion'];
  onDelete: (messageData: IChatHistoryItem) => void;
  onPinToggle: (messageData: IChatHistoryItem) => void;
  onSendMessage: (messageData: Partial<IChatHistoryItem>, options: SendMessageOptions) => Promise<void>;
  search: string;
  model: string;
  canUseAdminTools: boolean;
  virtuosoRef: React.RefObject<VirtuosoHandle | null>;
  firstItemIndex: number;
  onStartReached: () => void;
  onAtBottomStateChange: (atBottom: boolean) => void;
  scrollbarWidth: number;
  /** Max width for chat content. The Virtuoso scroller spans full width (scrollbar at
   *  window edge) while content is centered within this constraint. */
  contentMaxWidth?: string;
  /** Callback to capture Virtuoso's scroller DOM element for native scroll operations
   *  (auto-scroll during streaming, scroll-to-bottom button). */
  scrollerRef?: (ref: HTMLElement | Window | null) => void;
  /** Content rendered at the bottom of the virtual list (streaming status, spinners).
   *  Lives inside Virtuoso's scroll container so it doesn't overlap the message list. */
  footer?: React.ReactNode;
}

const ChatHistory: React.FC<ChatHistoryProps> = memo(
  ({
    filteredChatHistory,
    sessionId,
    mode,
    activeStreamingQuestId,
    chatCompletion,
    onDelete,
    onPinToggle,
    onSendMessage,
    search,
    model,
    canUseAdminTools,
    virtuosoRef,
    firstItemIndex,
    onStartReached,
    onAtBottomStateChange,
    scrollbarWidth,
    contentMaxWidth,
    scrollerRef,
    footer,
  }) => {
    // Reverse so oldest is at index 0, newest at last - Virtuoso renders top-to-bottom
    const reversedHistory = useMemo(() => [...filteredChatHistory].reverse(), [filteredChatHistory]);

    // NOTE: Virtuoso re-calls itemContent for ALL visible items on each streaming
    // chunk (because `data` reference changes). Non-streaming items get the same messageData
    // reference so React skips their DOM updates, but the component functions still execute.
    // If streaming becomes choppy with many visible messages, consider wrapping MessageContent
    // in React.memo to bail out early for unchanged props.
    const itemContent = useCallback(
      (virtualIndex: number, messageData: IChatHistoryItem) => {
        // Virtuoso's index is a virtual index offset by firstItemIndex.
        // Convert to the actual array position for correct isLastMessage / divider logic.
        const dataIndex = virtualIndex - firstItemIndex;
        const isStreamingItem = messageData.id != null && messageData.id === activeStreamingQuestId;
        const content = (
          <MessageContent
            sessionId={sessionId}
            messageData={messageData}
            mode={mode}
            index={dataIndex}
            onDelete={onDelete}
            onPinToggle={onPinToggle}
            onSendMessage={onSendMessage}
            isLastMessage={dataIndex === reversedHistory.length - 1}
            search={search}
            model={model}
            totalMessages={reversedHistory.length}
            chatCompletion={isStreamingItem ? chatCompletion : undefined}
            canUseAdminTools={canUseAdminTools}
          />
        );
        // data-message-id is the anchor for scroll-to-message highlighting
        // (see utils/chatScroll.ts)
        return (
          <Box
            data-message-id={messageData.id ?? undefined}
            sx={contentMaxWidth ? { maxWidth: contentMaxWidth, marginX: 'auto' } : undefined}
          >
            {content}
          </Box>
        );
      },
      [
        sessionId,
        mode,
        onDelete,
        onPinToggle,
        onSendMessage,
        search,
        model,
        canUseAdminTools,
        reversedHistory.length,
        firstItemIndex,
        activeStreamingQuestId,
        chatCompletion,
        contentMaxWidth,
      ]
    );

    const virtuosoContext = useMemo<VirtuosoContext>(() => ({ sessionId, footer }), [sessionId, footer]);

    // Scroll-to-message service for other components (e.g. the QuestMaster
    // plan board). Virtuoso's index API reaches messages that are currently
    // virtualized out and have no DOM node.
    useEffect(() => {
      return registerScrollToMessageHandler(messageId => {
        const reversedIndex = reversedHistory.findIndex(item => item.id === messageId);
        if (reversedIndex === -1) return false;
        virtuosoRef.current?.scrollToIndex({
          index: firstItemIndex + reversedIndex,
          align: 'center',
          behavior: 'smooth',
        });
        flashMessageHighlight(messageId);
        return true;
      });
    }, [reversedHistory, firstItemIndex, virtuosoRef]);

    // Don't mount Virtuoso until data is available - initialTopMostItemIndex
    // only applies on mount, so the component must mount AFTER data loads
    // to start at the bottom (newest messages). Render the footer fallback
    // so loading spinners and streaming messages still show.
    if (reversedHistory.length === 0) {
      return <>{footer}</>;
    }

    return (
      <Virtuoso
        ref={virtuosoRef}
        data={reversedHistory}
        computeItemKey={(virtualIndex: number, item: IChatHistoryItem) => item.id ?? String(virtualIndex)}
        firstItemIndex={firstItemIndex}
        initialTopMostItemIndex={{ index: reversedHistory.length - 1, align: 'end' }}
        followOutput="auto"
        atBottomThreshold={50}
        startReached={onStartReached}
        atBottomStateChange={onAtBottomStateChange}
        itemContent={itemContent}
        context={virtuosoContext}
        increaseViewportBy={{ top: 400, bottom: 400 }}
        components={VIRTUOSO_COMPONENTS}
        scrollerRef={scrollerRef}
        style={
          {
            flex: 1,
            minHeight: 0,
            '--chat-scrollbar-width': `${scrollbarWidth}px`,
          } as React.CSSProperties
        }
      />
    );
  }
);

ChatHistory.displayName = 'ChatHistory';

export default ChatHistory;

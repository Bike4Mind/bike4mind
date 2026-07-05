import React, { useRef, useEffect, useState } from 'react';
import { Box, IconButton, Input, Typography, CircularProgress, Sheet, Avatar, Button, Link, Textarea } from '@mui/joy';
import { useTheme } from '@mui/joy/styles';
import SendIcon from '@mui/icons-material/Send';
import SmartToyIcon from '@mui/icons-material/SmartToy';
import PersonIcon from '@mui/icons-material/Person';
import DeleteOutlineIcon from '@mui/icons-material/DeleteOutline';
import ChatIcon from '@mui/icons-material/Chat';
import KeyboardArrowDownIcon from '@mui/icons-material/KeyboardArrowDown';
import ArticleIcon from '@mui/icons-material/Article';
import ThumbUpOutlinedIcon from '@mui/icons-material/ThumbUpOutlined';
import ThumbDownOutlinedIcon from '@mui/icons-material/ThumbDownOutlined';
import ThumbUpIcon from '@mui/icons-material/ThumbUp';
import ThumbDownIcon from '@mui/icons-material/ThumbDown';
import { useHelpChat, HelpChatMessage } from '@client/app/hooks/useHelpChat';
import { useHelpPanel } from '@client/app/hooks/useHelpPanel';
import MarkdownViewer from '@client/app/components/Knowledge/MarkdownViewer';
import { useHelpAnalytics, useHelpFeedback, useMyRecentFeedback } from '@client/app/hooks/useHelpAnalytics';
import EditIcon from '@mui/icons-material/Edit';
import { APP_NAME } from '@client/config/general';

interface HelpChatProps {
  currentHelpSlug?: string;
  height?: number;
}

/**
 * Inline feedback for an AI chat response (thumbs up/down + optional comment).
 *
 * Flow: click thumbs up/down -> rating is sent immediately with visual confirmation.
 * Comment box appears for optional follow-up.
 */
const ChatMessageFeedback: React.FC<{ message: HelpChatMessage; previousUserMessage?: string }> = ({
  message,
  previousUserMessage,
}) => {
  const { submitChatFeedback } = useHelpFeedback();
  const { data: recentFeedback } = useMyRecentFeedback();
  const [rating, setRating] = useState<'helpful' | 'not_helpful' | null>(null);
  const [comment, setComment] = useState('');
  const [commentSent, setCommentSent] = useState(false);
  const populatedRef = useRef(false);

  // Pre-populate from recent feedback on mount
  useEffect(() => {
    if (!recentFeedback || populatedRef.current) return;
    populatedRef.current = true;
    const existing = recentFeedback.chatFeedback.find(
      f => f.chatQuestion === (previousUserMessage || '') && f.chatAnswer === message.content
    );
    if (existing) {
      setRating(existing.rating);
      if (existing.comment) {
        setComment(existing.comment);
        setCommentSent(true);
      }
    }
  }, [recentFeedback, previousUserMessage, message.content]);

  const handleRating = (value: 'helpful' | 'not_helpful') => {
    if (value === rating) return; // Same thumb is a no-op
    setRating(value);
    submitChatFeedback.mutate({
      chatQuestion: previousUserMessage || '',
      chatAnswer: message.content,
      rating: value,
    });
  };

  const handleSubmitComment = () => {
    if (!rating || !comment.trim()) return;
    submitChatFeedback.mutate(
      {
        chatQuestion: previousUserMessage || '',
        chatAnswer: message.content,
        rating,
        comment: comment.trim(),
      },
      { onSuccess: () => setCommentSent(true) }
    );
  };

  return (
    <Box sx={{ px: 1.5, pb: 1, pt: 0.5 }}>
      <Box sx={{ display: 'flex', alignItems: 'center', gap: 0.5 }}>
        <IconButton
          size="sm"
          variant="plain"
          color={rating === 'helpful' ? 'success' : 'neutral'}
          onClick={() => handleRating('helpful')}
          data-testid="chat-feedback-thumbs-up"
          sx={{ '--IconButton-size': '24px' }}
        >
          {rating === 'helpful' ? <ThumbUpIcon sx={{ fontSize: 14 }} /> : <ThumbUpOutlinedIcon sx={{ fontSize: 14 }} />}
        </IconButton>
        <IconButton
          size="sm"
          variant="plain"
          color={rating === 'not_helpful' ? 'danger' : 'neutral'}
          onClick={() => handleRating('not_helpful')}
          data-testid="chat-feedback-thumbs-down"
          sx={{ '--IconButton-size': '24px' }}
        >
          {rating === 'not_helpful' ? (
            <ThumbDownIcon sx={{ fontSize: 14 }} />
          ) : (
            <ThumbDownOutlinedIcon sx={{ fontSize: 14 }} />
          )}
        </IconButton>
        {rating && (
          <Typography level="body-xs" sx={{ color: 'text.secondary', ml: 0.5 }}>
            Thanks!
          </Typography>
        )}
      </Box>
      {rating && !commentSent && (
        <Box sx={{ mt: 0.5, display: 'flex', gap: 0.5, alignItems: 'flex-end' }}>
          <Textarea
            size="sm"
            placeholder="Optional feedback..."
            value={comment}
            onChange={e => setComment(e.target.value.slice(0, 1000))}
            minRows={1}
            maxRows={2}
            sx={{ flex: 1, fontSize: '0.75rem' }}
            data-testid="chat-feedback-comment"
          />
          <Button
            size="sm"
            variant="plain"
            onClick={handleSubmitComment}
            disabled={!comment.trim() || submitChatFeedback.isPending}
            sx={{ minWidth: 'auto', px: 1 }}
            data-testid="chat-feedback-submit"
          >
            Send
          </Button>
        </Box>
      )}
      {rating && commentSent && (
        <Box sx={{ mt: 0.5, display: 'flex', alignItems: 'center', gap: 0.5, px: 0.5 }}>
          <Typography level="body-xs" sx={{ color: 'text.tertiary' }}>
            Feedback sent
          </Typography>
          <IconButton
            size="sm"
            variant="plain"
            color="neutral"
            onClick={() => setCommentSent(false)}
            data-testid="chat-feedback-edit"
            sx={{ '--IconButton-size': '20px' }}
          >
            <EditIcon sx={{ fontSize: 12 }} />
          </IconButton>
        </Box>
      )}
    </Box>
  );
};

/**
 * Message bubble component for displaying chat messages
 */
const MessageBubble: React.FC<{ message: HelpChatMessage; previousUserMessage?: string }> = ({
  message,
  previousUserMessage,
}) => {
  const isUser = message.role === 'user';
  const navigateTo = useHelpPanel(state => state.navigateTo);

  return (
    <Box
      sx={{
        display: 'flex',
        gap: 1,
        mb: 2,
        flexDirection: isUser ? 'row-reverse' : 'row',
      }}
    >
      <Avatar size="sm" variant="soft" color={isUser ? 'primary' : 'neutral'} sx={{ flexShrink: 0 }}>
        {isUser ? <PersonIcon /> : <SmartToyIcon />}
      </Avatar>

      <Sheet
        variant="soft"
        color={isUser ? 'primary' : 'neutral'}
        sx={{
          borderRadius: 'lg',
          maxWidth: '85%',
          overflow: 'hidden',
          ...(isUser ? { borderTopRightRadius: 0 } : { borderTopLeftRadius: 0 }),
        }}
      >
        {message.isStreaming && !message.content ? (
          <Box sx={{ display: 'flex', alignItems: 'center', gap: 1, p: 1.5 }}>
            <CircularProgress size="sm" />
            <Typography level="body-sm">Thinking...</Typography>
          </Box>
        ) : isUser ? (
          // User messages: simple text display
          <Typography level="body-sm" sx={{ p: 1.5, whiteSpace: 'pre-wrap' }}>
            {message.content}
          </Typography>
        ) : (
          // Assistant messages: use MarkdownViewer for rich rendering
          <Box
            sx={{
              '& .markdown-viewer-container': {
                p: 1.5,
                '& p:last-child': { mb: 0 },
              },
            }}
          >
            <MarkdownViewer content={message.content} />
            {message.isStreaming && (
              <Box
                component="span"
                sx={{
                  display: 'inline-block',
                  width: '8px',
                  height: '16px',
                  backgroundColor: 'text.primary',
                  animation: 'blink 1s infinite',
                  ml: 0.5,
                  verticalAlign: 'text-bottom',
                  '@keyframes blink': {
                    '0%, 50%': { opacity: 1 },
                    '51%, 100%': { opacity: 0 },
                  },
                }}
              />
            )}
            {/* Relevant article links */}
            {!message.isStreaming && message.relevantArticles && message.relevantArticles.length > 0 && (
              <Box
                sx={{
                  px: 1.5,
                  pb: 1.5,
                  pt: 0.5,
                  borderTop: '1px solid',
                  borderColor: 'neutral.outlinedBorder',
                  mt: 0.5,
                }}
              >
                <Typography
                  level="body-xs"
                  sx={{ mb: 0.5, color: 'text.tertiary', display: 'flex', alignItems: 'center', gap: 0.5 }}
                >
                  <ArticleIcon sx={{ fontSize: 14 }} />
                  Related articles
                </Typography>
                {message.relevantArticles.map(article => (
                  <Link
                    key={article.slug}
                    component="button"
                    level="body-xs"
                    onClick={() => navigateTo(article.slug)}
                    data-testid={`help-chat-article-link-${article.slug}`}
                    sx={{
                      display: 'block',
                      textAlign: 'left',
                      py: 0.25,
                      textDecoration: 'none',
                      '&:hover': { textDecoration: 'underline' },
                    }}
                  >
                    {article.title}
                  </Link>
                ))}
              </Box>
            )}
            {/* Chat feedback (thumbs up/down) */}
            {!message.isStreaming && message.content && previousUserMessage && (
              <ChatMessageFeedback message={message} previousUserMessage={previousUserMessage} />
            )}
          </Box>
        )}
      </Sheet>
    </Box>
  );
};

/**
 * AI-powered chat interface for help questions, integrated into the Help Panel.
 */
const HelpChat: React.FC<HelpChatProps> = ({ currentHelpSlug, height }) => {
  const theme = useTheme();
  const mode = theme.palette.mode;

  const { messages, isLoading, error, isOpen, setIsOpen, sendMessage, clearMessages } = useHelpChat();
  const { trackChatQuery } = useHelpAnalytics();

  const [inputValue, setInputValue] = useState('');
  const messagesEndRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);

  // Auto-scroll to bottom when new messages arrive
  useEffect(() => {
    if (messagesEndRef.current) {
      messagesEndRef.current.scrollIntoView({ behavior: 'smooth' });
    }
  }, [messages]);

  // Focus input when chat opens
  useEffect(() => {
    if (isOpen && inputRef.current) {
      inputRef.current.focus();
    }
  }, [isOpen]);

  const handleSubmit = async (e?: React.FormEvent) => {
    e?.preventDefault();

    const question = inputValue.trim();
    if (!question || isLoading) return;

    setInputValue('');
    trackChatQuery(question);
    await sendMessage(question, currentHelpSlug);
  };

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      handleSubmit();
    }
  };

  // Collapsed view - just a button to open chat
  if (!isOpen) {
    return (
      <Box
        sx={{
          p: 2,
          borderTop: '1px solid',
          borderColor: 'divider',
        }}
      >
        <Button
          variant="soft"
          color="primary"
          fullWidth
          startDecorator={<ChatIcon />}
          onClick={() => setIsOpen(true)}
          data-testid="help-chat-open-btn"
          sx={{
            justifyContent: 'flex-start',
          }}
        >
          Ask AI for help
        </Button>
      </Box>
    );
  }

  // Expanded chat view
  return (
    <Box
      sx={{
        display: 'flex',
        flexDirection: 'column',
        height: height ?? 400,
        borderTop: '1px solid',
        borderColor: 'divider',
      }}
    >
      {/* Chat header */}
      <Box
        sx={{
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'space-between',
          px: 2,
          py: 1,
          borderBottom: '1px solid',
          borderColor: 'divider',
          backgroundColor: 'background.level1',
        }}
      >
        <Box sx={{ display: 'flex', alignItems: 'center', gap: 1 }}>
          <SmartToyIcon sx={{ fontSize: 18, color: 'primary.500' }} />
          <Typography level="title-sm">Help Assistant</Typography>
        </Box>

        <Box sx={{ display: 'flex', gap: 0.5 }}>
          {messages.length > 0 && (
            <IconButton
              size="sm"
              variant="plain"
              color="neutral"
              onClick={clearMessages}
              aria-label="Clear chat"
              data-testid="help-chat-clear-btn"
            >
              <DeleteOutlineIcon sx={{ fontSize: 18 }} />
            </IconButton>
          )}
          <IconButton
            size="sm"
            variant="plain"
            color="neutral"
            onClick={() => setIsOpen(false)}
            aria-label="Minimize chat"
            data-testid="help-chat-minimize-btn"
          >
            <KeyboardArrowDownIcon />
          </IconButton>
        </Box>
      </Box>

      {/* Messages area */}
      <Box
        sx={{
          flex: 1,
          overflow: 'auto',
          p: 2,
          backgroundColor: mode === 'dark' ? 'background.surface' : 'background.body',
        }}
      >
        {messages.length === 0 ? (
          <Box
            sx={{
              display: 'flex',
              flexDirection: 'column',
              alignItems: 'center',
              justifyContent: 'center',
              height: '100%',
              textAlign: 'center',
              color: 'text.tertiary',
            }}
          >
            <SmartToyIcon sx={{ fontSize: 40, mb: 1, opacity: 0.5 }} />
            <Typography level="body-sm">
              {APP_NAME ? `Ask me anything about ${APP_NAME}!` : 'Ask me anything!'}
            </Typography>
            <Typography level="body-xs" sx={{ mt: 0.5 }}>
              I can help with features, troubleshooting, and how-to questions.
            </Typography>
          </Box>
        ) : (
          <>
            {messages.map((message, idx) => {
              // Find the preceding user message for assistant responses
              const previousUserMessage =
                message.role === 'assistant'
                  ? messages
                      .slice(0, idx)
                      .reverse()
                      .find(m => m.role === 'user')?.content
                  : undefined;
              return <MessageBubble key={message.id} message={message} previousUserMessage={previousUserMessage} />;
            })}
            <div ref={messagesEndRef} />
          </>
        )}
      </Box>

      {/* Error display */}
      {error && (
        <Box
          sx={{
            px: 2,
            py: 1,
            backgroundColor: 'danger.softBg',
            borderTop: '1px solid',
            borderColor: 'danger.outlinedBorder',
          }}
        >
          <Typography level="body-xs" color="danger">
            {error}
          </Typography>
        </Box>
      )}

      {/* Input area */}
      <Box
        component="form"
        onSubmit={handleSubmit}
        sx={{
          p: 1.5,
          borderTop: '1px solid',
          borderColor: 'divider',
          backgroundColor: 'background.level1',
        }}
      >
        <Input
          ref={inputRef}
          placeholder="Ask a question..."
          value={inputValue}
          onChange={e => setInputValue(e.target.value)}
          onKeyDown={handleKeyDown}
          disabled={isLoading}
          data-testid="help-chat-input"
          endDecorator={
            <IconButton
              type="submit"
              variant="plain"
              color="primary"
              disabled={!inputValue.trim() || isLoading}
              aria-label="Send message"
              data-testid="help-chat-send-btn"
            >
              {isLoading ? <CircularProgress size="sm" /> : <SendIcon />}
            </IconButton>
          }
          sx={{
            '--Input-focusedThickness': '1px',
          }}
        />
      </Box>
    </Box>
  );
};

export default HelpChat;

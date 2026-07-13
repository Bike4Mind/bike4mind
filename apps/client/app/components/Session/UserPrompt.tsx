import { UserPromptProps } from './types/UserPromptTypes';
import { CopyCodeButton } from './CopyCodeButton';
import { Box, IconButton, Typography, Tooltip } from '@mui/joy';
import ReactMarkdown, { ExtraProps } from 'react-markdown';
import { Prism as SyntaxHighlighter } from 'react-syntax-highlighter';
import { oneDark } from 'react-syntax-highlighter/dist/esm/styles/prism';
import ErrorBoundary from '../common/ErrorBoundary';
import ImageContainer from './ImageContainer';
import { GetFileIcon } from '@client/app/utils/fabFileUtils';
import { FC, useState, useEffect, ComponentProps, Children } from 'react';
import { useMessageEditMode } from '@client/app/hooks/useMessageEditMode';
import { highlightTextSearch } from '@client/app/components/GenAI/highlight';
import { Edit as EditIcon, KeyboardArrowDown, KeyboardArrowUp } from '@mui/icons-material';
import { useContentTruncation } from '@client/app/hooks/useContentTruncation';
import remarkBreaks from 'remark-breaks';
import remarkMath from 'remark-math';
import rehypeKatex from 'rehype-katex';
import { promoteInlineLatexDollars } from '@client/app/utils/remarkPlugins';
import { Components } from 'react-markdown';
import { extractSnippetMeta } from '@bike4mind/common';
import EditModeContent from './EditModeContent';
import { useIsMobile } from '@client/app/hooks/useIsMobile';
import { ExpandCollapseButton } from './ExpandCollapseButton';

const isCodeContent = (content: string): { isCode: boolean; language: string } => {
  try {
    const trimmedContent = content.trim();

    // If message has markdown code block syntax, let ReactMarkdown handle it
    if (trimmedContent.includes('```')) {
      return { isCode: false, language: 'text' };
    }

    // Check for common markdown formatting (but allow backticks for template literals)
    const hasOtherMarkdownFormatting = /^\#{1,6}\s|^\*\*|^-\s|^\d+\.\s|^\*\s/m.test(trimmedContent);
    if (hasOtherMarkdownFormatting) {
      return { isCode: false, language: 'text' };
    }

    // Language pattern detection for pure code (no markdown)
    // Patterns check both at start (^) and after newlines (\n) for indented code
    const languagePatterns = {
      rust: [
        /(?:^|\n)\s*fn\s+\w+/,
        /(?:^|\n)\s*pub\s+fn/,
        /(?:^|\n)\s*use\s+/,
        /(?:^|\n)\s*impl\s+/,
        /(?:^|\n)\s*struct\s+/,
      ],
      typescript: [
        /(?:^|\n)\s*import\s+.*from/,
        /(?:^|\n)\s*export\s+/,
        /(?:^|\n)\s*interface\s+/,
        /(?:^|\n)\s*type\s+\w+\s*=/,
      ],
      javascript: [
        /(?:^|\n)\s*function\s+\w+/,
        /(?:^|\n)\s*const\s+\w+/,
        /(?:^|\n)\s*let\s+\w+/,
        /(?:^|\n)\s*var\s+\w+/,
        /(?:^|\n)\s*class\s+\w+/,
        /(?:^|\n)\s*return\s+/,
        /console\.log\(/,
      ],
      python: [
        /(?:^|\n)\s*def\s+\w+/,
        /(?:^|\n)\s*class\s+\w+/,
        /(?:^|\n)\s*import\s+/,
        /(?:^|\n)\s*from\s+.*import/,
        /(?:^|\n)\s*return\s+/,
      ],
      jsx: [/(?:^|\n)\s*<\w+/, /<\/\w+>/, /(?:^|\n)\s*import\s+React/],
      html: [/(?:^|\n)\s*<!DOCTYPE/, /(?:^|\n)\s*<html/, /(?:^|\n)\s*<script/, /(?:^|\n)\s*<\/\w+>/],
      sql: [
        /(?:^|\n)\s*SELECT\s+/i,
        /(?:^|\n)\s*INSERT\s+/i,
        /(?:^|\n)\s*UPDATE\s+/i,
        /(?:^|\n)\s*DELETE\s+/i,
        /\s+FROM\s+/i,
      ],
    };

    // Consider it code if it has 2+ pattern matches OR has typical code structure
    for (const [language, patterns] of Object.entries(languagePatterns)) {
      const matchCount = patterns.filter(pattern => pattern.test(trimmedContent)).length;
      if (matchCount >= 2) {
        return { isCode: true, language };
      }
    }

    // Additional heuristic: content looks like code (indentation + semicolons/braces)
    const lines = trimmedContent.split('\n');
    if (lines.length >= 3) {
      const hasIndentation = lines.filter(line => /^\s{2,}/.test(line)).length >= 2;
      const hasCodePunctuation = /[{};()]/.test(trimmedContent);
      const hasFunctionKeywords = /\b(function|const|let|var|return|if|else|for|while)\b/.test(trimmedContent);

      if (hasIndentation && hasCodePunctuation && hasFunctionKeywords) {
        return { isCode: true, language: 'javascript' };
      }
    }

    return { isCode: false, language: 'text' };
  } catch (error) {
    console.error('Error in isCodeContent:', error);
    // Fallback to safe default - let ReactMarkdown handle it
    return { isCode: false, language: 'text' };
  }
};

/**
 * Renders markdown or code content
 */
const PromptContent: FC<{
  content: string;
  search?: string;
}> = ({ content, search }) => {
  const { isCode, language } = isCodeContent(content);
  const isMobile = useIsMobile();

  const markdownComponents: Components = {
    p: ({ node, children, ...props }: ComponentProps<'p'> & ExtraProps) => {
      if (!children) return null;
      // Check if this is the last paragraph in the parent
      const isLast =
        node &&
        (node as any).parent &&
        Array.isArray((node as any).parent.children) &&
        (node as any).parent.children[(node as any).parent.children.length - 1] === node;

      const processedChildren = Children.map(children, child => {
        if (typeof child === 'string') {
          return highlightTextSearch(child);
        }
        return child;
      });

      return (
        <Typography
          component="p"
          level={isMobile ? 'body-sm' : 'body-md'}
          gutterBottom={false}
          sx={{ display: 'block', color: 'text.primary', mb: isLast ? '0 !important' : '8px !important' }}
        >
          {processedChildren}
        </Typography>
      );
    },
    code: ({ node, className, children, ...props }) => {
      const match = /language-(\w+)/.exec(className || '');
      const language = match ? match[1] : 'text';
      const inline =
        node?.position?.start.line === node?.position?.end.line &&
        node?.position?.start.column !== node?.position?.end.column;

      return !inline ? (
        <Box sx={{ position: 'relative' }}>
          <CopyCodeButton code={children!.toString()} language={language} />
          <SyntaxHighlighter style={oneDark} customStyle={{ paddingTop: '32px' }} language={language} PreTag="div">
            {String(children).replace(/\n$/, '')}
          </SyntaxHighlighter>
        </Box>
      ) : (
        <Box
          component="code"
          sx={{
            padding: '3px 6px',
            backgroundColor: 'neutral.700',
            borderRadius: '.235rem',
            color: 'neutral.50',
            textWrap: 'balance',
          }}
        >
          {children}
        </Box>
      );
    },
  };

  return isCode ? (
    <SyntaxHighlighter style={oneDark} language={language}>
      {content}
    </SyntaxHighlighter>
  ) : (
    <ReactMarkdown
      remarkPlugins={[remarkBreaks, [remarkMath, { singleDollarTextMath: false }]]}
      rehypePlugins={[rehypeKatex]}
      components={markdownComponents}
    >
      {promoteInlineLatexDollars(content)}
    </ReactMarkdown>
  );
};

/**
 * Wrapper component that handles content truncation with the styled container.
 * Uses JS-based markdown truncation to avoid rendering hidden DOM nodes.
 */
const TruncatablePromptContent: FC<{
  content: string;
  search?: string;
  isEnabled?: boolean;
}> = ({ content, search, isEnabled = true }) => {
  const isMobile = useIsMobile();
  const { needsTruncation, isExpanded, toggleExpanded, displayContent } = useContentTruncation({
    content,
    isEnabled,
  });

  return (
    <Box sx={{ position: 'relative', flex: 1 }}>
      <Typography
        className="prompt-content"
        variant="soft"
        level={isMobile ? 'body-sm' : 'body-md'}
        component="div"
        sx={theme => ({
          margin: 0,
          padding: 2,
          backgroundColor: theme.palette.mode === 'light' ? '#F4F7F9' : 'background.panel',
          borderRadius: '8px',
          color: 'text.primary',
          overflowX: 'auto',
          position: 'relative',
          '& p:last-child': { mb: '0 !important' },
        })}
      >
        <PromptContent content={displayContent} search={search} />
      </Typography>

      <ExpandCollapseButton needsTruncation={needsTruncation} isExpanded={isExpanded} onToggle={toggleExpanded} />
    </Box>
  );
};

const EditButton: FC<{
  onEdit: () => void;
}> = ({ onEdit }) => {
  return (
    <Tooltip title="Edit Prompt">
      <IconButton
        className="edit-button"
        size="sm"
        onClick={onEdit}
        variant="outlined"
        color="neutral"
        sx={{
          width: '28px',
          height: '28px',
          borderRadius: '6px',
          flexShrink: 0,
          marginBottom: '16px',
          '& svg': {
            width: '16px',
            height: '16px',
          },
        }}
      >
        <EditIcon />
      </IconButton>
    </Tooltip>
  );
};

const UserPrompt: FC<UserPromptProps> = ({ prompt, messageFiles = [], search, onEdit, onSendMessage, messageId }) => {
  const [isEditMode, setIsEditMode] = useState(false);
  const [expandedSnippets, setExpandedSnippets] = useState<Record<string, boolean>>({});

  // Subscribe to the edit mode store for external edit triggers (e.g., dropdown menu "Edit" action).
  // Under virtualization, off-screen messages are unmounted - DOM queries would return null.
  const editingMessageId = useMessageEditMode(s => s.editingMessageId);
  const editTarget = useMessageEditMode(s => s.editTarget);
  const clearEdit = useMessageEditMode(s => s.clearEdit);

  useEffect(() => {
    if (messageId && editingMessageId === messageId && editTarget === 'prompt') {
      setIsEditMode(true);
      clearEdit();
    }
  }, [editingMessageId, editTarget, messageId, clearEdit]);

  const { sections } = extractSnippetMeta(prompt);

  if (sections.length > 0) {
    return (
      <Box sx={{ display: 'flex', flexDirection: 'column', width: '100%', gap: 2 }}>
        <Box
          sx={{
            display: 'flex',
            flexDirection: 'column',
            gap: 2,
            alignItems: 'flex-end',
            borderRadius: '8px',
          }}
        >
          {sections.map((section, index) =>
            section.type === 'snippet' ? (
              <SnippetSection
                key={section.meta.id}
                section={section}
                isExpanded={expandedSnippets[section.meta.id]}
                onToggle={() => {
                  setExpandedSnippets(prev => ({
                    ...prev,
                    [section.meta.id]: !prev[section.meta.id],
                  }));
                }}
                search={search}
                isEditMode={isEditMode}
              />
            ) : (
              <Box
                key={index}
                sx={{
                  maxWidth: '100%',
                  minWidth: isEditMode ? '100%' : undefined,
                  alignSelf: 'end',
                  borderRadius: '8px',
                }}
              >
                {!isEditMode ? (
                  <TruncatablePromptContent content={section.content} search={search} />
                ) : (
                  <EditModeContent
                    content={prompt}
                    onCancel={() => {
                      setIsEditMode(false);
                    }}
                    onEdit={newPrompt => {
                      if (onEdit) {
                        setIsEditMode(false);
                        onEdit(newPrompt);
                      }
                    }}
                  />
                )}
              </Box>
            )
          )}
          {/* Display all files (images and documents) */}
          {messageFiles.length > 0 && (
            <Box sx={{ display: 'flex', flexDirection: 'column', gap: 1, mt: 1 }}>
              {/* Images */}
              {messageFiles.filter(f => f.mimeType?.startsWith('image/')).length > 0 && (
                <Box sx={{ display: 'flex', gap: '.5rem', flexWrap: 'wrap' }}>
                  <ErrorBoundary fallback={<p>Image failed to load.</p>}>
                    {messageFiles
                      .filter(f => f.mimeType?.startsWith('image/'))
                      .map((file, index) => {
                        const imageUrl = file.fileUrl || file.presignedUrl || '';
                        const allImages = messageFiles
                          .filter(f => f.mimeType?.startsWith('image/'))
                          .map(f => f.fileUrl || f.presignedUrl || '');
                        return (
                          <ImageContainer
                            key={file.id}
                            id={file.id}
                            src={imageUrl}
                            index={index}
                            totalImages={allImages.length}
                            images={allImages}
                            onSendMessage={onSendMessage}
                            onNavigate={() => {}}
                            variant="thumbnail"
                            moderationStatus={file.moderationStatus}
                          />
                        );
                      })}
                  </ErrorBoundary>
                </Box>
              )}
              {/* Documents */}
              {messageFiles.filter(f => !f.mimeType?.startsWith('image/')).length > 0 && (
                <Box sx={{ display: 'flex', gap: '.5rem', flexWrap: 'wrap' }}>
                  {messageFiles
                    .filter(f => !f.mimeType?.startsWith('image/'))
                    .map(file => (
                      <Box
                        key={file.id}
                        sx={{
                          display: 'flex',
                          alignItems: 'center',
                          gap: 0.5,
                          p: 0.75,
                          borderRadius: '6px',
                          border: theme => `1px solid ${theme.palette.neutral.outlinedBorder}`,
                          backgroundColor: theme => theme.palette.background.level1,
                          maxWidth: '220px',
                        }}
                      >
                        <GetFileIcon file={file} size={20} />
                        <Typography
                          level="body-xs"
                          noWrap
                          sx={{
                            color: 'text.secondary',
                            maxWidth: '180px',
                            overflow: 'hidden',
                            textOverflow: 'ellipsis',
                          }}
                        >
                          {file.fileName}
                        </Typography>
                      </Box>
                    ))}
                </Box>
              )}
            </Box>
          )}
          {!!onEdit && !isEditMode && (
            <EditButton
              onEdit={() => {
                setIsEditMode(true);
              }}
            />
          )}
        </Box>
      </Box>
    );
  }

  return (
    <Box
      className="user-prompt"
      sx={{
        display: 'flex',
        flexDirection: 'column',
        width: '100%',
        gap: '0.5em',
      }}
    >
      <Box
        sx={theme => ({
          width: '100%',
          borderRadius: '8px',
          backgroundColor: theme.palette.mode === 'light' ? '#F4F7F9' : 'background.panel',
          position: 'relative',
        })}
      >
        {!isEditMode ? (
          <Box sx={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', gap: 2 }}>
            <TruncatablePromptContent content={prompt} search={search} />

            {/* Edit button */}
            {!!onEdit && (
              <EditButton
                onEdit={() => {
                  setIsEditMode(true);
                }}
              />
            )}
          </Box>
        ) : (
          <EditModeContent
            content={prompt}
            onCancel={() => {
              setIsEditMode(false);
            }}
            onEdit={newPrompt => {
              if (onEdit) {
                setIsEditMode(false);
                onEdit(newPrompt);
              }
            }}
          />
        )}
      </Box>
    </Box>
  );
};

/**
 * Component for rendering snippet sections with their own expand/collapse state
 */
const SnippetSection: FC<{
  section: { content: string; meta: { id: string } };
  isExpanded: boolean;
  onToggle: () => void;
  search?: string;
  isEditMode: boolean;
}> = ({ section, isExpanded, onToggle, search, isEditMode }) => {
  const isMobile = useIsMobile();

  const {
    needsTruncation,
    isExpanded: isTruncationExpanded,
    toggleExpanded,
    displayContent,
  } = useContentTruncation({
    content: section.content,
    isEnabled: !isExpanded, // Only truncate when not manually expanded
  });

  // If manually expanded via snippet toggle, show full content
  const contentToShow = isExpanded ? section.content : displayContent;

  return (
    <Box
      sx={{
        display: 'flex',
        alignItems: 'flex-start',
        justifyContent: 'flex-end',
        width: '100%',
        gap: 1,
      }}
    >
      <Box sx={{ display: 'flex', flexDirection: 'column', gap: 1, pt: 1 }}>
        <IconButton size="sm" data-testid={`snippet-toggle-${section.meta.id}`} onClick={onToggle}>
          {isExpanded ? <KeyboardArrowUp /> : <KeyboardArrowDown />}
        </IconButton>
      </Box>

      {!isEditMode && (
        <Box sx={{ position: 'relative', flex: 1 }}>
          <Typography
            className="prompt-content"
            variant="soft"
            level={isMobile ? 'body-sm' : 'body-md'}
            component="div"
            sx={theme => ({
              margin: 0,
              padding: 2,
              backgroundColor: theme.palette.mode === 'light' ? '#F4F7F9' : 'background.panel',
              borderRadius: '8px',
              color: 'text.primary',
              overflowX: 'auto',
              position: 'relative',
              '& p:last-child': { mb: '0 !important' },
            })}
          >
            <PromptContent content={contentToShow} search={search} />
          </Typography>

          {/* Only show expand button if not already manually expanded and truncation is needed */}
          {!isExpanded && (
            <ExpandCollapseButton
              needsTruncation={needsTruncation}
              isExpanded={isTruncationExpanded}
              onToggle={toggleExpanded}
            />
          )}
        </Box>
      )}
    </Box>
  );
};

export default UserPrompt;

import { useAnimatedText } from '@client/app/hooks/useAnimate';
import { Box, Typography, IconButton, Stack, Dropdown, MenuButton, MenuItem, ListItemDecorator, Menu } from '@mui/joy';
import React, { useCallback, useEffect, useId, useState } from 'react';
import { KeyboardArrowUp, KeyboardArrowDown } from '@mui/icons-material';
import CopyTextButton from './CopyTextButton';
import DownloadMenu from '../common/DownloadMenu';
import MenuIcon from '@mui/icons-material/Menu';
import MoreHorizIcon from '@mui/icons-material/MoreHoriz';
import { toast } from 'sonner';
import { useSessions, useWorkBenchActions, useWorkBenchFiles } from '@client/app/contexts/SessionsContext';
import { Save as SaveIcon, ContentCopy as ContentCopyIcon } from '@mui/icons-material';
import { useCopyToClipboard } from '@client/app/hooks/useCopyToClipboard';
import { useIsMobile } from '@client/app/hooks/useIsMobile';
import { detectChatContentType } from '@client/app/utils/contentTypes';
import { saveToFileAndWorkbench } from '@client/app/utils/fabFileUtils';

interface ThoughtBubblesProps {
  content: string;
  isStreaming?: boolean;
  defaultFolded?: boolean;
}

// Extract <think> content, handling streaming (unclosed tags) with an iteration cap
export const extractThinkContent = (reply: string, isStreaming?: boolean): string[] => {
  const thoughts: string[] = [];
  let currentPosition = 0;
  let iterationCount = 0;
  const MAX_ITERATIONS = 1000; // Safety limit to prevent infinite loops

  while (currentPosition < reply.length && iterationCount < MAX_ITERATIONS) {
    iterationCount++;

    const startTag = reply.indexOf('<think>', currentPosition);
    if (startTag === -1) break;

    const endTag = reply.indexOf('</think>', startTag);
    if (endTag === -1 && isStreaming) {
      const partialThought = reply.slice(startTag + 7).trim();
      if (partialThought) {
        thoughts.push(partialThought);
      }
      break;
    } else if (endTag === -1) {
      break;
    }

    const thoughtContent = reply.slice(startTag + 7, endTag);
    const thoughtLines = thoughtContent
      .split('\n')
      .map(line => line.trim())
      .filter(line => line.length > 0);

    thoughts.push(...thoughtLines);

    // Ensure we always advance position to prevent infinite loops
    const newPosition = endTag + 8;
    if (newPosition <= currentPosition) {
      console.warn('ThoughtBubbles: Position not advancing, breaking to prevent infinite loop');
      break;
    }
    currentPosition = newPosition;
  }

  if (iterationCount >= MAX_ITERATIONS) {
    console.error('ThoughtBubbles: Maximum iterations reached, possible infinite loop prevented');
  }

  return thoughts;
};

const ThoughtBubbles = React.memo(({ content, isStreaming, defaultFolded = false }: ThoughtBubblesProps) => {
  const thoughtsId = useId();
  const [thoughts, setThoughts] = useState<string>();
  const [isFolded, setIsFolded] = useState(defaultFolded);
  const isMobile = useIsMobile();

  const { currentSession, setCurrentSession, currentSessionId } = useSessions();
  const workBenchFiles = useWorkBenchFiles(currentSessionId);
  const { setWorkBenchFiles } = useWorkBenchActions();
  const { handleCopyToClipboard } = useCopyToClipboard();

  const handleSaveThoughtsAsFile = useCallback(
    async (thoughtsContent: string) => {
      if (!thoughtsContent) return;

      const contentType = detectChatContentType(thoughtsContent);

      try {
        const fileName = `thoughts_${Date.now()}.${contentType === 'Markdown' ? 'md' : 'txt'}`;

        const newWorkBenchFiles = await saveToFileAndWorkbench(
          contentType,
          fileName,
          thoughtsContent,
          workBenchFiles,
          currentSessionId,
          currentSession
        );

        setWorkBenchFiles(currentSessionId ?? '', newWorkBenchFiles);

        if (currentSession) {
          const knowledgeIds = newWorkBenchFiles.map(f => f.id);
          const updatedSession = { ...currentSession, knowledgeIds };
          setCurrentSession(updatedSession);
        }

        // Toast is shown by saveToFileAndWorkbench with the renamed filename
      } catch (error) {
        console.error('Error saving file:', error);
        toast.error('Failed to save file');
      }
    },
    [workBenchFiles, setWorkBenchFiles, currentSession, setCurrentSession, currentSessionId]
  );

  useEffect(() => {
    const withoutTags = content.replace(/^<think>/, '').replace(/<\/think>$/, '');
    setThoughts(withoutTags);
  }, [content]);

  const animatedText = useAnimatedText(thoughts || '', !isStreaming);

  // Don't render an empty thoughts block: a reply like `<think></think>` (or one with
  // only whitespace between the tags) has non-zero length but no actual thought content.
  const hasThoughtContent =
    content
      .replace(/^<think>/, '')
      .replace(/<\/think>$/, '')
      .trim().length > 0;
  if (!hasThoughtContent) return null;

  return (
    <Box
      sx={{
        px: { xs: 0, sm: isFolded ? 0 : 4 },
        pt: 0,
        pb: isFolded ? 1 : 0,
        maxWidth: '4xl',
        mx: isFolded ? 0 : 'auto',
        '& > *': { my: isFolded ? 0 : 2 },
      }}
    >
      <Box
        sx={{
          transition: 'all 500ms ease-in-out',
          position: 'relative',
        }}
      >
        <Box
          sx={{
            display: 'flex',
            alignItems: 'center',
            justifyContent: isFolded ? 'flex-start' : 'space-between',
            gap: 1,
            mb: isFolded ? 0 : 1,
          }}
        >
          <Typography
            sx={{ fontSize: '0.75rem', fontWeight: 'bold', opacity: 0.7, marginLeft: isFolded ? 0 : '0.5rem' }}
          >
            {isStreaming ? 'Thinking...' : 'Thoughts'}
          </Typography>
          <IconButton
            size="sm"
            variant="plain"
            onClick={() => setIsFolded(!isFolded)}
            sx={{ opacity: 0.7, '&:hover': { opacity: 1 } }}
          >
            {isFolded ? <KeyboardArrowDown /> : <KeyboardArrowUp />}
          </IconButton>
        </Box>
        {!isFolded && (
          <Box sx={{ position: 'relative' }}>
            <Box
              sx={theme => ({
                position: 'absolute',
                left: '-1rem',
                top: '-1rem',
                width: '0.75rem',
                height: '0.75rem',
                bgcolor: theme.palette.text.navLinks,
                borderRadius: '50%',
              })}
            />
            <Box
              sx={theme => ({
                position: 'absolute',
                left: '-2rem',
                top: '-1.5rem',
                width: '0.5rem',
                height: '0.5rem',
                bgcolor: theme.palette.text.primary,
                borderRadius: '50%',
              })}
            />
            <Box
              sx={theme => ({
                border: '1px solid',
                borderColor: 'border.solid',
                borderRadius: '1rem',
                p: 2,
                boxShadow: 'sm',
              })}
            >
              <Typography
                sx={theme => ({ color: theme.palette.chatbox.messageInputColor, opacity: 0.7, whiteSpace: 'pre-wrap' })}
              >
                {animatedText}
              </Typography>
            </Box>

            {/* Action buttons - only visible when not folded */}
            {!isMobile ? (
              <Box sx={{ display: 'flex', alignItems: 'center', justifyContent: 'flex-end', mt: 2 }}>
                <Stack direction={'row'} gap="10px" alignItems="center">
                  {!isStreaming && (
                    <>
                      {/* Always visible primary action */}
                      <CopyTextButton text={thoughts ? thoughts : ''} />
                      <DownloadMenu content={thoughts ? thoughts : ''} fileName={`thoughts_${thoughtsId}.md`} />

                      {/* Advanced actions in menu */}
                      <Dropdown>
                        <MenuButton
                          slots={{ root: IconButton }}
                          slotProps={{ root: { variant: 'outlined', color: 'neutral', size: 'sm' } }}
                          sx={{
                            width: '28px',
                            height: '28px',
                            flexShrink: '0',
                            borderRadius: '6px',
                            '& svg': {
                              width: '16px',
                              height: '16px',
                            },
                          }}
                        >
                          <MoreHorizIcon sx={{ fontSize: 16 }} />
                        </MenuButton>
                        <Menu
                          className="menuSurface"
                          placement="bottom-end"
                          sx={(theme: any) => ({
                            minWidth: '180px',
                            '--ListItem-minHeight': '32px',
                            borderRadius: '6px',
                          })}
                        >
                          <MenuItem onClick={() => handleSaveThoughtsAsFile(thoughts || '')}>
                            <ListItemDecorator>
                              <SaveIcon />
                            </ListItemDecorator>
                            Save as {detectChatContentType(thoughts || '')}
                          </MenuItem>
                        </Menu>
                      </Dropdown>
                    </>
                  )}
                </Stack>
              </Box>
            ) : (
              <Box sx={{ display: 'flex', justifyContent: 'flex-end', mt: 2 }}>
                <Dropdown>
                  <MenuButton
                    size={'sm'}
                    slots={{
                      root: IconButton,
                    }}
                    sx={{
                      alignSelf: 'end',
                      background: 'transparent',
                      '&:hover': {
                        background: 'transparent',
                      },
                      '.MuiIconButton-root': {
                        '&:hover': {
                          background: 'transparent',
                        },
                      },
                    }}
                  >
                    <MenuIcon />
                  </MenuButton>
                  <Menu
                    className="menuSurface"
                    sx={(theme: any) => ({
                      borderRadius: '10px',
                    })}
                    variant={'outlined'}
                  >
                    <MenuItem onClick={() => handleCopyToClipboard(thoughts || '')}>
                      <ListItemDecorator>
                        <ContentCopyIcon fontSize="small" />
                      </ListItemDecorator>
                      Copy to clipboard
                    </MenuItem>
                    <MenuItem onClick={() => handleSaveThoughtsAsFile(thoughts || '')}>
                      <ListItemDecorator>
                        <SaveIcon fontSize="small" />
                      </ListItemDecorator>
                      Save as {detectChatContentType(thoughts || '')}
                    </MenuItem>
                  </Menu>
                </Dropdown>
              </Box>
            )}
          </Box>
        )}
      </Box>
    </Box>
  );
});

ThoughtBubbles.displayName = 'ThoughtBubbles';

export default ThoughtBubbles;

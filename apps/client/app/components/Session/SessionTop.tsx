import { useSessions } from '@client/app/contexts/SessionsContext';
import { Box, IconButton, Tooltip } from '@mui/joy';
import Grid from '@mui/joy/Grid';
import React, { useCallback, useState } from 'react';
import SearchBar from './SearchBar';
import useSessionLayout from '@client/app/hooks/useSessionLayout';
import { useSearch } from '@tanstack/react-router';
import { useGetProject } from '@client/app/hooks/data/projects';
import { useGetSession } from '@client/app/hooks/data/sessions';
import Breadcrumbs from '../common/Breadcrumbs';
import { useTranslation } from 'react-i18next';
import { useNotebookSearch } from '@client/app/contexts/NotebookSearchContext';
import PushPinIcon from '@mui/icons-material/PushPin';
import PushPinOutlinedIcon from '@mui/icons-material/PushPinOutlined';
import SyncAltIcon from '@mui/icons-material/SyncAlt';
import HorizontalRuleIcon from '@mui/icons-material/HorizontalRule';
import ContentCopyIcon from '@mui/icons-material/ContentCopy';
import CheckIcon from '@mui/icons-material/Check';
import SessionOwnerBadge from './SessionOwnerBadge';
import BackgroundAgentBadge from './AgentExecution/BackgroundAgentBadge';
import { useQueryClient, type InfiniteData } from '@tanstack/react-query';
import type { IChatHistoryItemDocument } from '@bike4mind/common';
import { useCopyToClipboard } from '@client/app/hooks/useCopyToClipboard';
import { convertSessionToMarkdown } from '@client/app/utils/sessionMarkdownExport';

type SessionTopProps = {
  listClosed?: boolean;
  /**
   * Enable search bar
   * @default true
   */
  enableSearch?: boolean;
  onChatWidthToggle?: (isFullWidth: boolean) => void;
};

const SessionTop: React.FC<SessionTopProps> = ({ enableSearch = true, onChatWidthToggle }) => {
  const { currentSession, currentSessionId } = useSessions();
  const { data: cachedSession } = useGetSession(currentSessionId ?? null);
  const layout = useSessionLayout(s => s.layout);
  const { projectId } = useSearch({ strict: false }) as { projectId?: string };
  const { data: project } = useGetProject(projectId as string);
  const { t } = useTranslation();
  const { setSearch, showPinnedOnly, setShowPinnedOnly } = useNotebookSearch();
  const [isFullWidth, setIsFullWidth] = useState(false);
  const queryClient = useQueryClient();
  const { copied, handleCopyToClipboard } = useCopyToClipboard();

  const handleCopyMarkdown = useCallback(() => {
    if (!currentSessionId) return;
    const queryData = queryClient.getQueryData<InfiniteData<{ data: IChatHistoryItemDocument[] }>>([
      'quests',
      'session',
      currentSessionId,
    ]);
    if (!queryData?.pages) return;
    const quests = queryData.pages.flatMap(p => p.data).reverse();
    if (!quests.length) return;
    const markdown = convertSessionToMarkdown(quests);
    if (!markdown.trim()) return;
    handleCopyToClipboard(markdown);
  }, [currentSessionId, queryClient, handleCopyToClipboard]);

  const handleWidthToggle = () => {
    const newFullWidth = !isFullWidth;
    setIsFullWidth(newFullWidth);
    onChatWidthToggle?.(newFullWidth);
  };

  return (
    <>
      <Grid
        container
        spacing={0}
        sx={_theme => ({
          display: 'flex',
          width: '100%',
          justifyContent: 'space-between',
          alignItems: 'center',
          flexDirection: 'row',
          paddingRight: '0px',
          height: '0em',
          backgroundColor: 'chatbox.topbarBg',
          color: 'chatbox.topbarText',
          zIndex: 10000,
        })}
      >
        <Box sx={{ display: 'flex', alignItems: 'center', gap: 2 }}>
          {project && (
            <Breadcrumbs
              items={[
                { name: 'Projects', href: '/projects' },
                { name: project.name, href: `/projects/${project.id}` },
                { name: cachedSession?.name || currentSession?.name || 'New Chat' },
              ]}
            />
          )}
          {currentSession && <SessionOwnerBadge session={currentSession} variant="full" />}
        </Box>
        {enableSearch && !!currentSession && (
          <Box
            sx={{
              display: { xs: 'none', sm: 'flex' }, // Hide on mobile, searchbar now in NotebookHeader
              alignItems: 'center',
              gap: 1.5,
            }}
          >
            {/* Background subagent indicator — hidden when count is 0, so this
                slot collapses cleanly for the typical non-orchestration session. */}
            <BackgroundAgentBadge sessionId={currentSessionId} />
            {layout !== 'vertical' && layout !== 'pip' && (
              <SearchBar handleChange={setSearch} placeHolder={t('search')} width={'11rem'} />
            )}
            {(layout === 'vertical' || layout === 'pip') && (
              <SearchBar handleChange={setSearch} placeHolder={t('search')} width={'11rem'} />
            )}
            <Tooltip title={copied ? 'Copied!' : 'Copy chat as Markdown'} disableInteractive>
              <IconButton
                variant="outlined"
                color={copied ? 'success' : 'neutral'}
                size="sm"
                onClick={handleCopyMarkdown}
                data-testid="session-top-copy-markdown"
                aria-label="Copy chat as Markdown"
                sx={{
                  width: '32px',
                  height: '32px',
                }}
              >
                {copied ? <CheckIcon /> : <ContentCopyIcon />}
              </IconButton>
            </Tooltip>
            <Tooltip title={showPinnedOnly ? 'Show all replies' : 'Show only pinned replies'}>
              <IconButton
                variant={showPinnedOnly ? 'solid' : 'outlined'}
                color={showPinnedOnly ? 'primary' : 'neutral'}
                size="sm"
                onClick={() => setShowPinnedOnly(!showPinnedOnly)}
                aria-label={showPinnedOnly ? 'Show all replies' : 'Show only pinned replies'}
                aria-pressed={showPinnedOnly}
                sx={{
                  width: '32px',
                  height: '32px',
                }}
              >
                {showPinnedOnly ? <PushPinIcon /> : <PushPinOutlinedIcon />}
              </IconButton>
            </Tooltip>
            <Tooltip title={isFullWidth ? 'Collapse Chat Width' : 'Expand Chat Width'}>
              <IconButton
                variant={isFullWidth ? 'solid' : 'outlined'}
                color={isFullWidth ? 'primary' : 'neutral'}
                size="sm"
                onClick={handleWidthToggle}
                aria-label="Toggle chat width"
                aria-pressed={isFullWidth}
                sx={{
                  width: '32px',
                  height: '32px',
                }}
              >
                {isFullWidth ? <HorizontalRuleIcon /> : <SyncAltIcon />}
              </IconButton>
            </Tooltip>
          </Box>
        )}
      </Grid>
    </>
  );
};

export default SessionTop;

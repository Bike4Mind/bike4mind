import { FC, useState, useEffect } from 'react';
import { brandAlpha, purpleAlpha, blackAlpha, gray, brand, blue, purple, cyan } from '../../utils/themes/colors';
import {
  Box,
  Button,
  Stack,
  Tabs,
  Tab,
  TabList,
  TabPanel,
  Typography,
  ButtonGroup,
  Card,
  CardContent,
  Badge,
  IconButton,
  Chip,
  Tooltip,
} from '@mui/joy';
import { IResearchTask, IResearchTaskScrape, ResearchTaskStatus, ResearchTaskType } from '@bike4mind/common';
import TaskStatusBadge from './TaskStatusBadge';
import ResearchTaskDiscoveredLink from './DiscoveredLink';
import EditIcon from '@mui/icons-material/Edit';
import InfoOutlinedIcon from '@mui/icons-material/InfoOutlined';
import RefreshIcon from '@mui/icons-material/Refresh';
import RestoreIcon from '@mui/icons-material/Restore';
import { Language, Visibility, Code, Article, InsertDriveFile, Analytics } from '@mui/icons-material';
import { useGetResearchTask, useRetryResearchTask } from '@client/app/hooks/data/researchTasks';
import FileContent from '../Files/Content';
import ReactMarkdown from 'react-markdown';
import ResearchTaskDetailLiveStatus from './Detail/LiveStatus';
import ResearchTaskDetailInfo from './Detail/Info';
import ResearchTaskFileList from './FileList';
import { useKnowledgeModal } from '../Knowledge/KnowledgeModal';

interface ResearchTaskDetailProps {
  task: IResearchTask;
  onEdit?: () => void;
}

type ContentViewMode = 'raw' | 'html' | 'markdown';

const ResearchTaskDetail: FC<ResearchTaskDetailProps> = ({ task: propTask, onEdit }) => {
  const { setSelectedFabFileId } = useKnowledgeModal();
  const { data: fetchedTask, refetch, isLoading } = useGetResearchTask(propTask.researchAgentId, propTask.id);
  const { mutate: retryTask, isPending: isRetrying } = useRetryResearchTask();
  const [viewMode, setViewMode] = useState<ContentViewMode>('raw');
  const task = fetchedTask || propTask;

  // Auto-refetch during processing to show incremental updates
  useEffect(() => {
    if (task.status === ResearchTaskStatus.PROCESSING || task.status === ResearchTaskStatus.PENDING) {
      console.log(`📊 [AUTO_REFETCH] Starting polling for task ${task.id} in ${task.status} status`);

      const pollInterval = setInterval(() => {
        console.log(`🔄 [POLLING] Refreshing data for processing task ${task.id}`);
        refetch();
      }, 3000);

      return () => {
        console.log(`⏹️ [POLLING_STOP] Stopped polling for task ${task.id}`);
        clearInterval(pollInterval);
      };
    } else if (task.status === ResearchTaskStatus.COMPLETED && !fetchedTask?.researchData?.length) {
      console.log(`📊 [COMPLETION_REFETCH] Task completed but no research data loaded, forcing refetch`);
      refetch();
    }
  }, [task.status, task.id, fetchedTask?.researchData?.length, refetch]);

  // Debug logging to track data loading
  useEffect(() => {
    console.log('📊 [DEBUG] Task status:', task.status);
    console.log('📊 [DEBUG] Research data count:', fetchedTask?.researchData?.length || 0);
    console.log('📊 [DEBUG] Discovered links count:', (task as IResearchTaskScrape).discoveredLinks?.length || 0);
  }, [task.status, fetchedTask?.researchData?.length, task]);

  let sortedDiscoveredLinks: IResearchTaskScrape['discoveredLinks'] = [];

  if (!task) return null;

  if (task.type === ResearchTaskType.SCRAPE) {
    sortedDiscoveredLinks =
      (task as IResearchTaskScrape).discoveredLinks?.sort((a, b) => (b.relevance ?? 0) - (a.relevance ?? 0)) ?? [];
  }

  function getResearchDataFabFileId(researchDataId: string) {
    return fetchedTask?.researchData.find(f => f.id === researchDataId)?.fabFileId;
  }

  const mainContentId = fetchedTask?.researchData?.find(d => d.researchAgentId === task.researchAgentId)?.fabFileId;

  return (
    <Stack spacing={2} sx={{ p: 1 }}>
      {/* Task overview */}
      <Box
        sx={{
          background: `linear-gradient(135deg, ${brandAlpha[500][5]} 0%, ${purpleAlpha[550][5]} 100%)`,
          borderRadius: '16px',
          border: `1px solid ${brandAlpha[500][10]}`,
          p: 3,
          position: 'relative',
          overflow: 'hidden',
          flex: '0 0 auto',
          transition: 'all 0.2s ease',
          '&::before': {
            content: '""',
            position: 'absolute',
            top: 0,
            left: 0,
            right: 0,
            height: '3px',
            background: `linear-gradient(90deg, ${brand[500]} 0%, ${purple[500]} 50%, ${cyan[400]} 100%)`,
            backgroundSize: '200% 100%',
            animation: 'shimmer 3s ease-in-out infinite',
          },
          '@keyframes shimmer': {
            '0%, 100%': { backgroundPosition: '0% 50%' },
            '50%': { backgroundPosition: '100% 50%' },
          },
        }}
      >
        <Box
          sx={{
            display: 'flex',
            justifyContent: 'space-between',
            alignItems: 'flex-start',
            mb: 2,
            flexShrink: 0,
            width: '100%',
          }}
        >
          <Box sx={{ flex: '1 0 auto', width: '100%' }}>
            <Box sx={{ display: 'flex', alignItems: 'center', gap: 2, mb: 1 }}>
              <TaskStatusBadge status={task.status} />
              {task.type === ResearchTaskType.SCRAPE && (
                <Chip
                  variant="soft"
                  color="primary"
                  size="sm"
                  startDecorator={<Language sx={{ fontSize: 16 }} />}
                  sx={{ gap: 0.5 }}
                >
                  Web Scrape
                </Chip>
              )}
            </Box>
            <Typography level="h3" sx={{ fontWeight: 700, color: 'text.primary', mb: 1 }}>
              {task.title}
            </Typography>
            <Box id="research-task-description" sx={{ width: '100%' }}>
              <Typography
                level="body-md"
                sx={{
                  color: 'text.secondary',
                  lineHeight: 1.6,
                  overflow: 'hidden',
                  textOverflow: 'ellipsis',
                  display: '-webkit-box',
                  WebkitLineClamp: 4,
                  WebkitBoxOrient: 'vertical',
                  maxWidth: '100%',
                }}
              >
                {task.description}
              </Typography>
            </Box>

            <ResearchTaskDetailLiveStatus task={task} />
          </Box>

          {/* Action buttons */}
          <Box
            sx={{
              display: 'flex',
              gap: 1,
              flexShrink: 0,
              alignItems: 'flex-start',
              position: 'absolute',
              right: '20px',
              top: '20px',
            }}
          >
            <Tooltip title="Refresh task data" variant="soft" placement="top">
              <IconButton
                variant="soft"
                color="primary"
                onClick={() => refetch()}
                loading={isLoading}
                sx={{
                  transition: 'all 0.2s ease',
                  '&:hover': { transform: 'scale(1.1)' },
                }}
              >
                <RefreshIcon sx={{ fontSize: 18 }} />
              </IconButton>
            </Tooltip>

            <Tooltip title="Retry task" variant="soft" placement="top">
              <IconButton
                variant="soft"
                color="warning"
                onClick={() => retryTask(task)}
                loading={isRetrying}
                sx={{
                  transition: 'all 0.2s ease',
                  '&:hover': { transform: 'scale(1.1)' },
                }}
              >
                <RestoreIcon sx={{ fontSize: 18 }} />
              </IconButton>
            </Tooltip>

            <Tooltip title="Edit task details" variant="soft" placement="top">
              <IconButton
                variant="soft"
                color="neutral"
                onClick={onEdit}
                sx={{
                  transition: 'all 0.2s ease',
                  '&:hover': { transform: 'scale(1.1)' },
                }}
              >
                <EditIcon sx={{ fontSize: 18 }} />
              </IconButton>
            </Tooltip>
          </Box>
        </Box>

        {/* Failure message */}
        {task?.status === ResearchTaskStatus.FAILED && (
          <Card variant="soft" color="danger" sx={{ mt: 2 }}>
            <CardContent>
              <Typography level="title-sm" sx={{ display: 'flex', alignItems: 'center', gap: 1, mb: 1 }}>
                <Analytics sx={{ fontSize: 18 }} />
                Execution Failed
              </Typography>
              <Typography level="body-sm">{task.statusFailedMessage}</Typography>
            </CardContent>
          </Card>
        )}
      </Box>

      {/* Content tabs */}
      <Card variant="outlined" sx={{ flex: '1 0 auto', overflow: 'hidden' }}>
        <Tabs defaultValue={0} sx={{ height: '100%', display: 'flex', flexDirection: 'column' }}>
          <TabList
            sx={{
              flexShrink: 0,
              borderBottom: '1px solid',
              borderColor: 'divider',
              bgcolor: 'background.level1',
              m: 0,
              p: 1,
              gap: 1,
            }}
          >
            <Tab
              sx={{
                borderRadius: 'sm',
                transition: 'all 0.2s ease',
                '&:hover': { bgcolor: 'primary.softHoverBg' },
                '&[aria-selected="true"]': {
                  bgcolor: 'primary.softBg',
                  color: 'primary.700',
                  fontWeight: 600,
                },
              }}
            >
              <Box sx={{ display: 'flex', alignItems: 'center', gap: 1 }}>
                <InfoOutlinedIcon sx={{ fontSize: 18 }} />
                Info
              </Box>
            </Tab>
            <Tab
              sx={{
                borderRadius: 'sm',
                transition: 'all 0.2s ease',
                '&:hover': { bgcolor: 'primary.softHoverBg' },
                '&[aria-selected="true"]': {
                  bgcolor: 'primary.softBg',
                  color: 'primary.700',
                  fontWeight: 600,
                },
              }}
            >
              <Box sx={{ display: 'flex', alignItems: 'center', gap: 1 }}>
                <Article sx={{ fontSize: 18 }} />
                Content
              </Box>
            </Tab>

            {task.type === ResearchTaskType.SCRAPE && (
              <Tab
                sx={{
                  borderRadius: 'sm',
                  transition: 'all 0.2s ease',
                  '&:hover': { bgcolor: 'primary.softHoverBg' },
                  '&[aria-selected="true"]': {
                    bgcolor: 'primary.softBg',
                    color: 'primary.700',
                    fontWeight: 600,
                  },
                }}
              >
                <Box
                  sx={{
                    display: 'flex',
                    alignItems: 'center',
                    gap: 1,
                    '& .MuiBadge-root': {
                      width: '10px',
                    },
                  }}
                >
                  <Language sx={{ fontSize: 18 }} />
                  <span>Links</span>
                  <Badge badgeContent={task.discoveredLinks?.length || 0} color="primary" size="sm" />
                </Box>
              </Tab>
            )}

            {fetchedTask?.researchData && (
              <Tab
                sx={{
                  borderRadius: 'sm',
                  transition: 'all 0.2s ease',
                  '&:hover': { bgcolor: 'primary.softHoverBg' },
                  '&[aria-selected="true"]': {
                    bgcolor: 'primary.softBg',
                    color: 'primary.700',
                    fontWeight: 600,
                  },
                  '& .MuiBadge-root': {
                    width: '10px',
                  },
                }}
              >
                <Box sx={{ display: 'flex', alignItems: 'center', gap: 1 }}>
                  <InsertDriveFile sx={{ fontSize: 18 }} />
                  Files
                  <Badge badgeContent={fetchedTask.researchData.length} color="success" size="sm" />
                </Box>
              </Tab>
            )}
          </TabList>
          <TabPanel value={0} sx={{ flexGrow: 1, p: 0, overflow: 'hidden' }}>
            <ResearchTaskDetailInfo task={task} />
          </TabPanel>
          <TabPanel value={1} sx={{ flexGrow: 1, p: 0, overflow: 'hidden' }}>
            <Box sx={{ p: 2, borderBottom: '1px solid', borderColor: 'divider', bgcolor: 'background.surface' }}>
              <Box sx={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', mb: 2 }}>
                <Typography level="title-sm" sx={{ display: 'flex', alignItems: 'center', gap: 1 }}>
                  <Visibility sx={{ fontSize: 18, color: 'primary.500' }} />
                  Content Viewer
                </Typography>
                <ButtonGroup size="sm" variant="outlined">
                  <Button
                    variant={viewMode === 'raw' ? 'solid' : 'outlined'}
                    onClick={() => setViewMode('raw')}
                    startDecorator={<Code sx={{ fontSize: 16 }} />}
                    sx={{
                      transition: 'all 0.2s ease',
                      '&:hover': { transform: 'translateY(-1px)' },
                    }}
                  >
                    Raw
                  </Button>
                  <Button
                    variant={viewMode === 'html' ? 'solid' : 'outlined'}
                    onClick={() => setViewMode('html')}
                    startDecorator={<Language sx={{ fontSize: 16 }} />}
                    sx={{
                      transition: 'all 0.2s ease',
                      '&:hover': { transform: 'translateY(-1px)' },
                    }}
                  >
                    HTML
                  </Button>
                  <Button
                    variant={viewMode === 'markdown' ? 'solid' : 'outlined'}
                    onClick={() => setViewMode('markdown')}
                    startDecorator={<Article sx={{ fontSize: 16 }} />}
                    sx={{
                      transition: 'all 0.2s ease',
                      '&:hover': { transform: 'translateY(-1px)' },
                    }}
                  >
                    Markdown
                  </Button>
                </ButtonGroup>
              </Box>
            </Box>

            {mainContentId && (
              <FileContent id={mainContentId}>
                {content => {
                  return (
                    <Box
                      sx={{
                        height: 'calc(100% - 80px)',
                        overflowY: 'auto',
                        background: viewMode === 'raw' ? blackAlpha[0][2] : 'background.surface',
                        p: 3,
                        fontFamily: viewMode === 'raw' ? 'monospace' : 'inherit',
                        fontSize: viewMode === 'raw' ? 13 : 14,
                        lineHeight: 1.6,
                        position: 'relative',
                        '&::before':
                          viewMode === 'html'
                            ? {
                                content: '""',
                                position: 'absolute',
                                top: 0,
                                left: 0,
                                right: 0,
                                height: '3px',
                                background: `linear-gradient(135deg, ${blue[400]} 0%, ${brand[500]} 50%, ${purple[500]} 100%)`,
                              }
                            : {},
                      }}
                    >
                      {viewMode === 'raw' && (
                        <pre
                          style={{
                            whiteSpace: 'pre-wrap',
                            wordBreak: 'break-word',
                            margin: 0,
                            color: gray[725],
                            backgroundColor: 'transparent',
                          }}
                        >
                          {content}
                        </pre>
                      )}
                      {viewMode === 'html' && content && (
                        <div
                          dangerouslySetInnerHTML={{ __html: content }}
                          style={{
                            fontSize: '14px',
                            lineHeight: '1.7',
                            color: gray[725],
                          }}
                        />
                      )}
                      {viewMode === 'markdown' && (
                        <Box
                          sx={{
                            '& h1, & h2, & h3': { color: 'primary.700', fontWeight: 600 },
                            '& p': { mb: 2, color: 'text.primary' },
                            '& code': {
                              bgcolor: 'neutral.100',
                              px: 0.5,
                              borderRadius: 'sm',
                              fontFamily: 'monospace',
                            },
                          }}
                        >
                          <ReactMarkdown>{content}</ReactMarkdown>
                        </Box>
                      )}
                    </Box>
                  );
                }}
              </FileContent>
            )}
          </TabPanel>
          <TabPanel value={2} sx={{ flexGrow: 1, p: 0, overflow: 'hidden' }}>
            <Box sx={{ p: 2, borderBottom: '1px solid', borderColor: 'divider', bgcolor: 'background.surface' }}>
              <Typography level="title-sm" sx={{ display: 'flex', alignItems: 'center', gap: 1, mb: 1 }}>
                <Language sx={{ fontSize: 18, color: 'primary.500' }} />
                Discovered Links
                <Chip variant="soft" color="primary" size="sm">
                  {sortedDiscoveredLinks.length} found
                </Chip>
              </Typography>
              <Typography level="body-sm" sx={{ color: 'neutral.600' }}>
                Intelligent link discovery results ranked by relevance
              </Typography>
            </Box>

            <Box sx={{ height: 'calc(100% - 80px)', overflowY: 'auto', p: 2 }}>
              {sortedDiscoveredLinks.length === 0 ? (
                <Box
                  sx={{
                    display: 'flex',
                    flexDirection: 'column',
                    alignItems: 'center',
                    justifyContent: 'center',
                    height: '100%',
                    color: 'neutral.500',
                  }}
                >
                  <Language sx={{ fontSize: 48, mb: 2, opacity: 0.5 }} />
                  <Typography level="title-sm" sx={{ mb: 1 }}>
                    No Links Discovered
                  </Typography>
                  <Typography level="body-sm" textAlign="center">
                    No related links were found during the research process
                  </Typography>
                </Box>
              ) : (
                <Stack spacing={2}>
                  {sortedDiscoveredLinks.map((link, index) => (
                    <Card
                      key={index}
                      variant="outlined"
                      sx={{
                        transition: 'all 0.2s ease',
                        '&:hover': {
                          borderColor: 'primary.300',
                          boxShadow: `0 2px 12px ${brandAlpha[500][15]}`,
                          transform: 'translateY(-1px)',
                        },
                      }}
                    >
                      <CardContent>
                        <ResearchTaskDiscoveredLink link={link} getFabFileId={getResearchDataFabFileId} />
                      </CardContent>
                    </Card>
                  ))}
                </Stack>
              )}
            </Box>
          </TabPanel>

          <TabPanel value={3} sx={{ flexGrow: 1, p: 0, overflow: 'hidden' }}>
            <ResearchTaskFileList
              onView={fabFileId => setSelectedFabFileId(fabFileId)}
              researchData={fetchedTask?.researchData || []}
            />
          </TabPanel>
        </Tabs>
      </Card>
    </Stack>
  );
};

export default ResearchTaskDetail;

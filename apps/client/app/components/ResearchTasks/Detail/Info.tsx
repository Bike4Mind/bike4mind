import {
  Check,
  ContentCopy,
  Launch,
  Schedule,
  CalendarToday,
  Update,
  Speed,
  AccessTime,
  Timeline,
  Description,
} from '@mui/icons-material';
import {
  IResearchTask,
  ResearchTaskType,
  ResearchTaskExecutionType,
  ResearchTaskStatus,
  IResearchTaskScrape,
} from '@bike4mind/common';
import { Avatar, Box, Card, CardContent, Chip, Typography, IconButton, Tooltip, LinearProgress, Stack } from '@mui/joy';
import { Language } from '@mui/icons-material';
import { FC, useState } from 'react';
import CalendarTodayIcon from '@mui/icons-material/CalendarToday';
import BoltIcon from '@mui/icons-material/Bolt';
import AccessTimeOutlinedIcon from '@mui/icons-material/AccessTimeOutlined';
import { brand, purple, brandAlpha, orangeAlpha, greenAlpha, grayAlpha } from '../../../utils/themes/colors';

interface ResearchTaskDetailInfoProps {
  task: IResearchTask;
}

const ResearchTaskDetailInfo: FC<ResearchTaskDetailInfoProps> = ({ task }) => {
  // For multiple URLs, track which one was copied (index), or null if none
  const [urlCopiedIdx, setUrlCopiedIdx] = useState<number | null>(null);

  // Helper to get URLs array from task (for SCRAPE type)
  const getUrls = (): string[] => {
    if (task.type === ResearchTaskType.SCRAPE) {
      // Support both legacy single-url and new multi-url
      const scrapeTask = task as IResearchTaskScrape;
      if (Array.isArray((scrapeTask as any).urls)) {
        return (scrapeTask as any).urls;
      }
      if (typeof (scrapeTask as any).url === 'string') {
        return [(scrapeTask as any).url];
      }
    }
    return [];
  };

  const urls = getUrls();

  const handleCopyUrl = async (url: string, idx: number) => {
    try {
      await navigator.clipboard.writeText(url);
      setUrlCopiedIdx(idx);
      setTimeout(() => setUrlCopiedIdx(null), 2000);
    } catch (err) {
      console.error('Failed to copy URL:', err);
    }
  };

  return (
    <Box sx={{ display: 'grid', gridTemplateColumns: { xs: '1fr', md: '1fr 1fr' }, gap: 2, pt: 2 }}>
      {/* URL preview card */}
      {task.type === ResearchTaskType.SCRAPE && (
        <>
          {/* Prompt card */}
          {task.prompt && (
            <Card
              variant="outlined"
              sx={{
                gridColumn: { xs: '1', md: '1 / -1' },
                transition: 'all 0.2s ease',
                '&:hover': {
                  borderColor: 'info.300',
                  boxShadow: `0 4px 20px ${brandAlpha[500][15]}`,
                  transform: 'translateY(-2px)',
                },
              }}
            >
              <CardContent>
                <Box sx={{ display: 'flex', alignItems: 'flex-start', gap: 2 }}>
                  <Avatar variant="soft" sx={{ bgcolor: 'info.50', color: 'info.600' }}>
                    <Description sx={{ fontSize: 20 }} />
                  </Avatar>
                  <Box sx={{ flex: 1, minWidth: 0 }}>
                    <Typography level="title-sm" sx={{ mb: 1 }}>
                      Prompt
                    </Typography>
                    <Box>
                      <Typography
                        level="body-sm"
                        sx={{
                          color: 'neutral.700',
                          lineHeight: 1.6,
                          whiteSpace: 'pre-wrap',
                          wordBreak: 'break-word',
                        }}
                      >
                        {(task as IResearchTaskScrape).prompt}
                      </Typography>
                    </Box>
                  </Box>
                </Box>
              </CardContent>
            </Card>
          )}

          <Card
            variant="outlined"
            sx={{
              transition: 'all 0.2s ease',
              '&:hover': {
                borderColor: 'primary.300',
                boxShadow: `0 4px 20px ${brandAlpha[500][15]}`,
                transform: 'translateY(-2px)',
              },
            }}
          >
            <CardContent>
              <Box sx={{ display: 'flex', alignItems: 'flex-start', gap: 2 }}>
                <Avatar variant="soft" sx={{ bgcolor: 'primary.50', color: 'primary.600' }}>
                  <Language sx={{ fontSize: 20 }} />
                </Avatar>
                <Box sx={{ flex: 1, minWidth: 0 }}>
                  <Typography level="title-sm" sx={{ mb: 0.5, display: 'flex', alignItems: 'center', gap: 1 }}>
                    Target Website{urls.length > 1 ? 's' : ''}
                  </Typography>
                  <Box sx={{ display: 'flex', flexDirection: 'column', gap: 1 }}>
                    {urls.length === 0 && (
                      <Typography level="body-sm" sx={{ color: 'neutral.500', fontStyle: 'italic' }}>
                        No URLs specified.
                      </Typography>
                    )}
                    {urls.map((url, idx) => (
                      <Box
                        key={url + idx}
                        sx={{
                          display: 'flex',
                          alignItems: 'center',
                          gap: 1,
                          bgcolor: 'primary.50',
                          borderRadius: 'sm',
                          px: 1,
                          py: 0.5,
                          mb: 0.5,
                          minWidth: 0,
                        }}
                      >
                        <Typography
                          level="body-sm"
                          sx={{
                            fontFamily: 'monospace',
                            color: 'primary.600',
                            wordBreak: 'break-all',
                            lineHeight: 1.4,
                            flex: 1,
                          }}
                        >
                          {url}
                        </Typography>
                        <Tooltip title={urlCopiedIdx === idx ? 'Copied!' : 'Copy URL'} variant="soft" placement="top">
                          <IconButton
                            size="sm"
                            variant="soft"
                            color={urlCopiedIdx === idx ? 'success' : 'neutral'}
                            onClick={() => handleCopyUrl(url, idx)}
                            sx={{
                              transition: 'all 0.2s ease',
                              '&:hover': { transform: 'scale(1.1)' },
                            }}
                          >
                            {urlCopiedIdx === idx ? (
                              <Check sx={{ fontSize: 16 }} />
                            ) : (
                              <ContentCopy sx={{ fontSize: 16 }} />
                            )}
                          </IconButton>
                        </Tooltip>
                        <Tooltip title="Open in new tab" variant="soft" placement="top">
                          <IconButton
                            size="sm"
                            variant="soft"
                            onClick={() => window.open(url, '_blank')}
                            sx={{
                              transition: 'all 0.2s ease',
                              '&:hover': { transform: 'scale(1.1)' },
                            }}
                          >
                            <Launch sx={{ fontSize: 16 }} />
                          </IconButton>
                        </Tooltip>
                      </Box>
                    ))}
                  </Box>
                </Box>
              </Box>
            </CardContent>
          </Card>
        </>
      )}
      {/* Execution type card */}
      <Card
        variant="outlined"
        sx={{
          transition: 'all 0.2s ease',
          '&:hover': {
            borderColor: 'warning.300',
            boxShadow: `0 4px 20px ${orangeAlpha[550][15]}`,
            transform: 'translateY(-2px)',
          },
        }}
      >
        <CardContent>
          <Box sx={{ display: 'flex', alignItems: 'flex-start', gap: 2 }}>
            <Avatar variant="soft" sx={{ bgcolor: 'warning.50', color: 'warning.600' }}>
              <Schedule sx={{ fontSize: 20 }} />
            </Avatar>
            <Box sx={{ flex: 1 }}>
              <Typography level="title-sm" sx={{ mb: 0.5 }}>
                Execution Strategy
              </Typography>
              <Chip
                variant="soft"
                color={
                  task.executionType === ResearchTaskExecutionType.ON_DEMAND
                    ? 'primary'
                    : task.executionType === ResearchTaskExecutionType.PERIODIC
                      ? 'warning'
                      : 'neutral'
                }
                size="sm"
                startDecorator={
                  task.executionType === ResearchTaskExecutionType.ON_DEMAND ? (
                    <BoltIcon sx={{ fontSize: 14 }} />
                  ) : task.executionType === ResearchTaskExecutionType.PERIODIC ? (
                    <AccessTimeOutlinedIcon sx={{ fontSize: 14 }} />
                  ) : (
                    <CalendarTodayIcon sx={{ fontSize: 14 }} />
                  )
                }
              >
                {task.executionType === ResearchTaskExecutionType.ON_DEMAND
                  ? '🚀 On Demand'
                  : task.executionType === ResearchTaskExecutionType.PERIODIC
                    ? '🔄 Recurring'
                    : '📅 Scheduled'}
              </Chip>

              {/* PERIODIC DETAILS */}
              {task.executionType === ResearchTaskExecutionType.PERIODIC && (
                <Box sx={{ mt: 1.5, p: 1.5, bgcolor: 'warning.50', borderRadius: 'sm' }}>
                  <Typography level="body-xs" sx={{ mb: 0.5, fontWeight: 600, color: 'warning.700' }}>
                    Automation Schedule
                  </Typography>
                  <Box sx={{ display: 'flex', alignItems: 'center', gap: 1, mb: 0.5 }}>
                    <AccessTime sx={{ fontSize: 12, color: 'warning.600' }} />
                    <Typography level="body-xs" sx={{ color: 'warning.700' }}>
                      {new Date(task.executionPeriodicStartAt).toLocaleDateString()}
                    </Typography>
                    <Typography level="body-xs" sx={{ color: 'neutral.500' }}>
                      →
                    </Typography>
                    <Typography level="body-xs" sx={{ color: 'warning.700' }}>
                      {new Date(task.executionPeriodicEndAt).toLocaleDateString()}
                    </Typography>
                  </Box>
                  {task.lastExecutionAt && (
                    <Typography level="body-xs" sx={{ color: 'warning.700' }}>
                      {`Last executed: ${new Date(task.lastExecutionAt).toLocaleDateString()}`}
                    </Typography>
                  )}
                </Box>
              )}

              {/* SCHEDULED DETAILS */}
              {task.executionType === ResearchTaskExecutionType.SCHEDULED && (
                <Box sx={{ mt: 1.5, p: 1.5, bgcolor: 'neutral.50', borderRadius: 'sm' }}>
                  <Typography level="body-xs" sx={{ mb: 0.5, fontWeight: 600, color: 'neutral.700' }}>
                    Scheduled Execution
                  </Typography>
                  <Box sx={{ display: 'flex', alignItems: 'center', gap: 1 }}>
                    <CalendarToday sx={{ fontSize: 12, color: 'neutral.600' }} />
                    <Typography level="body-xs" sx={{ color: 'neutral.700' }}>
                      {new Date(task.executionScheduledAt).toLocaleString()}
                    </Typography>
                  </Box>
                </Box>
              )}
            </Box>
          </Box>
        </CardContent>
      </Card>
      {/* Timeline card */}
      <Card
        variant="outlined"
        sx={{
          transition: 'all 0.2s ease',
          '&:hover': {
            borderColor: 'success.300',
            boxShadow: `0 4px 20px ${greenAlpha[500][15]}`,
            transform: 'translateY(-2px)',
          },
        }}
      >
        <CardContent>
          <Box sx={{ display: 'flex', alignItems: 'flex-start', gap: 2 }}>
            <Avatar variant="soft" sx={{ bgcolor: 'success.50', color: 'success.600' }}>
              <Timeline sx={{ fontSize: 20 }} />
            </Avatar>
            <Box sx={{ flex: 1 }}>
              <Typography level="title-sm" sx={{ mb: 1 }}>
                Timeline
              </Typography>
              <Stack spacing={1}>
                <Box sx={{ display: 'flex', alignItems: 'center', gap: 1 }}>
                  <CalendarToday sx={{ fontSize: 14, color: 'success.600' }} />
                  <Typography level="body-xs" sx={{ color: 'neutral.600' }}>
                    Created
                  </Typography>
                  <Typography level="body-xs" sx={{ ml: 'auto', color: 'neutral.800' }}>
                    {new Date(task.createdAt).toLocaleDateString()}
                  </Typography>
                </Box>
                <Box sx={{ display: 'flex', alignItems: 'center', gap: 1 }}>
                  <Update sx={{ fontSize: 14, color: 'warning.600' }} />
                  <Typography level="body-xs" sx={{ color: 'neutral.600' }}>
                    Last Updated
                  </Typography>
                  <Typography level="body-xs" sx={{ ml: 'auto', color: 'neutral.800' }}>
                    {new Date(task.updatedAt).toLocaleDateString()}
                  </Typography>
                </Box>
              </Stack>
            </Box>
          </Box>
        </CardContent>
      </Card>
      {/* Performance card */}
      <Card
        variant="outlined"
        sx={{
          transition: 'all 0.2s ease',
          '&:hover': {
            borderColor: 'neutral.300',
            boxShadow: `0 4px 20px ${grayAlpha[690][15]}`,
            transform: 'translateY(-2px)',
          },
        }}
      >
        <CardContent>
          <Box sx={{ display: 'flex', alignItems: 'flex-start', gap: 2 }}>
            <Avatar variant="soft" sx={{ bgcolor: 'neutral.50', color: 'neutral.600' }}>
              <Speed sx={{ fontSize: 20 }} />
            </Avatar>
            <Box sx={{ flex: 1 }}>
              <Typography level="title-sm" sx={{ mb: 1 }}>
                Performance
              </Typography>
              <Stack spacing={1}>
                <Box>
                  <Box sx={{ display: 'flex', justifyContent: 'space-between', mb: 0.5 }}>
                    <Typography level="body-xs" sx={{ color: 'neutral.600' }}>
                      Execution Health
                    </Typography>
                    <Typography level="body-xs" sx={{ color: 'success.600', fontWeight: 600 }}>
                      {task.status === ResearchTaskStatus.COMPLETED
                        ? '100%'
                        : task.status === ResearchTaskStatus.PROCESSING
                          ? '65%'
                          : task.status === ResearchTaskStatus.FAILED
                            ? '0%'
                            : '50%'}
                    </Typography>
                  </Box>
                  <LinearProgress
                    determinate
                    value={
                      task.status === ResearchTaskStatus.COMPLETED
                        ? 100
                        : task.status === ResearchTaskStatus.PROCESSING
                          ? 65
                          : task.status === ResearchTaskStatus.FAILED
                            ? 0
                            : 50
                    }
                    color={
                      task.status === ResearchTaskStatus.COMPLETED
                        ? 'success'
                        : task.status === ResearchTaskStatus.PROCESSING
                          ? 'primary'
                          : task.status === ResearchTaskStatus.FAILED
                            ? 'danger'
                            : 'neutral'
                    }
                    sx={{
                      borderRadius: 'sm',
                      '&::before': {
                        background: `linear-gradient(90deg, ${brand[500]} 0%, ${purple[500]} 100%)`,
                      },
                    }}
                  />
                </Box>

                <Box sx={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', pt: 0.5 }}>
                  <Typography level="body-xs" sx={{ color: 'neutral.600' }}>
                    Efficiency Score
                  </Typography>
                  <Chip
                    variant="soft"
                    color={task.status === ResearchTaskStatus.COMPLETED ? 'success' : 'primary'}
                    size="sm"
                  >
                    {task.status === ResearchTaskStatus.COMPLETED
                      ? 'A+'
                      : task.status === ResearchTaskStatus.PROCESSING
                        ? 'B+'
                        : 'C'}
                  </Chip>
                </Box>
              </Stack>
            </Box>
          </Box>
        </CardContent>
      </Card>
    </Box>
  );
};

export default ResearchTaskDetailInfo;

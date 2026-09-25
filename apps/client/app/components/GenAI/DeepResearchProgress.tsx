import React, { useState, useEffect, useRef } from 'react';
import { Box, Card, Chip, LinearProgress, TabList, TabPanel, Tabs, Typography } from '@mui/joy';
import StyledTab from '@client/app/components/common/StyledTab';
import { profileTabListSx } from '@client/app/routes/profile/profileTabListSx';
import {
  Search as SearchIcon,
  FilterList as ExtractIcon,
  Analytics as AnalyzeIcon,
  Psychology as ReasoningIcon,
  AutoAwesome as SynthesisIcon,
  Lightbulb as ThoughtIcon,
  Link as LinkIcon,
  CheckCircle as CompleteIcon,
  Error as ErrorIcon,
  PendingActions as PendingIcon,
  Language as WebIcon,
} from '@mui/icons-material';

interface DeepResearchActivity {
  type: 'search' | 'extract' | 'analyze' | 'reasoning' | 'synthesis' | 'thought';
  status: 'pending' | 'complete' | 'error';
  message: string;
  timestamp: string;
  depth: number;
}

interface DeepResearchSource {
  url: string;
  title: string;
  description: string;
  status: 'found' | 'analyzing' | 'complete' | 'error';
  type?: string; // Optional for backward compatibility
  timestamp: string;
}

interface DeepResearchProgressProps {
  activities?: DeepResearchActivity[];
  sources?: DeepResearchSource[];
  isActive?: boolean;
  completedSteps?: number;
  totalExpectedSteps?: number;
}

const getActivityIcon = (type: DeepResearchActivity['type']) => {
  switch (type) {
    case 'search':
      return SearchIcon;
    case 'extract':
      return ExtractIcon;
    case 'analyze':
      return AnalyzeIcon;
    case 'reasoning':
      return ReasoningIcon;
    case 'synthesis':
      return SynthesisIcon;
    case 'thought':
      return ThoughtIcon;
    default:
      return SearchIcon;
  }
};

const getStatusIcon = (status: DeepResearchActivity['status']) => {
  switch (status) {
    case 'complete':
      return CompleteIcon;
    case 'error':
      return ErrorIcon;
    case 'pending':
      return PendingIcon;
    default:
      return PendingIcon;
  }
};

const getStatusColor = (status: string) => {
  switch (status) {
    case 'complete':
      return 'success';
    case 'error':
      return 'danger';
    case 'pending':
      return 'warning';
    case 'found':
    case 'analyzing':
      return 'primary';
    default:
      return 'neutral';
  }
};

const getSourceTypeIcon = (type: string) => {
  switch (type) {
    case 'database':
    case 'internal':
      return LinkIcon;
    case 'web_url':
    case 'web':
      return WebIcon;
    default:
      return LinkIcon;
  }
};

const DeepResearchProgress: React.FC<DeepResearchProgressProps> = ({
  activities = [],
  sources = [],
  completedSteps = 0,
  totalExpectedSteps = 0,
}) => {
  const [activeTab, setActiveTab] = useState(0);
  const activitiesEndRef = useRef<HTMLDivElement>(null);

  // Auto-scroll to bottom when new activities are added and activity tab is active
  useEffect(() => {
    if (activeTab === 0 && activitiesEndRef.current) {
      activitiesEndRef.current.scrollIntoView({ behavior: 'smooth' });
    }
  }, [activities.length, activeTab]);

  // Use the actual research progress if available, otherwise fall back to activity count
  const progressPercentage = Math.min(
    totalExpectedSteps > 0 ? Math.round((completedSteps / totalExpectedSteps) * 100) : 0,
    100
  );

  if (!activities.length && !sources.length) {
    return null;
  }

  return (
    <Card
      variant="outlined"
      sx={theme => ({
        // The artifact-card frame, so the panel a research run puts above the reply belongs
        // to the same family as the cards it puts below. It used to fill with
        // background.level1, a token this theme never defines, and carry a 12px radius where
        // every other framed thing is 8px.
        backgroundColor: theme.palette.reading.cardBase,
        backgroundImage: `linear-gradient(180deg, ${theme.palette.reading.cardTintTop}, ${theme.palette.reading.cardTintBottom})`,
        borderColor: theme.palette.reading.cardLine,
        borderRadius: '8px',
        // No hover lift: the other cards rise because clicking them opens something. This one
        // is a progress readout and goes nowhere.
        // The Card's own flex gap, between the progress header and the tab strip below it.
        gap: '32px',
        overflow: 'visible',
        mt: 2,
        mb: 1,
      })}
    >
      {/* One source of inset for the whole panel: the Card's own padding. The header, the
          tab bar and both panels used to add 16px of their own on top of it. */}
      <Box>
        {/* Progress Bar */}
        {totalExpectedSteps > 0 && (
          <Box>
            <Box sx={{ display: 'flex', justifyContent: 'space-between', mb: '8px' }}>
              {/* An artifact card's title type, and the percentage set as its peer rather than
                  as small print - it is the other half of the same line, not a caption. */}
              <Typography level="title-md" sx={{ flex: 1, color: 'text.primary' }}>
                Deep Research Progress
              </Typography>
              <Typography level="title-md" sx={{ color: 'text.primary' }}>
                {progressPercentage}%
              </Typography>
            </Box>
            <LinearProgress
              determinate
              value={progressPercentage}
              color="primary"
              sx={{ height: '6px', borderRadius: '3px' }}
            />
          </Box>
        )}
      </Box>

      {/* Tabs */}
      <Tabs
        value={activeTab}
        onChange={(_, newValue) => setActiveTab(newValue as number)}
        // Joy's Tabs paints background.surface by default, which would sit on top of the
        // card's fill and veil and undo the frame above.
        sx={{ backgroundColor: 'transparent' }}
      >
        {/* The app's tab strip, as the profile page defines it. Labels go through Typography
            because StyledTab's selected/unselected treatment is an opacity rule on it - a bare
            string would render every tab as if it were selected. */}
        <TabList sx={profileTabListSx}>
          <StyledTab>
            <Typography>Activity ({activities.length})</Typography>
          </StyledTab>
          <StyledTab>
            <Typography>Sources ({sources.length})</Typography>
          </StyledTab>
        </TabList>

        {/* Activity Tab */}
        <TabPanel
          value={0}
          sx={{
            p: 0,
            pt: '16px',
            maxHeight: '300px',
            overflowY: 'auto',
          }}
        >
          {activities.length > 0 ? (
            <>
              <Box sx={{ display: 'flex', flexDirection: 'column', gap: 1 }}>
                {activities.map((activity, index) => {
                  const ActivityIcon = getActivityIcon(activity.type);
                  const StatusIcon = getStatusIcon(activity.status);
                  return (
                    <Box
                      key={`${activity.timestamp}-${index}`}
                      // The code surface (see HighlightedCode's CODE_SURFACE_STYLE): a step is a
                      // well inside the panel, the same way a code body is a well inside a card,
                      // so they share the fill, the 6px corner and the 12px inset. It used to
                      // fill with background.level2, which this theme never defines.
                      sx={theme => ({
                        display: 'flex',
                        alignItems: 'center',
                        gap: '12px',
                        py: '12px',
                        px: '16px',
                        borderRadius: '6px',
                        backgroundColor: theme.palette.reading.surface,
                      })}
                    >
                      {/* Sized and coloured like a cited source's icon - it was 20px of
                        primary.500, the only saturated icon in the panel. */}
                      <ActivityIcon sx={{ fontSize: '1.25rem', color: 'text.tertiary', flexShrink: 0 }} />
                      <Typography level="body-sm" sx={{ flex: 1, color: 'text.primary' }}>
                        {activity.message}
                      </Typography>
                      <Box sx={{ display: 'flex', alignItems: 'center', gap: 0.5 }}>
                        <StatusIcon
                          sx={{
                            fontSize: '14px',
                            color:
                              activity.status === 'complete'
                                ? 'success.400'
                                : activity.status === 'error'
                                  ? 'danger.400'
                                  : 'warning.400', // TODO: add color for pending
                          }}
                        />
                      </Box>
                    </Box>
                  );
                })}
              </Box>
              {/* The auto-scroll target. Outside the gapped column: as a flex child it was a
                  zero-height item that still collected the column's gap, leaving dead space
                  under the last step. */}
              <div ref={activitiesEndRef} />
            </>
          ) : (
            <Typography level="body-sm" sx={{ color: 'text.secondary', textAlign: 'center', py: 2 }}>
              No activities yet
            </Typography>
          )}
        </TabPanel>

        {/* Sources Tab */}
        <TabPanel value={1} sx={{ p: 0, pt: '16px', maxHeight: '300px', overflowY: 'auto' }}>
          {sources.length > 0 ? (
            <Box sx={{ display: 'flex', flexDirection: 'column', gap: 1 }}>
              {sources.map((source, index) => {
                const SourceTypeIcon = getSourceTypeIcon(source.type || 'web_url');
                const isDatabaseSource = source.type === 'database' || source.type === 'internal';
                const isWebUrl = !source.type || source.type === 'web_url' || source.type === 'web';
                const isValidHttpUrl = source.url && source.url.startsWith('http');
                const isInternalPath = source.url && source.url.startsWith('/');
                const isClickableUrl = isValidHttpUrl || isInternalPath;

                return (
                  <Box
                    key={`${source.url}-${index}`}
                    sx={{
                      display: 'flex',
                      flexDirection: 'column',
                      gap: 0.5,
                      p: 1,
                      borderRadius: '6px',
                      backgroundColor: 'background.level2',
                    }}
                  >
                    <Box sx={{ display: 'flex', alignItems: 'center', gap: 1 }}>
                      {isWebUrl && isValidHttpUrl ? (
                        <>
                          <Box
                            component="img"
                            src={`https://www.google.com/s2/favicons?domain=${new URL(source.url).hostname}&sz=16`}
                            alt=""
                            sx={{
                              width: '16px',
                              height: '16px',
                              flexShrink: 0,
                              borderRadius: '2px',
                            }}
                            onError={e => {
                              const target = e.target as HTMLImageElement;
                              target.style.display = 'none';
                              const nextElement = target.nextElementSibling as HTMLElement;
                              if (nextElement) {
                                nextElement.style.display = 'inline-flex';
                              }
                            }}
                          />
                          <SourceTypeIcon
                            sx={{
                              fontSize: '16px',
                              color: 'primary.500',
                              flexShrink: 0,
                              display: 'none',
                            }}
                          />
                        </>
                      ) : (
                        <SourceTypeIcon
                          sx={{
                            fontSize: '16px',
                            color: 'primary.500',
                            flexShrink: 0,
                          }}
                        />
                      )}
                      <Typography
                        level="body-sm"
                        sx={{
                          fontWeight: 'bold',
                          flex: 1,
                          overflow: 'hidden',
                          textOverflow: 'ellipsis',
                          whiteSpace: 'nowrap',
                        }}
                      >
                        {source.title}
                      </Typography>
                      <Chip variant="soft" color={getStatusColor(source.status)} size="sm">
                        {source.status}
                      </Chip>
                    </Box>
                    <Typography
                      level="body-xs"
                      sx={{
                        color: 'text.secondary',
                        ml: 3,
                        overflow: 'hidden',
                        textOverflow: 'ellipsis',
                        whiteSpace: 'nowrap',
                      }}
                    >
                      {source.description}
                    </Typography>
                    {isClickableUrl ? (
                      <Typography
                        component="a"
                        href={source.url}
                        target="_blank"
                        rel="noopener noreferrer"
                        level="body-xs"
                        sx={{
                          color: 'primary.500',
                          ml: 3,
                          textDecoration: 'none',
                          '&:hover': {
                            textDecoration: 'underline',
                          },
                          overflow: 'hidden',
                          textOverflow: 'ellipsis',
                          whiteSpace: 'nowrap',
                        }}
                      >
                        {source.url}
                      </Typography>
                    ) : (
                      <Typography
                        level="body-xs"
                        sx={{
                          color: 'text.tertiary',
                          ml: 3,
                          overflow: 'hidden',
                          textOverflow: 'ellipsis',
                          whiteSpace: 'nowrap',
                        }}
                      >
                        {isDatabaseSource ? 'Internal Database' : source.url}
                      </Typography>
                    )}
                  </Box>
                );
              })}
            </Box>
          ) : (
            <Typography level="body-sm" sx={{ color: 'text.secondary', textAlign: 'center', py: 2 }}>
              No sources discovered yet
            </Typography>
          )}
        </TabPanel>
      </Tabs>
    </Card>
  );
};

export default DeepResearchProgress;

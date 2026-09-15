import {
  FileEvents,
  ICounterLogDocument,
  ICreateFileEvent,
  ISessionClonedEvent,
  ISessionCreatedEvent,
  ISessionUpdatedEvent,
  isValidEnumValue,
  IUpdateFileEvent,
  SessionEvents,
} from '@bike4mind/common';
import { useGetRecentActivities } from '@client/app/hooks/data/user';
import { Box, CircularProgress, Typography, Tooltip } from '@mui/joy';
import { brandAlpha } from '@client/app/utils/themes/colors';
import { ANALYTICS_EVENTS } from '@server/types/analytics';
import dayjs from 'dayjs';
import relativeTime from 'dayjs/plugin/relativeTime';
import InsertDriveFileOutlinedIcon from '@mui/icons-material/InsertDriveFileOutlined';
import EditNoteIcon from '@mui/icons-material/EditNote';
import { useNavigate } from '@tanstack/react-router';
import React, { useMemo } from 'react';
import { useKnowledgeModal } from '@client/app/components/Knowledge/KnowledgeModal';
import { useGetFabFileName } from '@client/app/hooks/data/fabFiles';
import { useGetSession } from '@client/app/hooks/data/sessions';
import { useLatestAnnouncement } from '@client/app/components/Session/NotebookSplash';
import { useIsMobile } from '@client/app/hooks/useIsMobile';

dayjs.extend(relativeTime);

interface ActivityContainerNewProps {
  title: React.ReactNode;
  subtitle: string;
  timestamp: Date;
  icon?: React.ReactNode;
  onClick?: () => void | undefined;
}

const ActivityContainer = ({ title, subtitle, timestamp, icon, onClick }: ActivityContainerNewProps) => {
  const isMobile = useIsMobile();

  return (
    <Box
      sx={{
        position: 'relative',
        border: '0.5px solid',
        borderColor: theme => theme.palette.session.activityBorder,
        borderRadius: '10px',
        backgroundColor: 'background.body',
        padding: '16px',
        minHeight: 60,
        width: '100%',
        display: 'flex',
        flexDirection: { xs: 'row', sm: 'column' },
        gap: { xs: '10px', sm: 0 },
        alignItems: { xs: 'center', sm: 'flex-start' },
        justifyContent: { xs: 'space-between', sm: 'flex-start' },
        boxSizing: 'border-box',
        cursor: !!onClick ? 'pointer' : 'default',
        boxShadow: `0px 1px 20px 0px ${brandAlpha[700][3]}`,
        overflow: 'hidden',
      }}
      onClick={onClick}
    >
      {/* Left side: icon, title, subtitle (mobile); all content (desktop) */}
      <Box
        sx={{
          display: 'flex',
          flexDirection: { xs: 'row', sm: 'column' },
          alignItems: { xs: 'center', sm: 'flex-start' },
          flex: 1,
          minWidth: 0,
          gap: { xs: 1.5, sm: 0 },
          width: '100%',
        }}
      >
        {/* Icon */}
        <Box
          sx={{
            fontSize: 0,
            flexShrink: 0,
            display: 'flex',
            alignItems: 'center',
            pt: { xs: '2px', sm: 0 },
            mb: { xs: 0, sm: 1.5 },
          }}
        >
          {icon && (
            <Box
              sx={{
                display: 'inline-flex',
                '& svg': {
                  width: isMobile ? 28 : 40,
                  height: isMobile ? 28 : 40,
                  color: 'primary.500',
                },
              }}
            >
              {icon}
            </Box>
          )}
        </Box>
        {/* Title and subtitle */}
        <Box
          sx={{
            display: 'flex',
            flexDirection: 'column',
            minWidth: 0,
            width: '100%',
          }}
        >
          <Typography
            level="body-lg"
            sx={{
              fontWeight: 400,
              fontSize: isMobile ? '14px' : '18px',
              color: 'text.primary',
              whiteSpace: { xs: 'normal', sm: 'nowrap' },
              overflow: { xs: 'visible', sm: 'hidden' },
              textOverflow: { xs: 'unset', sm: 'ellipsis' },
              wordBreak: 'break-word',
            }}
          >
            {title}
          </Typography>
          <Box
            sx={{
              display: 'flex',
              flexDirection: 'row',
              alignItems: 'center',
              justifyContent: 'space-between',
              width: '100%',
            }}
          >
            <Typography
              level="body-sm"
              sx={{
                color: 'text.primary50',
                fontWeight: 400,
                fontSize: isMobile ? '13px' : '14px',
                opacity: 0.85,
                whiteSpace: { xs: 'normal', sm: 'nowrap' },
                overflow: { xs: 'visible', sm: 'hidden' },
                textOverflow: { xs: 'unset', sm: 'ellipsis' },
                wordBreak: 'break-word',
                mt: { xs: '2px', sm: 0 },
              }}
            >
              {subtitle}
            </Typography>
            {/* Timestamp: right on mobile, absolute on desktop */}
            <Typography
              level="body-sm"
              sx={{
                display: { xs: 'block', sm: 'none' },
                color: 'text.primary50',
                fontSize: '12px',
                fontWeight: 400,
                opacity: 0.85,
                ml: 1,
                whiteSpace: 'nowrap',
                flexShrink: 0,
              }}
            >
              {dayjs(timestamp).fromNow()}
            </Typography>
          </Box>
        </Box>
      </Box>

      {/* Timestamp: absolute on desktop */}
      <Typography
        level="body-sm"
        sx={{
          display: { xs: 'none', sm: 'block' },
          position: 'absolute',
          top: 12,
          right: 10,
          color: 'text.primary50',
          fontSize: '14px',
          fontWeight: 400,
          opacity: 0.85,
        }}
      >
        {dayjs(timestamp).fromNow()}
      </Typography>
    </Box>
  );
};

// Icon mapping
const getIcon = (event: string) => {
  switch (event) {
    case SessionEvents.CREATE_SESSION:
    case SessionEvents.UPDATE_SESSION:
    case SessionEvents.DELETE_SESSION:
    case SessionEvents.CLONE_SESSION:
      return <EditNoteIcon sx={{ fontSize: 32 }} />;
    case FileEvents.CREATE_FILE:
    case FileEvents.UPDATE_FILE:
    case FileEvents.DELETE_FILE:
      return <InsertDriveFileOutlinedIcon sx={{ fontSize: 32 }} />;
    default:
      return undefined;
  }
};

const TruncatedText = ({ text, maxLength = 22 }: { text: string; maxLength?: number }) => {
  if (text.length <= maxLength) return <React.Fragment key="full-text">{text}</React.Fragment>;
  return (
    <Tooltip title={text} variant="soft">
      <Typography
        key="truncated-text"
        noWrap
        sx={{
          overflow: 'hidden',
          textOverflow: 'ellipsis',
          display: 'block',
          maxWidth: '100%',
        }}
      >
        {text.slice(0, maxLength)}...
      </Typography>
    </Tooltip>
  );
};

const getActivityTitle = (log: ICounterLogDocument): { title: React.ReactNode; subtitle: string } => {
  const eventName = log.counterName;
  if (isValidEnumValue(eventName, ANALYTICS_EVENTS)) {
    switch (eventName) {
      case SessionEvents.CREATE_SESSION: {
        const createMeta = log.metadata as ISessionCreatedEvent['metadata'];
        return {
          title: <TruncatedSessionNameText id={createMeta.sessionId} />,
          subtitle: 'Created notebook',
        };
      }
      case SessionEvents.UPDATE_SESSION: {
        const updateMeta = log.metadata as ISessionUpdatedEvent['metadata'];
        return {
          title: <TruncatedSessionNameText id={updateMeta.sessionId} />,
          subtitle: 'Updated notebook',
        };
      }
      case SessionEvents.CLONE_SESSION: {
        const cloneMeta = log.metadata as ISessionClonedEvent['metadata'];
        return {
          title: <TruncatedSessionNameText id={cloneMeta.sessionId} />,
          subtitle: 'Cloned notebook',
        };
      }
      case FileEvents.CREATE_FILE: {
        const createFileMeta = log.metadata as ICreateFileEvent['metadata'];
        return {
          title: <TruncatedFileNameText id={createFileMeta.fileId} />,
          subtitle: 'Created file',
        };
      }
      case FileEvents.UPDATE_FILE: {
        const updateFileMeta = log.metadata as IUpdateFileEvent['metadata'];
        return {
          title: <TruncatedFileNameText id={updateFileMeta.fileId} />,
          subtitle: 'Updated file',
        };
      }
      default:
        return { title: log.counterName, subtitle: '' };
    }
  }
  return { title: log.counterName, subtitle: '' };
};

const TruncatedFileNameText = ({ id }: { id: string }) => {
  const query = useGetFabFileName(id);
  const name = query.data;

  if (query.isFetching && !name) {
    return (
      <CircularProgress
        sx={{
          ml: '5px',
          '--CircularProgress-size': '14px',
          '--CircularProgress-trackThickness': '2px',
          '--CircularProgress-progressThickness': '-5px',
        }}
      />
    );
  }

  if (!name) return null;
  return <TruncatedText text={name} />;
};

const TruncatedSessionNameText = ({ id }: { id: string }) => {
  const query = useGetSession(id);
  const name = query.data?.name;

  if (query.isFetching && !name) {
    return (
      <CircularProgress
        sx={{
          ml: '5px',
          '--CircularProgress-size': '14px',
          '--CircularProgress-trackThickness': '2px',
          '--CircularProgress-progressThickness': '-5px',
        }}
      />
    );
  }

  if (!name) return null;
  return <TruncatedText text={name} />;
};

interface RecentActivitiesProps {
  gridLayout?: boolean;
}

const RecentActivities = ({ gridLayout }: RecentActivitiesProps) => {
  const recentActivities = useGetRecentActivities();
  const navigate = useNavigate();
  const { setSelectedFabFileId, setOpen, setViewOnly } = useKnowledgeModal();
  const { latestAnnouncement } = useLatestAnnouncement();

  const latestActivities = useMemo(() => {
    const limit = latestAnnouncement ? 3 : 4;
    return recentActivities.data?.slice(0, limit) ?? [];
  }, [recentActivities.data, latestAnnouncement]);

  const getActivityClickHandler = (log: ICounterLogDocument) => {
    const eventName = log.counterName;
    if (isValidEnumValue(eventName, ANALYTICS_EVENTS)) {
      switch (eventName) {
        case SessionEvents.CREATE_SESSION:
          return () => {
            const path = `/notebooks/${(log.metadata as ISessionCreatedEvent['metadata']).sessionId}`;
            navigate({ to: path });
          };
        case SessionEvents.UPDATE_SESSION:
          return () => {
            const path = `/notebooks/${(log.metadata as ISessionUpdatedEvent['metadata']).sessionId}`;
            navigate({ to: path });
          };
        case SessionEvents.CLONE_SESSION:
          return () => {
            navigate({ to: `/notebooks/${(log.metadata as ISessionClonedEvent['metadata']).newSessionId}` });
          };
        case FileEvents.CREATE_FILE:
          return () => {
            const metadata = log.metadata as ICreateFileEvent['metadata'];
            setSelectedFabFileId(metadata.fileId);
            setViewOnly(false);
            setOpen(true);
          };
        case FileEvents.UPDATE_FILE:
          return () => {
            const metadata = log.metadata as IUpdateFileEvent['metadata'];
            setSelectedFabFileId(metadata.fileId);
            setViewOnly(false);
            setOpen(true);
          };
        default:
          return undefined;
      }
    }
  };

  return (
    <Box
      sx={
        gridLayout
          ? {
              display: 'grid',
              gridTemplateColumns: { xs: '1fr', sm: '1fr 1fr', md: '1fr 1fr 1fr 1fr' },
              gap: '16px',
              alignItems: 'stretch',
              justifyItems: 'center',
              width: '100%',
              overflowY: 'auto',
              boxSizing: 'border-box',
              '& > *:first-of-type': {
                marginTop: 0,
              },
            }
          : {
              display: 'flex',
              gap: '16px',
              flexDirection: 'column',
              alignItems: 'center',
              overflowY: 'auto',
              boxSizing: 'border-box',
              '& > *:first-of-type': {
                marginTop: 0,
              },
            }
      }
    >
      {recentActivities.isPending && (
        <Box
          sx={{
            display: 'flex',
            justifyContent: 'center',
            alignItems: 'center',
            width: '100%',
            py: 4,
            gridColumn: gridLayout ? { xs: '1', sm: '1 / -1', md: '1 / -1' } : undefined,
          }}
        >
          <CircularProgress />
        </Box>
      )}

      {!recentActivities.isPending && latestActivities.length === 0 ? (
        <Box
          sx={{
            display: 'flex',
            justifyContent: 'center',
            alignItems: 'center',
            width: '100%',
            py: 4,
            gridColumn: gridLayout ? { xs: '1', sm: '1 / -1', md: '1 / -1' } : undefined,
          }}
        >
          <Typography level="body-sm" textAlign="center" color="neutral">
            Get started on a new Notebook. Be sure to add Files for better a better session.
          </Typography>
        </Box>
      ) : (
        latestActivities.map((activity, index) => {
          const { title, subtitle } = getActivityTitle(activity);
          return (
            <ActivityContainer
              key={index}
              title={title}
              subtitle={subtitle}
              timestamp={activity.createdAt}
              icon={getIcon(activity.counterName)}
              onClick={getActivityClickHandler(activity)}
            />
          );
        })
      )}
    </Box>
  );
};

export default RecentActivities;

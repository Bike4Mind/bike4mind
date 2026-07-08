import { memo } from 'react';
import { IProjectDocument, ISessionDocument, ISessionFavoriteItem } from '@bike4mind/common';
import { useGetProjectSessions } from '@client/app/hooks/data/sessions';
import SessionSidenavItem from '@client/app/components/Session/SidenavItem';
import { Box, CircularProgress, Typography } from '@mui/joy';

interface ProjectSessionListProps {
  project: IProjectDocument;
  onNotebookClick: (session: ISessionDocument) => void;
  favoriteSessions?: ISessionFavoriteItem[];
}

function ProjectSessionList({ project, onNotebookClick, favoriteSessions }: ProjectSessionListProps) {
  const { data: sessions, isLoading } = useGetProjectSessions(project.id);

  return (
    <Box sx={{ pl: '28px' }}>
      {isLoading ? (
        <Box sx={{ py: 1, display: 'flex', justifyContent: 'center' }}>
          <CircularProgress size="sm" />
        </Box>
      ) : sessions?.length ? (
        sessions.map(session => (
          <SessionSidenavItem
            key={session.id}
            session={session}
            onClick={() => onNotebookClick(session)}
            favoriteSessions={favoriteSessions}
            isEditMode={false}
            isChecked={false}
            isShared={false}
            showMessageCount={false}
          />
        ))
      ) : (
        <Typography level="body-xs" sx={{ color: 'neutral.softDisabledColor', py: 1, px: '12px' }}>
          No notebooks
        </Typography>
      )}
    </Box>
  );
}

export default memo(ProjectSessionList);

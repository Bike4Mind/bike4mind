import { Box, Button, Checkbox } from '@mui/joy';
import { FC, useCallback, useMemo, useState, useEffect } from 'react';
import AddIcon from '@mui/icons-material/Add';
import { useGetOwnSessions } from '@client/app/hooks/data/sessions';
import { debounce } from 'lodash';
import { useAddSessionsToProject } from '@client/app/hooks/data/projects';
import { useDetectScrollBottom } from '@client/app/hooks/useDetectScrollBottom';
import { ISessionDocument } from '@bike4mind/common';
import { Link } from '@tanstack/react-router';
import GenericAddItemsModal from './GenericAddItemsModal';
import { useTranslation } from 'react-i18next';
import { formatSessionTitle } from '@client/app/utils/sessionTitle';

interface ProjectAddSessionsModalProps {
  projectId: string;
  onAdd?: (sessionIds: string[]) => void;
  value?: string[];
}

const ProjectAddSessionsModal: FC<ProjectAddSessionsModalProps> = ({ projectId, onAdd, value }) => {
  const { t } = useTranslation();
  const [search, setSearch] = useState('');
  const { data, hasNextPage, fetchNextPage, isFetching } = useGetOwnSessions(search);
  const [selectedSessionIds, setSelectedSessionIds] = useState<string[]>(value || []);
  const { mutate: addSessionsToProject, isPending } = useAddSessionsToProject({
    onSuccess: () => {
      setSearch('');
      setSelectedSessionIds([]);
    },
  });
  const sessions = data?.pages?.map(page => page.data).flat() ?? [];
  const debouncedSearch = useMemo(() => debounce(setSearch, 300), []);

  useEffect(() => {
    if (value) {
      setSelectedSessionIds(value);
    }
  }, [value]);

  const debounceScroll = useDetectScrollBottom(
    hasNextPage && !isFetching,
    useCallback(() => {
      fetchNextPage();
    }, [fetchNextPage])
  );

  const handleAddSessions = useCallback(
    (sessionIds: string[]) => {
      if (onAdd) {
        onAdd(sessionIds);
        setSearch('');
        setSelectedSessionIds([]);
      } else {
        addSessionsToProject({ projectId, sessionIds });
      }
    },
    [addSessionsToProject, projectId, onAdd]
  );

  const renderSessionItem = useCallback((session: ISessionDocument, isSelected: boolean, onSelect: () => void) => {
    return (
      <Box
        onClick={onSelect}
        sx={theme => ({
          borderRadius: '8px',
          display: 'flex',
          width: '100%',
          border: '1px solid',
          borderColor: 'divider',
          backgroundColor: theme.palette.primary.softBg,
          alignItems: 'center',
          justifyContent: 'space-between',
          padding: '12px 15px',
          position: 'relative',
          cursor: 'pointer',
          '&:hover': {
            backgroundColor: theme.palette.primary.softHoverBg,
          },
        })}
      >
        <Box display="flex" gap="10px" alignItems="center">
          <Checkbox checked={isSelected} />
          <Box component="span" fontSize="14px">
            {formatSessionTitle(session.name)}
          </Box>
        </Box>
      </Box>
    );
  }, []);

  const createNotebookButton = (
    <Link
      to="/new"
      search={{ projectId }}
      style={{ textDecoration: 'none', width: '100%' }}
      data-testid="project-create-notebook-link"
    >
      <Button variant="solid" color="primary" sx={{ width: '100%' }}>
        {t('projects.modals.sessions.create_button')}
      </Button>
    </Link>
  );

  return (
    <GenericAddItemsModal
      title={t('projects.modals.sessions.title')}
      subtitle={t('projects.modals.sessions.subtitle')}
      buttonLabel={t('projects.modals.sessions.button_label')}
      buttonIcon={<AddIcon />}
      items={sessions}
      selectedIds={selectedSessionIds}
      onSelectIds={setSelectedSessionIds}
      getItemId={session => session.id}
      onSearch={term => debouncedSearch(term)}
      searchPlaceholder={t('projects.modals.sessions.search_placeholder')}
      onAdd={handleAddSessions}
      isPending={isPending}
      leftGridContent={createNotebookButton}
      renderItem={renderSessionItem}
      onScroll={debounceScroll}
      isLoadingMore={isFetching}
      value={value}
      emptyResultMessage={t('projects.modals.sessions.no_notebooks')}
      triggerTestId="project-add-notebooks-btn"
    />
  );
};

export default ProjectAddSessionsModal;

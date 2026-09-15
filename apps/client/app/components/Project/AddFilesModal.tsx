import { Box, Checkbox } from '@mui/joy';
import { FC, useCallback, useMemo, useState, useEffect } from 'react';
import AddIcon from '@mui/icons-material/Add';
import { debounce } from 'lodash';
import { useGetFabFiles } from '@client/app/hooks/data/fabFiles';
import { useAddFilesToProject } from '@client/app/hooks/data/projects';
import { GetFileIcon } from '@client/app/utils/fabFileUtils';
import { IFabFileDocument } from '@bike4mind/common';
import GenericAddItemsModal from './GenericAddItemsModal';
import { useTranslation } from 'react-i18next';

interface ProjectAddFilesModalProps {
  projectId: string;
  onAdd?: (fileIds: string[]) => void;
  value?: string[];
}

const ProjectAddFilesModal: FC<ProjectAddFilesModalProps> = ({ projectId, onAdd, value }) => {
  const { t } = useTranslation();
  const [search, setSearch] = useState('');
  const { data: filesData, fetchNextPage, hasNextPage, isFetchingNextPage } = useGetFabFiles(search, { projectId });
  const [selectedFileIds, setSelectedFileIds] = useState<string[]>(value || []);

  const handleScroll = useCallback(
    (e: React.UIEvent<HTMLDivElement>) => {
      const { scrollTop, clientHeight, scrollHeight } = e.currentTarget;
      if (scrollHeight - scrollTop - clientHeight < 50 && hasNextPage && !isFetchingNextPage) {
        fetchNextPage();
      }
    },
    [fetchNextPage, hasNextPage, isFetchingNextPage]
  );

  const { mutate: addFilesToProject, isPending } = useAddFilesToProject({
    onSuccess: () => {
      setSearch('');
      setSelectedFileIds([]);
    },
  });

  useEffect(() => {
    if (value) {
      setSelectedFileIds(value);
    }
  }, [value]);

  const files = filesData?.pages?.map(page => page.data).flat() ?? [];
  const debouncedSearch = useMemo(() => debounce(setSearch, 300), []);

  const handleAddFiles = useCallback(
    (fileIds: string[]) => {
      if (onAdd) {
        onAdd(fileIds);
        setSearch('');
        setSelectedFileIds([]);
      } else {
        addFilesToProject({ projectId, fileIds });
      }
    },
    [addFilesToProject, projectId, onAdd]
  );

  const renderFileItem = useCallback((file: IFabFileDocument, isSelected: boolean, onSelect: () => void) => {
    return (
      <Box
        onClick={onSelect}
        className="test-add-files-modal-item"
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
        <Box display="flex" gap="10px" alignItems="center" className="test-add-files-modal-item-content">
          <Checkbox checked={isSelected} className="test-add-files-modal-checkbox" />
          <GetFileIcon file={file} size={18} previewSize={48} />
          <Box component="span" fontSize="14px" className="test-add-files-modal-filename">
            {file.fileName}
          </Box>
        </Box>
      </Box>
    );
  }, []);

  return (
    <GenericAddItemsModal
      title={t('projects.modals.files.title')}
      subtitle={t('projects.modals.files.subtitle')}
      buttonLabel={t('projects.modals.files.button_label')}
      buttonIcon={<AddIcon className="test-add-files-modal-button-icon" />}
      items={files}
      selectedIds={selectedFileIds}
      onSelectIds={setSelectedFileIds}
      getItemId={file => file.id}
      onSearch={term => debouncedSearch(term)}
      searchPlaceholder={t('projects.modals.files.search_placeholder')}
      onAdd={handleAddFiles}
      isPending={isPending}
      renderItem={renderFileItem}
      onScroll={handleScroll}
      isLoadingMore={isFetchingNextPage}
      value={value}
      emptyResultMessage={t('projects.modals.files.no_files')}
    />
  );
};

export default ProjectAddFilesModal;

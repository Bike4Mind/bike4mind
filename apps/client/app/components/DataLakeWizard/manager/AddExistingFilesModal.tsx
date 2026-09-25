import { Box, Checkbox, Chip, Typography } from '@mui/joy';
import { useCallback, useMemo, useState } from 'react';
import AddIcon from '@mui/icons-material/Add';
import { debounce } from 'lodash';
import { useTranslation } from 'react-i18next';
import type { IFabFileDocument } from '@bike4mind/common';
import { useGetFabFiles } from '@client/app/hooks/data/fabFiles';
import { useAddFilesToLake } from '@client/app/hooks/data/dataLakes';
import { GetFileIcon } from '@client/app/utils/fabFileUtils';
import GenericAddItemsModal from '@client/app/components/Project/GenericAddItemsModal';
import type { ManagerLake } from './shared';

/** A file is a member when it carries the lake's meta-tag - the same test the Files browser and
 *  the server's membership scope use. */
export const isLakeMember = (file: IFabFileDocument, datalakeTag: string) =>
  (file.tags ?? []).some(tag => tag.name === datalakeTag);

/**
 * Split the picked ids into the ones safe to send and the ones already members. The toggle door
 * REMOVES a file that already carries the lake tag (and its content-prefix tags with it), so a
 * member must never be forwarded - see useAddFilesToLake's docblock. Ids with no loaded file are
 * dropped, matching the Files browser's unresolved-selection guard.
 */
export function partitionLakeAddCandidates(
  files: IFabFileDocument[],
  selectedIds: string[],
  datalakeTag: string
): { addIds: string[]; memberIds: string[] } {
  const selected = new Set(selectedIds);
  const addIds: string[] = [];
  const memberIds: string[] = [];
  for (const file of files) {
    if (!selected.has(file.id)) continue;
    if (isLakeMember(file, datalakeTag)) memberIds.push(file.id);
    else addIds.push(file.id);
  }
  return { addIds, memberIds };
}

interface AddExistingFilesModalProps {
  lake: ManagerLake;
  open: boolean;
  onClose: () => void;
}

/**
 * Picker for adding files the caller already has to a data lake, without re-uploading them.
 * Submits through the shared useAddFilesToLake toggle door - the same one the Files browser's
 * "Add to lake" uses - so this is an entry point, not a second way of joining a lake.
 */
export default function AddExistingFilesModal({ lake, open, onClose }: AddExistingFilesModalProps) {
  const { t } = useTranslation();
  const [search, setSearch] = useState('');
  const [selectedFileIds, setSelectedFileIds] = useState<string[]>([]);
  const { data: filesData, fetchNextPage, hasNextPage, isFetchingNextPage } = useGetFabFiles(search);
  const { mutateAsync: addFilesToLake, isPending } = useAddFilesToLake();
  const debouncedSearch = useMemo(() => debounce(setSearch, 300), []);

  const files = useMemo(() => filesData?.pages?.map(page => page.data).flat() ?? [], [filesData]);
  // Members are shown but never selectable: the row's click still reaches GenericAddItemsModal's
  // toggle, so the filter has to live on the way in, not only in the row's disabled checkbox.
  const memberIds = useMemo(
    () => new Set(files.filter(file => isLakeMember(file, lake.datalakeTag)).map(file => file.id)),
    [files, lake.datalakeTag]
  );

  const handleSelectIds = useCallback(
    (ids: string[]) => setSelectedFileIds(ids.filter(id => !memberIds.has(id))),
    [memberIds]
  );

  const handleScroll = useCallback(
    (e: React.UIEvent<HTMLDivElement>) => {
      const { scrollTop, clientHeight, scrollHeight } = e.currentTarget;
      if (scrollHeight - scrollTop - clientHeight < 50 && hasNextPage && !isFetchingNextPage) {
        fetchNextPage();
      }
    },
    [fetchNextPage, hasNextPage, isFetchingNextPage]
  );

  const handleClose = useCallback(() => {
    setSearch('');
    setSelectedFileIds([]);
    onClose();
  }, [onClose]);

  const handleAdd = useCallback(
    (ids: string[]) => {
      // Second pass at submit: the list can have changed since a row was rendered, and this is the
      // last point before the destructive toggle. Closing/reset is GenericAddItemsModal's job.
      const { addIds, memberIds: skippedIds } = partitionLakeAddCandidates(files, ids, lake.datalakeTag);
      if (addIds.length === 0) return;
      void addFilesToLake({
        fileIds: addIds,
        lake: { id: lake.id, datalakeTag: lake.datalakeTag },
        skippedCount: skippedIds.length,
      });
    },
    [files, lake.id, lake.datalakeTag, addFilesToLake]
  );

  const renderFileItem = useCallback(
    (file: IFabFileDocument, isSelected: boolean) => {
      const member = isLakeMember(file, lake.datalakeTag);
      return (
        <Box
          data-testid={`datalake-addexisting-item-${file.id}`}
          sx={theme => ({
            borderRadius: '8px',
            display: 'flex',
            width: '100%',
            border: '1px solid',
            borderColor: 'divider',
            backgroundColor: theme.palette.primary.softBg,
            alignItems: 'center',
            gap: '10px',
            padding: '12px 15px',
            cursor: member ? 'default' : 'pointer',
            opacity: member ? 0.65 : 1,
            '&:hover': { backgroundColor: member ? theme.palette.primary.softBg : theme.palette.primary.softHoverBg },
          })}
        >
          <Checkbox checked={isSelected} disabled={member} data-testid={`datalake-addexisting-checkbox-${file.id}`} />
          <GetFileIcon file={file} size={18} previewSize={48} />
          <Typography level="body-sm" noWrap sx={{ flex: 1, minWidth: 0 }}>
            {file.fileName}
          </Typography>
          {member && (
            <Chip size="sm" variant="soft" color="neutral" data-testid={`datalake-addexisting-member-chip-${file.id}`}>
              {t('file_browser.already_in_lake', 'Already in lake')}
            </Chip>
          )}
        </Box>
      );
    },
    [lake.datalakeTag, t]
  );

  const isDraft = !lake.status || lake.status === 'draft';
  const subtitle = t(
    'file_browser.add_existing_subtitle',
    "Pick files you already have. Files already in this lake are shown but can't be added again."
  );

  return (
    <GenericAddItemsModal
      open={open}
      onOpenChange={next => {
        if (!next) handleClose();
      }}
      title={t('file_browser.add_existing_title', 'Add existing files')}
      subtitle={
        isDraft
          ? `${subtitle} ${t('file_browser.add_existing_draft_notice', "This lake is a draft - added files won't ground answers until it is published.")}`
          : subtitle
      }
      buttonLabel={t('file_browser.add_existing_title', 'Add existing files')}
      buttonIcon={<AddIcon />}
      items={files}
      selectedIds={selectedFileIds}
      onSelectIds={handleSelectIds}
      getItemId={file => file.id}
      onSearch={term => debouncedSearch(term)}
      searchPlaceholder={t('file_browser.add_existing_search_placeholder', 'Search your files')}
      onAdd={handleAdd}
      isPending={isPending}
      renderItem={renderFileItem}
      onScroll={handleScroll}
      isLoadingMore={isFetchingNextPage}
      emptyResultMessage={t('file_browser.add_existing_empty', 'No files found.')}
    />
  );
}

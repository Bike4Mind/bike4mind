import { Box, Checkbox, Chip, Typography } from '@mui/joy';
import { useCallback, useMemo, useState } from 'react';
import AddIcon from '@mui/icons-material/Add';
import { debounce } from 'lodash';
import { useTranslation } from 'react-i18next';
import { toast } from 'sonner';
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
 * member must never be forwarded - see useAddFilesToLake's docblock. `files` is whatever resolved
 * documents the caller has, not necessarily the current search page: a selection outlives the
 * search that produced it, so the two are not the same set. Ids absent from `files` are omitted
 * from both lists - the caller must refuse in that case rather than post a partial batch.
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
  // Selection is the documents themselves, keyed by id, not bare ids: a selection outlives the
  // search that produced it (GenericAddItemsModal keeps selectedIds across searches), so at submit
  // the current page cannot resolve it. A bare id would be silently unresolvable there.
  const [selectedFiles, setSelectedFiles] = useState<Map<string, IFabFileDocument>>(() => new Map());
  const { data: filesData, fetchNextPage, hasNextPage, isFetchingNextPage } = useGetFabFiles(search);
  const { mutate: addFilesToLake, isPending } = useAddFilesToLake();
  const debouncedSearch = useMemo(() => debounce(setSearch, 300), []);

  const files = useMemo(() => filesData?.pages?.map(page => page.data).flat() ?? [], [filesData]);
  const selectedFileIds = useMemo(() => [...selectedFiles.keys()], [selectedFiles]);
  // Members are shown but never selectable: the row's click still reaches GenericAddItemsModal's
  // toggle, so the filter has to live on the way in, not only in the row's disabled checkbox.
  const memberIds = useMemo(
    () => new Set(files.filter(file => isLakeMember(file, lake.datalakeTag)).map(file => file.id)),
    [files, lake.datalakeTag]
  );

  const handleSelectIds = useCallback(
    (ids: string[]) => {
      setSelectedFiles(prev => {
        const next = new Map<string, IFabFileDocument>();
        for (const id of ids) {
          if (memberIds.has(id)) continue;
          const file = prev.get(id) ?? files.find(candidate => candidate.id === id);
          if (file) next.set(id, file);
        }
        return next;
      });
    },
    [files, memberIds]
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
    setSelectedFiles(new Map());
    onClose();
  }, [onClose]);

  const handleAdd = useCallback(
    (ids: string[]) => {
      // Resolve each selected id against the current page first, then the documents carried from
      // the search that produced the selection: a selection outlives its search, and partitioning
      // against the current page alone was dropping the off-page ids. Latest wins, so a refetch
      // that made a selected file a member is seen here.
      const currentById = new Map(files.map(file => [file.id, file]));
      const selectedDocs = ids
        .map(id => currentById.get(id) ?? selectedFiles.get(id))
        .filter((file): file is IFabFileDocument => Boolean(file));
      if (selectedDocs.length !== ids.length) {
        toast.error(t('file_browser.selection_not_resolved'));
        return false;
      }
      // Last point before the destructive toggle: re-check membership so a stale selection can
      // never remove a file that became a member since it was ticked.
      const { addIds, memberIds: skippedIds } = partitionLakeAddCandidates(selectedDocs, ids, lake.datalakeTag);
      if (addIds.length === 0) {
        toast.info(t('file_browser.already_lake_members'));
        return false;
      }
      addFilesToLake({
        fileIds: addIds,
        lake: { id: lake.id, datalakeTag: lake.datalakeTag },
        skippedCount: skippedIds.length,
      });
      return true;
    },
    [files, selectedFiles, lake.id, lake.datalakeTag, addFilesToLake, t]
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

  return (
    <GenericAddItemsModal
      open={open}
      onOpenChange={next => {
        if (!next) handleClose();
      }}
      title={t('file_browser.add_existing_title', 'Add existing files')}
      // The draft variant is its own key so a generated locale can reorder the two sentences.
      subtitle={t(
        isDraft ? 'file_browser.add_existing_subtitle_draft' : 'file_browser.add_existing_subtitle',
        isDraft
          ? "Pick files you already have. Files already in this lake are shown but can't be added again. This lake is a draft - added files won't ground answers until it is published."
          : "Pick files you already have. Files already in this lake are shown but can't be added again."
      )}
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

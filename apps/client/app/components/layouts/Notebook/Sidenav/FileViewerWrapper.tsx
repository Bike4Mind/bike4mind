import FileBrowser from '@client/app/components/FileBrowser';
import { useKnowledgeModal } from '@client/app/components/Knowledge/KnowledgeModal';
import { useSessions, useWorkBenchFiles, useWorkBenchActions } from '@client/app/contexts/SessionsContext';
import { useUser } from '@client/app/contexts/UserContext';
import { useDeleteFile, useGetFabFilesWithCombinedSearch } from '@client/app/hooks/data/fabFiles';
import { useUpdateSession } from '@client/app/hooks/data/sessions';
import { userCanDeleteDoc, userCanShareDoc, userCanUpdateDoc } from '@client/app/utils/userPermission';
import { formatSessionTitle } from '@client/app/utils/sessionTitle';
import { IFabFileDocument } from '@bike4mind/common';
import { useCallback, useEffect, useMemo, useState } from 'react';
import { toast } from 'sonner';
import { create } from 'zustand';
import { useShallow } from 'zustand/react/shallow';
import { useTranslation } from 'react-i18next';

export const useFileViewerStore = create<{
  search: string;
  sort: string;
  sortField: string;
  filters: { tag?: string; type?: 'text' | 'pdf' | 'url' | 'image'; shared?: boolean };
  displayType: 'list' | 'grid';
  isOpen: boolean;
}>(() => ({
  search: '',
  sort: 'desc',
  sortField: 'createdAt',
  filters: {},
  displayType: 'grid',
  isOpen: false,
}));

const FileViewerWrapper = () => {
  const { t } = useTranslation();
  const [search, sort, filters, sortField, isOpen] = useFileViewerStore(
    useShallow(s => [s.search, s.sort, s.filters, s.sortField, s.isOpen])
  );
  const { currentUser } = useUser();
  const [currentPage, setCurrentPage] = useState(1);

  const setOpenFileBrowser = (open: boolean) => {
    useFileViewerStore.setState({ isOpen: open });
  };
  const openFileBrowser = isOpen;

  const { data, isLoading, refetch } = useGetFabFilesWithCombinedSearch(
    search,
    { type: filters.type, shared: filters.shared },
    sort,
    sortField,
    currentPage,
    { enabled: openFileBrowser }
  );
  const deleteFile = useDeleteFile();
  const canUpdate = (file: IFabFileDocument) => userCanUpdateDoc(currentUser, file);
  const canDelete = (file: IFabFileDocument) => userCanDeleteDoc(currentUser, file);
  const canShare = (file: IFabFileDocument) => userCanShareDoc(currentUser, file);
  const updateSession = useUpdateSession();
  const { setSelectedFabFileId, setOpen, setViewOnly } = useKnowledgeModal();
  const { currentSession, setCurrentSession, currentSessionId } = useSessions();
  const workBenchFiles = useWorkBenchFiles(currentSessionId);
  const { setWorkBenchFiles } = useWorkBenchActions();
  const [isRefreshing, setIsRefreshing] = useState(false);

  const handleRefresh = useCallback(async () => {
    setIsRefreshing(true);
    await refetch();
    setIsRefreshing(false);
  }, [refetch]);

  function handleBulkAdd(files: IFabFileDocument[]) {
    const applicableFiles = files.filter(f => !workBenchFiles.some(w => w.id === f.id));

    const fileNames = applicableFiles.map(f => f.fileName).join(', ');
    const newWorkBenchFiles = [...workBenchFiles, ...applicableFiles];
    const knowledgeIds = newWorkBenchFiles.map(f => f.id);

    // Optimistic update
    setWorkBenchFiles(currentSessionId ?? '', newWorkBenchFiles);

    if (currentSession) {
      const updatedSession = { ...currentSession, knowledgeIds };
      updateSession.mutate(updatedSession, {
        onSuccess: () => {
          setCurrentSession(updatedSession);
          setWorkBenchFiles(currentSessionId ?? '', newWorkBenchFiles);
          toast.success(
            t('file_browser.add_to_session_success', {
              fileNames,
              sessionName: formatSessionTitle(currentSession.name),
            })
          );
        },
      });
    } else {
      toast.success(t('file_browser.add_file_success', { fileNames }));
    }
  }

  // Reset to page 1 when search, filters, or sort changes
  useEffect(() => {
    setCurrentPage(1);
  }, [search, filters, sort, sortField]);

  const fabFiles = useMemo(() => {
    if (isRefreshing) return [];
    return data?.data || [];
  }, [data?.data, isRefreshing]);

  const totalFiles = data?.total || 0;
  const totalPages = Math.ceil(totalFiles / 20);

  return (
    <FileBrowser
      totalFiles={totalFiles}
      fabFiles={fabFiles}
      currentSession={currentSession}
      isFetching={isLoading || isRefreshing}
      canDelete={canDelete}
      canUpdate={canUpdate}
      canShare={canShare}
      onBulkAdd={handleBulkAdd}
      onFabFileClick={() => {}}
      openKnowledgeModal={fabFile => {
        setSelectedFabFileId(fabFile.id);
        setViewOnly(false);
        setOpen(true);
      }}
      onFabFileDelete={fabFileId => deleteFile.mutateAsync(fabFileId)}
      onRefresh={handleRefresh}
      onScrollEnd={() => {}}
      onPageChange={setCurrentPage}
      currentPage={currentPage}
      totalPages={totalPages}
      open={openFileBrowser}
      onOpenChange={setOpenFileBrowser}
    />
  );
};

export default FileViewerWrapper;

import { FC, useCallback, useMemo, useState, useRef } from 'react';
import { debounce } from 'lodash';
import SearchIcon from '@mui/icons-material/Search';
import UploadFileIcon from '@mui/icons-material/UploadFile';
import { brand, brandAlpha } from '@client/app/utils/themes/colors';
import { useRemoveFilesFromProject } from '@client/app/hooks/data/projects';
import { IFabFileDocument, KnowledgeType } from '@bike4mind/common';
import ProjectFile from './File';
import SortByAlphaIcon from '@mui/icons-material/SortByAlpha';
import AccessTimeIcon from '@mui/icons-material/AccessTime';
import RefreshIcon from '@mui/icons-material/Refresh';
import { useTranslation } from 'react-i18next';
import { Box, CircularProgress, IconButton, Input, Stack, Tooltip, Typography, Divider } from '@mui/joy';
import EmbeddedFileBrowser, { EmbeddedFileBrowserHandle } from '@client/app/components/Files/EmbeddedFileBrowser';
import { useAddFilesToProject } from '@client/app/hooks/data/projects';
import FolderSharedIcon from '@mui/icons-material/FolderShared';
import { getErrorMessage } from '@client/app/utils/error';
import { createFabFileOnServerWithUpload } from '@client/app/utils/filesAPICalls';
import { toast } from 'react-hot-toast';

const ProjectFiles: FC<{
  projectId: string;
  files: IFabFileDocument[];
  isLoading: boolean;
  isFetching: boolean;
  onRefresh?: () => Promise<void>;
}> = ({ projectId, files, isLoading, isFetching, onRefresh }) => {
  const [search, setSearch] = useState('');
  const { mutate: removeFiles } = useRemoveFilesFromProject();
  const [sortField, setSortField] = useState<'fileName' | 'createdAt'>('createdAt');
  const [sortDirection, setSortDirection] = useState<'asc' | 'desc'>('desc');
  const { t } = useTranslation();
  const { mutate: addFilesToProject } = useAddFilesToProject();
  const projectFileIds = useMemo(() => new Set(files.map(f => f.id)), [files]);
  const [isDragging, setIsDragging] = useState(false);
  const [isRefreshing, setIsRefreshing] = useState(false);
  const dragCounter = useRef(0);
  const fileBrowserRef = useRef<EmbeddedFileBrowserHandle>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);

  const debouncedSearch = useMemo(
    () =>
      debounce((value: string) => {
        setSearch(value);
      }, 300),
    []
  );

  // Client-side search filtering
  const filteredFiles = useMemo(() => {
    if (!files) return [];
    let result: IFabFileDocument[] = files;
    if (search) {
      const searchLower = search.toLowerCase();
      result = files.filter(file => file.fileName.toLowerCase().includes(searchLower));
    }

    result.sort((a, b) => {
      if (sortField === 'fileName') {
        return sortDirection === 'asc' ? a.fileName.localeCompare(b.fileName) : b.fileName.localeCompare(a.fileName);
      } else if (sortField === 'createdAt') {
        // use updatedAt since it is the last time the file was updated or added to project
        // createdAt is the time the file was created on the server
        const dateA = new Date(a.updatedAt).getTime();
        const dateB = new Date(b.updatedAt).getTime();
        return sortDirection === 'asc' ? dateA - dateB : dateB - dateA;
      }
      return 0;
    });

    return result;
  }, [files, search, sortField, sortDirection]);

  const handleRemoveFile = useCallback(
    (fileId: string) => {
      removeFiles({ projectId, fileIds: [fileId] });
    },
    [projectId, removeFiles]
  );

  // Picker delete: remove a batch of files from the project in one request.
  const handleRemoveFiles = useCallback(
    (fileIds: string[]) => {
      removeFiles({ projectId, fileIds });
    },
    [projectId, removeFiles]
  );

  const handleBulkAdd = useCallback(
    (files: IFabFileDocument[]) => {
      const fileIds = files.map(file => file.id);
      addFilesToProject({ projectId, fileIds });
    },
    [addFilesToProject, projectId]
  );

  const handleProjectRefresh = useCallback(async () => {
    if (onRefresh) {
      setIsRefreshing(true);
      try {
        await onRefresh();
      } finally {
        setIsRefreshing(false);
      }
    }
  }, [onRefresh]);

  const handleDragEnter = (e: React.DragEvent<HTMLDivElement>) => {
    e.preventDefault();
    e.stopPropagation();
    dragCounter.current++;
    if (e.dataTransfer.items && e.dataTransfer.items.length > 0) {
      setIsDragging(true);
    }
  };

  const handleDragLeave = (e: React.DragEvent<HTMLDivElement>) => {
    e.preventDefault();
    e.stopPropagation();
    dragCounter.current--;
    if (dragCounter.current === 0) {
      setIsDragging(false);
    }
  };

  const handleDragOver = (e: React.DragEvent<HTMLDivElement>) => {
    e.preventDefault();
    e.stopPropagation();
  };

  const handleDrop = async (e: React.DragEvent<HTMLDivElement>) => {
    e.preventDefault();
    e.stopPropagation();
    setIsDragging(false);
    dragCounter.current = 0;

    if (e.dataTransfer.files && e.dataTransfer.files.length > 0) {
      await handleFiles(Array.from(e.dataTransfer.files));
      e.dataTransfer.clearData();
    }
  };

  // Not wrapped in useCallback: React Compiler refuses to memoize an async
  // for-await loop with side effects; manual useCallback would mask the
  // missing optimization rather than fix it.
  const handleFiles = async (files: File[]) => {
    for (const file of files) {
      try {
        const data = {
          type: KnowledgeType.FILE,
          fileName: file.name,
          mimeType: file.type,
          fileSize: file.size,
        };
        const newFile = await createFabFileOnServerWithUpload(data, file);
        addFilesToProject({ projectId, fileIds: [newFile.id] });
        toast.success(`Uploaded: ${file.name}`);
      } catch (error) {
        console.error('Error uploading file %s:', file.name, error);
        toast.error(getErrorMessage(error));
      }
    }
  };

  // Not wrapped in useCallback: its only dep would be handleFiles, which is an
  // unstable per-render closure, so memoization here would be a no-op.
  const handleFileInputChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    if (e.target.files && e.target.files.length > 0) {
      handleFiles(Array.from(e.target.files));
      // Reset the input value so the same file can be selected again
      e.target.value = '';
    }
  };

  return (
    <>
      <Stack className="project-files-container" gap="20px" sx={{ height: '100%' }}>
        <Box
          className="project-files-controls"
          sx={{
            flexDirection: {
              xs: 'column',
              sm: 'row',
            },
            display: 'flex',
            gap: '12px',
            mx: '20px',
          }}
        >
          <Input
            className="project-files-search-input"
            sx={theme => ({
              flexGrow: 1,
              color: theme.palette.searchbar.color,
              border: `1px solid ${theme.palette.border.input}`,
              background: theme.palette.searchbar.background,
              fontSize: '14px',
              fontWeight: 400,
              lineHeight: '100%',
              fontStyle: 'normal',
              borderRadius: '8px',
              boxShadow: `0px 1px 50px 0px ${brandAlpha[700][3]}`,
              '&:focus-within .MuiSvgIcon-root': {
                color: theme.palette.mode === 'dark' ? 'white' : 'black',
              },
            })}
            placeholder="Search files"
            onChange={e => {
              debouncedSearch(e.target.value);
            }}
            startDecorator={
              <SearchIcon
                className="project-files-search-icon"
                sx={theme => ({
                  width: '20px',
                  height: '20px',
                  color: 'grey',
                })}
              />
            }
            endDecorator={isFetching && <CircularProgress size="sm" />}
          />

          <Tooltip title={`Sort by Name ${sortField === 'fileName' && sortDirection === 'desc' ? 'Z → A' : 'A → Z'}`}>
            <IconButton
              className="project-files-sort-name-button"
              variant={sortField === 'fileName' ? 'solid' : 'outlined'}
              onClick={() => {
                if (sortField === 'fileName') {
                  setSortDirection(sortDirection === 'asc' ? 'desc' : 'asc');
                } else {
                  setSortField('fileName');
                  setSortDirection('asc');
                }
              }}
              sx={
                sortField === 'fileName'
                  ? {
                      borderColor: brand[800],
                      borderWidth: 1,
                      background: brandAlpha[800][8],
                      '&:hover': {
                        borderColor: brand[800],
                        background: brandAlpha[800][12],
                      },
                    }
                  : {
                      '&:hover': {
                        background: brandAlpha[400][8],
                      },
                    }
              }
            >
              <SortByAlphaIcon
                sx={{
                  fontSize: 20,
                  transform: sortField === 'fileName' && sortDirection === 'desc' ? 'scaleY(-1)' : 'none',
                }}
              />
            </IconButton>
          </Tooltip>

          <Tooltip
            title={`Sort by Date: ${sortField === 'createdAt' && sortDirection === 'asc' ? 'Oldest' : 'Newest'}`}
          >
            <IconButton
              className="project-files-sort-date-button"
              variant={sortField === 'createdAt' ? 'solid' : 'outlined'}
              onClick={() => {
                if (sortField === 'createdAt') {
                  setSortDirection(sortDirection === 'desc' ? 'asc' : 'desc');
                } else {
                  setSortField('createdAt');
                  setSortDirection('desc');
                }
              }}
              sx={
                sortField === 'createdAt'
                  ? {
                      borderColor: brand[800],
                      borderWidth: 1,
                      background: brandAlpha[800][8],
                      '&:hover': {
                        borderColor: brand[800],
                        background: brandAlpha[800][12],
                      },
                    }
                  : {
                      '&:hover': {
                        background: brandAlpha[400][8],
                      },
                    }
              }
            >
              {sortField === 'createdAt' && sortDirection === 'asc' ? (
                <AccessTimeIcon sx={{ fontSize: 20, transform: 'rotate(180deg)' }} />
              ) : (
                <AccessTimeIcon sx={{ fontSize: 20 }} />
              )}
            </IconButton>
          </Tooltip>

          <input
            type="file"
            className="project-files-file-input"
            ref={fileInputRef}
            onChange={handleFileInputChange}
            style={{ display: 'none' }}
            multiple
          />

          <Divider orientation="vertical" sx={{ height: '40px', mx: '8px' }} />

          <Tooltip title="Refresh">
            <IconButton
              className="project-files-refresh-button"
              variant="outlined"
              onClick={handleProjectRefresh}
              disabled={isRefreshing || !onRefresh}
              data-testid="refresh-files-btn"
              sx={{
                '&:hover': {
                  background: 'rgba(51, 95, 112, 0.08)',
                },
              }}
            >
              {isRefreshing ? <CircularProgress size="sm" /> : <RefreshIcon sx={{ fontSize: 20 }} />}
            </IconButton>
          </Tooltip>

          <IconButton
            className="project-files-upload-button"
            variant="outlined"
            color="primary"
            onClick={() => fileInputRef.current?.click()}
            sx={theme => ({
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'center',
              padding: '4px 16px',
              borderRadius: '8px',
              gap: '8px',
              color: theme.palette.text.primary,
            })}
          >
            <UploadFileIcon className="project-files-upload-icon" sx={{ fontSize: '18px', color: 'text.primary' }} />
            <Typography className="project-files-upload-text" level="body-sm" sx={{ color: 'text.primary' }}>
              {t('files.upload')}
            </Typography>
          </IconButton>

          <IconButton
            className="project-files-browser-button"
            data-testid="project-file-browser-btn"
            variant="outlined"
            color="primary"
            onClick={() => fileBrowserRef.current?.handleOpen()}
            sx={theme => ({
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'center',
              padding: '4px 16px',
              borderRadius: '8px',
              gap: '8px',
              color: theme.palette.text.primary,
            })}
          >
            <FolderSharedIcon className="project-files-browser-icon" sx={{ fontSize: '18px', color: 'text.primary' }} />
            <Typography className="project-files-browser-text" level="body-sm" sx={{ color: 'text.primary' }}>
              {t('files.long_title')}
            </Typography>
          </IconButton>
        </Box>
        {isLoading ? (
          <Box
            className="project-files-loading-container"
            flexGrow={1}
            mb="100px"
            display="flex"
            justifyContent="center"
            alignItems="center"
          >
            <CircularProgress className="project-files-loading-spinner" />
          </Box>
        ) : (
          <Stack
            className="project-files-list"
            flexGrow={1}
            sx={{
              overflow: 'auto',
              gap: '10px',
              ml: '20px',
              pr: '16px',
              pb: '50px',
              position: 'relative',
              borderRadius: 'md',
              transition: 'all 0.3s',
            }}
            onDragEnter={handleDragEnter}
            onDragLeave={handleDragLeave}
            onDragOver={handleDragOver}
            onDrop={handleDrop}
          >
            {isDragging && (
              <Box
                className="project-files-drag-overlay"
                sx={{
                  position: 'absolute',
                  top: 0,
                  left: 0,
                  right: 0,
                  bottom: 0,
                  display: 'flex',
                  alignItems: 'center',
                  justifyContent: 'center',
                  bgcolor: 'action.hover',
                  zIndex: 1000,
                  borderRadius: 'inherit',
                }}
              >
                <Typography className="project-files-drag-text" level="h4" sx={{ color: 'primary.main' }}>
                  {t('file_browser.drop_files_here')}
                </Typography>
              </Box>
            )}
            {filteredFiles.length > 0 ? (
              filteredFiles.map((file: IFabFileDocument) => (
                <ProjectFile key={file.id} file={file} onRemove={() => handleRemoveFile(file.id)} />
              ))
            ) : (
              <Box
                className="project-files-empty-state"
                display="flex"
                justifyContent="center"
                alignItems="center"
                py={4}
              >
                <Typography className="project-files-empty-text" level="body-lg" color="neutral">
                  {isDragging
                    ? t('file_browser.drop_files_here')
                    : `No files found. ${search ? 'Try adjusting your search.' : ''}`}
                </Typography>
              </Box>
            )}
          </Stack>
        )}
      </Stack>

      <EmbeddedFileBrowser
        ref={fileBrowserRef}
        onAdd={handleBulkAdd}
        onDelete={handleRemoveFiles}
        addedFileIds={projectFileIds}
        addButtonLabelKey="file_browser.add_files_to_project"
      />
    </>
  );
};

export { ProjectFiles };

// Export a default component for backwards compatibility
const ProjectFilesWrapper: FC<{
  projectId: string;
  files: IFabFileDocument[];
  isLoading: boolean;
  isFetching: boolean;
  onRefresh?: () => Promise<void>;
}> = props => {
  return <ProjectFiles {...props} />;
};

export default ProjectFilesWrapper;

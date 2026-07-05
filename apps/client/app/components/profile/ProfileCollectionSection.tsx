import { CollectionType, KnowledgeType } from '@bike4mind/common';
import { CreateFabFileRequestInputType } from '@bike4mind/common';
import { brand, blackAlpha } from '../../utils/themes/colors';
import { createFabFileOnServerWithUpload } from '@client/app/utils/filesAPICalls';
import { useKnowledgeModal } from '@client/app/components/Knowledge/KnowledgeModal';
import SectionContainer from '@client/app/components/ProfileModal/SectionContainer';
import { useGetUserCollections } from '@client/app/hooks/data/user';
import { useDebounceValue } from '@client/app/hooks/useDebouncedValue';
import SearchBar from '@client/app/components/Session/SearchBar';
import {
  Box,
  Button,
  IconButton,
  LinearProgress,
  Modal,
  ModalClose,
  ModalDialog,
  Option,
  Select,
  SelectStaticProps,
  Tooltip,
  CircularProgress,
} from '@mui/joy';
import { ContentCopy as ContentCopyIcon, Download as DownloadIcon, Save as SaveIcon } from '@mui/icons-material';
import dayjs from 'dayjs';
import relativeTime from 'dayjs/plugin/relativeTime';
import { TFunction } from 'i18next';
import PsychologyIcon from '@mui/icons-material/Psychology';
import KeyboardArrowLeftIcon from '@mui/icons-material/KeyboardArrowLeft';
import KeyboardArrowRightIcon from '@mui/icons-material/KeyboardArrowRight';
import FolderIcon from '@mui/icons-material/Folder';
import ImageOutlinedIcon from '@mui/icons-material/ImageOutlined';
import EditNoteIcon from '@mui/icons-material/EditNote';
import CloseIcon from '@mui/icons-material/Close';
import { useNavigate } from '@tanstack/react-router';
import { ReactNode, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { toast } from 'sonner';

dayjs.extend(relativeTime);

const getCollectionTypeName = (type: CollectionType, t: TFunction) => {
  switch (type) {
    case CollectionType.NOTEBOOK:
      return t('llm.session');
    case CollectionType.KNOWLEDGE:
      return t('file');
    case CollectionType.PROJECT:
      return t('projects.title');
    case CollectionType.AI_IMAGE:
      return t('llm.ai_image');
    default:
      return 'Unknown';
  }
};

const getCollectionTypeIcon = (type: CollectionType): ReactNode => {
  switch (type) {
    case CollectionType.NOTEBOOK:
      return <EditNoteIcon sx={{ color: brand[800] }} />;
    case CollectionType.KNOWLEDGE:
      return <PsychologyIcon sx={{ color: brand[800] }} />;
    case CollectionType.PROJECT:
      return <FolderIcon sx={{ color: brand[800] }} />;
    case CollectionType.AI_IMAGE:
      return <ImageOutlinedIcon sx={{ color: brand[800] }} />;
    default:
      return null;
  }
};

const isLocalDev = () => {
  return window.location.hostname === 'localhost' || window.location.hostname === '127.0.0.1';
};

const ProfileCollectionSection = ({ userId }: { userId: string }) => {
  const [page, setPage] = useState(1);
  const [type, setType] = useState<CollectionType | null>(null);
  const [selectedImage, setSelectedImage] = useState<string | null>(null);
  const [copying, setCopying] = useState<boolean>(false);
  const [saving, setSaving] = useState<boolean>(false);
  const [downloading, setDownloading] = useState<boolean>(false);
  const action: SelectStaticProps['action'] = useRef(null);
  const { debouncedValue: debouncedSearch, setValue: setSearch } = useDebounceValue('');
  const collections = useGetUserCollections(userId, {
    page,
    search: debouncedSearch,
    type,
  });
  const navigate = useNavigate();
  const { setOpen, setSelectedFabFileId, setViewOnly } = useKnowledgeModal();
  const { t } = useTranslation();

  const hasPreviousPage = collections.data?.meta ? collections.data.meta.currentPage > 1 : false;
  const hasNextPage = collections.data?.meta
    ? collections.data.meta.currentPage < collections.data.meta.totalPages
    : false;

  const handleImageError = () => {
    console.error('Failed to load image:', selectedImage);
  };

  const handleSaveImage = async () => {
    setSaving(true);
    try {
      // CORS Workaround for local development
      if (isLocalDev()) {
        window.open(selectedImage || '', '_blank');
        toast.success('Image opened in a new tab. Right-click and select "Save Image As..." to save it.');
        setSaving(false);
        return;
      }

      const response = await fetch(selectedImage || '');
      const blob = await response.blob();

      const filename = selectedImage?.split('/').pop() || 'image.png';
      const file = new File([blob], filename, { type: blob.type });

      const formData: CreateFabFileRequestInputType = {
        type: KnowledgeType.FILE,
        fileName: filename,
        mimeType: blob.type,
        fileSize: blob.size,
      };
      await createFabFileOnServerWithUpload(formData, file);

      toast.success('Image saved successfully as FabFile');
    } catch (error) {
      console.error('Failed to save image as FabFile: ', error);
      toast.error('Failed to save image as FabFile');
    } finally {
      setSaving(false);
    }
  };

  const handleCopyImage = async () => {
    setCopying(true);
    try {
      // CORS Workaround for local development
      if (isLocalDev()) {
        window.open(selectedImage || '', '_blank');
        toast.success('Image opened in a new tab. Right-click and select "Copy Image" to copy it.');
        setCopying(false);
        return;
      }

      const response = await fetch(selectedImage || '');
      const blob = await response.blob();
      await navigator.clipboard.write([
        new ClipboardItem({
          [blob.type]: blob,
        }),
      ]);
      toast.success('Image copied to clipboard');
    } catch (error) {
      console.error('Failed to copy image: ', error);
      toast.error('Failed to copy image');
    } finally {
      setCopying(false);
    }
  };

  const handleDownloadImage = async () => {
    setDownloading(true);
    try {
      // CORS Workaround for local development
      if (isLocalDev()) {
        window.open(selectedImage || '', '_blank');
        toast.success('Image opened in a new tab. Right-click and select "Save As..." to download it.');
        setDownloading(false);
        return;
      }

      const response = await fetch(selectedImage || '');
      const blob = await response.blob();
      const url = window.URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      const filename = selectedImage?.split('/').pop() || 'image.png';
      a.download = filename;
      a.click();
    } catch (error) {
      console.error('Failed to download image: ', error);
      toast.error('Failed to download image');
    } finally {
      setDownloading(false);
    }
  };

  const imageActions = (
    <>
      <Tooltip title="Save Image">
        <IconButton title="Save image" onClick={handleSaveImage}>
          {saving ? <CircularProgress /> : <SaveIcon />}
        </IconButton>
      </Tooltip>

      <Tooltip title="Copy Image">
        <IconButton title="Copy image" onClick={handleCopyImage}>
          {copying ? <CircularProgress /> : <ContentCopyIcon />}
        </IconButton>
      </Tooltip>

      <Tooltip title="Download Image">
        <IconButton title="Download image" onClick={handleDownloadImage}>
          {downloading ? <CircularProgress /> : <DownloadIcon />}
        </IconButton>
      </Tooltip>
    </>
  );

  return (
    <SectionContainer
      title={t('profile.collection')}
      titleActionStyles={{
        sx: {
          flexDirection: {
            xs: 'column',
            sm: 'row',
          },
          gap: {
            xs: '10px',
            sm: '20px',
          },
        },
      }}
      action={
        <Box
          className="profile-collection-section-filters"
          sx={{
            flexDirection: {
              xs: 'column',
              sm: 'row',
            },
            gap: {
              xs: '10px',
              sm: '20px',
            },
            display: 'flex',
          }}
        >
          <Select
            data-testid="profile-collection-type-filter"
            className="profile-collection-section-type-select"
            action={action}
            value={type}
            placeholder={t('profile.collections.all_types')}
            onChange={(e, value) => {
              setType(value);
              // Reset to first page when type changes
              setPage(1);
            }}
            {...(type && {
              // display the button and remove select indicator
              // when user has selected a value
              endDecorator: (
                <IconButton
                  className="profile-collection-section-type-clear"
                  size="sm"
                  variant="plain"
                  color="neutral"
                  onMouseDown={event => {
                    // don't open the popup when clicking on this button
                    event.stopPropagation();
                  }}
                  onClick={() => {
                    setType(null);
                    action.current?.focusVisible();
                  }}
                >
                  <CloseIcon />
                </IconButton>
              ),
              indicator: null,
            })}
            sx={{ minWidth: '140px' }}
          >
            <Option value={CollectionType.NOTEBOOK}>Notebooks</Option>
            <Option value={CollectionType.KNOWLEDGE}>Knowledge</Option>
            <Option value={CollectionType.PROJECT}>Projects</Option>
            <Option value={CollectionType.AI_IMAGE}>AI Images</Option>
          </Select>
          <SearchBar
            data-testid="profile-collection-search-input"
            className="profile-collection-section-search"
            handleChange={setSearch}
            placeHolder={t('search')}
            debounceTimeout={300}
            sx={theme => ({
              boxShadow: 'none',
              border: `1px solid ${theme.palette.border.input}`,
              background: theme.palette.searchbar.background,
            })}
          />
        </Box>
      }
    >
      <Box
        className="profile-collection-section-content"
        sx={{ display: 'flex', flexDirection: 'column', gap: '10px', marginTop: '15px' }}
      >
        {collections.isFetching && <LinearProgress className="profile-collection-section-loading" />}

        {collections.data?.data?.map(collection => (
          <Button
            data-testid="profile-collection-item"
            className="profile-collection-section-item"
            key={collection.id}
            variant="soft"
            sx={theme => ({
              fontWeight: theme.fontWeight.sm,
              display: 'flex',
              justifyContent: 'space-between',
              alignItems: 'center',
              backgroundColor: theme.palette.background.body,
              border: theme.palette.profile.border,
              borderRadius: '10px',
              padding: '10px 20px',
            })}
            onClick={() => {
              switch (collection.type) {
                case CollectionType.NOTEBOOK:
                  navigate({ to: `/notebooks/${collection.id}` });
                  break;
                case CollectionType.KNOWLEDGE:
                  setSelectedFabFileId(collection.id);
                  setViewOnly(false);
                  setOpen(true);
                  break;
                case CollectionType.PROJECT:
                  navigate({ to: `/projects/${collection.id}` });
                  break;
                case CollectionType.AI_IMAGE:
                  // Open image in modal if imageUrl exists
                  if (collection.imageUrl) {
                    setSelectedImage(collection.imageUrl);
                  }
                  break;
              }
            }}
          >
            <Box
              className="profile-collection-section-item-content"
              sx={theme => ({
                display: 'grid',
                gridTemplateColumns: '120px 1px 1fr auto',
                gap: {
                  xs: '10px',
                  sm: '20px',
                },
                alignItems: 'center',
                width: '100%',
              })}
            >
              <Box
                className="profile-collection-section-item-type"
                sx={{ display: 'flex', gap: '8px', alignItems: 'center', flexShrink: 0 }}
              >
                {getCollectionTypeIcon(collection.type)}
                <Box
                  component="span"
                  sx={theme => ({ fontSize: theme.fontSize.sm, color: theme.palette.text.tertiary })}
                >
                  {getCollectionTypeName(collection.type, t)}
                </Box>
              </Box>

              <Box
                className="profile-collection-section-item-divider"
                sx={theme => ({ height: '32px', width: '1px', backgroundColor: theme.palette.divider })}
              />

              <Tooltip
                className="profile-collection-section-item-name-tooltip"
                title={collection.name}
                enterDelay={1000}
                sx={{
                  maxWidth: 300,
                  fontSize: '0.875rem',
                }}
              >
                <Box
                  className="profile-collection-section-item-name"
                  component="span"
                  sx={{
                    overflow: 'hidden',
                    textOverflow: 'ellipsis',
                    whiteSpace: 'nowrap',
                    width: '100%',
                    display: 'block',
                    textAlign: 'left',
                  }}
                >
                  {collection.name}
                </Box>
              </Tooltip>

              <Box
                className="profile-collection-section-item-updated"
                sx={theme => ({
                  fontSize: theme.fontSize.sm,
                  color: theme.palette.text.tertiary,
                  flexShrink: 0,
                  display: 'flex',
                  alignItems: 'center',
                })}
              >
                Updated {dayjs(collection.updatedAt).fromNow()}
              </Box>
            </Box>
          </Button>
        ))}

        {/* Image Modal */}
        <Modal
          className="profile-collection-section-image-modal"
          open={!!selectedImage}
          onClose={() => setSelectedImage(null)}
        >
          <ModalDialog
            className="profile-collection-section-image-dialog"
            sx={{
              minWidth: '90vw',
              minHeight: '90vh',
              display: 'flex',
              flexDirection: 'column',
              gap: 2,
              padding: '20px',
            }}
          >
            <Box
              className="profile-collection-section-image-actions"
              sx={{ zIndex: 1, display: 'flex', justifyContent: 'end', gap: '.5rem', paddingRight: '2rem' }}
            >
              {imageActions}
            </Box>
            <ModalClose className="profile-collection-section-image-close" />
            <Box
              className="profile-collection-section-image-container"
              sx={{
                display: 'flex',
                justifyContent: 'center',
                alignItems: 'center',
                width: '100%',
                height: '100%',
                backgroundColor: blackAlpha[0][50],
                borderRadius: '10px',
                overflow: 'hidden',
              }}
            >
              {selectedImage && (
                <Box
                  className="profile-collection-section-image-wrapper"
                  sx={{
                    position: 'relative',
                    width: '100%',
                    height: '100%',
                    display: 'flex',
                    justifyContent: 'center',
                    alignItems: 'center',
                  }}
                >
                  {}
                  <img
                    className="profile-collection-section-image"
                    src={selectedImage}
                    alt="Generated image"
                    onError={handleImageError}
                    style={{
                      maxWidth: '100%',
                      maxHeight: '100%',
                      objectFit: 'contain',
                      width: 'auto',
                      height: 'auto',
                    }}
                  />
                </Box>
              )}
            </Box>
          </ModalDialog>
        </Modal>

        {/* Pagination. Previous and Next button with some available page numbers */}
        <Box
          data-testid="profile-collection-pagination"
          className="profile-collection-section-pagination"
          sx={{ alignSelf: 'end', display: 'flex', gap: '10px', marginTop: '10px' }}
        >
          <IconButton
            className="profile-collection-section-pagination-prev"
            disabled={!hasPreviousPage}
            onClick={() => setPage(page - 1)}
          >
            <KeyboardArrowLeftIcon />
          </IconButton>

          {collections.data?.meta ? (
            <>
              {(() => {
                const totalPages = collections.data.meta.totalPages;
                const currentPage = collections.data.meta.currentPage;
                let pagesToShow: number[] = [];

                if (totalPages <= 5) {
                  // Show all pages if total is 5 or less
                  pagesToShow = Array.from({ length: totalPages }, (_, i) => i + 1);
                } else {
                  // Always show first page
                  pagesToShow = [1];

                  // Add ellipsis after first page if needed
                  if (currentPage > 3) {
                    pagesToShow.push(-1);
                  }

                  // Add pages around current page
                  for (let i = Math.max(2, currentPage - 1); i <= Math.min(totalPages - 1, currentPage + 1); i++) {
                    pagesToShow.push(i);
                  }

                  // Add ellipsis before last page if needed
                  if (currentPage < totalPages - 2) {
                    pagesToShow.push(-1);
                  }

                  // Always show last page
                  pagesToShow.push(totalPages);
                }

                return pagesToShow.map(page =>
                  page === -1 ? (
                    <Box key={`ellipsis-${page}`} sx={{ alignSelf: 'center' }}>
                      ...
                    </Box>
                  ) : (
                    <IconButton
                      key={page}
                      variant={page === currentPage ? 'solid' : 'plain'}
                      color={page === currentPage ? 'primary' : 'neutral'}
                      onClick={() => setPage(page)}
                    >
                      {page}
                    </IconButton>
                  )
                );
              })()}
            </>
          ) : null}

          <IconButton
            className="profile-collection-section-pagination-next"
            disabled={!hasNextPage}
            onClick={() => setPage(page + 1)}
          >
            <KeyboardArrowRightIcon />
          </IconButton>
        </Box>
      </Box>
    </SectionContainer>
  );
};
export default ProfileCollectionSection;

import {
  IFabFileDocument,
  IFileTag,
  isImageServeable,
  KnowledgeType,
  SupportedFabFileMimeTypes,
} from '@bike4mind/common';
import { useUpdateFabFile } from '@client/app/hooks/data/fabFiles';
import { ImageModerationPlaceholder } from '@client/app/components/Session/ImageModerationPlaceholder';
import { Description } from '@mui/icons-material';
import ArticleIcon from '@mui/icons-material/Article';
import CodeIcon from '@mui/icons-material/Code';
import DashboardIcon from '@mui/icons-material/Dashboard';
import DataObjectIcon from '@mui/icons-material/DataObject';
import ImageIcon from '@mui/icons-material/Image';
import InsertDriveFileIcon from '@mui/icons-material/InsertDriveFile';
import PictureAsPdfIcon from '@mui/icons-material/PictureAsPdf';
import SlideshowIcon from '@mui/icons-material/Slideshow';
import TableChartIcon from '@mui/icons-material/TableChart';
import TagIcon from '@mui/icons-material/Tag';
import TextSnippetIcon from '@mui/icons-material/TextSnippet';
import SegmentIcon from '@mui/icons-material/Segment';
import WarningIcon from '@mui/icons-material/Warning';
import { Box, Card, Chip, CircularProgress, Grid, IconButton, Input, Stack, Tooltip, Typography } from '@mui/joy';
import dayjs from 'dayjs';
import CheckIcon from '@mui/icons-material/Check';
import CloseIcon from '@mui/icons-material/Close';
import React, { FC, useEffect, useState } from 'react';
import { toast } from 'sonner';
import { brand, brandAlpha, green, greenAlpha, orange, red } from '@client/app/utils/themes/colors';
import { useFileBrowserInstance } from './instanceContext';
import FileBrowserItemActions from './ItemActions';
import UsernameText from '@client/app/components/common/UsernameText';
import { useUser } from '@client/app/contexts/UserContext';

const ImageThumbnail: FC<{ url: string; fileName: string; size: number }> = ({ url, fileName, size }) => {
  const [error, setError] = useState(false);
  if (error) return <ImageIcon sx={{ fontSize: size }} />;
  return (
    <Box
      component="img"
      src={url}
      alt={fileName}
      loading="lazy"
      sx={{ width: size, height: size, objectFit: 'cover', borderRadius: '4px' }}
      onError={() => setError(true)}
    />
  );
};

export const getFileIcon = (file: IFabFileDocument, size: number = 48) => {
  if (file.mimeType?.startsWith('image/')) {
    // Content-moderation gating: a blocked image never gets a serveable URL;
    // a pending (not-yet-clean) image may briefly have one cached but must not
    // be shown until the scan completes.
    if (file.moderationStatus === 'blocked') {
      return <ImageModerationPlaceholder status="blocked" size={size} />;
    }
    if (!isImageServeable(file)) {
      return <ImageModerationPlaceholder status="scanning" size={size} />;
    }

    const imageUrl = file.fileUrl || file.presignedUrl;
    if (imageUrl) return <ImageThumbnail url={imageUrl} fileName={file.fileName} size={size} />;
    return <ImageIcon sx={{ fontSize: size }} />;
  }

  const IconComponent =
    file.type === KnowledgeType.URL
      ? InsertDriveFileIcon
      : (
          {
            // Documents
            [SupportedFabFileMimeTypes.PDF]: PictureAsPdfIcon,
            [SupportedFabFileMimeTypes.DOCX]: TextSnippetIcon,
            [SupportedFabFileMimeTypes.PPTX]: SlideshowIcon,
            [SupportedFabFileMimeTypes.XLS]: TableChartIcon,
            [SupportedFabFileMimeTypes.XLSX]: TableChartIcon,
            // Text / markup
            [SupportedFabFileMimeTypes.TXT_PLAIN]: ArticleIcon,
            [SupportedFabFileMimeTypes.TXT_MARKDOWN]: DashboardIcon,
            [SupportedFabFileMimeTypes.TXT_MD_LEGACY]: DashboardIcon,
            [SupportedFabFileMimeTypes.HTML]: CodeIcon,
            [SupportedFabFileMimeTypes.XML]: TagIcon,
            // Data
            [SupportedFabFileMimeTypes.JSON]: Description,
            [SupportedFabFileMimeTypes.CSV]: DataObjectIcon,
            [SupportedFabFileMimeTypes.YAML]: DataObjectIcon,
            [SupportedFabFileMimeTypes.TOML]: DataObjectIcon,
          } as Record<string, React.ElementType>
        )[file.mimeType] || InsertDriveFileIcon;

  return <IconComponent sx={{ fontSize: size }} />;
};

interface IFileBrowserItemProps {
  file: IFabFileDocument;
  viewType: 'list' | 'grid';
  tags?: IFileTag[];
}

interface StatusIconsProps {
  fileError?: string | null;
  isVectorizing?: boolean;
  vectorized?: boolean;
  chunked?: boolean;
  isChunking?: boolean;
}

const StatusIcons: FC<StatusIconsProps> = ({ fileError, isVectorizing, vectorized, chunked, isChunking }) => {
  if (fileError) {
    return (
      <Box sx={{ height: 20, display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
        <Tooltip title={fileError}>
          <WarningIcon sx={{ fontSize: 16, color: red[400], opacity: 0.9, verticalAlign: 'middle' }} />
        </Tooltip>
      </Box>
    );
  }
  if (isVectorizing || vectorized) {
    return (
      <Tooltip title="Vectorized">
        <Box
          sx={theme => ({
            height: '24px',
            minWidth: '24px',
            maxWidth: '120px',
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            bgcolor: theme.palette.fileBrowser.statusChip.backgroundColor,
            border: `1px solid ${theme.palette.fileBrowser.statusChip.borderColor}`,
            borderRadius: '12px',
            padding: '0 8px',
          })}
        >
          <SegmentIcon
            sx={(theme: any) => ({
              fontSize: 14,
              color: theme.palette.fileBrowser.statusChip.textColor,
              opacity: 0.9,
            })}
          />
        </Box>
      </Tooltip>
    );
  }
  if (!chunked) {
    return (
      <Chip
        size="sm"
        variant="soft"
        sx={theme => ({
          bgcolor: theme.palette.fileBrowser.statusChip.backgroundColor,
          color: theme.palette.fileBrowser.statusChip.textColor,
          fontSize: '13px',
          height: '24px',
          maxWidth: '120px',
          border: `1px solid ${theme.palette.fileBrowser.statusChip.borderColor}`,
        })}
      >
        Raw
      </Chip>
    );
  }
  if (chunked) {
    return (
      <Box sx={{ height: 20, display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
        <Tooltip title={isChunking && !chunked ? 'Chunking…' : 'Chunked'}>
          <CheckIcon
            sx={{
              fontSize: 16,
              color: isChunking && !chunked ? orange[430] : green[500],
              opacity: 0.9,
              verticalAlign: 'middle',
            }}
          />
        </Tooltip>
      </Box>
    );
  }
  return null;
};

const FileBrowserItem: FC<IFileBrowserItemProps> = ({ viewType = 'grid', ...rest }) => {
  return viewType === 'list' ? <ListItem {...rest} /> : <GridItem {...rest} />;
};

const useCommon = (file: IFabFileDocument) => {
  const { selectedIds, setSelectedIds, config } = useFileBrowserInstance();
  const selected = selectedIds.has(file.id);
  const isAdded = config.addedFileIds?.has(file.id) ?? false;
  const [editMode, setEditMode] = useState(false);

  function handleClick() {
    if (selected) {
      selectedIds.delete(file.id);
    } else {
      selectedIds.add(file.id);
    }

    setSelectedIds(new Set(selectedIds.values()));
  }

  return {
    selected,
    isAdded,
    editMode,
    setEditMode,
    handleClick,
  };
};

const AddedBadge: FC = () => (
  <Chip
    data-testid="file-browser-item-added-badge"
    size="sm"
    variant="soft"
    startDecorator={<CheckIcon sx={{ fontSize: 12 }} />}
    sx={{
      bgcolor: greenAlpha[800][20],
      color: green[800],
      fontSize: { xs: '11px', md: '13px' },
      height: { xs: '20px', md: '24px' },
      border: `1px solid ${green[800]}`,
    }}
  >
    Added
  </Chip>
);

const isImageFile = (filename: string) => {
  const imageExtensions = ['.jpg', '.jpeg', '.png', '.gif', '.webp', '.svg', '.bmp'];
  return imageExtensions.some(ext => filename.toLowerCase().endsWith(ext));
};

const ListItem: FC<Omit<IFileBrowserItemProps, 'viewType'>> = ({ file, tags = [] }) => {
  const { fileName, fileSize, createdAt, chunked, vectorized, isChunking, isVectorizing } = file;
  const { selected, isAdded, editMode, setEditMode, handleClick } = useCommon(file);
  const icon = getFileIcon(file, 20);
  const { currentUser } = useUser();
  const sharedUsersList = file.users ?? [];
  const isSharedToMe = currentUser != null && file.userId !== currentUser.id;

  const [localPrimaryTag, setLocalPrimaryTag] = useState<string | null | undefined>(file.primaryTag || null);

  useEffect(() => {
    setLocalPrimaryTag(file.primaryTag || null);
  }, [file.primaryTag]);

  const primaryTagName = localPrimaryTag || undefined;
  const primaryTag =
    (primaryTagName && tags?.find(t => t.name.toLowerCase() === primaryTagName.toLowerCase())) || undefined;
  const primaryColor = primaryTag?.color || brand[400];

  return (
    <Box
      data-testid="file-browser-list-item"
      sx={theme => ({
        // Mobile: flex layout for better space management
        py: { xs: '8px', md: '6px' },
        px: { xs: '8px', md: '8px' },
        display: { xs: 'flex', md: 'grid' },
        // Desktop: grid layout (original)
        flexDirection: { xs: 'row', md: 'unset' },
        alignItems: { xs: 'flex-start', md: 'center' },
        gap: { xs: '8px', md: '0px' },
        gridTemplateColumns: {
          md: '52px 60px 1fr 300px 32px',
        },
        backgroundColor: primaryTag ? `${primaryColor}10` : theme.palette.fileBrowser.item.background,
        borderRadius: '8px',
        border: selected
          ? `1px solid ${greenAlpha[800][50]}`
          : primaryTag
            ? `1px solid ${primaryColor}`
            : '1px solid var(--joy-palette-border-light)',
        ...(selected && {
          background: `linear-gradient(${greenAlpha[800][5]}, ${greenAlpha[800][5]}), ${theme.palette.fileBrowser.item.background}`,
        }),
        minHeight: { xs: 'auto', md: '64px' },
        cursor: 'pointer',
        transition: 'all 0.2s ease',

        // Override MUI defaults
        '&:hover': {
          bgcolor: selected ? 'fileBrowser.list.activeHoverBackgroundColor' : theme.palette.notebooklist.hoverBg,
        },
      })}
      onClick={handleClick}
    >
      {/* Checkbox Column */}
      <Box
        className="file-browser-list-item-checkbox-container"
        sx={{
          display: { xs: 'none', sm: 'flex' },
          alignItems: { xs: 'flex-start', md: 'center' },
          justifyContent: 'center',
          width: { xs: '24px', md: '48px' },
          height: { xs: '24px', md: '24px' },
          flexShrink: 0,
          mt: 0,
        }}
      >
        <Box
          sx={theme => ({
            display: 'flex',
            alignItems: 'center',
            width: { xs: '20px', md: '24px' },
            height: { xs: '20px', md: '24px' },
            bgcolor: selected ? greenAlpha[800][20] : 'transparent',
            border: selected ? `1px solid ${green[800]}` : `1px solid ${theme.palette.border.solid}`,
            justifyContent: 'center',
            borderRadius: '3px',
            transition: 'all 0.2s ease',
          })}
        >
          {selected && <CheckIcon sx={{ fontSize: 12, color: green[800] }} />}
        </Box>
      </Box>

      {/* Icon/Tag Column */}
      <Box
        className="file-browser-list-item-icon-container"
        sx={(theme: any) => ({
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
          width: { xs: '40px', md: '40px' },
          height: { xs: '40px', md: '40px' },
          borderRadius: '6px',
          position: 'relative',
          backgroundColor: brandAlpha[400][5],
          overflow: 'hidden',
          flexShrink: 0,
          '& svg': {
            color: theme.palette.fileBrowser.fileSizeColor,
            fontSize: { xs: '18px', md: '20px' },
          },
        })}
      >
        {isImageFile(fileName) ? (
          isImageServeable(file) && (file.fileUrl || file.presignedUrl) ? (
            <Box
              component="img"
              src={file.fileUrl || file.presignedUrl}
              alt={fileName}
              sx={{
                width: '100%',
                height: '100%',
                objectFit: 'cover',
                borderRadius: '6px',
              }}
              onError={e => {
                // Hide broken image on error
                const target = e.target as HTMLElement;
                target.style.display = 'none';
              }}
            />
          ) : (
            icon
          )
        ) : (
          icon
        )}
      </Box>

      {/* Filename Column */}
      <Box
        sx={{
          flex: { xs: 1, md: 'unset' },
          width: { xs: 'auto', md: '100%' },
          display: 'flex',
          flexDirection: { xs: 'column', md: 'row' },
          alignItems: 'flex-start',
          gap: { xs: '4px', md: '8px' },
          minWidth: 0,
        }}
      >
        {/* Filename and mobile info wrapper */}
        <Box
          sx={{
            display: 'flex',
            flexDirection: { xs: 'column', md: 'row' },
            alignItems: { xs: 'flex-start', md: 'center' },
            gap: { xs: '4px', md: '8px' },
          }}
        >
          {/* Filename - let it size naturally */}
          <ToggleRename file={file} editMode={editMode} setEditMode={setEditMode}>
            <Typography
              data-testid="file-browser-item-name"
              level="body-sm"
              sx={{
                fontWeight: 400,
                fontSize: { xs: '15px', md: '16px' },
                color: 'text.primary',
                lineHeight: { xs: '1.4', md: '1.2' },

                // Number of lines
                overflow: 'hidden',
                display: '-webkit-box',
                WebkitLineClamp: { xs: 1, md: 2 },
                WebkitBoxOrient: 'vertical',
                maxWidth: { xs: '100%', md: '400px' },
                wordBreak: 'break-all',
              }}
            >
              {fileName}
            </Typography>
          </ToggleRename>

          {/* Mobile: Show file info below filename */}
          <Box
            sx={{
              display: { xs: 'flex', md: 'none' },
              alignItems: 'center',
              gap: '6px',
              fontSize: '12px',
              color: 'fileBrowser.lightTextColor',
              flexWrap: 'wrap',
              width: '100%',
            }}
          >
            <Typography level="body-xs" sx={{ fontSize: '12px' }}>
              {Math.round(fileSize / 1024)} KB
            </Typography>
            <Typography level="body-xs" sx={{ fontSize: '12px' }}>
              •
            </Typography>
            <Typography level="body-xs" sx={{ fontSize: '12px' }}>
              {dayjs(createdAt).format('MMM D, YYYY')}
            </Typography>
          </Box>
        </Box>

        {/* Tags and status - positioned immediately after the text */}
        <Box
          sx={{
            display: 'flex',
            alignItems: 'center',
            gap: { xs: '4px', md: '8px' },
            flex: '0 0 auto',
            flexWrap: 'wrap',
            width: { xs: '100%', md: 'auto' },
          }}
        >
          {/* Show additional tags as small chips if more than one */}
          {tags && tags.length > 0 && (
            <Box sx={{ display: 'flex', gap: { xs: '4px', md: '8px' }, pointerEvents: 'none' }}>
              {tags.slice(0, 6).map(tag => {
                const isPrimary = primaryTagName && tag.name.toLowerCase() === primaryTagName.toLowerCase();
                return (
                  <Chip
                    key={tag.name}
                    size="sm"
                    variant="soft"
                    title={tag.name}
                    sx={{
                      bgcolor: `${tag.color}20`,
                      color: tag.color,
                      fontSize: { xs: '11px', md: '13px' },
                      height: { xs: '20px', md: '24px' },
                      maxWidth: { xs: '80px', md: '120px' },
                      border: `1px solid ${tag.color}`,
                      fontWeight: isPrimary ? 600 : 400,
                    }}
                  >
                    {isPrimary ? '★ ' : ''}
                    {tag.name}
                  </Chip>
                );
              })}
            </Box>
          )}

          <StatusIcons
            fileError={file.error}
            isVectorizing={isVectorizing}
            vectorized={vectorized}
            chunked={chunked}
            isChunking={isChunking}
          />

          {isAdded && <AddedBadge />}

          {tags.length - 6 > 0 && (
            <Chip
              size="sm"
              variant="soft"
              sx={{
                bgcolor: brandAlpha[400][8],
                color: brand[400],
                fontSize: { xs: '11px', md: '13px' },
                padding: '1.5px 8px',
                minWidth: 'auto',
                border: `1px solid ${brand[400]}`,
              }}
            >
              +{tags.length - 6}
            </Chip>
          )}

          {/* Owner label for shared files (List) */}
          {isSharedToMe && (
            <Chip size="sm" variant="outlined" color="neutral" sx={{ fontSize: '12px' }}>
              Owner: <UsernameText id={file.userId} useEmail />
            </Chip>
          )}

          {/* Shared recipients (List) */}
          {sharedUsersList.length > 0 && (
            <>
              {sharedUsersList.slice(0, 3).map((share: any, index: number) => (
                <UsernameText
                  key={`${share.userId}-${index}`}
                  id={share.userId as string}
                  useEmail
                  parent={props => (
                    <Chip size="sm" variant="soft" color="primary" sx={{ fontSize: '12px' }} {...props} />
                  )}
                />
              ))}
              {sharedUsersList.length - 3 > 0 && (
                <Chip size="sm" variant="soft" sx={{ fontSize: '12px' }}>
                  +{sharedUsersList.length - 3}
                </Chip>
              )}
            </>
          )}
        </Box>
      </Box>

      {/* Size and Date Column - Desktop Only */}
      <Box
        sx={{
          display: { xs: 'none', md: 'flex' },
          alignItems: 'center',
          justifyContent: 'flex-end',
          gap: { xs: '4px', md: '12px' },
          color: 'fileBrowser.lightTextColor',
          fontSize: '14px',
          fontWeight: '400',
          marginRight: { xs: 0, md: '20px' },
        }}
      >
        <Typography level="body-xs" sx={{ fontSize: '14px' }}>
          {Math.round(fileSize / 1024)} KB
        </Typography>
        <Typography level="body-xs" sx={{ fontSize: '14px' }}>
          •
        </Typography>
        <Typography level="body-xs" sx={{ fontSize: '14px', minWidth: '85px', textAlign: 'left' }}>
          {dayjs(createdAt).format('MMM D, YYYY')}
        </Typography>
      </Box>

      {/* Actions Column */}
      <Box
        sx={{
          display: 'flex',
          alignItems: { xs: 'flex-start', md: 'center' },
          justifyContent: 'flex-end',
          width: { xs: '32px', md: '32px' },
          flexShrink: 0,
        }}
      >
        <FileBrowserItemActions file={file} onRename={() => setEditMode(true)} size="sm" />
      </Box>
    </Box>
  );
};

const GridItem: FC<Omit<IFileBrowserItemProps, 'viewType'>> = ({ file, tags = [] }) => {
  const { selected, isAdded, editMode, setEditMode, handleClick } = useCommon(file);
  const icon = getFileIcon(file, 32);
  const { chunked, vectorized, isChunking, isVectorizing, fileName } = file;
  const { currentUser } = useUser();
  const sharedUsersGrid = file.users ?? [];
  const isSharedToMe = currentUser != null && file.userId !== currentUser.id;

  const [localPrimaryTag, setLocalPrimaryTag] = useState<string | null | undefined>(file.primaryTag || null);

  useEffect(() => {
    setLocalPrimaryTag(file.primaryTag || null);
  }, [file.primaryTag]);

  const primaryTagName = localPrimaryTag || undefined;
  const primaryTag =
    (primaryTagName && tags?.find(t => t.name.toLowerCase() === primaryTagName.toLowerCase())) || undefined;
  const primaryColor = primaryTag?.color || brand[400];

  return (
    <Grid
      className="file-browser-grid-item"
      component="div"
      lg={3.4}
      md={6}
      sm={12}
      xs={16}
      sx={{ p: 1, justifyContent: 'center' }}
    >
      <Card
        className="file-browser-grid-item-card"
        data-testid="file-browser-grid-item-card"
        variant="outlined"
        sx={theme => ({
          cursor: 'pointer',
          p: 2,
          display: 'flex',
          flexDirection: 'column',
          minHeight: '200px',
          height: '100%',
          borderRadius: '8px',
          backgroundColor: primaryTag ? `${primaryColor}10` : theme.palette.fileBrowser.item.background,
          border: selected
            ? `1px solid ${greenAlpha[800][50]}`
            : primaryTag
              ? `1px solid ${primaryColor}`
              : '1px solid var(--joy-palette-border-light)',
          ...(selected && {
            background: `linear-gradient(${greenAlpha[800][5]}, ${greenAlpha[800][5]}), ${theme.palette.fileBrowser.item.background}`,
          }),
          transition: 'all 0.2s ease',
          '&:hover': {
            bgcolor: selected
              ? theme.palette.fileBrowser.list.activeHoverBackgroundColor
              : theme.palette.notebooklist.hoverBg,
          },
        })}
        onClick={e => {
          e.stopPropagation();
          handleClick();
        }}
      >
        {/* Checkbox */}

        <Box
          sx={theme => ({
            display: 'flex',
            alignItems: 'center',
            width: '24px',
            height: '24px',
            bgcolor: selected ? greenAlpha[800][20] : 'transparent',
            border: selected ? `1px solid ${green[800]}` : `1px solid ${theme.palette.border.solid}`,
            justifyContent: 'center',
            borderRadius: '6px',
            transition: 'all 0.2s ease',
            position: 'absolute',
            top: '8px',
            left: '8px',
          })}
        >
          {selected && <CheckIcon sx={{ fontSize: 12, color: green[800] }} />}
        </Box>

        {/* Actions */}
        <Box sx={{ position: 'absolute', top: '5px', right: '5px' }}>
          <FileBrowserItemActions file={file} onRename={() => setEditMode(true)} size="sm" />
        </Box>

        <Stack
          className="file-browser-grid-item-content"
          direction="column"
          alignItems="center"
          justifyContent="flex-start"
          sx={{ height: '100%', flex: 1 }}
        >
          {/* Icon */}
          <Box
            className="file-browser-grid-item-icon-container"
            sx={theme => ({
              display: 'flex',
              alignItems: 'center',
              width: '50px',
              height: '50px',
              justifyContent: 'center',
              borderRadius: '5px',
              mb: '10px',
              flexShrink: 0,
              '& svg': {
                color: isImageFile(fileName) ? 'none' : theme.palette.fileBrowser.fileSizeColor,
              },
            })}
          >
            {isImageFile(fileName) ? (
              isImageServeable(file) && (file.fileUrl || file.presignedUrl) ? (
                <Box
                  component="img"
                  src={file.fileUrl || file.presignedUrl}
                  alt={fileName}
                  sx={{
                    width: '100%',
                    height: '100%',
                    objectFit: 'cover',
                    borderRadius: '6px',
                  }}
                  onError={e => {
                    // Hide broken image on error
                    const target = e.target as HTMLElement;
                    target.style.display = 'none';
                  }}
                />
              ) : (
                icon
              )
            ) : (
              icon
            )}
          </Box>

          {/* File Name */}
          <Box sx={{ flexShrink: 0, mb: 1 }}>
            {' '}
            {/* Added wrapper with flexShrink: 0 */}
            <ToggleRename file={file} editMode={editMode} setEditMode={setEditMode}>
              <Typography
                className="file-browser-grid-item-name"
                level="body-md"
                sx={{
                  textAlign: 'center',
                  px: 1,
                  maxWidth: '200px',

                  // text style
                  lineHeight: '1.2',
                  fontSize: '16px',
                  fontWeight: 400,
                  color: 'text.primary',

                  // Number of lines
                  overflow: 'hidden',
                  display: '-webkit-box',
                  WebkitLineClamp: 2,
                  WebkitBoxOrient: 'vertical',
                  wordBreak: 'break-all',
                }}
                title={file.fileName}
              >
                {file.fileName}
              </Typography>
            </ToggleRename>
          </Box>

          {/* Size and Date */}
          <Typography
            level="body-xs"
            sx={{
              color: 'text.primary',
              opacity: 0.5,
              fontSize: '14px',
              fontWeight: '400',
              lineHeight: '150%',
              textAlign: 'center',
            }}
          >
            {numberToBytes(file.fileSize)} •{' '}
            {new Date(file.createdAt).toLocaleDateString('en-US', {
              month: 'short',
              day: 'numeric',
              year: 'numeric',
            })}
          </Typography>

          {/* Owner label for shared files (Grid) */}
          {isSharedToMe && (
            <Typography
              level="body-xs"
              sx={{
                color: 'text.tertiary',
                fontSize: '12px',
                textAlign: 'center',
                mt: 0.5,
              }}
            >
              Owner: <UsernameText id={file.userId} useEmail />
            </Typography>
          )}

          {/* Show additional tags as small chips if more than one */}
          <Box
            sx={{
              display: 'flex',
              justifyContent: 'flex-start',
              alignItems: 'center',
              flexWrap: 'wrap',
              maxWidth: '100%',
              gap: '8px',
              pt: '20px',
              flexDirection: 'column',
              flex: 1,
              pointerEvents: 'none',
            }}
          >
            {tags &&
              tags.length > 0 &&
              tags.slice(0, 6).map(tag => {
                const isPrimary = primaryTagName && tag.name.toLowerCase() === primaryTagName.toLowerCase();
                return (
                  <Chip
                    key={tag.name}
                    size="sm"
                    variant="soft"
                    title={tag.name}
                    sx={{
                      bgcolor: `${tag.color}20`,
                      color: tag.color,
                      fontSize: '13px',
                      height: '24px',
                      padding: '1.5px 10px',
                      maxWidth: '160px',
                      border: `1px solid ${tag.color}`,
                      fontWeight: isPrimary ? 600 : 400,
                    }}
                  >
                    {isPrimary ? '★ ' : ''}
                    {tag.name}
                  </Chip>
                );
              })}

            {tags.length - 6 > 0 && (
              <Chip
                size="sm"
                variant="soft"
                sx={{
                  bgcolor: brandAlpha[400][8],
                  color: 'text.primary',
                  fontSize: '13px',
                  padding: '1.5px 8px',
                  minWidth: 'auto',
                  border: '1px solid',
                  borderColor: 'fileBrowser.selectAll.borderColor',
                }}
              >
                +{tags.length - 6}
              </Chip>
            )}
            <StatusIcons
              fileError={file.error}
              isVectorizing={isVectorizing}
              vectorized={vectorized}
              chunked={chunked}
              isChunking={isChunking}
            />
            {isAdded && <AddedBadge />}
            {/* Shared recipients (Grid) */}
            {sharedUsersGrid.length > 0 && (
              <Box sx={{ display: 'flex', gap: '6px', flexWrap: 'wrap', justifyContent: 'center' }}>
                {sharedUsersGrid.slice(0, 3).map((share: any, index: number) => (
                  <UsernameText
                    key={`${share.userId}-${index}`}
                    id={share.userId as string}
                    useEmail
                    parent={props => (
                      <Chip size="sm" variant="soft" color="primary" sx={{ fontSize: '12px' }} {...props} />
                    )}
                  />
                ))}
                {sharedUsersGrid.length - 3 > 0 && (
                  <Chip size="sm" variant="soft" sx={{ fontSize: '12px' }}>
                    +{sharedUsersGrid.length - 3}
                  </Chip>
                )}
                <Typography level="body-xs" sx={{ width: '100%', textAlign: 'center', opacity: 0.6 }}>
                  Shared to: {sharedUsersGrid.length}
                </Typography>
              </Box>
            )}
          </Box>
        </Stack>
      </Card>
    </Grid>
  );
};

const ToggleRename: FC<{
  file: IFabFileDocument;
  children: React.ReactNode;
  editMode: boolean;
  setEditMode: (editMode: boolean) => void;
}> = ({ file, children, editMode, setEditMode }) => {
  const { fileName } = file;
  const [editedFileName, setEditedFileName] = useState(fileName);
  const update = useUpdateFabFile({
    onSuccess: () => {
      setEditMode(false);
      toast.success('File renamed successfully');
    },
  });

  const handleRename = async (file: IFabFileDocument) => {
    await update.mutateAsync({
      ...file,
      fileName: editedFileName,
    });
  };

  if (editMode) {
    return (
      <Input
        data-testid="file-browser-rename-input"
        value={editedFileName}
        onClick={e => e.stopPropagation()}
        onChange={e => setEditedFileName(e.target.value)}
        onKeyDown={e => {
          if (e.key === 'Enter') handleRename(file);
          if (e.key === 'Escape') {
            // Cancel editing without saving
            setEditMode(false);
          }
        }}
        autoFocus
        sx={{ width: '100%', ml: 1 }}
        endDecorator={
          update.isPending ? (
            <CircularProgress size="sm" />
          ) : (
            <Box sx={{ display: 'flex', gap: 1 }}>
              <IconButton
                data-testid="file-browser-rename-save-btn"
                size="sm"
                variant="plain"
                color="success"
                onClick={() => handleRename(file)}
                aria-label="Save"
                sx={{
                  padding: '2px',
                  minWidth: '20px',
                  minHeight: '20px',
                }}
              >
                <CheckIcon sx={{ fontSize: 16 }} />
              </IconButton>
              <IconButton
                size="sm"
                variant="plain"
                color="danger"
                onClick={() => setEditMode(false)}
                aria-label="Cancel"
                sx={{
                  padding: '2px',
                  minWidth: '20px',
                  minHeight: '20px',
                }}
              >
                <CloseIcon sx={{ fontSize: 16 }} />
              </IconButton>
            </Box>
          )
        }
      />
    );
  }

  return <>{children}</>;
};

const numberToBytes = (bytes: number) => {
  const sizes = ['Bytes', 'KB', 'MB', 'GB', 'TB', 'PB', 'EB', 'ZB', 'YB'];
  if (bytes === 0) return 'n/a';
  const i = parseInt(String(Math.floor(Math.log(bytes) / Math.log(1024))));
  return Math.round(bytes / Math.pow(1024, i)) + ' ' + sizes[i];
};

export default FileBrowserItem;

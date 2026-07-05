import { IFileTag, ITag } from '@bike4mind/common';
import { gray } from '../../../utils/themes/colors';
import { useCreateFileTag, useDeleteFileTag, useUpdateFileTag } from '@client/app/hooks/data/tag';
import { useConfirmation } from '@client/app/hooks/useConfirmation';
import {
  Box,
  Button,
  Card,
  Dropdown,
  IconButton,
  Menu,
  MenuButton,
  MenuItem,
  Modal,
  ModalClose,
  ModalDialog,
  Stack,
  Typography,
} from '@mui/joy';
import { MoreVert, EditOutlined, DeleteOutline } from '@mui/icons-material';
import { FC, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { brand, red, redAlpha } from '@client/app/utils/themes/colors';
import TagForm from '../../Tag/Form';

interface FileBrowserTagListProps {
  tags: IFileTag[];
  onClick: (tag: string) => void;
  onOpenTagManager?: () => void;
}

const FileBrowserTagList: FC<FileBrowserTagListProps> = ({ tags = [], onClick, onOpenTagManager }) => {
  const [open, setOpen] = useState(false);
  const [selectedTag, setSelectedTag] = useState<IFileTag | null>(null);

  const { mutateAsync: createTag, isPending: isPendingCreate } = useCreateFileTag();
  const { mutateAsync: updateTag, isPending: isPendingUpdate } = useUpdateFileTag();
  const { mutateAsync: deleteTag } = useDeleteFileTag();
  const confirm = useConfirmation();

  // Debug function to generate random tags
  const generateRandomTags = async () => {
    const tagNames = [
      'React',
      'Vue',
      'Angular',
      'TypeScript',
      'JavaScript',
      'Node.js',
      'Python',
      'Java',
      'C++',
      'Go',
      'Rust',
      'Swift',
      'Kotlin',
      'Flutter',
      'React Native',
      'Express',
      'Django',
      'Spring',
      'Laravel',
      'Rails',
      'MongoDB',
      'PostgreSQL',
      'MySQL',
      'Redis',
      'GraphQL',
      'REST API',
      'Docker',
      'Kubernetes',
      'AWS',
      'Azure',
      'GCP',
      'CI/CD',
      'DevOps',
      'Machine Learning',
      'AI',
      'Data Science',
      'Analytics',
      'Frontend',
      'Backend',
      'Fullstack',
      'UI/UX',
      'Design',
      'Figma',
      'Sketch',
      'Adobe',
      'Git',
      'GitHub',
      'GitLab',
      'Jira',
      'Slack',
      'Documentation',
      'Testing',
      'QA',
      'Security',
      'Performance',
      'Optimization',
      'Mobile',
      'Web',
      'Desktop',
      'API',
      'Database',
      'Cloud',
      'Serverless',
      'Microservices',
      'Architecture',
      'Clean Code',
      'Refactoring',
      'Legacy',
      'Migration',
      'Deployment',
    ];

    const colors = [
      '#FF6B6B',
      '#4ECDC4',
      '#45B7D1',
      '#96CEB4',
      '#FECA57',
      '#FF9FF3',
      '#54A0FF',
      '#5F27CD',
      '#00D2D3',
      '#FF9F43',
      '#10AC84',
      '#EE5A24',
      '#0984E3',
      '#6C5CE7',
      '#FD79A8',
      '#FDCB6E',
      '#E17055',
      '#00B894',
      '#2D3436',
      '#636E72',
      '#74B9FF',
      '#A29BFE',
      '#E84393',
      '#00CEC9',
    ];

    const icons = [
      '🏷️',
      '📱',
      '💻',
      '🌐',
      '⚡',
      '🔥',
      '💡',
      '🎯',
      '🚀',
      '⭐',
      '🔧',
      '📊',
      '🎨',
      '🔒',
      '⚙️',
      '📈',
      '🎉',
      '💎',
      '🌟',
      '🔍',
    ];

    try {
      const promises = [];
      for (let i = 0; i < 100; i++) {
        const randomName =
          tagNames[Math.floor(Math.random() * tagNames.length)] + ' ' + Math.floor(Math.random() * 1000);
        const randomColor = colors[Math.floor(Math.random() * colors.length)];
        const randomIcon = icons[Math.floor(Math.random() * icons.length)];

        promises.push(
          createTag({
            name: randomName,
            color: randomColor,
            icon: randomIcon,
            description: `Auto-generated tag for testing purposes`,
          })
        );
      }

      await Promise.all(promises);
      console.log('✅ Generated 20 random tags successfully');
    } catch (error) {
      console.error('❌ Failed to generate random tags:', error);
    }
  };

  return (
    <Box
      className="tag-list-container"
      sx={{ display: 'flex', flexDirection: 'column', gap: '12px', marginTop: '6px' }}
    >
      <Stack className="tag-list-header" direction="row" alignItems="center" justifyContent="flex-start" gap="10px">
        <Typography
          className="tag-list-count"
          level="body-sm"
          sx={{
            color: 'fileBrowser.lightTextColor',
            fontSize: '14px',
            fontWeight: '500',
            lineHeight: '150%',
          }}
        >
          Tag Collection ({tags.length})
        </Typography>
        <Button
          className="tag-list-create-button"
          size="sm"
          onClick={() => setOpen(true)}
          sx={{
            // button style
            width: '100px',
            height: '25px',
            borderRadius: '6px',
            border: `1px solid ${brand[800]}`,

            backgroundColor: 'transparent',

            // text style
            color: 'text.primary',
            fontSize: '12px',
            fontWeight: '500',
            lineHeight: '150%',
            letterSpacing: '8%',

            // hover style
            '&:hover': {
              backgroundColor: 'fileBrowser.buttons.hoverBackgroundColor',
              borderColor: 'fileBrowser.buttons.mainBlueBorderColor',
            },
          }}
        >
          Create Tag
        </Button>
        {onOpenTagManager && (
          <Button
            className="tag-list-manager-button"
            variant="outlined"
            color="neutral"
            size="md"
            onClick={onOpenTagManager}
            sx={{
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'center',
              padding: '6px 30px',
              '@media (max-width: 600px)': {
                width: '100%',
              },
              borderRadius: '6px',
              border: '1px solid',
              borderColor: 'fileBrowser.selectAll.borderColor',
              bgcolor: theme => theme.palette.fileBrowser.tagList.itemBackground,
              minHeight: '32px',
              height: '32px',

              // text style
              color: 'text.primary',
              fontSize: '14px',
              fontWeight: '400',
              lineHeight: '150%',
              letterSpacing: '1px',
            }}
          >
            Tag Manager
          </Button>
        )}
        {/* Debug Button - Only show in development */}
        {process.env.NODE_ENV === 'development' && (
          <Button
            className="tag-list-debug-button"
            size="sm"
            onClick={generateRandomTags}
            disabled={isPendingCreate}
            sx={{
              // button style
              width: '100px',
              height: '25px',
              borderRadius: '6px',
              border: `1px solid ${red[450]}`,

              backgroundColor: 'transparent',

              // text style
              color: red[450],
              fontSize: '12px',
              fontWeight: '500',
              lineHeight: '150%',
              letterSpacing: '8%',

              // hover style
              '&:hover': {
                backgroundColor: redAlpha[450][10],
                borderColor: red[450],
              },
            }}
          >
            +20 Tags
          </Button>
        )}
      </Stack>
      <Box className="tag-list-scroll-container" sx={{ flex: 1, minHeight: 0, overflowY: 'auto', overflowX: 'hidden' }}>
        <Box
          className="tag-list-items-container"
          sx={{
            display: 'flex',
            flexWrap: 'nowrap',
            gap: 2,
            overflowX: 'auto',
            pb: 1, // space for scrollbar
            '::-webkit-scrollbar': {
              height: '4px',
            },
            '::-webkit-scrollbar-track': {
              background: gray[155],
              borderRadius: '4px',
            },
            '::-webkit-scrollbar-thumb': {
              background: theme => theme.palette.primary.solidBg,
              borderRadius: '4px',
              '&:hover': {
                background: gray[665],
              },
            },
          }}
        >
          {tags.map(tag => (
            <Box className="tag-list-item-wrapper" key={tag.id} sx={{ flex: '0 0 auto' }}>
              <Item
                value={tag}
                onClick={() => onClick(tag.name)}
                onEdit={() => {
                  setSelectedTag(tag);
                  setOpen(true);
                }}
                onDelete={() => {
                  confirm({
                    title: `Delete ${tag.name}`,
                    description: 'Are you sure you want to delete this tag?',
                    onOk: async () => {
                      await deleteTag(tag.id);
                    },
                  });
                }}
              />
            </Box>
          ))}
        </Box>
      </Box>
      <Modal
        className="tag-list-modal"
        open={open}
        onClose={isPendingCreate || isPendingUpdate ? undefined : () => setOpen(false)}
      >
        <ModalDialog className="tag-list-modal-dialog" sx={{ width: '790px' }}>
          {isPendingCreate ? (
            <ModalClose className="tag-list-modal-close" />
          ) : (
            <Box
              className="tag-list-modal-content"
              style={{ justifyContent: 'center', alignItems: 'center', display: 'flex', flexDirection: 'column' }}
            >
              {/* Close button */}
              <ModalClose />

              {/* Title */}
              <Typography
                className="tag-list-modal-title"
                level="title-lg"
                sx={{
                  color: 'text.primary',
                  fontWeight: '400',
                  size: '20px',
                  lineHeight: '150%',
                  margin: '8px 0px 8px 0px',
                }}
              >
                Create a New Tag
              </Typography>

              <Typography
                className="tag-list-modal-subtitle"
                level="body-sm"
                sx={{
                  color: 'fileBrowser.createTag.secondaryText',
                  fontWeight: '400',
                  size: '14px',
                  lineHeight: '130%',
                  mb: '8px',
                }}
              >
                Design a beautiful tag to organize your files effortlessly.
              </Typography>

              {/* Form */}
              <TagForm
                data={selectedTag as ITag}
                onSubmit={tag => {
                  if (selectedTag) {
                    updateTag({
                      ...selectedTag,
                      ...tag,
                    }).then(() => {
                      setSelectedTag(null);
                      setOpen(false);
                    });
                  } else {
                    createTag(tag).then(() => setOpen(false));
                  }
                }}
                submitting={isPendingCreate || isPendingUpdate}
              />
            </Box>
          )}
        </ModalDialog>
      </Modal>
    </Box>
  );
};

const Item: FC<{
  value: IFileTag;
  onClick: () => void;
  onEdit: () => void;
  onDelete: () => void;
}> = ({ value, onClick, onEdit, onDelete }) => {
  const { t } = useTranslation();

  return (
    <Card
      className="tag-item-card"
      sx={theme => ({
        borderRadius: '8px',
        border: '1px solid',
        borderColor: 'border.light',
        backgroundColor: theme.palette.fileBrowser.item.background,
        width: '280px',
        height: '100px',
        p: '16px',
        cursor: 'pointer',
        transition: 'all 0.2s ease-in-out',
        // #hex + 0D is 5% opacity
        '&:hover': {
          bgcolor: `${value.color}0D`,
          border: `1px solid ${value.color}`,
        },
      })}
      onClick={onClick}
    >
      <Stack className="tag-item-content" direction="row" alignItems="flex-start" gap="10px">
        {/* left side / icon side */}
        <Box
          className="tag-item-icon-container"
          sx={{
            minWidth: '40px',
            height: '40px',
            bgcolor: value.color,
            fontSize: '18px',
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            borderRadius: '10px',
          }}
        >
          {value.icon}
        </Box>

        {/* right side / text side */}

        <Stack className="tag-item-text-container" flexGrow={1} direction="column" gap="10px">
          {/* top name and description side */}
          <Stack className="tag-item-text-row" direction="row">
            <Box className="tag-item-text-content" sx={{ minWidth: 0, flex: 1 }}>
              <Typography
                className="tag-item-name"
                level="body-md"
                sx={{
                  textOverflow: 'ellipsis',
                  overflow: 'hidden',
                  whiteSpace: 'nowrap',
                  fontSize: '16px',
                  fontWeight: '400',
                }}
              >
                {value.name}
              </Typography>

              <Typography
                className="tag-item-description"
                level="body-sm"
                sx={{
                  textOverflow: 'ellipsis',
                  overflow: 'hidden',
                  whiteSpace: 'nowrap',
                  fontSize: '12px',
                  fontWeight: '400',
                  color: 'fileBrowser.lightTextColor',
                }}
                title={value.description}
              >
                {value.description}
              </Typography>
            </Box>

            {/* action buttons side */}
            <Box
              className="tag-item-actions"
              sx={{
                opacity: 0,
                transition: 'opacity 0.2s ease-in-out',
                '.MuiCard-root:hover &': {
                  opacity: 1,
                },
                alignItems: 'center',
                justifyContent: 'center',
                border: `1px solid ${brand[100]}`,
                borderRadius: '6px',
                width: '24px',
                height: '24px',
                display: 'flex',
              }}
            >
              <Dropdown>
                <MenuButton
                  className="tag-item-menu-button"
                  slots={{ root: IconButton }}
                  slotProps={{
                    root: {
                      variant: 'plain',
                      color: 'neutral',
                      sx: {
                        minHeight: 'auto',
                        minWidth: 'auto',
                        padding: 0,
                      },
                    },
                  }}
                  onClick={e => e.stopPropagation()}
                >
                  <MoreVert sx={{ fontSize: 16 }} />
                </MenuButton>
                <Menu className="tag-item-menu" sx={{ zIndex: 99999 }} placement="bottom-end">
                  <MenuItem
                    className="tag-item-menu-edit"
                    onClick={e => {
                      e.stopPropagation();
                      onEdit();
                    }}
                  >
                    <EditOutlined />
                    Edit
                  </MenuItem>
                  <MenuItem
                    className="tag-item-menu-delete"
                    onClick={e => {
                      e.stopPropagation();
                      onDelete();
                    }}
                  >
                    <DeleteOutline />
                    Delete
                  </MenuItem>
                </Menu>
              </Dropdown>
            </Box>
          </Stack>

          {/* bottom file count */}
          <Stack className="tag-item-file-count" direction="row" alignItems="center" gap="4px">
            {/* file icon  */}
            <Box className="tag-item-file-icon" sx={{ fontSize: '10px' }}>
              📁
            </Box>
            <Typography
              className="tag-item-file-count-text"
              level="body-sm"
              sx={{
                textOverflow: 'ellipsis',
                overflow: 'hidden',
                whiteSpace: 'nowrap',
                fontSize: '12px',
                fontWeight: '400',
                color: 'fileBrowser.lightTextColor',
              }}
            >
              {t('file_browser.count_file', { count: value.fileCount || 0 })}
            </Typography>
          </Stack>
        </Stack>
      </Stack>
    </Card>
  );
};

export default FileBrowserTagList;

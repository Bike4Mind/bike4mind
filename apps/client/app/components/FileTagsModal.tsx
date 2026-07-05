import { Modal, Typography, Box, Chip, Input, Button, Stack, Sheet, IconButton, CircularProgress } from '@mui/joy';
import { useState, useEffect } from 'react';
import { blackAlpha } from '@client/app/utils/themes/colors';
import { IFabFileDocument } from '@bike4mind/common';
import { updateFileUtility } from '@client/app/utils/filesAPICalls';
import CloseIcon from '@mui/icons-material/Close';
import { toast } from 'sonner';

interface FileTagsModalProps {
  open: boolean;
  onClose: () => void;
  file: IFabFileDocument;
  onRefresh: () => Promise<void>;
}

export const FileTagsModal = ({ open, onClose, file, onRefresh }: FileTagsModalProps) => {
  const [newTag, setNewTag] = useState('');
  const [strength] = useState(1);
  const [loading, setLoading] = useState(false);

  const [localTags, setLocalTags] = useState<Array<{ name: string; strength: number }>>(() => file.tags ?? []);

  useEffect(() => {
    setLocalTags(file.tags ?? []);
  }, [file]);

  const handleAddTag = async () => {
    if (!newTag.trim()) return;

    const tagsToAdd = newTag
      .split(/[,;]/)
      .map(tag => tag.trim())
      .filter(tag => tag.length > 0);

    if (tagsToAdd.length === 0) return;

    const filteredNewTags = tagsToAdd.filter(
      tagName => !localTags.some(existingTag => existingTag.name.toLowerCase() === tagName.toLowerCase())
    );

    if (filteredNewTags.length === 0) return;

    const mergedTags = [...localTags, ...filteredNewTags.map(tagName => ({ name: tagName, strength }))];

    setLocalTags(mergedTags);

    setLoading(true);
    try {
      await updateFileUtility(file.id, {
        ...file,
        tags: mergedTags,
      });
      await onRefresh();
      setNewTag('');
      toast.success('Tag(s) added successfully!');
    } catch (error) {
      console.error('Failed to add tags:', error);
      toast.error('Failed to add tags.');
    } finally {
      setLoading(false);
    }
  };

  const handleRemoveTag = async (tagToRemove: string) => {
    console.log('Removing tag:', tagToRemove);

    const filteredTags = localTags.filter(tag => tag.name !== tagToRemove);

    setLocalTags(filteredTags);

    setLoading(true);
    try {
      await updateFileUtility(file.id, {
        ...file,
        tags: filteredTags,
      });
      await onRefresh();
      toast.success(`Removed tag: "${tagToRemove}"`);
    } catch (error) {
      console.error('Failed to remove tag:', error);
      toast.error('Failed to remove tag.');
    } finally {
      setLoading(false);
    }
  };

  return (
    <Modal
      open={open}
      onClose={onClose}
      sx={{
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
      }}
    >
      <Sheet
        variant="outlined"
        sx={{
          minWidth: 600,
          borderRadius: 'md',
          p: 3,
          boxShadow: 'lg',
          display: 'flex',
          flexDirection: 'column',
          gap: 2,
          '@media (max-width: 600px)': {
            minWidth: '90%',
            maxWidth: '90%',
            p: 2,
          },
        }}
      >
        <Box sx={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', mb: 1 }}>
          <Typography level="h4">Manage Tags</Typography>
          <IconButton onClick={onClose} variant="plain" size="sm">
            <CloseIcon />
          </IconButton>
        </Box>

        <Box sx={{ mt: 2 }}>
          <Typography level="body-sm">Current Tags:</Typography>
          <Stack direction="row" spacing={1} flexWrap="wrap" sx={{ mt: 1 }}>
            {localTags.map(tag => (
              <Chip
                key={tag.name}
                color="primary"
                size="sm"
                variant="soft"
                endDecorator={
                  <IconButton
                    variant="plain"
                    color="neutral"
                    size="sm"
                    sx={{
                      pointerEvents: 'auto',
                      '--IconButton-size': '16px',
                      ml: -0.5,
                      mr: -0.75,
                      '&:hover': {
                        bgcolor: blackAlpha[0][10],
                      },
                    }}
                    onClick={() => handleRemoveTag(tag.name)}
                  >
                    <CloseIcon sx={{ fontSize: '12px' }} />
                  </IconButton>
                }
              >
                {tag.name}
              </Chip>
            ))}
            {localTags.length === 0 && (
              <Typography level="body-sm" sx={{ color: 'neutral.500' }}>
                No tags yet
              </Typography>
            )}
          </Stack>
        </Box>

        <Stack direction="row" spacing={1} sx={{ mt: 2 }}>
          <Input
            value={newTag}
            onChange={e => setNewTag(e.target.value)}
            placeholder="Add tags (separate with comma or semicolon)..."
            sx={{ flexGrow: 1 }}
            onKeyDown={e => {
              if (e.key === 'Enter') {
                e.preventDefault();
                handleAddTag();
              }
            }}
          />
          <Button onClick={handleAddTag} disabled={loading || !newTag.trim()}>
            {loading ? <CircularProgress size="sm" /> : 'Add'}
          </Button>
        </Stack>
      </Sheet>
    </Modal>
  );
};

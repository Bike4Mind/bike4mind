import { useState } from 'react';
import {
  Modal,
  ModalDialog,
  DialogTitle,
  DialogContent,
  DialogActions,
  Button,
  Typography,
  Box,
  Input,
  Chip,
  IconButton,
} from '@mui/joy';
import CloseIcon from '@mui/icons-material/Close';
import { toast } from 'sonner';
import { ISessionDocument } from '@bike4mind/common';
import { useQueryClient } from '@tanstack/react-query';
import { useUpdateSession } from '@client/app/hooks/data/sessions';
import { api } from '@client/app/contexts/ApiContext';
import type { CombinedSessionDocument } from './types';

interface TagModalProps {
  open: boolean;
  /** Close without clearing selection - mirrors the backdrop-dismiss behaviour. */
  onClose: () => void;
  selectedItems: Set<string>;
  combinedSessions: CombinedSessionDocument[];
  /** Called after tags are successfully applied so the parent can clear the selection. */
  onTagged: () => void;
}

/**
 * "Manage Tags" bulk-action modal. Owns its own manual-tag input state (nothing else in the
 * sidebar reads it). Applies manual tag chips when present, otherwise triggers server-side tag
 * generation, then invalidates the session caches and asks the parent to clear the selection.
 */
const TagModal = ({ open, onClose, selectedItems, combinedSessions, onTagged }: TagModalProps) => {
  const [manualTags, setManualTags] = useState('');
  const [tagChips, setTagChips] = useState<string[]>([]);
  const queryClient = useQueryClient();
  const updateSession = useUpdateSession();

  return (
    <Modal open={open} onClose={onClose}>
      <ModalDialog>
        <DialogTitle>Manage Tags</DialogTitle>
        <DialogContent>
          <Typography level="body-md" sx={{ mb: 2 }}>
            Managing tags for {selectedItems.size} item{selectedItems.size > 1 ? 's' : ''}
          </Typography>

          {/* Manual tag input */}
          <Box>
            <Typography level="body-sm" sx={{ mb: 1 }}>
              Add tags manually (press Enter to add):
            </Typography>
            <Input
              placeholder="Type a tag and press Enter..."
              value={manualTags}
              onChange={e => setManualTags(e.target.value)}
              onKeyDown={e => {
                if (e.key === 'Enter' && manualTags.trim()) {
                  e.preventDefault();
                  const newTag = manualTags.trim();
                  if (!tagChips.includes(newTag)) {
                    setTagChips([...tagChips, newTag]);
                  }
                  setManualTags('');
                }
              }}
              size="sm"
            />

            {/* Display added tags */}
            {tagChips.length > 0 && (
              <Box sx={{ mt: 1, display: 'flex', flexWrap: 'wrap', gap: 0.5 }}>
                {tagChips.map((tag, index) => (
                  <Chip
                    key={index}
                    size="sm"
                    variant="soft"
                    endDecorator={
                      <IconButton
                        size="sm"
                        variant="plain"
                        color="neutral"
                        onClick={() => {
                          setTagChips(tagChips.filter((_, i) => i !== index));
                        }}
                        sx={{ ml: 0.5 }}
                      >
                        <CloseIcon sx={{ fontSize: '14px' }} />
                      </IconButton>
                    }
                  >
                    {tag}
                  </Chip>
                ))}
              </Box>
            )}
          </Box>

          <Typography level="body-sm" sx={{ mt: 2, color: 'text.secondary' }}>
            Or click &quot;Generate Tags&quot; to automatically analyze and tag the selected items.
          </Typography>
        </DialogContent>
        <DialogActions>
          <Button
            variant="plain"
            color="neutral"
            onClick={() => {
              onClose();
              setManualTags('');
              setTagChips([]);
            }}
          >
            Cancel
          </Button>
          <Button
            onClick={async () => {
              const itemsToTag = Array.from(selectedItems);
              const sessions = combinedSessions.filter(s => itemsToTag.includes(s.id));

              try {
                // If manual tags are provided, use them. Otherwise generate.
                if (tagChips.length > 0) {
                  // Apply manual tags to each session
                  for (const session of sessions) {
                    // Fetch the full session data to ensure we have all fields
                    const fullSessionData = queryClient.getQueryData<ISessionDocument>(['sessions', session.id]);
                    const existingTags = fullSessionData?.tags || session.tags || [];

                    // Convert string tags to proper tag objects with strength
                    const newTagObjects = tagChips
                      .filter(tag => !existingTags.some(t => t.name === tag))
                      .map(tag => ({ name: tag, strength: 1 }));
                    const newTags = [...existingTags, ...newTagObjects];

                    // Update with full session data
                    const sessionToUpdate = fullSessionData || session;
                    const updatedSession = await updateSession.mutateAsync({
                      ...sessionToUpdate,
                      tags: newTags,
                    });

                    // Update the cache directly with the returned session
                    if (updatedSession) {
                      queryClient.setQueryData(['sessions', session.id], updatedSession);
                    }

                    // Invalidate specific session query as well
                    queryClient.invalidateQueries({ queryKey: ['sessions', session.id] });
                  }

                  // Invalidate all session queries to refresh the list
                  await queryClient.invalidateQueries({ queryKey: ['sessions'] });
                  await queryClient.invalidateQueries({ queryKey: ['sessions', 'favorites'] });

                  // Small delay to ensure cache updates propagate
                  await new Promise(resolve => setTimeout(resolve, 100));

                  toast.success(
                    `Added ${tagChips.length} tag${tagChips.length > 1 ? 's' : ''} to ${sessions.length} item${sessions.length > 1 ? 's' : ''}`
                  );
                } else {
                  // Generate tags for each session
                  for (const session of sessions) {
                    await api.post(`/api/sessions/${session.id}/tags/generate`);
                  }
                  queryClient.invalidateQueries({ queryKey: ['sessions'] });
                  toast.success(`Generated tags for ${sessions.length} item${sessions.length > 1 ? 's' : ''}`);
                }

                onClose();
                onTagged();
                setManualTags('');
                setTagChips([]);
              } catch (error) {
                toast.error('Failed to manage tags');
              }
            }}
          >
            {tagChips.length > 0 ? 'Add Tags' : 'Generate Tags'}
          </Button>
        </DialogActions>
      </ModalDialog>
    </Modal>
  );
};

export default TagModal;

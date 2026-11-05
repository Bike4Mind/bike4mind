import { useRef, useState } from 'react';
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
import { MAX_BULK_ITEMS, type ISessionDocument } from '@bike4mind/common';
import { useQueryClient } from '@tanstack/react-query';
import { api } from '@client/app/contexts/ApiContext';
import { useJobStatus } from '@client/app/hooks/useJobStatus';
import { getInsufficientCreditsMessage } from '@client/app/utils/error';
import type { CombinedSessionDocument } from './types';

type BulkTagResponse = {
  okCount: number;
  results: { id: string; ok: boolean; session?: ISessionDocument }[];
};

interface TagModalProps {
  open: boolean;
  /** Close without clearing selection - mirrors the backdrop-dismiss behaviour. */
  onClose: () => void;
  /** Must already be narrowed to visible sessions: the count shown and the ids sent both come from it. */
  selectedItems: Set<string>;
  combinedSessions: CombinedSessionDocument[];
  /** Called after tags are successfully applied so the parent can clear the selection. */
  onTagged: () => void;
}

/**
 * "Manage Tags" bulk-action modal. Owns its own manual-tag input state (nothing else in the
 * sidebar reads it). Applies manual tag chips when present, otherwise queues server-side tag
 * generation, one bulk request per MAX_BULK_ITEMS sessions, then asks the parent to clear the selection.
 */
const TagModal = ({ open, onClose, selectedItems, combinedSessions, onTagged }: TagModalProps) => {
  const applyingTags = useRef(false);
  const [isApplying, setIsApplying] = useState(false);
  const [manualTags, setManualTags] = useState('');
  const [tagChips, setTagChips] = useState<string[]>([]);
  const queryClient = useQueryClient();
  const { startJob } = useJobStatus();

  const applyTags = async () => {
    const ids = combinedSessions.filter(s => selectedItems.has(s.id)).map(s => s.id);
    if (ids.length === 0) return;
    if (applyingTags.current) return;
    applyingTags.current = true;
    setIsApplying(true);
    const addMode = tagChips.length > 0;
    const plural = (n: number) => `${n} item${n > 1 ? 's' : ''}`;
    let okCount = 0;
    let failure: unknown;

    try {
      for (let i = 0; i < ids.length; i += MAX_BULK_ITEMS) {
        const sessionIds = ids.slice(i, i + MAX_BULK_ITEMS);
        let data: BulkTagResponse;
        try {
          ({ data } = await api.post<BulkTagResponse>(
            '/api/sessions/bulk',
            addMode ? { action: 'addTags', sessionIds, tags: tagChips } : { action: 'generateTags', sessionIds }
          ));
        } catch (error) {
          failure = error;
          break;
        }
        okCount += data.okCount;
        for (const result of data.results) {
          if (!result.ok) continue;
          if (result.session) queryClient.setQueryData(['sessions', result.id], result.session);
          if (!addMode) startJob(result.id, 'generateTags');
        }
      }

      // Nothing committed: keep the modal open so the user can retry.
      if (failure && okCount === 0) {
        toast.error(getInsufficientCreditsMessage(failure) ?? 'Failed to manage tags');
        return;
      }

      const done = addMode
        ? `Added ${tagChips.length} tag${tagChips.length > 1 ? 's' : ''} to`
        : 'Started generating tags for';
      if (okCount === ids.length) toast.success(`${done} ${plural(ids.length)}`);
      else toast.warning(`${done} ${okCount} of ${ids.length} items`);
      // Earlier chunks are already applied (and billed), so close rather than invite a retry of them.
      if (failure) toast.error(getInsufficientCreditsMessage(failure) ?? 'Failed to manage the remaining tags');

      onClose();
      onTagged();
      setManualTags('');
      setTagChips([]);
    } finally {
      applyingTags.current = false;
      setIsApplying(false);
      queryClient.invalidateQueries({ queryKey: ['sessions'] });
    }
  };

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
                        aria-label="Remove tag"
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
          <Button data-testid="tag-modal-apply-btn" disabled={isApplying} loading={isApplying} onClick={applyTags}>
            {tagChips.length > 0 ? 'Add Tags' : 'Generate Tags'}
          </Button>
        </DialogActions>
      </ModalDialog>
    </Modal>
  );
};

export default TagModal;

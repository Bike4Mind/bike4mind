import { useMemo, useState } from 'react';
import {
  Box,
  Button,
  Checkbox,
  DialogActions,
  DialogContent,
  DialogTitle,
  Input,
  Modal,
  ModalClose,
  ModalDialog,
  Skeleton,
  Stack,
  Typography,
} from '@mui/joy';
import SearchIcon from '@mui/icons-material/Search';
import PersonOutlineIcon from '@mui/icons-material/PersonOutline';
import { useGetDataLakes } from '@client/app/hooks/data/dataLakes';

/** Below this many lakes a filter box is noise rather than help - mirrors DataLakeLakePicker. */
const SEARCH_THRESHOLD = 8;

export interface TestLakeScopeDialogProps {
  /** The lake whose settings modal opened this dialog - checked by default. */
  anchorLakeId: string;
  onClose: () => void;
  /** One `datalakeTag` per checked lake, the exact shape `retrievalTags` expects. */
  onConfirm: (retrievalTags: string[]) => void;
  confirming?: boolean;
}

/**
 * Multi-select over the lakes the caller can reach, for building a test session's `retrievalTags`
 * (the same field an API-key caller sends to narrow a session to a lake subset). Mirrors
 * DataLakeLakePicker's row presentation (search past the threshold, owner-icon marker) but writes
 * a set of ids rather than a single browse-tree selection - a new writer over the same accessible
 * lake list, not a second copy of that list's fetch/loading/error handling.
 */
export function TestLakeScopeDialog({ anchorLakeId, onClose, onConfirm, confirming }: TestLakeScopeDialogProps) {
  const { data: lakes, isLoading, isError, refetch } = useGetDataLakes();
  const [query, setQuery] = useState('');
  const [selected, setSelected] = useState<Set<string>>(() => new Set([anchorLakeId]));

  const filtered = useMemo(() => {
    if (!lakes) return [];
    const q = query.trim().toLowerCase();
    if (!q) return lakes;
    return lakes.filter(l => l.name.toLowerCase().includes(q));
  }, [lakes, query]);

  const toggle = (id: string) => {
    setSelected(prev => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  };

  const handleConfirm = () => {
    const tags = (lakes ?? []).filter(l => selected.has(l.id)).map(l => l.datalakeTag);
    onConfirm(tags);
  };

  return (
    <Modal open onClose={onClose}>
      <ModalDialog data-testid="test-lake-scope-dialog" sx={{ minWidth: 340, maxWidth: 420 }}>
        <ModalClose data-testid="test-lake-scope-close-btn" />
        <DialogTitle>Test this lake</DialogTitle>
        <DialogContent>
          <Typography level="body-sm" sx={{ color: 'text.tertiary', mb: 1.5 }}>
            Starts a chat narrowed to only the lakes checked below, on both the retrieval and injection doors - the same
            scope an API key gets by sending these lakes&apos; tags as <code>retrievalTags</code>. Lake scope only: this
            does not simulate a different entitlement, organization membership, or file-level access for the caller.
          </Typography>
          {(lakes?.length ?? 0) >= SEARCH_THRESHOLD && (
            <Input
              size="sm"
              placeholder="Filter lakes"
              value={query}
              onChange={e => setQuery(e.target.value)}
              startDecorator={<SearchIcon sx={{ fontSize: 16 }} />}
              sx={{ mb: 1 }}
              data-testid="test-lake-scope-search"
            />
          )}
          <Box sx={{ maxHeight: 320, overflowY: 'auto' }}>
            {isLoading ? (
              <Stack gap={1} data-testid="test-lake-scope-loading">
                {[0, 1, 2].map(i => (
                  <Skeleton key={i} variant="text" level="body-sm" />
                ))}
              </Stack>
            ) : isError ? (
              <Stack gap={1} data-testid="test-lake-scope-error">
                <Typography level="body-sm" sx={{ color: 'danger.400' }}>
                  Could not load lakes.
                </Typography>
                <Button size="sm" variant="outlined" color="neutral" onClick={() => refetch()}>
                  Retry
                </Button>
              </Stack>
            ) : filtered.length === 0 ? (
              <Typography level="body-xs" sx={{ color: 'text.tertiary' }}>
                {query ? 'No matches' : 'No lakes yet'}
              </Typography>
            ) : (
              <Stack gap={0.5}>
                {filtered.map(lake => (
                  <Checkbox
                    key={lake.id}
                    size="sm"
                    checked={selected.has(lake.id)}
                    onChange={() => toggle(lake.id)}
                    data-testid={`test-lake-scope-checkbox-${lake.id}`}
                    label={
                      <Stack direction="row" gap={0.5} alignItems="center">
                        <Typography level="body-sm">{lake.name}</Typography>
                        {lake.isOwn === false && (
                          <PersonOutlineIcon
                            data-testid={`test-lake-scope-owner-icon-${lake.id}`}
                            sx={{ fontSize: 14, color: 'warning.400' }}
                          />
                        )}
                      </Stack>
                    }
                  />
                ))}
              </Stack>
            )}
          </Box>
        </DialogContent>
        <DialogActions>
          <Button
            loading={confirming}
            disabled={selected.size === 0}
            onClick={handleConfirm}
            data-testid="test-lake-scope-confirm-btn"
          >
            Start test chat
          </Button>
          <Button variant="plain" color="neutral" onClick={onClose} data-testid="test-lake-scope-cancel-btn">
            Cancel
          </Button>
        </DialogActions>
      </ModalDialog>
    </Modal>
  );
}

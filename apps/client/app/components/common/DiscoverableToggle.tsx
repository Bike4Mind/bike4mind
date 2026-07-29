import React, { useState } from 'react';
import { Box, FormControl, FormLabel, Switch, Typography } from '@mui/joy';
import TravelExploreIcon from '@mui/icons-material/TravelExplore';
import { toast } from 'sonner';
import { updatePublishedDiscoverable } from '@client/app/utils/publishApi';

export interface DiscoverableToggleProps {
  publicId: string;
  /** Current stored value, seeded from the live record. */
  initialDiscoverable: boolean;
  /** Rendered only when true - the server ANDs `discoverable` with open-public, so
   *  offering it on a gated or non-public item would promise a no-op. */
  isOpenPublic: boolean;
  testIdPrefix?: string;
}

/**
 * Search-engine opt-in for an already-published artifact. Publishing publicly means
 * "anyone with the link may view", never "listed in Google" - so indexing is a separate
 * switch that starts OFF, and this is where an owner turns it on.
 *
 * Optimistic with rollback: the switch reflects the request's outcome, never just the
 * click, so a failed PATCH can't leave the UI claiming a page is hidden when it isn't.
 */
export function DiscoverableToggle({
  publicId,
  initialDiscoverable,
  isOpenPublic,
  testIdPrefix = 'discoverable',
}: DiscoverableToggleProps) {
  const [discoverable, setDiscoverable] = useState(initialDiscoverable);
  const [busy, setBusy] = useState(false);

  if (!isOpenPublic) return null;

  const onToggle = async (next: boolean) => {
    if (busy) return;
    const prev = discoverable;
    setDiscoverable(next);
    setBusy(true);
    try {
      await updatePublishedDiscoverable(publicId, next);
      toast.success(
        next
          ? 'Search engines may now list this page'
          : 'Hidden from search engines - the link still works for anyone you send it to'
      );
    } catch {
      setDiscoverable(prev);
      toast.error('Failed to update search listing');
    } finally {
      setBusy(false);
    }
  };

  return (
    <FormControl
      orientation="horizontal"
      sx={{ justifyContent: 'space-between', alignItems: 'center', gap: 1 }}
      data-testid={`${testIdPrefix}-control`}
    >
      <Box sx={{ display: 'flex', alignItems: 'center', gap: 1 }}>
        <TravelExploreIcon fontSize="small" />
        <Box>
          <FormLabel sx={{ mb: 0 }}>List in search engines</FormLabel>
          <Typography level="body-xs" sx={{ opacity: 0.75 }}>
            Off by default. When off, the link still works for anyone you send it to - it just won&apos;t show up in
            Google. Link previews in chat apps work either way.
          </Typography>
        </Box>
      </Box>
      <Switch
        checked={discoverable}
        disabled={busy}
        onChange={e => void onToggle(e.target.checked)}
        // On the INPUT slot, not the root: Joy spreads bare props to the root span,
        // where a test can't read `.checked`.
        slotProps={{ input: { 'data-testid': `${testIdPrefix}-toggle` } }}
      />
    </FormControl>
  );
}

export default DiscoverableToggle;

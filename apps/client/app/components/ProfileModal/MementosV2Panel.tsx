import { useState, type ReactNode } from 'react';
import { Box, Button, Chip, CircularProgress, Divider, IconButton, Sheet, Stack, Tooltip, Typography } from '@mui/joy';
import LocalFireDepartmentIcon from '@mui/icons-material/LocalFireDepartment';
import WbTwilightIcon from '@mui/icons-material/WbTwilight';
import AcUnitIcon from '@mui/icons-material/AcUnit';
import DeleteIcon from '@mui/icons-material/Delete';
import { useV2Memory, useShredBelief, type V2Belief } from '@client/app/hooks/data/memoryV2';

/**
 * Mementos 2.0 view: the beliefs folded from a user's principal-scoped ledger. Deliberately NOT the V1
 * CRUD table - V2 memory is an append-only, encrypted ledger, so the operations that make sense are
 * READ and SHRED (delete-forever), not edit. When both V1 and V2 are on this is the unified view: the
 * read path already UNIONS V1 mementos into the ledger, so they appear here as beliefs too.
 */

const SALIENCE: Record<NonNullable<V2Belief['salience']>, { label: string; color: 'danger' | 'warning' | 'neutral'; icon: ReactNode }> = {
  hot: { label: 'Hot', color: 'danger', icon: <LocalFireDepartmentIcon fontSize="small" /> },
  warm: { label: 'Warm', color: 'warning', icon: <WbTwilightIcon fontSize="small" /> },
  cold: { label: 'Cold', color: 'neutral', icon: <AcUnitIcon fontSize="small" /> },
};

const relativeTime = (iso: string): string => {
  const days = Math.floor((Date.now() - new Date(iso).getTime()) / 86_400_000);
  if (days <= 0) return 'today';
  if (days === 1) return 'yesterday';
  if (days < 30) return `${days}d ago`;
  if (days < 365) return `${Math.floor(days / 30)}mo ago`;
  return `${Math.floor(days / 365)}y ago`;
};

const BeliefRow = ({
  belief,
  onShred,
  shredding,
}: {
  belief: V2Belief;
  onShred: (opts: { onSettled: () => void }) => void;
  shredding: boolean;
}) => {
  const [confirming, setConfirming] = useState(false);
  const sal = belief.salience ? SALIENCE[belief.salience] : undefined;

  return (
    <Sheet variant="soft" sx={{ borderRadius: 'sm', p: 1.5, display: 'flex', gap: 1.5, alignItems: 'flex-start' }}>
      <Box sx={{ flex: 1, minWidth: 0 }}>
        <Typography level="body-sm" sx={{ wordBreak: 'break-word' }}>
          {belief.fact}
        </Typography>
        <Stack direction="row" spacing={1} sx={{ mt: 0.75, alignItems: 'center', flexWrap: 'wrap' }}>
          {sal && (
            <Chip size="sm" color={sal.color} variant="soft" startDecorator={sal.icon}>
              {sal.label}
            </Chip>
          )}
          <Typography level="body-xs" textColor="text.tertiary">
            seen {relativeTime(belief.lastAffirmedAt)}
          </Typography>
          {belief.derivedFrom.length > 1 && (
            <Typography level="body-xs" textColor="text.tertiary">
              {belief.derivedFrom.length} mentions
            </Typography>
          )}
        </Stack>
      </Box>

      {confirming ? (
        <Stack direction="row" spacing={0.5} sx={{ alignItems: 'center' }}>
          <Typography level="body-xs" textColor="danger.plainColor">
            Delete forever?
          </Typography>
          <Button
            size="sm"
            color="danger"
            variant="solid"
            loading={shredding}
            onClick={() => onShred({ onSettled: () => setConfirming(false) })}
            data-testid="v2-belief-shred-btn"
          >
            Yes
          </Button>
          <Button size="sm" variant="plain" onClick={() => setConfirming(false)}>
            No
          </Button>
        </Stack>
      ) : (
        <Tooltip title="Delete this memory (irreversible)">
          <IconButton
            size="sm"
            color="danger"
            variant="plain"
            aria-label="Delete this memory"
            onClick={() => setConfirming(true)}
            data-testid="v2-belief-delete-btn"
          >
            <DeleteIcon fontSize="small" />
          </IconButton>
        </Tooltip>
      )}
    </Sheet>
  );
};

const MementosV2Panel = () => {
  const { data: beliefs, isLoading, isError } = useV2Memory();
  const shred = useShredBelief();

  return (
    <Box sx={{ p: 2 }}>
      <Typography level="h4">Memory (Mementos 2.0)</Typography>
      <Typography level="body-sm" textColor="text.secondary" sx={{ mt: 0.5 }}>
        What the assistant knows about you, folded from your encrypted memory ledger. Deleting a memory
        shreds it for good - the fact is destroyed, not hidden.
      </Typography>
      <Divider sx={{ my: 2 }} />

      {isLoading && (
        <Box sx={{ display: 'flex', justifyContent: 'center', py: 4 }}>
          <CircularProgress />
        </Box>
      )}

      {isError && !beliefs && (
        <Typography level="body-sm" color="danger">
          Could not load your memory. Please refresh or re-authenticate.
        </Typography>
      )}

      {beliefs && beliefs.length === 0 && (
        <Typography level="body-sm" textColor="text.tertiary" sx={{ py: 3 }}>
          No memories yet. As you chat, the assistant will remember durable facts about you here.
        </Typography>
      )}

      {beliefs && beliefs.length > 0 && (
        <>
          <Typography level="body-xs" textColor="text.tertiary" sx={{ mb: 1 }}>
            {beliefs.length} {beliefs.length === 1 ? 'memory' : 'memories'}
          </Typography>
          <Stack spacing={1}>
            {beliefs.map(b => (
              <BeliefRow
                key={b.id}
                belief={b}
                shredding={shred.isPending && shred.variables === b.id}
                onShred={opts => shred.mutate(b.id, opts)}
              />
            ))}
          </Stack>
        </>
      )}
    </Box>
  );
};

export default MementosV2Panel;

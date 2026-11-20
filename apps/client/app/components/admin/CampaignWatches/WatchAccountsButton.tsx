import { useState, type ReactNode } from 'react';
import { useNavigate } from '@tanstack/react-router';
import { Alert, Button, FormControl, FormLabel, IconButton, Input, Typography } from '@mui/joy';
import { toast } from 'sonner';
import { CAMPAIGN_WATCH_MAX_MEMBERS } from '@bike4mind/common';
import { useUser } from '@client/app/contexts/UserContext';
import {
  canUseCampaignWatches,
  useCreateCampaignWatch,
  watchErrorMessage,
} from '@client/app/hooks/data/campaignWatches';
import { ActionDialog } from '../shared';

export function WatchAccountsButton({
  userIds,
  sourceDetectionId,
  label = 'Watch these accounts',
  incomplete = false,
  incompleteHint = 'This list is incomplete. Open an individual detection to watch a complete group.',
  icon,
  onCreated,
}: {
  userIds: readonly string[];
  sourceDetectionId?: string;
  label?: string;
  incomplete?: boolean;
  /** Tooltip on the disabled button explaining why an incomplete list cannot be watched. */
  incompleteHint?: string;
  /** Renders a ghost icon button labelled `label` instead of a text button, e.g. in a table's row actions. */
  icon?: ReactNode;
  onCreated?: () => void;
}) {
  const { currentUser: user } = useUser();
  const navigate = useNavigate();
  const create = useCreateCampaignWatch();
  const [open, setOpen] = useState(false);
  const [name, setName] = useState('Account watch');
  const [error, setError] = useState<string | null>(null);
  const [snapshot, setSnapshot] = useState<string[]>([]);
  const ids = [...new Set(userIds)];
  if (!canUseCampaignWatches(user) || ids.length === 0) return null;
  const trigger = {
    disabled: incomplete || ids.length > CAMPAIGN_WATCH_MAX_MEMBERS,
    title: incomplete ? incompleteHint : icon ? label : undefined,
    onClick: () => {
      setSnapshot(ids);
      setOpen(true);
      setError(null);
    },
    'data-testid': 'watch-accounts-open-btn',
  };
  return (
    <>
      {icon ? (
        <IconButton size="sm" variant="plain" color="neutral" aria-label={label} {...trigger}>
          {icon}
        </IconButton>
      ) : (
        <Button size="sm" variant="outlined" color="neutral" {...trigger}>
          {label}
        </Button>
      )}
      {open && (
        <ActionDialog
          open
          onClose={() => {
            if (!create.isPending) setOpen(false);
          }}
          title="Watch accounts"
          description="Keeps this fixed group accessible after its AI advisory expires or changes. You own the watch initially; another operator can take ownership."
          reasonPresets={['Monitor account activity', 'Investigate linked accounts']}
          confirmLabel="Create watch"
          blockedReason={
            name.trim().length === 0 || name.trim().length > 80 ? 'Name the watch (up to 80 characters).' : null
          }
          pending={create.isPending}
          data-testid="watch-accounts-dialog"
          onConfirm={async reason => {
            setError(null);
            try {
              const result = await create.mutateAsync({
                name: name.trim(),
                userIds: snapshot,
                sourceDetectionId,
                reason,
              });
              if (!result.created) toast.info('These accounts already have an open watch. Opening it instead.');
              setOpen(false);
              onCreated?.();
              await navigate({ to: '/admin', search: { tab: 'shadow-detections', campaignWatch: result.watch.id } });
            } catch (failure) {
              setError(watchErrorMessage(failure));
            }
          }}
        >
          <FormControl>
            <FormLabel>Watch name</FormLabel>
            <Input
              value={name}
              onChange={event => setName(event.target.value)}
              slotProps={{ input: { maxLength: 80, 'data-testid': 'watch-accounts-name-input' } }}
            />
          </FormControl>
          <Typography level="body-sm">
            {snapshot.length} accounts. This is a manual watch; it does not enable automatic alerts or change account
            access.
          </Typography>
          {error && (
            <Alert color="danger" data-testid="watch-accounts-error">
              {error}
            </Alert>
          )}
        </ActionDialog>
      )}
    </>
  );
}

import { useState } from 'react';
import { useNavigate } from '@tanstack/react-router';
import { Alert, Button, FormControl, FormLabel, Input, Typography } from '@mui/joy';
import { toast } from 'sonner';
import { CAMPAIGN_WATCH_MAX_MEMBERS, hasAdminPermission } from '@bike4mind/common';
import { useUser } from '@client/app/contexts/UserContext';
import { useCreateCampaignWatch, watchErrorMessage } from '@client/app/hooks/data/campaignWatches';
import { ActionDialog } from '../shared';

export function WatchAccountsButton({
  userIds,
  sourceDetectionId,
  label = 'Watch these accounts',
  incomplete = false,
  onCreated,
}: {
  userIds: readonly string[];
  sourceDetectionId?: string;
  label?: string;
  incomplete?: boolean;
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
  if (!hasAdminPermission(user, 'users:moderate') || ids.length === 0) return null;
  return (
    <>
      <Button
        size="sm"
        variant="outlined"
        color="neutral"
        disabled={incomplete || ids.length > CAMPAIGN_WATCH_MAX_MEMBERS}
        title={
          incomplete ? 'This list is incomplete. Open an individual detection to watch a complete group.' : undefined
        }
        onClick={() => {
          setSnapshot(ids);
          setOpen(true);
          setError(null);
        }}
        data-testid="watch-accounts-open-btn"
      >
        {label}
      </Button>
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

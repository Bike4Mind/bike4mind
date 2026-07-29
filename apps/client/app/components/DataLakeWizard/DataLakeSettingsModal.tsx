import { useEffect, useState } from 'react';
import {
  Button,
  DialogActions,
  DialogContent,
  DialogTitle,
  FormControl,
  FormHelperText,
  FormLabel,
  Input,
  Modal,
  ModalDialog,
  Radio,
  RadioGroup,
  Stack,
  Textarea,
} from '@mui/joy';
import { useSetLakeVisibility, useUpdateDataLake } from '@client/app/hooks/data/dataLakes';
import { useAccounts } from '@client/app/components/Credits/AccountSelector';
import { toast } from 'sonner';

export interface EditableLake {
  id: string;
  name: string;
  description: string;
  requiredUserTag: string;
  requiredEntitlement: string;
  /** Current org scope ('' = personal/private). Drives the Visibility control. */
  organizationId: string;
  /** Public opt-in. With organizationId, derives the tri-state Visibility control. */
  isPublic: boolean;
}

/**
 * Edit a lake's metadata (rename, description, access gate). Wires the previously
 * unused useUpdateDataLake hook. Gates can be set or changed but not cleared here -
 * the backend rejects empty values (a deliberate PHI-boundary non-affordance), so we
 * only send a gate field when it's non-empty.
 */
export function DataLakeSettingsModal({ lake, onClose }: { lake: EditableLake | null; onClose: () => void }) {
  const updateLake = useUpdateDataLake();
  const setVisibility = useSetLakeVisibility();
  const { accounts, selectedAccount } = useAccounts();
  // Promotion targets the active account-switcher org, so the toggle is enabled only in a
  // Team context (a non-personal account selected) - matching what the create/visibility
  // calls actually send. `belongsToOrg` (is the user in any org at all) only shapes the hint.
  const activeOrg = selectedAccount && !selectedAccount.personal ? selectedAccount : undefined;
  const belongsToOrg = accounts.some(account => !account.personal);
  const canShareToOrg = !!activeOrg;
  // Tri-state visibility derived from the lake: public wins, else org scope, else private.
  const visibility: 'private' | 'organization' | 'public' = lake?.isPublic
    ? 'public'
    : lake?.organizationId
      ? 'organization'
      : 'private';
  // A gated lake can't be published (the server refuses it) - a PHI/entitlement boundary must
  // not be exposed app-wide. Keyed off the PERSISTED gate, matching the server guardrail.
  const hasGate = !!(lake?.requiredUserTag || lake?.requiredEntitlement);
  // Publishing exposes every file in the lake to all users, so it takes an explicit confirm.
  const [confirmPublicOpen, setConfirmPublicOpen] = useState(false);
  // The org the lake is CURRENTLY scoped to - which for a multi-org owner may not be the
  // active switcher org. Name it from the account list so the "Shared" copy is unambiguous.
  const lakeOrgName = lake?.organizationId
    ? accounts.find(account => account.id === lake.organizationId)?.name
    : undefined;
  const [name, setName] = useState('');
  const [description, setDescription] = useState('');
  const [requiredUserTag, setRequiredUserTag] = useState('');
  const [requiredEntitlement, setRequiredEntitlement] = useState('');

  // Seed the form once per opened lake, keyed on id (NOT the object): `lake` is now derived
  // from the live list, so it changes identity on every refetch - keying on id keeps a
  // background refresh (e.g. after a visibility change) from clobbering in-progress edits.
  useEffect(() => {
    if (lake) {
      setName(lake.name);
      setDescription(lake.description);
      setRequiredUserTag(lake.requiredUserTag);
      setRequiredEntitlement(lake.requiredEntitlement);
    }
    // Intentional id-keying: seed once per lake, not on every live-object refetch.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [lake?.id]);

  // Close the publish-confirm whenever the edited lake changes or clears, so it can never
  // linger over a stale/nulled lake if the parent resets selection while it is open.
  useEffect(() => {
    // Reset-on-lake-change is the intent, so the setState here is deliberate.
    // eslint-disable-next-line react-hooks/set-state-in-effect
    setConfirmPublicOpen(false);
  }, [lake?.id]);

  // A gate can be set or changed but not cleared (the backend rejects empty values). If the
  // user blanks a previously-set gate, the Save silently keeps the old value - surface that
  // instead of only showing the generic "Data lake updated" success.
  const clearingUserTag = !!lake?.requiredUserTag && !requiredUserTag.trim();
  const clearingEntitlement = !!lake?.requiredEntitlement && !requiredEntitlement.trim();

  const handleSave = () => {
    if (!lake) return;
    const trimmedName = name.trim();
    if (!trimmedName) return;
    const clearing = clearingUserTag || clearingEntitlement;
    if (clearing) {
      const kept =
        clearingUserTag && clearingEntitlement
          ? 'tag and entitlement were'
          : clearingUserTag
            ? 'tag was'
            : 'entitlement was';
      toast.warning(`Access gates can be changed but not cleared here — the existing ${kept} kept.`);
    }
    // If blanking a gate is the ONLY change, the update is a no-op the backend ignores - skip it so
    // we don't also fire a misleading "Data lake updated" success alongside the warning above.
    const hasOtherChange =
      trimmedName !== lake.name ||
      description.trim() !== lake.description ||
      (!!requiredUserTag.trim() && requiredUserTag.trim() !== lake.requiredUserTag) ||
      (!!requiredEntitlement.trim() && requiredEntitlement.trim() !== lake.requiredEntitlement);
    if (clearing && !hasOtherChange) {
      onClose();
      return;
    }
    updateLake.mutate(
      {
        id: lake.id,
        name: trimmedName,
        description: description.trim(),
        ...(requiredUserTag.trim() ? { requiredUserTag: requiredUserTag.trim() } : {}),
        ...(requiredEntitlement.trim() ? { requiredEntitlement: requiredEntitlement.trim() } : {}),
      },
      { onSuccess: onClose }
    );
  };

  return (
    <>
      <Modal open={!!lake} onClose={onClose}>
        <ModalDialog
          data-testid="datalake-settings-modal"
          sx={{ width: { xs: '95%', sm: '28rem' }, maxWidth: '28rem' }}
        >
          <DialogTitle>Data lake settings</DialogTitle>
          <DialogContent>
            <Stack gap={2} sx={{ mt: 1 }}>
              <FormControl required>
                <FormLabel>Name</FormLabel>
                <Input value={name} onChange={e => setName(e.target.value)} data-testid="datalake-settings-name" />
              </FormControl>
              <FormControl>
                <FormLabel>Description</FormLabel>
                <Textarea
                  minRows={2}
                  maxRows={5}
                  value={description}
                  onChange={e => setDescription(e.target.value)}
                  data-testid="datalake-settings-description"
                />
              </FormControl>
              <FormControl>
                <FormLabel>Visibility</FormLabel>
                <RadioGroup
                  orientation="horizontal"
                  value={visibility}
                  onChange={e => {
                    if (!lake) return;
                    const next = e.target.value as 'private' | 'organization' | 'public';
                    if (next === visibility) return;
                    // Publishing exposes every file app-wide, so gate it behind an explicit
                    // confirm instead of firing the mutation straight from the radio.
                    if (next === 'public') {
                      setConfirmPublicOpen(true);
                      return;
                    }
                    setVisibility.mutate({ id: lake.id, visibility: next });
                  }}
                  data-testid="datalake-settings-visibility"
                >
                  <Radio value="private" label="Private" disabled={setVisibility.isPending} />
                  <Radio
                    value="organization"
                    label="Organization"
                    disabled={setVisibility.isPending || (!canShareToOrg && visibility !== 'organization')}
                    data-testid="datalake-settings-visibility-org"
                  />
                  <Radio
                    value="public"
                    label="Public"
                    disabled={setVisibility.isPending || (hasGate && visibility !== 'public')}
                    data-testid="datalake-settings-visibility-public"
                  />
                </RadioGroup>
                <FormHelperText>
                  {visibility === 'public'
                    ? 'Public — readable by everyone across the app. Only you can manage or add files.'
                    : hasGate
                      ? 'This lake has an access gate, so it can’t be made public. Choose Private or Organization.'
                      : visibility === 'organization'
                        ? `Shared with everyone in ${lakeOrgName ?? 'your organization'}.`
                        : canShareToOrg
                          ? `Private. “Organization” scopes it to “${activeOrg?.name}”; “Public” exposes it to everyone.`
                          : belongsToOrg
                            ? 'Private. Switch to your team account (top-left account switcher) to share with your organization, or make it public.'
                            : 'Private. Make it public to share with everyone, or join an organization to share with a team.'}
                </FormHelperText>
              </FormControl>
              <FormControl error={clearingUserTag}>
                <FormLabel>Access tag</FormLabel>
                <Input
                  value={requiredUserTag}
                  onChange={e => setRequiredUserTag(e.target.value)}
                  placeholder="e.g. Opti"
                  data-testid="datalake-settings-usertag"
                />
                <FormHelperText>
                  {clearingUserTag
                    ? 'A gate can’t be cleared here — saving keeps the current tag. Change it instead, or contact an admin to remove it.'
                    : 'Users must hold this tag to access the lake. Can be set or changed, not cleared.'}
                </FormHelperText>
              </FormControl>
              <FormControl error={clearingEntitlement}>
                <FormLabel>Required entitlement</FormLabel>
                <Input
                  value={requiredEntitlement}
                  onChange={e => setRequiredEntitlement(e.target.value)}
                  placeholder="e.g. product:pro"
                  data-testid="datalake-settings-entitlement"
                />
                <FormHelperText>
                  {clearingEntitlement
                    ? 'A gate can’t be cleared here — saving keeps the current entitlement. Change it instead, or contact an admin to remove it.'
                    : 'Namespaced key (e.g. "product:pro"). Can be set or changed, not cleared.'}
                </FormHelperText>
              </FormControl>
            </Stack>
          </DialogContent>
          <DialogActions>
            <Button
              variant="solid"
              color="primary"
              loading={updateLake.isPending}
              disabled={!name.trim()}
              onClick={handleSave}
              data-testid="datalake-settings-save-btn"
            >
              Save
            </Button>
            <Button variant="plain" color="neutral" onClick={onClose}>
              Cancel
            </Button>
          </DialogActions>
        </ModalDialog>
      </Modal>
      <Modal open={confirmPublicOpen} onClose={() => setConfirmPublicOpen(false)}>
        <ModalDialog role="alertdialog" data-testid="datalake-publish-confirm" sx={{ maxWidth: '28rem' }}>
          <DialogTitle>Make this data lake public?</DialogTitle>
          <DialogContent>
            Every file in <b>{lake?.name}</b> becomes readable by all users across the app, in every organization. You
            stay the only person who can manage or add files, and you can switch it back to private at any time.
          </DialogContent>
          <DialogActions>
            <Button
              variant="solid"
              color="danger"
              loading={setVisibility.isPending}
              data-testid="datalake-publish-confirm-btn"
              onClick={() => {
                if (!lake) return;
                setVisibility.mutate(
                  { id: lake.id, visibility: 'public' },
                  { onSuccess: () => setConfirmPublicOpen(false) }
                );
              }}
            >
              Make public
            </Button>
            <Button variant="plain" color="neutral" onClick={() => setConfirmPublicOpen(false)}>
              Cancel
            </Button>
          </DialogActions>
        </ModalDialog>
      </Modal>
    </>
  );
}

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
  Option,
  Radio,
  RadioGroup,
  Select,
  Stack,
  Textarea,
} from '@mui/joy';
import { useSetLakeVisibility, useUpdateDataLake } from '@client/app/hooks/data/dataLakes';
import { useActivatablePrompts } from '@client/app/hooks/data/useActivatablePrompts';
import { useAccounts } from '@client/app/components/Credits/AccountSelector';

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
  /**
   * Per-lake system prompt. '' both when unset AND when the caller may not read it (the server
   * sends it only to a lake's editors), so the field renders off `canManage`, never off this.
   */
  systemPrompt: string;
  /**
   * Preferred registry system prompt bound to this lake, by promptId ('' = none). Editor-only,
   * same as systemPrompt: the field renders off `canManage`, not off this value.
   */
  preferredSystemPromptId: string;
  /**
   * Whether the caller may manage this lake - server-computed, see DataLakeConfig.canManage.
   * Gates the editor-only per-lake config fields (System prompt, Preferred prompt).
   */
  canManage: boolean;
}

/**
 * Edit a lake's metadata (rename, description, access gate). Gate fields are always sent,
 * including when blank: the backend reads '' as "remove this gate", so a lake gated by
 * mistake can be returned to ungated. Ungated is NOT world-readable - the lake falls back
 * to its Visibility (private/organization/public), per Private-by-default on the server.
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
  const [systemPrompt, setSystemPrompt] = useState('');
  const [preferredSystemPromptId, setPreferredSystemPromptId] = useState('');
  // Only fetch the picker options when an editor is actually viewing the settings (a lake is open
  // and manageable) - a reader never sees the field, so never pays for the list.
  const { data: activatablePrompts, isLoading: promptsLoading } = useActivatablePrompts(!!lake?.canManage);
  const activatable = activatablePrompts ?? [];
  // The bound prompt's <Option> may be absent: the allowlist loads async (not there on first open),
  // or an admin delisted a prompt this lake was bound to. A controlled Joy Select whose value has
  // no matching <Option> resolves the value to '' and fires onChange - which would silently clear
  // the binding on the next save. Track whether the current value is represented so we can always
  // render an Option for it (see the fallback Option below).
  const boundPromptListed = activatable.some(prompt => prompt.promptId === preferredSystemPromptId);

  // Seed the form once per opened lake, keyed on id (NOT the object): `lake` is now derived
  // from the live list, so it changes identity on every refetch - keying on id keeps a
  // background refresh (e.g. after a visibility change) from clobbering in-progress edits.
  useEffect(() => {
    if (lake) {
      setName(lake.name);
      setDescription(lake.description);
      setRequiredUserTag(lake.requiredUserTag);
      setRequiredEntitlement(lake.requiredEntitlement);
      // Defensive fallback: the type promises a string, but a caller that forgets to
      // normalize a server response missing this field would otherwise set state to
      // undefined and crash the character-count helper text below (`.trim()` on undefined).
      setSystemPrompt(lake.systemPrompt ?? '');
      setPreferredSystemPromptId(lake.preferredSystemPromptId ?? '');
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

  // Blanking a previously-set gate un-gates the lake. Call it out on the way out: what the
  // lake becomes reachable by afterwards is its Visibility, which is not what "removed the
  // gate" reads like on its own.
  const clearingUserTag = !!lake?.requiredUserTag && !requiredUserTag.trim();
  const clearingEntitlement = !!lake?.requiredEntitlement && !requiredEntitlement.trim();

  const handleSave = () => {
    if (!lake) return;
    const trimmedName = name.trim();
    if (!trimmedName) return;
    updateLake.mutate(
      {
        id: lake.id,
        name: trimmedName,
        description: description.trim(),
        // Sent even when blank - '' is the backend's "remove this gate" sentinel.
        requiredUserTag: requiredUserTag.trim(),
        requiredEntitlement: requiredEntitlement.trim(),
        // Only when the field was actually shown. Defense in depth for a state that should be
        // unreachable: the gear button is gated on canManage too, and updateDataLake rejects a
        // non-manager's whole request with a 400 rather than applying part of it - so this branch
        // guards a path no user can currently take. Blank from an EDITOR is a deliberate clear,
        // and '' is what unsets it.
        ...(lake.canManage ? { systemPrompt: systemPrompt.trim() } : {}),
        // Same manage gate + '' clear sentinel as systemPrompt. Sent as-is: '' removes the binding.
        ...(lake.canManage ? { preferredSystemPromptId } : {}),
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
              {/* Editor-only: the wording steers every answer drawn from this lake, but a user
                  who can merely read the lake must never see it - so this renders off the
                  server-computed manage flag, and the server withholds the text from everyone
                  else regardless of what the client does with it. */}
              {lake?.canManage && (
                <FormControl>
                  <FormLabel>System prompt</FormLabel>
                  <Textarea
                    minRows={3}
                    maxRows={10}
                    value={systemPrompt}
                    onChange={e => setSystemPrompt(e.target.value)}
                    placeholder="e.g. Answer only from this lake's documents, and always cite the source file."
                    data-testid="datalake-systemprompt-input"
                  />
                  <FormHelperText data-testid="datalake-systemprompt-help">
                    {`Extra instructions applied to your chats, and to your organization's chats, while this lake is accessible - not only when the lake is used. Your organization's prompt stays authoritative on conflict, and only people who can manage this lake can read this text in the app.${
                      // Count what SAVE will persist (trimmed), not the raw field contents.
                      systemPrompt.trim() ? ` (${systemPrompt.trim().length} characters)` : ''
                    }`}
                  </FormHelperText>
                </FormControl>
              )}
              {/* Per-lake config, editor-only (canManage). This section is the home for lake-scoped
                  session defaults - the preferred prompt today, a per-lake grounding mode next -
                  so new fields join here rather than spawning a second config surface. */}
              {lake?.canManage && (
                <FormControl>
                  <FormLabel>Preferred prompt</FormLabel>
                  <Select
                    value={preferredSystemPromptId}
                    onChange={(_e, value) => setPreferredSystemPromptId(value ?? '')}
                    data-testid="datalake-preferred-prompt-select"
                    slotProps={{ button: { 'data-testid': 'datalake-preferred-prompt-button' } }}
                  >
                    <Option value="" data-testid="datalake-preferred-prompt-none">
                      None
                    </Option>
                    {activatable.map(prompt => (
                      <Option
                        key={prompt.promptId}
                        value={prompt.promptId}
                        data-testid={`datalake-preferred-prompt-${prompt.promptId}`}
                      >
                        {prompt.name}
                      </Option>
                    ))}
                    {/* Keep an Option for the currently-bound value so the controlled Select can
                        always hold it - otherwise a first-open (list still loading) or a delisted
                        prompt collapses the value to '' and a save clears the binding. While the
                        list loads we don't have the display name yet, so show a neutral label; a
                        genuinely delisted id is shown verbatim so the editor can see it. */}
                    {preferredSystemPromptId && !boundPromptListed && (
                      <Option value={preferredSystemPromptId} data-testid="datalake-preferred-prompt-bound-fallback">
                        {promptsLoading ? 'Loading...' : preferredSystemPromptId}
                      </Option>
                    )}
                  </Select>
                  <FormHelperText data-testid="datalake-preferred-prompt-help">
                    Applied when someone starts a chat with this lake, unless they picked their own prompt. Leave as
                    None for the default behavior.
                  </FormHelperText>
                </FormControl>
              )}
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
                      ? 'This lake has an access gate, so it can’t be made public. Clear the gate below and save, then reopen settings to publish.'
                      : visibility === 'organization'
                        ? `Shared with everyone in ${lakeOrgName ?? 'your organization'}.`
                        : canShareToOrg
                          ? `Private. “Organization” scopes it to “${activeOrg?.name}”; “Public” exposes it to everyone.`
                          : belongsToOrg
                            ? 'Private. Switch to your team account (top-left account switcher) to share with your organization, or make it public.'
                            : 'Private. Make it public to share with everyone, or join an organization to share with a team.'}
                </FormHelperText>
              </FormControl>
              <FormControl>
                <FormLabel>Access tag</FormLabel>
                <Input
                  value={requiredUserTag}
                  onChange={e => setRequiredUserTag(e.target.value)}
                  placeholder="e.g. Opti"
                  data-testid="datalake-settings-usertag"
                />
                <FormHelperText data-testid="datalake-settings-usertag-help">
                  {clearingUserTag
                    ? `Saving removes the “${lake?.requiredUserTag}” gate. Access then follows Visibility above.`
                    : 'Users must hold this tag to access the lake. Leave blank for no tag gate.'}
                </FormHelperText>
              </FormControl>
              <FormControl>
                <FormLabel>Required entitlement</FormLabel>
                <Input
                  value={requiredEntitlement}
                  onChange={e => setRequiredEntitlement(e.target.value)}
                  placeholder="e.g. product:pro"
                  data-testid="datalake-settings-entitlement"
                />
                <FormHelperText data-testid="datalake-settings-entitlement-help">
                  {clearingEntitlement
                    ? `Saving removes the “${lake?.requiredEntitlement}” gate. Access then follows Visibility above.`
                    : 'Namespaced key (e.g. "product:pro"). Leave blank for no entitlement gate.'}
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

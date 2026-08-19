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
  Tab,
  TabList,
  TabPanel,
  Tabs,
  Textarea,
} from '@mui/joy';
import { useDataLakeSpend, useSetLakeVisibility, useUpdateDataLake } from '@client/app/hooks/data/dataLakes';
import { useActivatablePrompts } from '@client/app/hooks/data/useActivatablePrompts';
import { useAccounts } from '@client/app/components/Credits/AccountSelector';
import {
  DATA_LAKE_GROUNDING_MODES,
  DEFAULT_DATA_LAKE_GROUNDING_MODE,
  DEFAULT_PASSAGE_TOKEN_TARGET,
  MIN_PASSAGE_TOKEN_TARGET,
  OVERSIZED_PASSAGE_TOKEN_THRESHOLD,
} from '@bike4mind/common';
import type { DataLakeGroundingMode } from '@bike4mind/common';
import { DataLakeSpendPanel } from './DataLakeSpendPanel';

/** Human-facing labels + helper copy for the grounding-mode picker, keyed by the shared enum. */
const GROUNDING_MODE_LABELS: Record<DataLakeGroundingMode, string> = {
  retrieve: 'Retrieve (recommended)',
  inline: 'Inline into the prompt',
  'auto-by-size': 'Auto (decide by size)',
};

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
   * How this lake grounds its corpus into a chat (inline vs retrieve vs auto-by-size). Editor-only,
   * always a concrete mode: the manager panel seeds the default for a lake that never set it, so
   * the picker never has to render an empty selection.
   */
  groundingMode: DataLakeGroundingMode;
  /**
   * The passage size (TOKENS) this lake REQUIRES of its member files, or `null` to inherit the
   * platform default. `null` is not a cosmetic difference: an EXPLICIT target is the sole trigger
   * for convergence (epic decision 5 - `isConvergeablePolicy`), so a lake left inheriting is
   * measured and reported by health but never repaired, and the Converge action never appears.
   */
  requiredPassageTokenTarget: number | null;
  /**
   * Whether the caller may manage this lake - server-computed, see DataLakeConfig.canManage.
   * Gates the editor-only per-lake config fields (System prompt, Preferred prompt, Grounding mode,
   * Required passage size).
   */
  canManage: boolean;
  /**
   * Lifetime embedding-spend meter, ALWAYS present (defaulted to 0) when canManage - its
   * presence, not its value, is the signal that gates the Spend tab (see
   * ManageableDataLakeConfig.embeddingSpendMicroUsd). undefined for a non-manager.
   */
  embeddingSpendMicroUsd?: number;
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
  const [tab, setTab] = useState<'settings' | 'spend'>('settings');
  const [spendDays, setSpendDays] = useState<30 | 60 | 90>(30);
  // Presence (not value) of embeddingSpendMicroUsd is the manage-access signal (see
  // ManageableDataLakeConfig's doc comment) - a zero-spend manageable lake must show the tab too.
  const canViewSpend = !!lake && lake.embeddingSpendMicroUsd !== undefined;
  const spend = useDataLakeSpend(lake?.id ?? null, spendDays, { enabled: canViewSpend && tab === 'spend' });
  // Derived at render, not effect-synced: a 403 removes the tab retroactively and the panel
  // snaps back to Settings with no error paint, matching DataLakeManagerPanel's activeLake pattern.
  const showSpendTab = canViewSpend && !spend.isForbidden;
  const activeTab = showSpendTab ? tab : 'settings';
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
  const [groundingMode, setGroundingMode] = useState<DataLakeGroundingMode>(DEFAULT_DATA_LAKE_GROUNDING_MODE);
  // Held as a STRING, not a number: '' is the "inherit the platform default" state and is what the
  // save maps to the server's `null` clear sentinel. A numeric state would have to overload 0 or
  // NaN for that, and both are values the range check below has to reject anyway.
  const [requiredPassageTokenTarget, setRequiredPassageTokenTarget] = useState('');
  // Only fetch the picker options when an editor is actually viewing the settings (a lake is open
  // and manageable) - a reader never sees the field, so never pays for the list.
  const {
    data: activatablePrompts,
    isLoading: promptsLoading,
    isError: promptsFailed,
  } = useActivatablePrompts(!!lake?.canManage);
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
      setGroundingMode(lake.groundingMode ?? DEFAULT_DATA_LAKE_GROUNDING_MODE);
      setRequiredPassageTokenTarget(
        typeof lake.requiredPassageTokenTarget === 'number' ? String(lake.requiredPassageTokenTarget) : ''
      );
    }
    setTab('settings');
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

  // Validated client-side against the SAME bounds UpdateDataLakeRequestInput enforces, so an
  // out-of-range value is a helper-text correction rather than a 400 that loses the whole form
  // (name, description and the gates are sent in the same request).
  const trimmedTarget = requiredPassageTokenTarget.trim();
  const parsedTarget = trimmedTarget === '' ? null : Number(trimmedTarget);
  const targetInvalid =
    parsedTarget !== null &&
    (!Number.isInteger(parsedTarget) ||
      parsedTarget < MIN_PASSAGE_TOKEN_TARGET ||
      parsedTarget > OVERSIZED_PASSAGE_TOKEN_THRESHOLD);

  const handleSave = () => {
    if (!lake) return;
    const trimmedName = name.trim();
    if (!trimmedName) return;
    if (targetInvalid) return;
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
        // Send only when the editor actually changed the binding. Omitting an unchanged value is
        // "leave as-is" server-side, which (a) never re-sends a now-delisted id that the write
        // boundary would 400 on - that would block saving name/description/gate too - and (b) still
        // lets an explicit None ('') through as a deliberate clear. Pairs with the fallback <Option>
        // above, which keeps the Select from silently resetting the value to '' before we get here.
        ...(lake.canManage && preferredSystemPromptId !== (lake.preferredSystemPromptId ?? '')
          ? { preferredSystemPromptId }
          : {}),
        // Editor-only, same manage gate. Always a concrete mode (no clear sentinel - a lake always
        // has a grounding mode), so it is sent as the chosen enum value.
        ...(lake.canManage ? { groundingMode } : {}),
        // Editor-only, same manage gate. Sent even when null - null is the server's explicit CLEAR
        // sentinel (drop the requirement and go back to inheriting), which is a state an owner has
        // to be able to return to: it is what turns convergence back off for this lake.
        ...(lake.canManage ? { requiredPassageTokenTarget: parsedTarget } : {}),
      },
      { onSuccess: onClose }
    );
  };

  // A plain JSX value (not a nested component function): a component DEFINED inside another
  // component's body gets a new identity every render and would remount its whole subtree
  // (losing focus/in-progress typing) on every keystroke - this is reused as a value instead
  // of invoked as <SettingsFields />, so its identity is just the outer render's.
  const settingsFields = (
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
            {`Extra instructions added to answers on turns that actually pull content from this lake. They apply to you and to members of this lake's organization - not to users granted access by tag or entitlement - and never fire on turns that don't use the lake. Your organization's prompt stays authoritative on conflict, and only people who can manage this lake can read this text in the app.${
              // Count what SAVE will persist (trimmed), not the raw field contents.
              systemPrompt.trim() ? ` (${systemPrompt.trim().length} characters)` : ''
            }`}
          </FormHelperText>
        </FormControl>
      )}
      {/* Per-lake config, editor-only (canManage). This section is the home for lake-scoped
          session defaults - the preferred prompt and the grounding mode - so new fields
          join here rather than spawning a second config surface. */}
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
            {promptsFailed
              ? "Couldn't load the available prompts. Any existing binding is unchanged; reopen settings to try again."
              : 'Applied when someone starts a chat with this lake, unless they picked their own prompt. Leave as None for the default behavior.'}
          </FormHelperText>
        </FormControl>
      )}
      {lake?.canManage && (
        <FormControl>
          <FormLabel>Grounding mode</FormLabel>
          <Select
            value={groundingMode}
            onChange={(_e, value) => setGroundingMode(value ?? DEFAULT_DATA_LAKE_GROUNDING_MODE)}
            data-testid="datalake-grounding-mode-select"
            slotProps={{ button: { 'data-testid': 'datalake-grounding-mode-button' } }}
          >
            {DATA_LAKE_GROUNDING_MODES.map(mode => (
              <Option key={mode} value={mode} data-testid={`datalake-grounding-mode-${mode}`}>
                {GROUNDING_MODE_LABELS[mode]}
              </Option>
            ))}
          </Select>
          <FormHelperText data-testid="datalake-grounding-mode-help">
            How a chat started with this lake uses its documents. Retrieve searches the lake on demand (same for owners
            and readers); Inline pastes the documents into the prompt; Auto decides by corpus size.
          </FormHelperText>
        </FormControl>
      )}
      {lake?.canManage && (
        <FormControl error={targetInvalid}>
          <FormLabel>Required passage size</FormLabel>
          <Input
            type="number"
            value={requiredPassageTokenTarget}
            onChange={e => setRequiredPassageTokenTarget(e.target.value)}
            placeholder={`Inherit the default (${DEFAULT_PASSAGE_TOKEN_TARGET})`}
            slotProps={{
              input: {
                min: MIN_PASSAGE_TOKEN_TARGET,
                max: OVERSIZED_PASSAGE_TOKEN_THRESHOLD,
                step: 1,
                'data-testid': 'datalake-passage-target-input',
              },
            }}
          />
          <FormHelperText data-testid="datalake-passage-target-help">
            {targetInvalid
              ? `Enter a whole number between ${MIN_PASSAGE_TOKEN_TARGET} and ${OVERSIZED_PASSAGE_TOKEN_THRESHOLD}, or leave blank to inherit the default.`
              : 'How large this lake needs its documents chunked, in tokens. Leave blank to inherit the platform ' +
                'default - a lake that inherits is measured by health but never repaired, so setting a value here is ' +
                'what enables "Converge to policy". Changing it does not re-chunk anything on its own.'}
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
            ? 'Public \u2014 readable by everyone across the app. Only you can manage or add files.'
            : hasGate
              ? "This lake has an access gate, so it can't be made public. Clear the gate below and save, then reopen settings to publish."
              : visibility === 'organization'
                ? `Shared with everyone in ${lakeOrgName ?? 'your organization'}.`
                : canShareToOrg
                  ? `Private. \u201COrganization\u201D scopes it to \u201C${activeOrg?.name}\u201D; \u201CPublic\u201D exposes it to everyone.`
                  : belongsToOrg
                    ? 'Private. Switch to your team account (the profile card at the bottom left) to share with your organization, or make it public.'
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
            ? `Saving removes the \u201C${lake?.requiredUserTag}\u201D gate. Access then follows Visibility above.`
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
            ? `Saving removes the \u201C${lake?.requiredEntitlement}\u201D gate. Access then follows Visibility above.`
            : 'Namespaced key (e.g. \u201Cproduct:pro\u201D). Leave blank for no entitlement gate.'}
        </FormHelperText>
      </FormControl>
    </Stack>
  );

  return (
    <>
      <Modal open={!!lake} onClose={onClose}>
        <ModalDialog
          data-testid="datalake-settings-modal"
          sx={{
            width: { xs: '95%', sm: activeTab === 'spend' ? '44rem' : '28rem' },
            maxWidth: activeTab === 'spend' ? '44rem' : '28rem',
          }}
        >
          <DialogTitle>Data lake settings</DialogTitle>
          <DialogContent>
            {showSpendTab ? (
              <Tabs
                value={activeTab}
                onChange={(_e, value) => setTab(value as 'settings' | 'spend')}
                sx={{ mt: 1, background: 'transparent' }}
              >
                <TabList sx={{ mb: 2 }}>
                  <Tab value="settings" data-testid="datalake-settings-tab-settings">
                    Settings
                  </Tab>
                  <Tab value="spend" data-testid="datalake-settings-tab-spend">
                    Spend
                  </Tab>
                </TabList>
                <TabPanel value="settings" sx={{ p: 0 }}>
                  {settingsFields}
                </TabPanel>
                <TabPanel value="spend" sx={{ p: 0 }}>
                  <DataLakeSpendPanel
                    summary={spend.data}
                    days={spendDays}
                    onDaysChange={setSpendDays}
                    isLoading={spend.isLoading}
                    isFetching={spend.isFetching}
                    error={spend.isForbidden ? null : spend.error}
                    onRefetch={() => spend.refetch()}
                  />
                </TabPanel>
              </Tabs>
            ) : (
              settingsFields
            )}
          </DialogContent>
          {/* Save/Cancel apply to the Settings form only - the Spend tab has nothing to
              save, so these belong to that tab, not the modal as a whole. */}
          {activeTab !== 'spend' && (
            <DialogActions>
              <Button
                variant="solid"
                color="primary"
                loading={updateLake.isPending}
                disabled={!name.trim() || targetInvalid}
                onClick={handleSave}
                data-testid="datalake-settings-save-btn"
              >
                Save
              </Button>
              <Button variant="plain" color="neutral" onClick={onClose}>
                Cancel
              </Button>
            </DialogActions>
          )}
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

import { useEffect, useState } from 'react';
import {
  Button,
  DialogActions,
  DialogContent,
  DialogTitle,
  FormControl,
  FormHelperText,
  FormLabel,
  Modal,
  ModalDialog,
  Option,
  Select,
  Textarea,
} from '@mui/joy';
import { useUpdateFallbackLakeSettings } from '@client/app/hooks/data/dataLakes';
import { useActivatablePrompts } from '@client/app/hooks/data/useActivatablePrompts';
import { DATA_LAKE_GROUNDING_MODES, DEFAULT_DATA_LAKE_GROUNDING_MODE } from '@bike4mind/common';
import type { DataLakeGroundingMode } from '@bike4mind/common';

/** Mirrors DataLakeSettingsModal's copy for the same picker, so the two editors read identically. */
const GROUNDING_MODE_LABELS: Record<DataLakeGroundingMode, string> = {
  retrieve: 'Retrieve (recommended)',
  inline: 'Inline into the prompt',
  'auto-by-size': 'Auto (decide by size)',
};

export interface EditableFallbackLake {
  id: string;
  name: string;
  groundingMode: DataLakeGroundingMode;
  /** '' means no preferred prompt bound - same sentinel as DataLakeSettingsModal's field. */
  preferredSystemPromptId: string;
  /** '' means unset - same as DataLakeSettingsModal's field. */
  systemPrompt: string;
  /**
   * Whether this lake is currently org-scoped - drives which helper text `systemPrompt` shows.
   * `isTrustedForInjection` (getDataLakePrompts.ts) never injects a GATELESS registry lake's
   * prompt, so an admin editing one needs to know the value they are typing is stored but inert
   * until (if ever) the lake is scoped to an org - it is not a silent no-op to hide from them.
   */
  organizationId: string;
}

/**
 * Edit a STATIC (registry) lake's admin-settable overlay - `groundingMode`,
 * `preferredSystemPromptId` and `systemPrompt`. Not `DataLakeSettingsModal`: a fallback lake has no
 * name/description/gate/visibility to edit (it is curated config, not a document), so reusing that
 * modal would offer affordances that 400 server-side.
 */
export function FallbackLakeSettingsModal({
  lake,
  onClose,
}: {
  lake: EditableFallbackLake | null;
  onClose: () => void;
}) {
  const updateSettings = useUpdateFallbackLakeSettings();
  const [groundingMode, setGroundingMode] = useState<DataLakeGroundingMode>(DEFAULT_DATA_LAKE_GROUNDING_MODE);
  const [preferredSystemPromptId, setPreferredSystemPromptId] = useState('');
  const [systemPrompt, setSystemPrompt] = useState('');
  // Only fetch the picker options while the modal is actually open - mirrors DataLakeSettingsModal.
  const { data: activatablePrompts, isLoading: promptsLoading, isError: promptsFailed } = useActivatablePrompts(!!lake);
  const activatable = activatablePrompts ?? [];
  // Same reasoning as DataLakeSettingsModal: the allowlist loads async, or an admin may have
  // delisted a prompt this lake was bound to. Keep a fallback <Option> for the bound value so a
  // controlled Select never silently resets it to '' (which would clear the binding on save).
  const boundPromptListed = activatable.some(prompt => prompt.promptId === preferredSystemPromptId);

  // Seed once per opened lake, keyed on id (not the object) - matching DataLakeSettingsModal's
  // reasoning: `lake` is derived from the live list, so a background refetch must not clobber an
  // in-progress edit.
  useEffect(() => {
    if (lake) {
      setGroundingMode(lake.groundingMode);
      setPreferredSystemPromptId(lake.preferredSystemPromptId);
      setSystemPrompt(lake.systemPrompt);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [lake?.id]);

  const handleSave = () => {
    if (!lake) return;
    updateSettings.mutate(
      // EVERY field is sent only when actually changed, and for this lake kind that is a data-safety
      // rule, not just tidiness. A registry lake's settings come from a SEPARATE overlay read
      // (resolveFallbackSettings) that degrades to "nothing set" on a transient failure while the
      // lake still renders - unlike a DB lake, whose prompt lives on the document itself, so a
      // failed read means the lake simply does not appear and there is nothing to seed from. Sending
      // an unchanged field would therefore write a degraded seed back over real stored values.
      // Omitting one means "leave as-is" server-side; an explicit '' is still a deliberate clear.
      {
        id: lake.id,
        ...(groundingMode !== lake.groundingMode ? { groundingMode } : {}),
        // Also avoids re-sending a now-delisted id the picker still shows (via the fallback Option
        // above), which would 400 a save of otherwise-unrelated fields.
        ...(preferredSystemPromptId !== lake.preferredSystemPromptId ? { preferredSystemPromptId } : {}),
        ...(systemPrompt.trim() !== lake.systemPrompt.trim() ? { systemPrompt: systemPrompt.trim() } : {}),
      },
      { onSuccess: onClose }
    );
  };

  return (
    <Modal open={!!lake} onClose={onClose}>
      <ModalDialog
        data-testid="fallback-lake-settings-modal"
        sx={{ width: { xs: '95%', sm: '28rem' }, maxWidth: '28rem' }}
      >
        <DialogTitle>{lake?.name ?? 'Data lake'} settings</DialogTitle>
        <DialogContent>
          <FormControl>
            <FormLabel>System prompt</FormLabel>
            <Textarea
              minRows={3}
              maxRows={10}
              value={systemPrompt}
              onChange={e => setSystemPrompt(e.target.value)}
              placeholder="e.g. Answer only from this lake's documents, and always cite the source file."
              data-testid="fallback-lake-systemprompt-input"
            />
            <FormHelperText data-testid="fallback-lake-systemprompt-help">
              {lake?.organizationId
                ? "Extra instructions added to answers on turns that use this lake, for members of this lake's organization."
                : "This lake is global (not scoped to an organization), so this prompt is stored but NEVER injected into anyone's turn - only an org-scoped registry lake's prompt is ever used. Scope this lake to an org to activate it."}
              {systemPrompt.trim() ? ` (${systemPrompt.trim().length} characters)` : ''}
            </FormHelperText>
          </FormControl>
          <FormControl sx={{ mt: 2 }}>
            <FormLabel>Grounding mode</FormLabel>
            <Select
              value={groundingMode}
              onChange={(_e, value) => setGroundingMode(value ?? DEFAULT_DATA_LAKE_GROUNDING_MODE)}
              data-testid="fallback-lake-grounding-mode-select"
              slotProps={{ button: { 'data-testid': 'fallback-lake-grounding-mode-button' } }}
            >
              {DATA_LAKE_GROUNDING_MODES.map(mode => (
                <Option key={mode} value={mode} data-testid={`fallback-lake-grounding-mode-${mode}`}>
                  {GROUNDING_MODE_LABELS[mode]}
                </Option>
              ))}
            </Select>
            <FormHelperText data-testid="fallback-lake-grounding-mode-help">
              How a chat started with this lake uses its documents. Retrieve searches the lake on demand; Inline pastes
              the documents into the prompt; Auto decides by corpus size.
            </FormHelperText>
          </FormControl>
          <FormControl sx={{ mt: 2 }}>
            <FormLabel>Preferred prompt</FormLabel>
            <Select
              value={preferredSystemPromptId}
              onChange={(_e, value) => setPreferredSystemPromptId(value ?? '')}
              data-testid="fallback-lake-preferred-prompt-select"
              slotProps={{ button: { 'data-testid': 'fallback-lake-preferred-prompt-button' } }}
            >
              <Option value="" data-testid="fallback-lake-preferred-prompt-none">
                None
              </Option>
              {activatable.map(prompt => (
                <Option
                  key={prompt.promptId}
                  value={prompt.promptId}
                  data-testid={`fallback-lake-preferred-prompt-${prompt.promptId}`}
                >
                  {prompt.name}
                </Option>
              ))}
              {preferredSystemPromptId && !boundPromptListed && (
                <Option value={preferredSystemPromptId} data-testid="fallback-lake-preferred-prompt-bound-fallback">
                  {promptsLoading ? 'Loading...' : preferredSystemPromptId}
                </Option>
              )}
            </Select>
            <FormHelperText data-testid="fallback-lake-preferred-prompt-help">
              {promptsFailed
                ? "Couldn't load the available prompts. Any existing binding is unchanged; reopen settings to try again."
                : 'Applied when someone starts a chat with this lake, unless they picked their own prompt. Leave as None for the default behavior.'}
            </FormHelperText>
          </FormControl>
        </DialogContent>
        <DialogActions>
          <Button
            variant="solid"
            color="primary"
            loading={updateSettings.isPending}
            onClick={handleSave}
            data-testid="fallback-lake-settings-save-btn"
          >
            Save
          </Button>
          <Button variant="plain" color="neutral" onClick={onClose}>
            Cancel
          </Button>
        </DialogActions>
      </ModalDialog>
    </Modal>
  );
}

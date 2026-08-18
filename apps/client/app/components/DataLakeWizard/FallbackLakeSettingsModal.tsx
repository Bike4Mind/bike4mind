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
} from '@mui/joy';
import { useUpdateFallbackLakeSettings } from '@client/app/hooks/data/dataLakes';
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
}

/**
 * Edit a STATIC (registry) lake's admin-settable overlay - currently `groundingMode` only. Not
 * `DataLakeSettingsModal`: a fallback lake has no name/description/gate/visibility to edit (it is
 * curated config, not a document), so reusing that modal would offer affordances that 400 server-
 * side. `systemPrompt` and `preferredSystemPromptId` are not here yet - see IFallbackLakeSetting's
 * doc comment for why.
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

  // Seed once per opened lake, keyed on id (not the object) - matching DataLakeSettingsModal's
  // reasoning: `lake` is derived from the live list, so a background refetch must not clobber an
  // in-progress edit.
  useEffect(() => {
    if (lake) setGroundingMode(lake.groundingMode);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [lake?.id]);

  const handleSave = () => {
    if (!lake) return;
    updateSettings.mutate({ id: lake.id, groundingMode }, { onSuccess: onClose });
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

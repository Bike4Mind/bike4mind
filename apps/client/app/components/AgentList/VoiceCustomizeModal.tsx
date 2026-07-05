import { FC, useState } from 'react';
import {
  Button,
  DialogContent,
  DialogTitle,
  FormControl,
  FormLabel,
  Modal,
  ModalClose,
  ModalDialog,
  Option,
  Select,
  Stack,
  Textarea,
  Typography,
} from '@mui/joy';
import { toast } from 'sonner';
import { api } from '@client/app/contexts/ApiContext';
import { useUser } from '@client/app/contexts/UserContext';
import { useElevenLabsVoices } from '@client/app/hooks/data/elevenLabsVoices';

interface VoiceCustomizeModalProps {
  open: boolean;
  onClose: () => void;
  agentName: string;
}

/**
 * Per-user voice customization for the org's voice agent. Saves voice + system
 * prompt overrides onto the user document; they're layered on top of the
 * default voice agent at session start.
 */
const VoiceCustomizeModal: FC<VoiceCustomizeModalProps> = ({ open, onClose, agentName }) => {
  const { currentUser, setCurrentUser } = useUser();
  const { data: voices = [], isLoading: voicesLoading } = useElevenLabsVoices();

  const [voiceOverrideId, setVoiceOverrideId] = useState<string>(currentUser?.voiceOverrideId ?? '');
  const [promptOverride, setPromptOverride] = useState<string>(currentUser?.voiceSystemPromptOverride ?? '');
  const [saving, setSaving] = useState(false);

  const dirty =
    voiceOverrideId !== (currentUser?.voiceOverrideId ?? '') ||
    promptOverride !== (currentUser?.voiceSystemPromptOverride ?? '');

  const handleSave = async () => {
    if (!currentUser) return;
    setSaving(true);
    try {
      const response = await api.put(`/api/users/${currentUser.id}/update`, {
        voiceOverrideId: voiceOverrideId || null,
        voiceSystemPromptOverride: promptOverride.trim() || null,
      });
      setCurrentUser(response.data);
      toast.success('Voice customization saved');
      onClose();
    } catch (e) {
      console.error('Failed to save voice customization', e);
      toast.error('Failed to save voice customization');
    } finally {
      setSaving(false);
    }
  };

  return (
    <Modal open={open} onClose={onClose}>
      <ModalDialog data-testid="voice-customize-modal" sx={{ width: 520, maxWidth: '95vw', gap: 2 }}>
        <ModalClose />
        <DialogTitle sx={{ color: 'text.primary' }}>Customize {agentName}</DialogTitle>
        <DialogContent sx={{ display: 'grid', gap: 2 }}>
          <Typography level="body-sm" sx={{ color: 'text.tertiary' }}>
            Optional overrides applied on top of this voice agent — just for you. Leave blank to use the agent&apos;s
            own voice and system prompt.
          </Typography>

          <FormControl>
            <FormLabel>Voice override</FormLabel>
            <Select
              value={voiceOverrideId || null}
              onChange={(_, v) => setVoiceOverrideId(v ?? '')}
              placeholder={voicesLoading ? 'Loading voices…' : "Use the agent's voice"}
              data-testid="voice-customize-voice"
            >
              <Option value="">Use the agent&apos;s voice</Option>
              {voices.map(v => (
                <Option key={v.id} value={v.id}>
                  {v.name}
                  {v.labels.accent ? ` — ${v.labels.accent}` : ''}
                </Option>
              ))}
            </Select>
          </FormControl>

          <FormControl>
            <FormLabel>System prompt override</FormLabel>
            <Textarea
              value={promptOverride}
              onChange={e => setPromptOverride(e.target.value)}
              minRows={3}
              placeholder="Leave blank to use the agent's own system prompt"
              data-testid="voice-customize-prompt"
            />
          </FormControl>

          <Stack direction="row" spacing={1} justifyContent="flex-end">
            <Button variant="plain" color="neutral" onClick={onClose} disabled={saving}>
              Cancel
            </Button>
            <Button
              onClick={handleSave}
              disabled={!dirty || saving}
              loading={saving}
              data-testid="voice-customize-save"
            >
              Save customization
            </Button>
          </Stack>
        </DialogContent>
      </ModalDialog>
    </Modal>
  );
};

export default VoiceCustomizeModal;

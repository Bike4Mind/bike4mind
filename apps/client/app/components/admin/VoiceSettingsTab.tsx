import { FC, useEffect, useRef, useState } from 'react';
import {
  Alert,
  Box,
  Button,
  Card,
  CircularProgress,
  FormControl,
  FormLabel,
  IconButton,
  Input,
  Modal,
  ModalDialog,
  Option,
  Select,
  Sheet,
  Stack,
  Switch,
  Textarea,
  Tooltip,
  Typography,
} from '@mui/joy';
import AddIcon from '@mui/icons-material/Add';
import DeleteIcon from '@mui/icons-material/DeleteOutline';
import DownloadIcon from '@mui/icons-material/DownloadOutlined';
import EditIcon from '@mui/icons-material/EditOutlined';
import PlayArrowIcon from '@mui/icons-material/PlayArrowRounded';
import StopIcon from '@mui/icons-material/StopRounded';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { toast } from 'sonner';
import { api } from '@client/app/contexts/ApiContext';
import type { IAgent } from '@bike4mind/common';
import { useElevenLabsVoices } from '@client/app/hooks/data/elevenLabsVoices';
import { downloadData } from '@client/app/utils/download';

interface VoiceAgentsListResponse {
  agents: IAgent[];
}

type TurnEagerness = 'patient' | 'normal' | 'eager';

interface FormState {
  name: string;
  description: string;
  voiceId: string;
  systemPrompt: string;
  firstMessage: string;
  turnEagerness: TurnEagerness;
  turnTimeoutSeconds: number;
}

const DEFAULT_FIRST_MESSAGE = 'Hello! How can I help you today?';

// Voice users frequently pause mid-thought, so default to the least eager
// turn-taking; admins can dial it up per agent. Mirrors createElevenLabsAgent.
const DEFAULT_TURN_EAGERNESS: TurnEagerness = 'patient';
const DEFAULT_TURN_TIMEOUT_SECONDS = 10;

const TURN_EAGERNESS_OPTIONS: { value: TurnEagerness; label: string }[] = [
  { value: 'patient', label: 'Patient — waits longest (best for users who pause)' },
  { value: 'normal', label: 'Normal — balanced (ElevenLabs default)' },
  { value: 'eager', label: 'Eager — responds soonest (may cut users off)' },
];

// Joy's Select onChange yields `string | null`; narrow it to a real option
// instead of asserting the type, falling back to the default for anything else.
const isTurnEagerness = (v: unknown): v is TurnEagerness => TURN_EAGERNESS_OPTIONS.some(o => o.value === v);

// Prefilled into the system prompt when creating a new voice agent. Tuned for
// voice: concise and conversational.
const DEFAULT_SYSTEM_PROMPT = `You are a helpful AI assistant engaged in a voice conversation.
Be conversational, friendly, and concise in your responses.
When the user asks about previous discussions, refer back to the conversation context naturally.
Keep responses brief and suitable for voice - avoid long lists or complex formatting.
When you get a tool result back, summarize it conversationally for voice.`;

const EMPTY_FORM: FormState = {
  name: '',
  description: '',
  voiceId: '',
  systemPrompt: DEFAULT_SYSTEM_PROMPT,
  firstMessage: DEFAULT_FIRST_MESSAGE,
  turnEagerness: DEFAULT_TURN_EAGERNESS,
  turnTimeoutSeconds: DEFAULT_TURN_TIMEOUT_SECONDS,
};

const ADMIN_VOICE_AGENTS_KEY = ['admin/voice-agents'] as const;

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function errDetail(e: any): string {
  return e?.response?.data?.detail ?? e?.response?.data?.error ?? (e instanceof Error ? e.message : String(e));
}

const VoiceSettingsTab: FC = () => {
  const queryClient = useQueryClient();
  const {
    data: agentsData,
    isLoading,
    error,
  } = useQuery({
    queryKey: ADMIN_VOICE_AGENTS_KEY,
    queryFn: async (): Promise<IAgent[]> => {
      const res = await api.get<VoiceAgentsListResponse>('/api/admin/voice-agents');
      return res.data.agents;
    },
  });

  const { data: voices = [], isLoading: voicesLoading } = useElevenLabsVoices();

  // null = closed; '' = creating; <id> = editing that agent.
  const [editorId, setEditorId] = useState<string | null>(null);
  const isEditing = Boolean(editorId);
  const [form, setForm] = useState<FormState>(EMPTY_FORM);

  // Voice preview playback. ElevenLabs returns a short sample clip per voice
  // (`previewUrl`); we play one at a time and track which is sounding so the
  // dropdown can show a stop affordance.
  const previewAudioRef = useRef<HTMLAudioElement | null>(null);
  const [previewingVoiceId, setPreviewingVoiceId] = useState<string | null>(null);

  const stopPreview = () => {
    previewAudioRef.current?.pause();
    previewAudioRef.current = null;
    setPreviewingVoiceId(null);
  };

  const togglePreview = (voiceId: string, url?: string) => {
    if (!url) return;
    // Clicking the playing voice again stops it.
    if (previewingVoiceId === voiceId) {
      stopPreview();
      return;
    }
    stopPreview();
    const audio = new Audio(url);
    previewAudioRef.current = audio;
    setPreviewingVoiceId(voiceId);
    audio.onended = () => setPreviewingVoiceId(null);
    audio.onerror = () => {
      setPreviewingVoiceId(null);
      toast.error('Could not play voice preview');
    };
    void audio.play().catch(() => setPreviewingVoiceId(null));
  };

  // Stop any preview when the component unmounts.
  useEffect(() => stopPreview, []);

  const closeEditor = () => {
    stopPreview();
    setEditorId(null);
    setForm(EMPTY_FORM);
  };

  const openCreate = () => {
    setForm(EMPTY_FORM);
    setEditorId('');
  };

  // Downloads the live ElevenLabs agent configuration (the full
  // conversation_config ElevenLabs stores), not our thin B4M mirror. The server
  // fetches it from ElevenLabs by elevenLabsAgentId on demand.
  const [downloadingId, setDownloadingId] = useState<string | null>(null);
  const downloadConfig = async (agent: IAgent) => {
    setDownloadingId(agent.id);
    try {
      const res = await api.get<{ config: unknown }>(`/api/admin/voice-agents/${agent.id}`);
      const slug =
        agent.name
          .trim()
          .toLowerCase()
          .replace(/[^a-z0-9]+/g, '-')
          .replace(/^-+|-+$/g, '') || agent.id;
      downloadData(JSON.stringify(res.data.config, null, 2), `voice-agent-${slug}.json`, 'application/json');
      toast.success('ElevenLabs agent config downloaded');
    } catch (e) {
      toast.error(`Failed to download config: ${errDetail(e)}`);
    } finally {
      setDownloadingId(null);
    }
  };

  const openEdit = (agent: IAgent) => {
    setForm({
      name: agent.name,
      description: agent.description ?? '',
      voiceId: agent.elevenLabsVoiceId ?? '',
      systemPrompt: agent.systemPrompt ?? '',
      firstMessage: agent.firstMessage ?? DEFAULT_FIRST_MESSAGE,
      turnEagerness: agent.turnEagerness ?? DEFAULT_TURN_EAGERNESS,
      turnTimeoutSeconds: agent.turnTimeoutSeconds ?? DEFAULT_TURN_TIMEOUT_SECONDS,
    });
    setEditorId(agent.id);
  };

  const saveMutation = useMutation({
    mutationFn: async (state: FormState) => {
      if (isEditing && editorId) {
        const res = await api.patch(`/api/admin/voice-agents/${editorId}`, state);
        return res.data;
      }
      const res = await api.post('/api/admin/voice-agents', state);
      return res.data;
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ADMIN_VOICE_AGENTS_KEY });
      toast.success(isEditing ? 'Voice agent updated' : 'Voice agent created');
      closeEditor();
    },
    onError: (e: unknown) => toast.error(`Failed to save: ${errDetail(e)}`),
  });

  const deleteMutation = useMutation({
    mutationFn: async (id: string) => {
      await api.delete(`/api/admin/voice-agents/${id}`);
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ADMIN_VOICE_AGENTS_KEY });
      toast.success('Voice agent deleted');
    },
    onError: () => toast.error('Failed to delete voice agent'),
  });

  const defaultMutation = useMutation({
    mutationFn: async ({ id, isDefault }: { id: string; isDefault: boolean }) => {
      await api.patch(`/api/admin/voice-agents/${id}`, { isDefault });
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ADMIN_VOICE_AGENTS_KEY });
    },
    onError: () => toast.error('Failed to update default voice agent'),
  });

  const canSubmit = form.name.trim() && form.voiceId && form.systemPrompt.trim();

  return (
    <Box sx={{ p: 3, display: 'flex', flexDirection: 'column', gap: 2 }}>
      <Stack direction="row" justifyContent="space-between" alignItems="center">
        <Box>
          <Typography level="h3">Voice Settings</Typography>
          <Typography level="body-sm" sx={{ color: 'text.tertiary' }}>
            Create ElevenLabs Conversational AI agents and expose them to all users on the /agents page.
          </Typography>
        </Box>
        <Button startDecorator={<AddIcon />} onClick={openCreate} data-testid="voice-settings-create-btn">
          New voice agent
        </Button>
      </Stack>

      {isLoading ? (
        <Box display="flex" justifyContent="center" py={4}>
          <CircularProgress />
        </Box>
      ) : error ? (
        <Alert color="danger" variant="soft">
          Failed to load voice agents. Confirm Voice v2 is enabled and the ElevenLabs server API key is configured under
          Admin Settings.
        </Alert>
      ) : !agentsData || agentsData.length === 0 ? (
        <Sheet variant="soft" sx={{ p: 3, textAlign: 'center', borderRadius: 'sm' }}>
          <Typography level="body-md">
            No voice agents yet. Click <em>New voice agent</em> to create one.
          </Typography>
        </Sheet>
      ) : (
        <Stack spacing={1.5} data-testid="voice-settings-list">
          {agentsData.map(agent => (
            <Card
              key={agent.id}
              variant="outlined"
              sx={{ flexDirection: 'row', alignItems: 'center', gap: 2, p: 2 }}
              data-testid={`voice-settings-row-${agent.id}`}
            >
              <Box sx={{ flex: 1 }}>
                <Typography level="title-md">{agent.name}</Typography>
                {agent.description && (
                  <Typography level="body-sm" sx={{ color: 'text.tertiary' }}>
                    {agent.description}
                  </Typography>
                )}
                <Typography level="body-xs" sx={{ color: 'text.tertiary', fontFamily: 'monospace', mt: 0.5 }}>
                  ElevenLabs agent ID: {agent.elevenLabsAgentId ?? '—'}
                </Typography>
              </Box>
              <Tooltip title="Default voice assistant for users with no personal selection">
                <Box sx={{ display: 'flex', alignItems: 'center', gap: 1 }}>
                  <Typography level="body-sm" sx={{ color: 'text.tertiary' }}>
                    Default
                  </Typography>
                  <Switch
                    checked={Boolean(agent.isDefaultVoiceAgent)}
                    disabled={defaultMutation.isPending}
                    onChange={e => defaultMutation.mutate({ id: agent.id, isDefault: e.target.checked })}
                    data-testid={`voice-settings-default-${agent.id}`}
                  />
                </Box>
              </Tooltip>
              <Tooltip title="Download ElevenLabs agent config as JSON">
                <IconButton
                  variant="plain"
                  color="neutral"
                  loading={downloadingId === agent.id}
                  onClick={() => downloadConfig(agent)}
                  data-testid={`voice-settings-download-${agent.id}`}
                >
                  <DownloadIcon />
                </IconButton>
              </Tooltip>
              <IconButton
                variant="plain"
                color="neutral"
                onClick={() => openEdit(agent)}
                data-testid={`voice-settings-edit-${agent.id}`}
              >
                <EditIcon />
              </IconButton>
              <IconButton
                variant="plain"
                color="danger"
                disabled={deleteMutation.isPending}
                onClick={() => {
                  if (confirm(`Delete voice agent "${agent.name}"? This also removes the ElevenLabs agent.`)) {
                    deleteMutation.mutate(agent.id);
                  }
                }}
                data-testid={`voice-settings-delete-${agent.id}`}
              >
                <DeleteIcon />
              </IconButton>
            </Card>
          ))}
        </Stack>
      )}

      <Modal open={editorId !== null} onClose={closeEditor}>
        <ModalDialog data-testid="voice-settings-editor-modal" sx={{ width: 520, maxWidth: '95vw' }}>
          <Typography level="h4">{isEditing ? 'Edit voice agent' : 'New voice agent'}</Typography>
          <Stack spacing={2} sx={{ mt: 1 }}>
            <FormControl required>
              <FormLabel>Name</FormLabel>
              <Input
                value={form.name}
                onChange={e => setForm({ ...form, name: e.target.value })}
                placeholder="e.g. British Concierge"
                data-testid="voice-settings-form-name"
              />
            </FormControl>
            <FormControl>
              <FormLabel>Description</FormLabel>
              <Input
                value={form.description}
                onChange={e => setForm({ ...form, description: e.target.value })}
                placeholder="Optional — shown on the user-facing card"
              />
            </FormControl>
            <FormControl>
              <FormLabel>First message</FormLabel>
              <Input
                value={form.firstMessage}
                onChange={e => setForm({ ...form, firstMessage: e.target.value })}
                placeholder="Spoken greeting the agent opens with"
                data-testid="voice-settings-form-first-message"
              />
            </FormControl>
            <FormControl required>
              <FormLabel>Voice</FormLabel>
              <Select
                value={form.voiceId || null}
                onChange={(_, v) => setForm({ ...form, voiceId: v ?? '' })}
                placeholder={voicesLoading ? 'Loading ElevenLabs voices…' : 'Pick a voice'}
                data-testid="voice-settings-form-voice"
              >
                {voices.map(v => (
                  <Option key={v.id} value={v.id}>
                    <Box
                      sx={{
                        display: 'flex',
                        alignItems: 'center',
                        justifyContent: 'space-between',
                        gap: 1,
                        width: '100%',
                      }}
                    >
                      <span>
                        {v.name}
                        {v.labels.accent ? ` — ${v.labels.accent}` : ''}
                      </span>
                      {v.previewUrl && (
                        <IconButton
                          size="sm"
                          variant="plain"
                          color="neutral"
                          aria-label={previewingVoiceId === v.id ? `Stop ${v.name} preview` : `Play ${v.name} preview`}
                          // Stop the click/mousedown from selecting (and closing) the option.
                          onMouseDown={e => e.stopPropagation()}
                          onClick={e => {
                            e.stopPropagation();
                            e.preventDefault();
                            togglePreview(v.id, v.previewUrl);
                          }}
                          data-testid={`voice-settings-preview-${v.id}`}
                        >
                          {previewingVoiceId === v.id ? (
                            <StopIcon fontSize="small" />
                          ) : (
                            <PlayArrowIcon fontSize="small" />
                          )}
                        </IconButton>
                      )}
                    </Box>
                  </Option>
                ))}
              </Select>
            </FormControl>
            <FormControl required>
              <FormLabel>System prompt</FormLabel>
              <Textarea
                value={form.systemPrompt}
                onChange={e => setForm({ ...form, systemPrompt: e.target.value })}
                minRows={4}
                maxRows={12}
                placeholder="You are a helpful assistant…"
                data-testid="voice-settings-form-prompt"
                slotProps={{ textarea: { style: { overflow: 'auto' } } }}
              />
            </FormControl>
            <FormControl>
              <FormLabel>Turn eagerness</FormLabel>
              <Select
                value={form.turnEagerness}
                onChange={(_, v) =>
                  setForm({ ...form, turnEagerness: isTurnEagerness(v) ? v : DEFAULT_TURN_EAGERNESS })
                }
                data-testid="voice-settings-form-turn-eagerness"
              >
                {TURN_EAGERNESS_OPTIONS.map(o => (
                  <Option key={o.value} value={o.value}>
                    {o.label}
                  </Option>
                ))}
              </Select>
              <Typography level="body-xs" sx={{ color: 'text.tertiary', mt: 0.5 }}>
                How readily the agent responds when the user pauses. Lower it if turns get cut off mid-sentence.
              </Typography>
            </FormControl>
            <FormControl>
              <FormLabel>Turn timeout (seconds)</FormLabel>
              <Input
                type="number"
                value={form.turnTimeoutSeconds}
                onChange={e => {
                  const n = Number(e.target.value);
                  setForm({
                    ...form,
                    turnTimeoutSeconds: Number.isFinite(n)
                      ? Math.min(30, Math.max(1, Math.round(n)))
                      : form.turnTimeoutSeconds,
                  });
                }}
                slotProps={{ input: { min: 1, max: 30 } }}
                data-testid="voice-settings-form-turn-timeout"
              />
              <Typography level="body-xs" sx={{ color: 'text.tertiary', mt: 0.5 }}>
                Seconds of silence before the agent re-engages (1–30).
              </Typography>
            </FormControl>
            <Stack direction="row" spacing={1} justifyContent="flex-end" sx={{ mt: 1 }}>
              <Button variant="plain" onClick={closeEditor}>
                Cancel
              </Button>
              <Button
                disabled={!canSubmit || saveMutation.isPending}
                loading={saveMutation.isPending}
                onClick={() => saveMutation.mutate(form)}
                data-testid="voice-settings-form-submit"
              >
                {isEditing ? 'Save changes' : 'Create'}
              </Button>
            </Stack>
          </Stack>
        </ModalDialog>
      </Modal>
    </Box>
  );
};

export default VoiceSettingsTab;

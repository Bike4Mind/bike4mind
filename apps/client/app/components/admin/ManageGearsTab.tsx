import { useState } from 'react';
import {
  Box,
  Button,
  Chip,
  IconButton,
  Input,
  Sheet,
  Stack,
  Switch,
  Table,
  Textarea,
  Tooltip,
  Typography,
} from '@mui/joy';
import RestartAltIcon from '@mui/icons-material/RestartAlt';
import SaveOutlinedIcon from '@mui/icons-material/SaveOutlined';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { toast } from 'sonner';
import { api } from '@client/app/contexts/ApiContext';

/**
 * Manage Gears - the ops override surface for the Gears progression system
 * (same defaults+overrides pattern as System Prompts). Everything shipped in
 * code is the default; an admin edit here comes over the top LIVE, no deploy:
 * kill a runaway reward (enabled off / credits 0), reword a card, or repoint
 * a CTA. Reset reverts a gear to its code defaults.
 */

interface AdminGear {
  key: string;
  kind: 'destination' | 'skill';
  defaults: {
    credits: number;
    enabled: boolean;
    title: string;
    tagline: string;
    intro: string;
    cta: string;
    ctaAction: string;
  };
  override: {
    enabled: boolean | null;
    credits: number | null;
    title: string | null;
    tagline: string | null;
    intro: string | null;
    cta: string | null;
    ctaAction: string | null;
    updatedBy: string | null;
    updatedAt: string | null;
  } | null;
}

type Draft = {
  enabled: boolean;
  credits: string;
  title: string;
  tagline: string;
  intro: string;
  cta: string;
  ctaAction: string;
};

const effective = (g: AdminGear) => ({
  enabled: g.override?.enabled ?? g.defaults.enabled,
  credits: g.override?.credits ?? g.defaults.credits,
  title: g.override?.title ?? g.defaults.title,
  tagline: g.override?.tagline ?? g.defaults.tagline,
  intro: g.override?.intro ?? g.defaults.intro,
  cta: g.override?.cta ?? g.defaults.cta,
  ctaAction: g.override?.ctaAction ?? g.defaults.ctaAction,
});

const ManageGearsTab = () => {
  const queryClient = useQueryClient();
  const { data, isPending } = useQuery<{ gears: AdminGear[] }>({
    queryKey: ['admin', 'gears'],
    queryFn: async () => (await api.get<{ gears: AdminGear[] }>('/api/admin/gears')).data,
  });
  // Row being edited (one at a time) + its draft values.
  const [editingKey, setEditingKey] = useState<string | null>(null);
  const [draft, setDraft] = useState<Draft | null>(null);
  const [busy, setBusy] = useState(false);

  const refresh = () => queryClient.invalidateQueries({ queryKey: ['admin', 'gears'] });

  const startEdit = (g: AdminGear) => {
    const e = effective(g);
    setEditingKey(g.key);
    setDraft({
      enabled: e.enabled,
      credits: String(e.credits),
      title: e.title,
      tagline: e.tagline,
      intro: e.intro,
      cta: e.cta,
      ctaAction: e.ctaAction,
    });
  };

  const save = async (g: AdminGear) => {
    if (!draft) return;
    const credits = Number(draft.credits);
    if (!Number.isInteger(credits) || credits < 0) {
      toast.error('Credits must be a non-negative integer');
      return;
    }
    setBusy(true);
    try {
      // Sparse patch: only ship fields that differ from the code default, and
      // null out fields returned to it - keeps the override row honest about
      // what the admin actually changed.
      const d = g.defaults;
      await api.put('/api/admin/gears', {
        key: g.key,
        enabled: draft.enabled === d.enabled ? null : draft.enabled,
        credits: credits === d.credits ? null : credits,
        title: draft.title === d.title ? null : draft.title,
        tagline: draft.tagline === d.tagline ? null : draft.tagline,
        intro: draft.intro === d.intro ? null : draft.intro,
        cta: draft.cta === d.cta ? null : draft.cta,
        ctaAction: draft.ctaAction === d.ctaAction ? null : draft.ctaAction,
      });
      toast.success(`Saved override for "${g.key}" - live now`);
      setEditingKey(null);
      setDraft(null);
      await refresh();
    } catch {
      toast.error('Failed to save override');
    } finally {
      setBusy(false);
    }
  };

  const reset = async (g: AdminGear) => {
    setBusy(true);
    try {
      await api.delete(`/api/admin/gears/${encodeURIComponent(g.key)}`);
      toast.success(`"${g.key}" reset to code defaults`);
      if (editingKey === g.key) {
        setEditingKey(null);
        setDraft(null);
      }
      await refresh();
    } catch {
      toast.error('Failed to reset override');
    } finally {
      setBusy(false);
    }
  };

  return (
    <Box data-testid="manage-gears-tab">
      <Typography level="h3" sx={{ mb: 0.5 }}>
        Manage Gears
      </Typography>
      <Typography level="body-sm" sx={{ mb: 2, opacity: 0.8 }}>
        Code ships the defaults; anything you save here overrides them live - no deploy. Kill a runaway reward by
        disabling a gear or setting its credits to 0.
      </Typography>
      {isPending ? (
        <Typography level="body-sm">Loading gears...</Typography>
      ) : (
        <Sheet variant="outlined" sx={{ borderRadius: 'sm', overflow: 'auto' }}>
          <Table size="sm" stickyHeader sx={{ minWidth: 900, '& td': { verticalAlign: 'top' } }}>
            <thead>
              <tr>
                <th style={{ width: 140 }}>Gear</th>
                <th style={{ width: 70 }}>On</th>
                <th style={{ width: 90 }}>Credits</th>
                <th>Copy (title / tagline / intro)</th>
                <th style={{ width: 220 }}>CTA (label / action)</th>
                <th style={{ width: 110 }} aria-label="actions" />
              </tr>
            </thead>
            <tbody>
              {(data?.gears ?? []).map(g => {
                const e = effective(g);
                const isEditing = editingKey === g.key && draft;
                const overridden = g.override !== null;
                return (
                  <tr key={g.key} data-testid={`manage-gear-row-${g.key}`}>
                    <td>
                      <Stack gap={0.5} alignItems="flex-start">
                        <Typography level="title-sm" sx={{ fontFamily: 'monospace' }}>
                          {g.key}
                        </Typography>
                        <Stack direction="row" gap={0.5}>
                          <Chip size="sm" variant="soft" color={g.kind === 'destination' ? 'primary' : 'neutral'}>
                            {g.kind}
                          </Chip>
                          {overridden && (
                            <Chip size="sm" variant="soft" color="warning">
                              overridden
                            </Chip>
                          )}
                        </Stack>
                      </Stack>
                    </td>
                    <td>
                      <Switch
                        checked={isEditing ? draft.enabled : e.enabled}
                        disabled={!isEditing || busy}
                        onChange={ev => draft && setDraft({ ...draft, enabled: ev.target.checked })}
                        data-testid={`manage-gear-enabled-${g.key}`}
                      />
                    </td>
                    <td>
                      {isEditing ? (
                        <Input
                          size="sm"
                          value={draft.credits}
                          onChange={ev => setDraft({ ...draft, credits: ev.target.value })}
                          slotProps={{ input: { inputMode: 'numeric', 'data-testid': `manage-gear-credits-${g.key}` } }}
                        />
                      ) : (
                        <Typography level="body-sm" sx={{ fontVariantNumeric: 'tabular-nums' }}>
                          {e.credits.toLocaleString()}
                        </Typography>
                      )}
                    </td>
                    <td>
                      {isEditing ? (
                        <Stack gap={0.5}>
                          <Input
                            size="sm"
                            value={draft.title}
                            onChange={ev => setDraft({ ...draft, title: ev.target.value })}
                            placeholder="Title"
                          />
                          <Input
                            size="sm"
                            value={draft.tagline}
                            onChange={ev => setDraft({ ...draft, tagline: ev.target.value })}
                            placeholder="Tagline"
                          />
                          <Textarea
                            size="sm"
                            minRows={2}
                            value={draft.intro}
                            onChange={ev => setDraft({ ...draft, intro: ev.target.value })}
                            placeholder="Intro"
                          />
                        </Stack>
                      ) : (
                        <Stack gap={0.25}>
                          <Typography level="body-sm">
                            <b>{e.title}</b> / {e.tagline}
                          </Typography>
                          <Typography level="body-xs" sx={{ opacity: 0.7 }}>
                            {e.intro}
                          </Typography>
                        </Stack>
                      )}
                    </td>
                    <td>
                      {isEditing ? (
                        <Stack gap={0.5}>
                          <Input
                            size="sm"
                            value={draft.cta}
                            onChange={ev => setDraft({ ...draft, cta: ev.target.value })}
                            placeholder="CTA label"
                          />
                          <Input
                            size="sm"
                            value={draft.ctaAction}
                            onChange={ev => setDraft({ ...draft, ctaAction: ev.target.value })}
                            placeholder="navigate:/path | external:https://... | files"
                            sx={{ fontFamily: 'monospace' }}
                          />
                        </Stack>
                      ) : (
                        <Stack gap={0.25}>
                          <Typography level="body-sm">{e.cta}</Typography>
                          <Typography level="body-xs" sx={{ fontFamily: 'monospace', opacity: 0.7 }}>
                            {e.ctaAction}
                          </Typography>
                        </Stack>
                      )}
                    </td>
                    <td>
                      {isEditing ? (
                        <Stack direction="row" gap={0.5}>
                          <Tooltip title="Save - takes effect immediately">
                            <IconButton
                              size="sm"
                              color="primary"
                              variant="solid"
                              disabled={busy}
                              onClick={() => void save(g)}
                              data-testid={`manage-gear-save-${g.key}`}
                            >
                              <SaveOutlinedIcon />
                            </IconButton>
                          </Tooltip>
                          <Button size="sm" variant="plain" disabled={busy} onClick={() => setEditingKey(null)}>
                            Cancel
                          </Button>
                        </Stack>
                      ) : (
                        <Stack direction="row" gap={0.5}>
                          <Button size="sm" variant="outlined" disabled={busy} onClick={() => startEdit(g)}>
                            Edit
                          </Button>
                          {overridden && (
                            <Tooltip title="Reset to code defaults">
                              <IconButton
                                size="sm"
                                variant="plain"
                                color="danger"
                                disabled={busy}
                                onClick={() => void reset(g)}
                                data-testid={`manage-gear-reset-${g.key}`}
                              >
                                <RestartAltIcon />
                              </IconButton>
                            </Tooltip>
                          )}
                        </Stack>
                      )}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </Table>
        </Sheet>
      )}
    </Box>
  );
};

export default ManageGearsTab;

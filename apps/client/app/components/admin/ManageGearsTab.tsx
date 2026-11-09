import { useState } from 'react';
import {
  Alert,
  Box,
  Button,
  Dropdown,
  IconButton,
  Input,
  Menu,
  MenuButton,
  MenuItem,
  Stack,
  Switch,
  Textarea,
  Typography,
} from '@mui/joy';
import MoreHorizIcon from '@mui/icons-material/MoreHoriz';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { toast } from 'sonner';
import { z } from 'zod';
import { api } from '@client/app/contexts/ApiContext';
import { SettingsDraftProvider, useSettingsDraft } from './SettingsDraftProvider';
import { AdminPageHeader, DataTable, EmptyState, StatusChip, UpdatingBar, type DataColumn } from './shared';
import { ADMIN_REGION_GAP, adminFocus } from './shared/adminStyles';

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

const draftOf = (g: AdminGear): Draft => {
  const e = effective(g);
  return {
    enabled: e.enabled,
    credits: String(e.credits),
    title: e.title,
    tagline: e.tagline,
    intro: e.intro,
    cta: e.cta,
    ctaAction: e.ctaAction,
  };
};

const creditsSchema = z.string().trim().min(1).transform(Number).pipe(z.number().int().min(0).max(1_000_000));

const creditsBlocked = (draft: Draft) =>
  creditsSchema.safeParse(draft.credits).success
    ? undefined
    : 'Credits must be a non-negative integer no greater than 1,000,000';

type SaveGear = (g: AdminGear, draft: Draft) => Promise<void>;

/**
 * One gear's staged edit. Every cell of the row calls this with the same id, so they share the
 * draft the page's SaveBar saves (SettingsDraftProvider).
 */
const useGearDraft = (gear: AdminGear, save: SaveGear) =>
  useSettingsDraft<Draft>(`gear:${gear.key}`, draftOf(gear), {
    name: gear.key,
    save: draft => save(gear, draft),
    blocked: creditsBlocked,
  });

type CellProps = { gear: AdminGear; editing: boolean; busy: boolean; save: SaveGear };

function GearEnabledCell({ gear, editing, busy, save }: CellProps) {
  const { value, setValue, pending } = useGearDraft(gear, save);
  return (
    <Switch
      checked={value.enabled}
      disabled={!editing || busy || pending}
      onChange={ev => setValue(previous => ({ ...previous, enabled: ev.target.checked }))}
      slotProps={{ input: { 'aria-label': `${gear.key} enabled` } }}
      data-testid={`manage-gear-enabled-${gear.key}`}
    />
  );
}

function GearCreditsCell({ gear, editing, save }: CellProps) {
  const { value, setValue, pending } = useGearDraft(gear, save);
  if (!editing) return <>{Number(value.credits).toLocaleString()}</>;
  return (
    <Input
      size="sm"
      disabled={pending}
      value={value.credits}
      onChange={ev => setValue(previous => ({ ...previous, credits: ev.target.value }))}
      slotProps={{ input: { inputMode: 'numeric', 'data-testid': `manage-gear-credits-${gear.key}` } }}
    />
  );
}

function GearCopyCell({ gear, editing, save }: CellProps) {
  const { value, setValue, pending } = useGearDraft(gear, save);
  if (!editing) {
    return (
      <Stack gap={0.25} sx={{ minWidth: 0 }}>
        <Typography level="body-sm">
          <b>{value.title}</b> / {value.tagline}
        </Typography>
        <Typography level="body-xs" sx={{ color: 'admin.inkMuted' }}>
          {value.intro}
        </Typography>
      </Stack>
    );
  }
  return (
    <Stack gap={0.5}>
      <Input
        size="sm"
        disabled={pending}
        value={value.title}
        onChange={ev => setValue(previous => ({ ...previous, title: ev.target.value }))}
        placeholder="Title"
        slotProps={{ input: { 'data-testid': `manage-gear-title-${gear.key}` } }}
      />
      <Input
        size="sm"
        disabled={pending}
        value={value.tagline}
        onChange={ev => setValue(previous => ({ ...previous, tagline: ev.target.value }))}
        placeholder="Tagline"
      />
      <Textarea
        size="sm"
        minRows={2}
        disabled={pending}
        value={value.intro}
        onChange={ev => setValue(previous => ({ ...previous, intro: ev.target.value }))}
        placeholder="Intro"
      />
    </Stack>
  );
}

function GearCtaCell({ gear, editing, save }: CellProps) {
  const { value, setValue, pending } = useGearDraft(gear, save);
  if (!editing) {
    return (
      <Stack gap={0.25} sx={{ minWidth: 0 }}>
        <Typography level="body-sm">{value.cta}</Typography>
        <Typography
          level="body-xs"
          noWrap
          title={value.ctaAction}
          sx={{ fontFamily: 'monospace', color: 'admin.inkMuted' }}
        >
          {value.ctaAction}
        </Typography>
      </Stack>
    );
  }
  return (
    <Stack gap={0.5}>
      <Input
        size="sm"
        disabled={pending}
        value={value.cta}
        onChange={ev => setValue(previous => ({ ...previous, cta: ev.target.value }))}
        placeholder="CTA label"
      />
      <Input
        size="sm"
        disabled={pending}
        value={value.ctaAction}
        onChange={ev => setValue(previous => ({ ...previous, ctaAction: ev.target.value }))}
        placeholder="navigate:/path | external:https://... | files"
        sx={{ fontFamily: 'monospace' }}
      />
    </Stack>
  );
}

function GearRowMenu({
  gear,
  editing,
  busy,
  save,
  onEdit,
  onStopEditing,
  onReset,
}: CellProps & { onEdit(): void; onStopEditing(): void; onReset(): Promise<boolean> }) {
  const { setValue, pending } = useGearDraft(gear, save);
  const discard = () => setValue(draftOf(gear));
  return (
    <Dropdown>
      <MenuButton
        slots={{ root: IconButton }}
        slotProps={{
          root: {
            size: 'sm',
            variant: 'plain',
            disabled: busy || pending,
            'aria-label': `Actions for ${gear.key}`,
            sx: { ...adminFocus, color: 'admin.inkMuted' },
          },
        }}
        data-testid={`manage-gear-actions-${gear.key}`}
      >
        <MoreHorizIcon sx={{ fontSize: 18 }} />
      </MenuButton>
      <Menu size="sm" placement="bottom-end" sx={{ zIndex: 1300 }}>
        {editing ? (
          <MenuItem
            disabled={busy || pending}
            onClick={() => {
              discard();
              onStopEditing();
            }}
            data-testid={`manage-gear-cancel-${gear.key}`}
          >
            Cancel editing
          </MenuItem>
        ) : (
          <MenuItem disabled={busy || pending} onClick={onEdit} data-testid={`manage-gear-edit-${gear.key}`}>
            Edit gear
          </MenuItem>
        )}
        {gear.override !== null && (
          <MenuItem
            color="danger"
            disabled={busy || pending}
            // discard() writes the baseline this render closed over, so it clears the draft whatever the refetch loaded.
            onClick={() => void onReset().then(reset => reset && discard())}
            data-testid={`manage-gear-reset-${gear.key}`}
          >
            Reset to code defaults
          </MenuItem>
        )}
      </Menu>
    </Dropdown>
  );
}

const ManageGearsTab = () => {
  const queryClient = useQueryClient();
  const { data, isPending, isError, isFetching, refetch } = useQuery<{ gears: AdminGear[] }>({
    queryKey: ['admin', 'gears'],
    queryFn: async () => (await api.get<{ gears: AdminGear[] }>('/api/admin/gears')).data,
  });
  // Rows showing their inputs; their edits are staged for the page's one SaveBar.
  const [editing, setEditing] = useState<ReadonlySet<string>>(new Set());
  const [busy, setBusy] = useState(false);

  const refresh = () => queryClient.invalidateQueries({ queryKey: ['admin', 'gears'] });
  const setRowEditing = (key: string, on: boolean) =>
    setEditing(previous => {
      const next = new Set(previous);
      if (on) next.add(key);
      else next.delete(key);
      return next;
    });

  const save: SaveGear = async (g, draft) => {
    if (busy) throw new Error('Wait for the gear reset to finish before saving.');
    const credits = creditsSchema.parse(draft.credits);
    // Sparse patch: only ship fields that differ from the code default, and
    // null out fields returned to it - keeps the override row honest about
    // what the admin actually changed.
    const d = g.defaults;
    const response = await api.put<{ override: NonNullable<AdminGear['override']> }>('/api/admin/gears', {
      key: g.key,
      enabled: draft.enabled === d.enabled ? null : draft.enabled,
      credits: credits === d.credits ? null : credits,
      title: draft.title === d.title ? null : draft.title,
      tagline: draft.tagline === d.tagline ? null : draft.tagline,
      intro: draft.intro === d.intro ? null : draft.intro,
      cta: draft.cta === d.cta ? null : draft.cta,
      ctaAction: draft.ctaAction === d.ctaAction ? null : draft.ctaAction,
    });
    await queryClient.cancelQueries({ queryKey: ['admin', 'gears'] });
    queryClient.setQueryData<{ gears: AdminGear[] }>(
      ['admin', 'gears'],
      previous =>
        previous && {
          ...previous,
          gears: previous.gears.map(gear =>
            gear.key === g.key ? { ...gear, override: response.data.override } : gear
          ),
        }
    );
    toast.success(`Saved override for "${g.key}" - live now`);
    setRowEditing(g.key, false);
  };

  const reset = async (g: AdminGear) => {
    setBusy(true);
    try {
      await api.delete(`/api/admin/gears/${encodeURIComponent(g.key)}`);
      await queryClient.cancelQueries({ queryKey: ['admin', 'gears'] });
      queryClient.setQueryData<{ gears: AdminGear[] }>(
        ['admin', 'gears'],
        previous =>
          previous && {
            ...previous,
            gears: previous.gears.map(gear => (gear.key === g.key ? { ...gear, override: null } : gear)),
          }
      );
      toast.success(`"${g.key}" reset to code defaults`);
      setRowEditing(g.key, false);
      await refresh();
      return true;
    } catch {
      toast.error('Failed to reset override');
      return false;
    } finally {
      setBusy(false);
    }
  };

  const cell = (g: AdminGear) => ({ gear: g, editing: editing.has(g.key), busy, save });
  const columns: DataColumn<AdminGear>[] = [
    {
      id: 'gear',
      label: 'Gear',
      width: '12rem',
      render: g => (
        <Stack gap={0.5} alignItems="flex-start" sx={{ minWidth: 0 }}>
          <Typography
            level="title-sm"
            noWrap
            title={g.key}
            sx={{ fontFamily: 'monospace', maxWidth: '100%' }}
            data-testid={`manage-gear-key-${g.key}`}
          >
            {g.key}
          </Typography>
          <Stack direction="row" gap={0.5} flexWrap="wrap">
            <StatusChip tone="neutral" label={g.kind} data-testid={`manage-gear-kind-${g.key}`} />
            {g.override !== null && (
              <StatusChip tone="warn" label="overridden" data-testid={`manage-gear-overridden-${g.key}`} />
            )}
          </Stack>
        </Stack>
      ),
    },
    { id: 'enabled', label: 'On', width: '5rem', render: g => <GearEnabledCell {...cell(g)} /> },
    { id: 'credits', label: 'Credits', width: '8rem', numeric: true, render: g => <GearCreditsCell {...cell(g)} /> },
    { id: 'copy', label: 'Copy (title / tagline / intro)', render: g => <GearCopyCell {...cell(g)} /> },
    { id: 'cta', label: 'CTA (label / action)', width: '16rem', render: g => <GearCtaCell {...cell(g)} /> },
  ];

  return (
    <Stack sx={{ gap: ADMIN_REGION_GAP, minWidth: 0 }} data-testid="manage-gears-tab">
      <AdminPageHeader
        title="Gears"
        description="Code ships the defaults; a saved override applies live, with no deploy. Stop a runaway reward by turning its gear off or setting its credits to 0."
      />

      {isError && data && (
        <Alert color="warning" variant="soft" data-testid="manage-gears-refresh-error">
          Could not refresh gears. Showing the last loaded list.
        </Alert>
      )}

      <Box component="fieldset" disabled={busy} sx={{ border: 0, p: 0, m: 0, minWidth: 0 }}>
        <SettingsDraftProvider>
          <Stack gap={1}>
            <UpdatingBar active={isFetching && !isPending} testId="manage-gears-updating" />
            <DataTable
              label="Gears"
              testId="manage-gears-table"
              rows={data?.gears ?? []}
              columns={columns}
              getRowId={g => g.key}
              rowTestId={g => `manage-gear-row-${g.key}`}
              loading={isPending}
              error={isError && !data ? 'Could not load gears.' : undefined}
              onRetry={() => void refetch()}
              rowActions={g => (
                <GearRowMenu
                  {...cell(g)}
                  onEdit={() => setRowEditing(g.key, true)}
                  onStopEditing={() => setRowEditing(g.key, false)}
                  onReset={() => reset(g)}
                />
              )}
              // Fixed columns total 44.5rem with the actions column; the copy column takes the rest.
              minWidth="62rem"
              maxHeight="none"
              pagination={false}
              empty={
                <EmptyState
                  title="No gears to show"
                  description="Gears are defined in code, so this list is never empty on a healthy deploy."
                  action={
                    <Button variant="outlined" onClick={() => void refetch()} data-testid="manage-gears-refresh-btn">
                      Refresh gears
                    </Button>
                  }
                />
              }
            />
          </Stack>
        </SettingsDraftProvider>
      </Box>
    </Stack>
  );
};

export default ManageGearsTab;

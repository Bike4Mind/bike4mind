import { useMemo, useState } from 'react';
import {
  Autocomplete,
  Box,
  Button,
  FormControl,
  FormHelperText,
  FormLabel,
  Input,
  Option,
  Select,
  Stack,
  Typography,
} from '@mui/joy';
import { normalizeEntitlementKey, type AdminModelRow, type ModelAccessChange } from '@bike4mind/common';
import { KNOWN_ENTITLEMENT_KEYS } from '@bike4mind/server-utils/lib/entitlements/registry';
import { useAdminModelsOfType, useAdminUserTags } from '@client/app/hooks/data/adminModels';
import { Fact, SectionCard } from '../../../shared';
import { ModelAccessDialog, ModelToggleDialog } from '../../Access/ModelAccessDialog';
import { diffAccess, effectiveAccess } from '../../Access/modelAccessChange';
import { ModelWriteAction } from '../../ModelWriteAction';
import { MODEL_STATUS_LABEL, accessSummary } from '../../modelPresentation';
import { useModelsNavigation } from '../../modelsNavigation';

type Editor = 'toggle' | 'audience' | 'ranking';

const RANK_MIN = 0;
const RANK_MAX = 100;

const listOrNone = (values: readonly string[]) => (values.length > 0 ? values.join(', ') : 'None');

const dedupe = (values: readonly string[], normalize: (value: string) => string) => [
  ...new Set(values.map(normalize).filter(Boolean)),
];

/** Rank input text to a rank: empty is automatic (null); anything else must be a whole number in range. */
export const parseRankInput = (text: string): { rank: number | null } | { error: string } => {
  const trimmed = text.trim();
  if (trimmed === '') return { rank: null };
  const value = Number(trimmed);
  if (!Number.isInteger(value) || value < RANK_MIN || value > RANK_MAX) {
    return { error: `Enter a whole number from ${RANK_MIN} to ${RANK_MAX}, or leave it empty for automatic.` };
  }
  return { rank: value };
};

function EditButton({ label, onClick, testId }: { label: string; onClick: () => void; testId: string }) {
  return (
    <ModelWriteAction>
      {disabled => (
        <Button size="sm" variant="plain" disabled={disabled} onClick={onClick} data-testid={testId}>
          {label}
        </Button>
      )}
    </ModelWriteAction>
  );
}

function AudienceEditor({ model, onClose }: { model: AdminModelRow; onClose: () => void }) {
  const before = effectiveAccess(model.access.entry);
  const [tags, setTags] = useState<string[]>(before.allowedUserTags);
  const [entitlements, setEntitlements] = useState<string[]>(before.allowedEntitlements);
  const tagCounts = useAdminUserTags();
  const entryTags = model.access.entry?.allowedUserTags;
  const tagOptions = useMemo(
    () => [...new Set([...(tagCounts.data ?? []).map(entry => entry.tag), ...(entryTags ?? [])])],
    [tagCounts.data, entryTags]
  );
  const change = diffAccess(before, { ...before, allowedUserTags: tags, allowedEntitlements: entitlements });
  return (
    <ModelAccessDialog
      target={model}
      change={change}
      title={`Edit who can pick ${model.name}`}
      confirmLabel="Save access"
      onClose={onClose}
    >
      <Typography level="body-sm" sx={{ color: 'admin.inkSecondary' }}>
        A user can pick the model when they hold any of these tags or entitlements. Every signed-in user holds base.
      </Typography>
      <FormControl>
        <FormLabel>User tags</FormLabel>
        <Autocomplete
          multiple
          freeSolo
          size="sm"
          placeholder="Pick or type a tag"
          options={tagOptions}
          loading={tagCounts.isLoading}
          value={tags}
          onChange={(_event, next) => setTags(dedupe(next, value => value.trim()))}
          slotProps={{ input: { 'data-testid': 'model-access-tags-input' } }}
        />
      </FormControl>
      <FormControl>
        <FormLabel>Entitlements</FormLabel>
        <Autocomplete
          multiple
          freeSolo
          size="sm"
          placeholder="Pick or type an entitlement"
          options={[...KNOWN_ENTITLEMENT_KEYS]}
          value={entitlements}
          onChange={(_event, next) => setEntitlements(dedupe(next, normalizeEntitlementKey))}
          slotProps={{ input: { 'data-testid': 'model-access-entitlements-input' } }}
        />
      </FormControl>
    </ModelAccessDialog>
  );
}

function RankingEditor({ model, onClose }: { model: AdminModelRow; onClose: () => void }) {
  const before = effectiveAccess(model.access.entry);
  const [rankText, setRankText] = useState(before.rank === null ? '' : String(before.rank));
  const [fallback, setFallback] = useState(before.fallbackModel);
  const sameType = useAdminModelsOfType(model.type);
  const parsed = parseRankInput(rankText);
  const rankError = 'error' in parsed ? parsed.error : null;
  const change: ModelAccessChange | null =
    'rank' in parsed ? diffAccess(before, { ...before, rank: parsed.rank, fallbackModel: fallback }) : null;
  const candidates = (sameType.data ?? []).filter(candidate => candidate.id !== model.id);
  const knownFallback = !fallback || candidates.some(candidate => candidate.id === fallback);

  return (
    <ModelAccessDialog
      target={model}
      change={change}
      title={`Edit rank and fallback for ${model.name}`}
      confirmLabel="Save rank and fallback"
      onClose={onClose}
    >
      <FormControl error={!!rankError}>
        <FormLabel>Rank</FormLabel>
        <Input
          size="sm"
          value={rankText}
          onChange={event => setRankText(event.target.value)}
          placeholder="Automatic"
          slotProps={{ input: { inputMode: 'numeric', 'data-testid': 'model-access-rank-input' } }}
          sx={{ maxWidth: 160 }}
        />
        <FormHelperText>
          {rankError ?? `Lower ranks list first in the picker. ${RANK_MIN} to ${RANK_MAX}; empty is automatic.`}
        </FormHelperText>
      </FormControl>
      <FormControl>
        <FormLabel>Fallback model</FormLabel>
        <Select
          size="sm"
          value={fallback}
          onChange={(_event, next) => setFallback(next ?? '')}
          slotProps={{ button: { 'data-testid': 'model-access-fallback-select' } }}
        >
          <Option value="">Automatic</Option>
          {!knownFallback && <Option value={fallback}>{fallback}</Option>}
          {candidates.map(candidate => (
            <Option key={candidate.id} value={candidate.id}>
              {candidate.name} ({MODEL_STATUS_LABEL[candidate.status]})
            </Option>
          ))}
        </Select>
        <FormHelperText>Used when this model fails. Only models of the same type are offered.</FormHelperText>
      </FormControl>
    </ModelAccessDialog>
  );
}

/** Access: on/off, who can pick it, rank and fallback; each change is one audited write with Undo. */
export function ModelAccessTab({ model }: { model: AdminModelRow }) {
  // Each editor works on the row as it was when it opened, so a refetch cannot re-base its change or its stamp.
  const [editor, setEditor] = useState<{ kind: Editor; model: AdminModelRow } | null>(null);
  const open = (kind: Editor) => setEditor({ kind, model });
  const { openSection } = useModelsNavigation();
  const before = effectiveAccess(model.access.entry);
  const summary = accessSummary(model.access);
  const close = () => setEditor(null);

  return (
    <Box
      sx={{ display: 'grid', gridTemplateColumns: { xs: '1fr', md: '1fr 1fr' }, gap: 2, alignItems: 'start' }}
      data-testid="model-access-tab"
    >
      <SectionCard
        title="Availability"
        action={
          <EditButton
            label={before.enabled ? 'Turn off' : 'Turn on'}
            onClick={() => open('toggle')}
            testId="model-access-toggle-btn"
          />
        }
        data-testid="model-access-availability"
      >
        <Fact label="State" data-testid="model-access-state">
          {before.enabled ? 'On' : 'Off'}
        </Fact>
        <Fact label="Who can pick it" data-testid="model-access-summary">
          {summary.label}
        </Fact>
        <Fact label="Free tier">
          <Stack direction="row" gap={1} alignItems="center" flexWrap="wrap">
            {model.access.freeTierLocked ? 'Locked for free users' : 'Not locked'}
            <Button
              size="sm"
              variant="plain"
              sx={{ minHeight: 24, px: 1 }}
              onClick={() => void openSection('settings')}
              data-testid="model-access-free-tier-settings-btn"
            >
              Free tier settings
            </Button>
          </Stack>
        </Fact>
        {!model.access.entry && <Fact label="Access entry">None yet: open to everyone through base</Fact>}
      </SectionCard>

      <SectionCard
        title="Tags and entitlements"
        action={<EditButton label="Edit" onClick={() => open('audience')} testId="model-access-audience-btn" />}
        data-testid="model-access-audience"
      >
        <Fact label="User tags" data-testid="model-access-tags">
          {listOrNone(before.allowedUserTags)}
        </Fact>
        <Fact label="Entitlements" data-testid="model-access-entitlements">
          {listOrNone(before.allowedEntitlements)}
        </Fact>
      </SectionCard>

      <SectionCard
        title="Rank and fallback"
        action={<EditButton label="Edit" onClick={() => open('ranking')} testId="model-access-ranking-btn" />}
        data-testid="model-access-ranking"
      >
        <Fact label="Rank" data-testid="model-access-rank">
          {before.rank !== null
            ? `${before.rank} (set by admin)`
            : model.rank === null
              ? 'Unranked'
              : `${model.rank}${model.rankProvisional ? ' (provisional)' : ''}`}
        </Fact>
        <Fact label="Fallback" data-testid="model-access-fallback">
          {before.fallbackModel || 'Automatic'}
        </Fact>
      </SectionCard>

      {editor?.kind === 'toggle' && <ModelToggleDialog model={editor.model} onClose={close} />}
      {editor?.kind === 'audience' && <AudienceEditor model={editor.model} onClose={close} />}
      {editor?.kind === 'ranking' && <RankingEditor model={editor.model} onClose={close} />}
    </Box>
  );
}

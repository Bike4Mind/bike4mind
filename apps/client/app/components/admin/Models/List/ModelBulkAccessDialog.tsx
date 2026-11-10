import { useMemo, useState } from 'react';
import { Alert, Autocomplete, Box, Button, Checkbox, FormControl, FormLabel, Stack, Typography } from '@mui/joy';
import { useMutation, useQuery } from '@tanstack/react-query';
import {
  MODEL_ACCESS_BULK_MAX_IDS,
  normalizeEntitlementKey,
  type ModelAccessBulkDryRun,
  type ModelAccessBulkResult,
  type ModelAccessSelection,
} from '@bike4mind/common';
import { KNOWN_ENTITLEMENT_KEYS } from '@bike4mind/server-utils/lib/entitlements/registry';
import { getErrorMessage } from '@client/app/utils/error';
import { apiErrorOf, postModelAccessBulk, useAdminUserTags } from '@client/app/hooks/data/adminModels';
import { ADMIN_REASON_PRESETS, ActionDialog } from '../../shared';
import { MODEL_PICKER_FRESHNESS } from '../Access/ModelAccessDialog';
import {
  BULK_AUDIENCE_LABEL,
  MODEL_BULK_LABEL,
  bulkChangeOf,
  bulkDiffSummary,
  bulkKindIsTags,
  bulkKindTakesValues,
  canAlsoRemoveBase,
  countOf,
  describeBulkEntry,
  noAudienceChangeItems,
  type ModelBulkKind,
} from './modelBulkAccess';

export type ModelBulkRequest = {
  kind: ModelBulkKind;
  selection: ModelAccessSelection;
  /** What the list showed as selected, for the title before the dry run resolves it. */
  count: number;
  /** Prefilled tags or entitlements, for Retry failed. */
  values?: string[];
  alsoRemoveBase?: boolean;
  /** Tags already on the selected models' entries, offered alongside the tags users hold. */
  entryTags?: string[];
};

export type ModelBulkApplied = {
  request: ModelBulkRequest;
  values: string[];
  alsoRemoveBase: boolean;
  reason: string;
  result: ModelAccessBulkResult;
};

const DRY_RUN_KEY = ['admin', 'model-access-bulk-dry-run'] as const;

const confirmLabelOf = (kind: ModelBulkKind, count: number) => {
  const models = countOf(count, 'model');
  switch (kind) {
    case 'turn-on':
    case 'turn-off':
      return `${MODEL_BULK_LABEL[kind]} ${models}`;
    case 'add-tag':
    case 'add-entitlement':
      return `${MODEL_BULK_LABEL[kind]} to ${models}`;
    case 'remove-tag':
    case 'remove-entitlement':
      return `${MODEL_BULK_LABEL[kind]} from ${models}`;
  }
};

/** A 422 for a filter that matches nothing or too many models carries `matched`. */
const selectionProblem = (error: unknown): string | null => {
  const { status, data } = apiErrorOf(error);
  if (status !== 422 || typeof data.matched !== 'number') return null;
  return data.matched === 0
    ? 'No models match this selection any more. Close and check the filters.'
    : `This selection matches ${countOf(data.matched, 'model')}. One bulk change covers at most ${MODEL_ACCESS_BULK_MAX_IDS}; narrow the filters.`;
};

/**
 * Bulk access (POST /api/admin/models/access/bulk, docs/admin-models-spec.md 5.1 and 7.6): a server dry run with the
 * diff, audience effect and admins-only list, then apply with the dry run's token. A 409 swaps in the fresh dry run.
 */
export function ModelBulkAccessDialog({
  request,
  onClose,
  onApplied,
}: {
  request: ModelBulkRequest | null;
  onClose: () => void;
  onApplied: (applied: ModelBulkApplied) => void;
}) {
  if (!request) return null;
  return <BulkDialogBody key={JSON.stringify(request)} request={request} onClose={onClose} onApplied={onApplied} />;
}

function BulkDialogBody({
  request,
  onClose,
  onApplied,
}: {
  request: ModelBulkRequest;
  onClose: () => void;
  onApplied: (applied: ModelBulkApplied) => void;
}) {
  const { kind, selection } = request;
  const takesValues = bulkKindTakesValues(kind);
  const isTags = bulkKindIsTags(kind);
  const [values, setValues] = useState<string[]>(request.values ?? []);
  const [alsoRemoveBase, setAlsoRemoveBase] = useState(request.alsoRemoveBase ?? false);
  const [showChanged, setShowChanged] = useState(false);
  /** A fresh dry run from a 409, for the change it was computed for. */
  const [replaced, setReplaced] = useState<{ changeKey: string; dryRun: ModelAccessBulkDryRun } | null>(null);

  const tags = useAdminUserTags(isTags);
  const change = bulkChangeOf(kind, values, alsoRemoveBase);
  const changeKey = JSON.stringify(change);
  const tooMany = 'ids' in selection && selection.ids.length > MODEL_ACCESS_BULK_MAX_IDS;

  const preview = useQuery({
    queryKey: [...DRY_RUN_KEY, selection, change],
    queryFn: () => postModelAccessBulk<ModelAccessBulkDryRun>({ selection, change: change! }),
    enabled: !!change && !tooMany,
    retry: false,
    gcTime: 0,
  });
  const dryRun = replaced?.changeKey === changeKey ? replaced.dryRun : preview.data;
  // The admins-only confirm and the server's admins-only list hold for one change and one dry run only.
  const previewKey = `${changeKey}|${dryRun?.token ?? ''}`;
  const [adminOnlyConfirmedFor, setAdminOnlyConfirmedFor] = useState<string | null>(null);
  const adminOnlyConfirmed = adminOnlyConfirmedFor === previewKey;
  const [serverAdminOnly, setServerAdminOnly] = useState<{ previewKey: string; ids: string[] } | null>(null);
  const serverAdminOnlyIds = serverAdminOnly?.previewKey === previewKey ? serverAdminOnly.ids : null;

  const apply = useMutation({
    mutationFn: ({ reason }: { reason: string; previewKey: string }) =>
      postModelAccessBulk<ModelAccessBulkResult>({
        selection,
        change: change!,
        reason,
        dryRunToken: dryRun!.token,
        ...(adminOnlyConfirmed ? { confirmAdminOnly: true } : {}),
      }),
  });

  const entryTags = request.entryTags;
  const options = useMemo(() => {
    if (!isTags) return [...KNOWN_ENTITLEMENT_KEYS];
    return [...new Set([...(tags.data ?? []).map(entry => entry.tag), ...(entryTags ?? [])])];
  }, [isTags, tags.data, entryTags]);
  const tagCounts = useMemo(() => new Map((tags.data ?? []).map(entry => [entry.tag, entry.count])), [tags.data]);

  const adminOnlyIds = serverAdminOnlyIds ?? dryRun?.adminOnlyIds ?? [];
  const quiet = dryRun ? noAudienceChangeItems(dryRun) : [];
  const changed = dryRun?.items.filter(item => item.changes) ?? [];
  const applyError = apply.variables?.previewKey === previewKey ? apply.error : null;
  const conflict = applyError ? apiErrorOf(applyError) : null;
  const stale = !!replaced && replaced.changeKey === changeKey;
  const previewProblem = selectionProblem(preview.error);
  const valueNoun = isTags ? 'tag' : 'entitlement';

  const blockedReason =
    takesValues && values.length === 0
      ? `Pick at least one ${valueNoun}.`
      : tooMany
        ? `Select at most ${MODEL_ACCESS_BULK_MAX_IDS} models for one bulk change.`
        : preview.error && !dryRun
          ? 'The preview failed.'
          : !dryRun
            ? 'Loading the preview.'
            : dryRun.counts.change === 0
              ? 'Nothing to change: every selected model already matches.'
              : adminOnlyIds.length > 0 && !adminOnlyConfirmed
                ? 'Confirm the models only admins will see.'
                : null;

  const confirm = async (reason: string) => {
    if (!change || !dryRun) return;
    try {
      const result = await apply.mutateAsync({ reason, previewKey });
      onApplied({ request, values, alsoRemoveBase, reason, result });
    } catch (error) {
      const { status, data } = apiErrorOf(error);
      if (status === 409 && data.dryRun) {
        setReplaced({ changeKey, dryRun: data.dryRun as ModelAccessBulkDryRun });
      } else if (status === 422 && Array.isArray(data.adminOnlyIds)) {
        setServerAdminOnly({ previewKey, ids: data.adminOnlyIds as string[] });
      }
    }
  };

  const normalize = (raw: string[]) => {
    const cleaned = raw.map(value => (isTags ? value.trim() : normalizeEntitlementKey(value))).filter(Boolean);
    return [...new Set(cleaned)];
  };

  return (
    <ActionDialog
      open
      onClose={() => {
        if (!apply.isPending) onClose();
      }}
      title={`${MODEL_BULK_LABEL[kind]}: ${countOf(dryRun?.counts.selected ?? request.count, 'selected model')}`}
      description={`Each model's access entry is written on its own. ${MODEL_PICKER_FRESHNESS}`}
      reasonPresets={ADMIN_REASON_PRESETS.modelAccess}
      confirmLabel={confirmLabelOf(kind, dryRun?.counts.change ?? request.count)}
      onConfirm={confirm}
      pending={apply.isPending}
      blockedReason={blockedReason}
      data-testid="models-bulk-dialog"
    >
      <Stack gap={1.5}>
        {takesValues && (
          <FormControl>
            <FormLabel>{isTags ? 'Tags' : 'Entitlements'}</FormLabel>
            <Autocomplete
              multiple
              freeSolo
              size="sm"
              placeholder={isTags ? 'Pick or type a user tag' : 'Pick or type an entitlement'}
              options={options}
              value={values}
              loading={isTags && tags.isLoading}
              onChange={(_event, next) => setValues(normalize(next))}
              getOptionLabel={option =>
                isTags && tagCounts.has(option) ? `${option} (${countOf(tagCounts.get(option)!, 'user')})` : option
              }
              slotProps={{ input: { 'data-testid': 'models-bulk-values-input' } }}
            />
          </FormControl>
        )}

        {previewProblem ? (
          <Alert color="danger" data-testid="models-bulk-selection-error">
            {previewProblem}
          </Alert>
        ) : preview.error && !dryRun ? (
          <Alert
            color="danger"
            data-testid="models-bulk-preview-error"
            endDecorator={
              <Button
                size="sm"
                variant="plain"
                color="neutral"
                onClick={() => void preview.refetch()}
                data-testid="models-bulk-preview-retry-btn"
              >
                Retry
              </Button>
            }
          >
            {getErrorMessage(preview.error)}
          </Alert>
        ) : null}

        {stale && (
          <Alert color="warning" data-testid="models-bulk-stale">
            Access changed since the preview. Check the new diff below and apply again.
          </Alert>
        )}

        {dryRun && change && (
          <Stack gap={1} data-testid="models-bulk-preview">
            <Typography level="title-sm" data-testid="models-bulk-summary">
              {bulkDiffSummary(kind, values, dryRun.counts)}
            </Typography>
            {changed.length > 0 && (
              <Box>
                <Button
                  size="sm"
                  variant="plain"
                  onClick={() => setShowChanged(open => !open)}
                  aria-expanded={showChanged}
                  data-testid="models-bulk-changed-toggle-btn"
                  sx={{ px: 0 }}
                >
                  {showChanged ? 'Hide' : 'Show'} the {countOf(changed.length, 'model')} that change
                </Button>
                {showChanged && (
                  <Box
                    component="ul"
                    data-testid="models-bulk-changed-list"
                    sx={{ m: 0, pl: 2.5, maxHeight: 240, overflowY: 'auto' }}
                  >
                    {changed.map(item => (
                      <Typography
                        key={item.id}
                        component="li"
                        level="body-sm"
                        sx={{ overflowWrap: 'anywhere' }}
                        data-testid="models-bulk-changed-item"
                      >
                        <Box component="span" sx={{ fontFamily: 'code', fontSize: 12 }}>
                          {item.id}
                        </Box>
                        {': '}
                        {describeBulkEntry(item)}
                        <Typography component="span" level="body-xs" sx={{ display: 'block', color: 'admin.inkMuted' }}>
                          {BULK_AUDIENCE_LABEL[item.audience]}
                        </Typography>
                      </Typography>
                    ))}
                  </Box>
                )}
              </Box>
            )}
          </Stack>
        )}

        {dryRun && quiet.length > 0 && !alsoRemoveBase && (
          <Alert color="neutral" variant="soft" data-testid="models-bulk-no-audience-change">
            <Stack gap={1}>
              <Typography level="body-sm">
                No audience change for {countOf(quiet.length, 'model')}: everyone has access through base, so the{' '}
                {valueNoun} leaves their access unchanged.
              </Typography>
              {canAlsoRemoveBase(kind, dryRun) && (
                <Checkbox
                  size="sm"
                  label="Also remove base, so only users with the tag can pick them"
                  checked={alsoRemoveBase}
                  onChange={event => setAlsoRemoveBase(event.target.checked)}
                  slotProps={{ input: { 'data-testid': 'models-bulk-also-remove-base-checkbox' } }}
                />
              )}
            </Stack>
          </Alert>
        )}
        {alsoRemoveBase && (
          <Alert color="warning" variant="soft" data-testid="models-bulk-removing-base">
            <Stack gap={1}>
              <Typography level="body-sm">
                Base is removed too: only users with {values.length === 1 ? 'this tag' : 'these tags'} keep access.
              </Typography>
              <Checkbox
                size="sm"
                label="Also remove base"
                checked
                onChange={() => setAlsoRemoveBase(false)}
                slotProps={{ input: { 'data-testid': 'models-bulk-also-remove-base-checkbox' } }}
              />
            </Stack>
          </Alert>
        )}

        {adminOnlyIds.length > 0 && (
          <Alert color="danger" variant="soft" data-testid="models-bulk-admin-only">
            <Stack gap={1} sx={{ minWidth: 0 }}>
              <Typography level="body-sm">
                Only admins will see {countOf(adminOnlyIds.length, 'model')} after this change: no tags and no
                entitlements are left, so no user can pick {adminOnlyIds.length === 1 ? 'it' : 'them'}.
              </Typography>
              <Box component="ul" sx={{ m: 0, pl: 2.5, maxHeight: 160, overflowY: 'auto' }}>
                {adminOnlyIds.map(id => (
                  <Typography
                    key={id}
                    component="li"
                    level="body-sm"
                    sx={{ fontFamily: 'code', fontSize: 12, overflowWrap: 'anywhere' }}
                  >
                    {id}
                  </Typography>
                ))}
              </Box>
              <Checkbox
                size="sm"
                label="Keep these visible to admins only"
                checked={adminOnlyConfirmed}
                onChange={event => setAdminOnlyConfirmedFor(event.target.checked ? previewKey : null)}
                slotProps={{ input: { 'data-testid': 'models-bulk-admin-only-checkbox' } }}
              />
            </Stack>
          </Alert>
        )}

        {conflict && !(conflict.status === 409 && stale) && !(conflict.status === 422 && serverAdminOnlyIds) && (
          <Alert color="danger" data-testid="models-bulk-apply-error">
            {getErrorMessage(applyError)}
          </Alert>
        )}
      </Stack>
    </ActionDialog>
  );
}

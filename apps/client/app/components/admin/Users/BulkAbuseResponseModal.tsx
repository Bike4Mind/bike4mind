import {
  MAX_BULK_ABUSE_BATCH,
  normalizeEmailDomain,
  type BulkAbuseAction,
  type BulkAbuseActions,
  type BulkAbuseExclusionReason,
  type BulkAbuseExecuteResult,
  type BulkAbusePreview,
  type BulkAbusePreviewRequest,
  type BulkAbuseTarget,
} from '@bike4mind/common';
import { ReasonPicker } from '@client/app/components/admin/shared/ReasonPicker';
import {
  ADMIN_REASON_PRESETS,
  type AdminReasonDraft,
  EMPTY_ADMIN_REASON,
  composeAdminReason,
  isAdminReasonComplete,
} from '@client/app/components/admin/shared/adminReason';
import { useBulkAbuseExecute, useBulkAbusePreview } from '@client/app/hooks/data/adminBulkAbuse';
import { getErrorMessage } from '@client/app/utils/error';
import {
  Alert,
  Button,
  Checkbox,
  FormControl,
  FormHelperText,
  FormLabel,
  Input,
  List,
  ListItem,
  Modal,
  ModalClose,
  ModalDialog,
  Radio,
  RadioGroup,
  Stack,
  Typography,
} from '@mui/joy';
import React, { useState } from 'react';

type BulkAbuseResponseModalProps = {
  selectedUserIds: string[];
  onClose: () => void;
  /** Called after an execute, so the caller can drop its selection. */
  onExecuted: () => void;
  recordAction?: 'suspend' | 'revoke';
};

type Stage =
  | { kind: 'edit' }
  | { kind: 'previewed'; request: BulkAbusePreviewRequest; preview: BulkAbusePreview }
  | { kind: 'executed'; request: BulkAbusePreviewRequest; result: BulkAbuseExecuteResult };

const ACTION_LABELS: Record<BulkAbuseAction, string> = {
  ban: 'Ban accounts',
  revokeApiKeys: 'Revoke API keys',
  revokeSessions: 'Sign out everywhere (sessions and trusted devices)',
  clawbackFreeCredits: 'Claw back the unspent signup grant',
};

const EXCLUSION_LABELS: Record<BulkAbuseExclusionReason, string> = {
  self: 'your own account',
  admin: 'admin',
  system: 'system account',
  org_owner: 'organization owner or manager',
  org_member: 'organization member',
  paid: 'paid account',
  not_found: 'not found',
};

const ALL_ACTIONS: BulkAbuseActions = {
  ban: true,
  revokeApiKeys: true,
  revokeSessions: true,
  clawbackFreeCredits: true,
};

/**
 * Dry-run-then-confirm dialog for pages/api/admin/abuse/bulk-preview.ts and bulk-execute.ts.
 * Execute only acts on what the last preview showed; changing the target or actions discards it.
 * A domain past MAX_BULK_ABUSE_BATCH continues batch by batch from each result's cursor.
 */
const BulkAbuseResponseModal: React.FC<BulkAbuseResponseModalProps> = ({
  selectedUserIds,
  onClose,
  onExecuted,
  recordAction,
}) => {
  const [targetKind, setTargetKind] = useState<BulkAbuseTarget['kind']>(selectedUserIds.length ? 'users' : 'domain');
  const [domain, setDomain] = useState('');
  // Domain continuation cursor; kept across action edits so "Preview again" stays on the same batch.
  const [afterUserId, setAfterUserId] = useState<string | undefined>();
  const [actions, setActions] = useState<BulkAbuseActions>(
    recordAction
      ? {
          ban: recordAction === 'suspend',
          revokeApiKeys: true,
          revokeSessions: recordAction === 'suspend',
          clawbackFreeCredits: false,
        }
      : ALL_ACTIONS
  );
  const [reason, setReason] = useState<AdminReasonDraft>(EMPTY_ADMIN_REASON);
  const [stage, setStage] = useState<Stage>({ kind: 'edit' });
  const previewMutation = useBulkAbusePreview();
  const executeMutation = useBulkAbuseExecute();

  const normalizedDomain = normalizeEmailDomain(domain);
  const tooManySelected = selectedUserIds.length > MAX_BULK_ABUSE_BATCH;
  // The server revokes API keys for any ban, so the checkbox shows it as on and locked.
  const effectiveActions: BulkAbuseActions = { ...actions, revokeApiKeys: actions.revokeApiKeys || actions.ban };
  const hasAction = Object.values(effectiveActions).some(Boolean);
  const targetValid =
    targetKind === 'domain' ? normalizedDomain !== null : selectedUserIds.length > 0 && !tooManySelected;
  const busy = previewMutation.isPending || executeMutation.isPending;

  const resetPreview = () => {
    setStage({ kind: 'edit' });
    previewMutation.reset();
    executeMutation.reset();
  };

  const runPreview = (request: BulkAbusePreviewRequest) => {
    executeMutation.reset();
    previewMutation.mutate(request, {
      onSuccess: preview => setStage({ kind: 'previewed', request, preview }),
      // A failed re-preview must not leave the previous one armed beside the error.
      onError: () => setStage({ kind: 'edit' }),
    });
  };

  const handlePreview = () => {
    const target: BulkAbuseTarget =
      targetKind === 'domain'
        ? { kind: 'domain', domain: normalizedDomain ?? domain, ...(afterUserId ? { afterUserId } : {}) }
        : { kind: 'users', userIds: selectedUserIds };
    runPreview({ target, actions: effectiveActions });
  };

  const handleExecute = () => {
    if (stage.kind !== 'previewed') return;
    const { request, preview } = stage;
    executeMutation.mutate(
      { ...request, previewToken: preview.previewToken, reason: composeAdminReason(reason) },
      {
        onSuccess: result => {
          setStage({ kind: 'executed', request, result });
          onExecuted();
        },
      }
    );
  };

  const nextBatchCursor =
    stage.kind === 'executed'
      ? stage.result.nextAfterUserId
      : stage.kind === 'previewed' && stage.preview.includedCount === 0
        ? stage.preview.nextAfterUserId
        : null;

  const handleNextBatch = () => {
    if (stage.kind === 'edit' || stage.request.target.kind !== 'domain' || !nextBatchCursor) return;
    setAfterUserId(nextBatchCursor);
    runPreview({
      target: { ...stage.request.target, afterUserId: nextBatchCursor },
      actions: stage.request.actions,
    });
  };

  // A batch of only skipped users can still be applied when it carries the domain block.
  const hasWork =
    stage.kind === 'previewed' && (stage.preview.includedCount > 0 || stage.preview.blocksDomain !== null);
  const canExecute = hasWork && isAdminReasonComplete(reason) && !busy;
  const error = previewMutation.error ?? executeMutation.error;
  // Closing mid-run would unmount before onSuccess, losing the results and the selection reset.
  const handleClose = () => {
    if (!executeMutation.isPending) onClose();
  };

  return (
    <Modal open onClose={handleClose}>
      <ModalDialog
        data-testid="bulk-abuse-modal"
        aria-labelledby="bulk-abuse-title"
        sx={{ minWidth: { xs: '90%', sm: 600 }, maxWidth: 720, maxHeight: '90vh', overflow: 'auto' }}
      >
        <ModalClose disabled={executeMutation.isPending} />
        <Typography id="bulk-abuse-title" level="h4">
          {recordAction === 'suspend'
            ? 'Suspend account'
            : recordAction === 'revoke'
              ? 'Revoke API keys'
              : 'Bulk abuse response'}
        </Typography>
        {recordAction && (
          <Typography level="body-sm">
            This audited flow excludes paid, admin, system and organization accounts. Preview checks eligibility before
            any change. Suspension also revokes API keys and signs the user out.
          </Typography>
        )}

        {stage.kind !== 'executed' && (
          <>
            <FormControl>
              <FormLabel>Target</FormLabel>
              <RadioGroup
                orientation="horizontal"
                value={targetKind}
                onChange={event => {
                  setTargetKind(event.target.value === 'users' ? 'users' : 'domain');
                  setAfterUserId(undefined);
                  resetPreview();
                }}
              >
                <Radio
                  value="users"
                  label={`Selected users (${selectedUserIds.length})`}
                  disabled={selectedUserIds.length === 0 || executeMutation.isPending}
                  slotProps={{ input: { 'data-testid': 'bulk-abuse-target-users-radio' } }}
                />
                <Radio
                  value="domain"
                  label="Email domain"
                  disabled={executeMutation.isPending || !!recordAction}
                  slotProps={{ input: { 'data-testid': 'bulk-abuse-target-domain-radio' } }}
                />
              </RadioGroup>
              {targetKind === 'users' && tooManySelected && (
                <FormHelperText>Select at most {MAX_BULK_ABUSE_BATCH} users per run.</FormHelperText>
              )}
            </FormControl>

            {targetKind === 'domain' && (
              <FormControl error={domain.length > 0 && !normalizedDomain}>
                <FormLabel>Domain</FormLabel>
                <Input
                  placeholder="example.com"
                  value={domain}
                  disabled={executeMutation.isPending}
                  onChange={event => {
                    setDomain(event.target.value);
                    setAfterUserId(undefined);
                    resetPreview();
                  }}
                  slotProps={{ input: { 'data-testid': 'bulk-abuse-domain-input' } }}
                />
                <FormHelperText data-testid="bulk-abuse-domain-helper">
                  {afterUserId
                    ? 'Continuing after the previous batch. Edit the domain to start over.'
                    : 'Covers every subdomain. Banning also blocks new signups from it.'}
                </FormHelperText>
              </FormControl>
            )}

            <Stack component="fieldset" spacing={0.5} sx={{ border: 0, p: 0, m: 0 }}>
              <Typography component="legend" level="title-sm">
                Actions
              </Typography>
              {(Object.keys(ACTION_LABELS) as BulkAbuseAction[]).map(action => (
                <Checkbox
                  key={action}
                  label={ACTION_LABELS[action]}
                  checked={effectiveActions[action]}
                  disabled={executeMutation.isPending || !!recordAction || (action === 'revokeApiKeys' && actions.ban)}
                  onChange={event => {
                    setActions(current => ({ ...current, [action]: event.target.checked }));
                    resetPreview();
                  }}
                  slotProps={{
                    input: {
                      'data-testid': `bulk-abuse-action-${action}-checkbox`,
                      'aria-label': ACTION_LABELS[action],
                    },
                  }}
                />
              ))}
            </Stack>
          </>
        )}

        {error && (
          <Alert color="danger" data-testid="bulk-abuse-error">
            {getErrorMessage(error)}
          </Alert>
        )}

        {stage.kind === 'previewed' && <PreviewSummary preview={stage.preview} actions={stage.request.actions} />}
        {stage.kind === 'executed' && <ExecuteSummary result={stage.result} />}

        {hasWork && (
          <ReasonPicker
            presets={ADMIN_REASON_PRESETS.bulkAbuseResponse}
            value={reason}
            onChange={setReason}
            data-testid="bulk-abuse-reason-input"
          />
        )}

        <Stack direction="row" spacing={1} justifyContent="flex-end">
          {stage.kind !== 'edit' && stage.request.target.kind === 'domain' && nextBatchCursor && (
            <Button data-testid="bulk-abuse-next-batch-btn" loading={busy} onClick={handleNextBatch}>
              Preview next batch
            </Button>
          )}
          {stage.kind === 'executed' ? (
            <>
              <Button data-testid="bulk-abuse-done-btn" variant="outlined" onClick={onClose}>
                Done
              </Button>
            </>
          ) : (
            <>
              <Button
                data-testid="bulk-abuse-preview-btn"
                variant="outlined"
                disabled={!targetValid || !hasAction || busy}
                loading={previewMutation.isPending}
                onClick={handlePreview}
              >
                {stage.kind === 'previewed' ? 'Preview again' : 'Preview'}
              </Button>
              <Button
                data-testid="bulk-abuse-execute-btn"
                color="danger"
                disabled={!canExecute}
                loading={executeMutation.isPending}
                onClick={handleExecute}
              >
                {stage.kind !== 'previewed'
                  ? 'Apply'
                  : stage.preview.includedCount > 0
                    ? `Apply to ${stage.preview.includedCount} ${stage.preview.includedCount === 1 ? 'user' : 'users'}`
                    : stage.request.target.kind === 'domain'
                      ? 'Block domain only'
                      : 'No eligible users'}
              </Button>
            </>
          )}
        </Stack>
      </ModalDialog>
    </Modal>
  );
};

const PreviewSummary: React.FC<{ preview: BulkAbusePreview; actions: BulkAbuseActions }> = ({ preview, actions }) => (
  <Stack spacing={1} data-testid="bulk-abuse-preview-summary">
    <Typography level="title-md" data-testid="bulk-abuse-included-count">
      {preview.includedCount} users will be actioned
      {preview.hasMore ? ` (the first ${preview.includedCount}; more match and continue in a next batch)` : ''}
    </Typography>
    <Typography level="body-sm">
      {preview.alreadyBannedCount} already banned, {preview.activeApiKeyCount} active API keys,{' '}
      {actions.clawbackFreeCredits
        ? `${preview.clawbackCredits} credits to claw back.`
        : 'No credits will be clawed back.'}
    </Typography>
    {preview.blocksDomain && (
      <Alert color="warning" data-testid="bulk-abuse-blocks-domain">
        New signups from {preview.blocksDomain} and its subdomains will be blocked.
      </Alert>
    )}
    {preview.sample.length > 0 && (
      <List size="sm" data-testid="bulk-abuse-sample">
        {preview.sample.map(user => (
          <ListItem key={user.id}>
            {user.email ?? user.username} - {user.currentCredits} credits{user.isBanned ? ' (banned)' : ''}
          </ListItem>
        ))}
      </List>
    )}
    {preview.excluded.length > 0 && (
      <Stack data-testid="bulk-abuse-excluded">
        <Typography level="title-sm">{preview.excluded.length} skipped</Typography>
        <List size="sm">
          {preview.excluded.map(exclusion => (
            <ListItem key={exclusion.userId}>
              {exclusion.email ?? exclusion.userId}: {EXCLUSION_LABELS[exclusion.reason]}
            </ListItem>
          ))}
        </List>
      </Stack>
    )}
  </Stack>
);

const ExecuteSummary: React.FC<{ result: BulkAbuseExecuteResult }> = ({ result }) => (
  <Stack spacing={1} data-testid="bulk-abuse-result-summary">
    <Alert color={result.failedCount ? 'warning' : 'success'}>
      {result.succeededCount} succeeded, {result.failedCount} failed, {result.excluded.length} skipped.
    </Alert>
    <Typography level="body-sm">
      {result.bannedCount} banned, {result.revokedApiKeyCount} API keys revoked, {result.clawedBackCredits} credits
      clawed back.
      {result.blockedDomain ? ` ${result.blockedDomain} added to the blocked email domains.` : ''}
    </Typography>
    {result.failedCount > 0 && (
      <List size="sm" data-testid="bulk-abuse-failures">
        {result.results
          .filter(entry => entry.status === 'failed')
          .map(entry => (
            <ListItem key={entry.userId}>
              {entry.email ?? entry.userId}: {entry.error ?? 'failed'}
            </ListItem>
          ))}
      </List>
    )}
    {result.hasMore && (
      <Typography level="body-sm" data-testid="bulk-abuse-has-more">
        More users match this domain. Preview the next batch to continue.
      </Typography>
    )}
  </Stack>
);

export default BulkAbuseResponseModal;

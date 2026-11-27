import { useState } from 'react';
import { isAxiosError } from 'axios';
import { Box, Button, Chip, Option, Select, Sheet, Stack, Switch, Typography } from '@mui/joy';
import type { SxProps } from '@mui/joy/styles/types';
import {
  CALLABLE_FUNCTION_TRUST_LABEL_TEXT,
  describeFunctionContractChange,
  type CallableFunctionApprovalMode,
  type ICallableFunctionShared,
} from '@bike4mind/common';
import {
  useCallableFunctionsEnabled,
  useReviewSharedCallableFunction,
  useSharedCallableFunctions,
  useUpdateSharedCallableFunctionReview,
} from '@client/app/hooks/data/callableFunctions';
import { ContractTable } from '@client/app/components/Knowledge/FunctionContractTable';

const VIA: Record<ICallableFunctionShared['sharedVia'], string> = {
  person: 'Shared with you',
  project: 'Shared with a project you are in',
  organization: 'Shared with your organization',
  signed_in: 'Offered to everyone signed in',
};

const STATUS: Record<ICallableFunctionShared['status'], { label: string; color: 'warning' | 'success' | 'neutral' }> = {
  pending_review: { label: 'Pending review', color: 'warning' },
  reviewed: { label: 'Reviewed', color: 'success' },
  disabled: { label: 'Turned off', color: 'neutral' },
};

const APPROVAL_LABELS: Record<CallableFunctionApprovalMode, string> = {
  default: 'Default',
  always_allow: 'Always allow',
  always_ask: 'Always ask',
};

const errorMessage = (error: unknown, fallback: string): string =>
  isAxiosError(error) && (error.response?.data as { code?: unknown } | undefined)?.code === 'review_conflict'
    ? 'The tool changed while you were reviewing it. Review it again.'
    : fallback;

/** One shared function and the recipient's review of it; also the recipient's view in the functions library. */
export function SharedFunctionCard({
  fn,
  defaultOpen = false,
}: {
  fn: ICallableFunctionShared;
  defaultOpen?: boolean;
}) {
  const pending = fn.status === 'pending_review';
  const [open, setOpen] = useState(defaultOpen);
  const [draftApproval, setDraftApproval] = useState<CallableFunctionApprovalMode>(fn.review?.approval ?? 'default');
  const [error, setError] = useState<string | null>(null);
  const review = useReviewSharedCallableFunction();
  const update = useUpdateSharedCallableFunctionReview();
  const approval = pending ? draftApproval : (fn.review?.approval ?? 'default');
  const status = STATUS[fn.status];

  const onReview = () => {
    setError(null);
    review.mutate(
      { id: fn.id, reviewHash: fn.reviewHash, approval },
      { onError: err => setError(errorMessage(err, 'Could not save the review. Try again.')) }
    );
  };
  const onSettings = (settings: { approval?: CallableFunctionApprovalMode; enabled?: boolean }) => {
    setError(null);
    update.mutate({ id: fn.id, ...settings }, { onError: () => setError('Could not save the change. Try again.') });
  };

  return (
    <Sheet variant="outlined" sx={{ borderRadius: '8px', p: 1.5 }} data-testid="shared-function-row">
      <Stack direction="row" gap="8px" alignItems="center" flexWrap="wrap">
        <Typography level="title-sm" sx={{ fontFamily: 'code' }}>
          {fn.slug}
        </Typography>
        <Chip size="sm" variant="soft" color={status.color} data-testid="shared-function-status">
          {status.label}
        </Chip>
        <Box sx={{ flex: 1 }} />
        <Button
          size="sm"
          variant={pending ? 'solid' : 'plain'}
          onClick={() => setOpen(value => !value)}
          data-testid="shared-function-open-btn"
        >
          {open ? 'Close' : pending ? 'Review' : 'Details'}
        </Button>
      </Stack>
      <Typography level="body-sm" sx={{ mt: 0.5 }}>
        {fn.description}
      </Typography>
      <Typography level="body-xs" sx={{ color: 'text.secondary', mt: 0.5 }} data-testid="shared-function-summary">
        {VIA[fn.sharedVia]} by {fn.ownerName}, promotion {fn.pin.seq ?? ''}.{' '}
        {pending
          ? fn.review
            ? 'Its name, description, or schemas changed since your review, so it cannot be called until you review it again.'
            : 'It cannot be called until you review it.'
          : fn.status === 'disabled'
            ? 'You turned it off.'
            : 'You reviewed it.'}
      </Typography>
      {pending && fn.changes && fn.changes.length > 0 && (
        <Stack gap="2px" sx={{ mt: 0.5 }} data-testid="shared-function-changes">
          <Typography level="body-xs" sx={{ color: 'text.secondary' }}>
            Changed since your review:
          </Typography>
          <Box component="ul" sx={{ m: 0, pl: 2.5 }}>
            {fn.changes.map(change => {
              const { subject, field, words } = describeFunctionContractChange(change);
              return (
                <Typography
                  component="li"
                  level="body-sm"
                  key={`${change.path}:${change.kind}`}
                  data-testid="shared-function-change"
                >
                  {subject}
                  {field && (
                    <>
                      {' '}
                      <code>{field}</code>
                    </>
                  )}{' '}
                  {words}
                </Typography>
              );
            })}
          </Box>
        </Stack>
      )}
      {open && (
        <Stack gap="12px" sx={{ mt: 1.5 }} data-testid="shared-function-review-card">
          <Stack gap="4px">
            <Typography level="title-sm">Inputs</Typography>
            <ContractTable schema={fn.inputs} testId="shared-function-inputs" />
          </Stack>
          <Stack gap="4px">
            <Typography level="title-sm">Outputs</Typography>
            <ContractTable schema={fn.outputs} testId="shared-function-outputs" />
          </Stack>
          <Stack gap="4px">
            <Typography level="title-sm">Label</Typography>
            <Typography level="body-sm" data-testid="shared-function-label">
              {fn.trustLabel ? CALLABLE_FUNCTION_TRUST_LABEL_TEXT[fn.trustLabel] : 'None.'}
            </Typography>
          </Stack>
          <Stack gap="4px">
            <Typography level="title-sm">Owner</Typography>
            <Typography level="body-sm" data-testid="shared-function-owner">
              {fn.ownerName}
            </Typography>
          </Stack>
          <Stack gap="4px" data-testid="shared-function-data">
            <Typography level="title-sm">Data it reads</Typography>
            {fn.dataPins.length + fn.sources.length === 0 ? (
              <Typography level="body-sm" sx={{ color: 'text.secondary' }}>
                None.
              </Typography>
            ) : (
              <Box component="ul" sx={{ m: 0, pl: 2.5 }}>
                {fn.dataPins.map(name => (
                  <li key={`data-${name}`} data-testid="shared-function-data-item">
                    <Typography level="body-sm">Data file: {name}</Typography>
                  </li>
                ))}
                {fn.sources.map(name => (
                  <li key={`source-${name}`} data-testid="shared-function-data-item">
                    <Typography level="body-sm">Source: {name}</Typography>
                  </li>
                ))}
              </Box>
            )}
          </Stack>
          <Typography level="body-xs" sx={{ color: 'text.secondary' }}>
            A review covers the name, description, and schemas, not the code. The owner can change the code and keep
            your review; a change to any of those asks you to review again.
          </Typography>
          <Stack direction="row" gap="12px" alignItems="center" flexWrap="wrap">
            <Typography level="body-sm">Before a call in chat</Typography>
            <Select
              size="sm"
              value={approval}
              onChange={(_event, value) => {
                if (!value) return;
                if (pending) setDraftApproval(value);
                else onSettings({ approval: value });
              }}
              disabled={update.isPending}
              slotProps={{ button: { 'data-testid': 'shared-function-approval' } }}
              sx={{ minWidth: 150 }}
            >
              {(Object.keys(APPROVAL_LABELS) as CallableFunctionApprovalMode[]).map(mode => (
                <Option key={mode} value={mode}>
                  {APPROVAL_LABELS[mode]}
                </Option>
              ))}
            </Select>
            <Box sx={{ flex: 1 }} />
            {pending ? (
              <Button size="sm" onClick={onReview} loading={review.isPending} data-testid="shared-function-review-btn">
                Allow calls
              </Button>
            ) : (
              <Switch
                checked={fn.status === 'reviewed'}
                disabled={update.isPending}
                onChange={event => onSettings({ enabled: event.target.checked })}
                endDecorator={fn.status === 'reviewed' ? 'On' : 'Off'}
                slotProps={{ input: { 'aria-label': 'Allow calls', 'data-testid': 'shared-function-enabled' } }}
              />
            )}
          </Stack>
          <Typography level="body-xs" sx={{ color: 'text.tertiary' }}>
            An Always ask function is not offered in a run with no one to answer.
          </Typography>
          {error && (
            <Typography level="body-sm" color="danger" data-testid="shared-function-error">
              {error}
            </Typography>
          )}
        </Stack>
      )}
    </Sheet>
  );
}

/**
 * Functions other people shared with this person: each runs for them only after they review its interface. Shown
 * on the Integrations page whenever callable functions are on, whatever the MCP settings are.
 */
export default function SharedFunctionsSection({ sx }: { sx?: SxProps }) {
  const enabled = useCallableFunctionsEnabled();
  const { data } = useSharedCallableFunctions(enabled);
  if (!enabled || !data || data.length === 0) return null;
  return (
    <Stack gap="8px" sx={sx} data-testid="shared-functions-section">
      <Typography level="title-sm">Functions shared with you</Typography>
      {data.map(fn => (
        <SharedFunctionCard key={`${fn.id}:${fn.reviewHash}`} fn={fn} />
      ))}
    </Stack>
  );
}

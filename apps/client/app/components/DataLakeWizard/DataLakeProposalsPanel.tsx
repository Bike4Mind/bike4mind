import React, { useState } from 'react';
import { Alert, Box, Button, Chip, CircularProgress, Divider, Input, Link, Stack, Typography } from '@mui/joy';
import type { IDataLakeProposalDocument } from '@bike4mind/common';

export interface DataLakeProposalsPanelProps {
  proposals: IDataLakeProposalDocument[] | undefined;
  isLoading: boolean;
  error: unknown;
  /** The proposal a decision is currently in flight for, so only its own buttons show busy. */
  pendingProposalId?: string;
  onApprove: (proposalId: string) => void;
  onDecline: (proposalId: string, reason?: string) => void;
}

const formatRetrieved = (value: Date | string | undefined): string => {
  if (!value) return 'unknown date';
  const date = value instanceof Date ? value : new Date(value);
  return Number.isNaN(date.getTime()) ? 'unknown date' : date.toLocaleDateString();
};

/**
 * The human half of the acquisition queue (#1671): one lake's pending proposals, each approved or
 * declined explicitly. There is no bulk-approve and no auto-approve control, deliberately - the
 * decision this panel exists to capture is per-source, and a confidence score is shown only as
 * context a reviewer may weigh, never as a lever anything acts on.
 *
 * Pure/presentational - all data and mutations arrive via props - so it needs no
 * QueryClientProvider in tests.
 */
export function DataLakeProposalsPanel({
  proposals,
  isLoading,
  error,
  pendingProposalId,
  onApprove,
  onDecline,
}: DataLakeProposalsPanelProps) {
  const [decliningId, setDecliningId] = useState<string | null>(null);
  const [reason, setReason] = useState('');

  if (isLoading) {
    return (
      <Box sx={{ display: 'flex', justifyContent: 'center', py: 3 }} data-testid="datalake-proposals-loading">
        <CircularProgress size="sm" />
      </Box>
    );
  }

  if (error) {
    return (
      <Alert color="danger" size="sm" data-testid="datalake-proposals-error">
        Could not load proposals for this data lake. Try again shortly.
      </Alert>
    );
  }

  if (!proposals?.length) {
    return (
      <Typography level="body-sm" data-testid="datalake-proposals-empty">
        Nothing is waiting for review. Content found for this lake shows up here for you to approve before it is added.
      </Typography>
    );
  }

  return (
    <Stack spacing={2} data-testid="datalake-proposals-list">
      {proposals.map(proposal => {
        const busy = pendingProposalId === proposal.id;
        return (
          <Box
            key={proposal.id}
            data-testid="datalake-proposal-row"
            sx={{ border: '1px solid', borderColor: 'divider', borderRadius: 'sm', p: 1.5 }}
          >
            <Stack spacing={1}>
              <Stack direction="row" spacing={1} sx={{ alignItems: 'center', flexWrap: 'wrap' }}>
                <Typography level="title-sm" sx={{ flex: 1, minWidth: '12rem' }}>
                  {proposal.title}
                </Typography>
                {proposal.priorDisposition === 'declined' && (
                  <Chip size="sm" color="warning" data-testid="datalake-proposal-previously-declined">
                    Previously declined
                  </Chip>
                )}
                {/* Deliberately not "Updated since approval": a re-proposed approved source means
                    EITHER its text changed materially OR the file that approval admitted is no
                    longer a live lake member (see proposeDataLakeContent's prior_approval arm).
                    "Previously approved" is the one claim true of both, and it is the history the
                    reviewer actually needs. */}
                {proposal.priorDisposition === 'approved' && (
                  <Chip size="sm" color="neutral" data-testid="datalake-proposal-previously-approved">
                    Previously approved
                  </Chip>
                )}
                {typeof proposal.confidence === 'number' && (
                  <Chip size="sm" variant="soft" data-testid="datalake-proposal-confidence">
                    {`Confidence ${Math.round(proposal.confidence * 100)}%`}
                  </Chip>
                )}
              </Stack>

              <Link
                href={proposal.sourceUrl}
                target="_blank"
                rel="noopener noreferrer nofollow"
                level="body-xs"
                data-testid="datalake-proposal-source"
              >
                {proposal.sourceUrl}
              </Link>

              <Typography level="body-xs" textColor="text.tertiary" data-testid="datalake-proposal-provenance">
                {`Found by ${proposal.provenance.producer}`}
                {proposal.provenance.query ? ` while researching "${proposal.provenance.query}"` : ''}
                {` \u00b7 retrieved ${formatRetrieved(proposal.provenance.retrievedAt)}`}
              </Typography>

              {proposal.proposedTags.length > 0 && (
                <Stack direction="row" spacing={0.5} sx={{ flexWrap: 'wrap' }}>
                  {proposal.proposedTags.map(tag => (
                    <Chip key={tag} size="sm" variant="outlined" data-testid="datalake-proposal-tag">
                      {tag}
                    </Chip>
                  ))}
                </Stack>
              )}

              {proposal.excerpt && (
                <Box
                  sx={{ bgcolor: 'background.level1', borderRadius: 'sm', p: 1 }}
                  data-testid="datalake-proposal-excerpt"
                >
                  <Typography level="body-xs" textColor="text.tertiary" sx={{ mb: 0.5 }}>
                    {/* Framed as untrusted on purpose: this is text the source wrote, shown to a
                        human deciding whether to admit it. It is never HTML and never instructions. */}
                    Excerpt from the source - not yet reviewed
                  </Typography>
                  <Typography level="body-xs" sx={{ whiteSpace: 'pre-wrap' }}>
                    {proposal.excerpt}
                  </Typography>
                </Box>
              )}

              <Divider />

              {decliningId === proposal.id ? (
                <Stack direction="row" spacing={1} sx={{ alignItems: 'center' }}>
                  <Input
                    size="sm"
                    value={reason}
                    autoFocus
                    placeholder="Why are you declining? (optional)"
                    onChange={e => setReason(e.target.value)}
                    sx={{ flex: 1 }}
                    slotProps={{ input: { 'data-testid': 'datalake-proposal-decline-reason' } }}
                  />
                  <Button
                    size="sm"
                    color="danger"
                    loading={busy}
                    onClick={() => {
                      onDecline(proposal.id, reason.trim() || undefined);
                      setDecliningId(null);
                      setReason('');
                    }}
                    data-testid="datalake-proposal-decline-confirm-btn"
                  >
                    Decline
                  </Button>
                  <Button
                    size="sm"
                    variant="plain"
                    color="neutral"
                    onClick={() => {
                      setDecliningId(null);
                      setReason('');
                    }}
                    data-testid="datalake-proposal-decline-cancel-btn"
                  >
                    Cancel
                  </Button>
                </Stack>
              ) : (
                <Stack direction="row" spacing={1}>
                  <Button
                    size="sm"
                    color="primary"
                    loading={busy}
                    onClick={() => onApprove(proposal.id)}
                    data-testid="datalake-proposal-approve-btn"
                  >
                    Approve and add
                  </Button>
                  <Button
                    size="sm"
                    variant="outlined"
                    color="neutral"
                    disabled={busy}
                    onClick={() => {
                      setDecliningId(proposal.id);
                      setReason('');
                    }}
                    data-testid="datalake-proposal-decline-btn"
                  >
                    Decline
                  </Button>
                </Stack>
              )}
            </Stack>
          </Box>
        );
      })}
    </Stack>
  );
}

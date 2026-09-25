import React, { useMemo, useState } from 'react';
import {
  Alert,
  Box,
  Button,
  Chip,
  CircularProgress,
  Divider,
  Input,
  Link,
  Option,
  Select,
  Stack,
  ToggleButtonGroup,
  Typography,
} from '@mui/joy';
import type { IDataLakeProposalDocument } from '@bike4mind/common';
import { RESEARCH_RUN_PRODUCER } from '@bike4mind/common';

export type ProposalsView = 'pending' | 'declined';
type ProposalSort = 'relevance' | 'newest';

export interface DataLakeProposalsPanelProps {
  /** The rows for the current `view` - pending proposals, or declined tombstones. */
  proposals: IDataLakeProposalDocument[] | undefined;
  isLoading: boolean;
  error: unknown;
  /** The proposal a decision is currently in flight for, so only its own buttons show busy. */
  pendingProposalId?: string;
  /**
   * The last failed decision, kept ON the card. A toast is the wrong and only home for this: it
   * fades, and approval is the slow action a reviewer looks away from - so the one who most needs the
   * message is the one guaranteed to miss it, and the card gives no hint it was ever tried.
   */
  failure?: { proposalId: string; message: string };
  onApprove: (proposalId: string) => void;
  onDecline: (proposalId: string, reason?: string) => void;
  view?: ProposalsView;
  /** Absent, the panel shows the pending queue only, with no way to switch to declined. */
  onViewChange?: (view: ProposalsView) => void;
  onRestore?: (proposalId: string) => void;
  /**
   * `canonicalSourceKey`s of the current pending queue, used only in the declined view: a declined
   * row whose source has a newer pending proposal is a tombstone too, the same as an older declined
   * row a later decline superseded - restoring it hits the server's `pending_exists` refusal. The
   * server remains the guard for the later-approved case; this only prevents the guaranteed error.
   */
  pendingCanonicalSourceKeys?: ReadonlySet<string>;
}

/** Past this, an excerpt is collapsed until the reviewer asks for the rest. */
const EXCERPT_PREVIEW_CHARS = 280;

function ProposalExcerpt({ excerpt }: { excerpt: string }) {
  const [expanded, setExpanded] = useState(false);
  const collapsible = excerpt.length > EXCERPT_PREVIEW_CHARS;
  const shown = collapsible && !expanded ? `${excerpt.slice(0, EXCERPT_PREVIEW_CHARS).trimEnd()}\u2026` : excerpt;
  return (
    <Box sx={{ bgcolor: 'background.level1', borderRadius: 'sm', p: 1 }} data-testid="datalake-proposal-excerpt">
      <Typography level="body-xs" textColor="text.tertiary" sx={{ mb: 0.5 }}>
        {/* Framed as untrusted on purpose: this is text the source wrote, shown to a
            human deciding whether to admit it. It is never HTML and never instructions. */}
        Excerpt from the source - not yet reviewed
      </Typography>
      <Typography
        level="body-xs"
        sx={{
          whiteSpace: 'pre-wrap',
          // The char cut alone still lets a run of short lines push the actions off screen.
          ...(collapsible && !expanded
            ? { display: '-webkit-box', WebkitLineClamp: 4, WebkitBoxOrient: 'vertical', overflow: 'hidden' }
            : {}),
        }}
        data-testid="datalake-proposal-excerpt-text"
      >
        {shown}
      </Typography>
      {collapsible && (
        <Button
          size="sm"
          variant="plain"
          sx={{ mt: 0.5, px: 0.5, minHeight: 0 }}
          onClick={() => setExpanded(v => !v)}
          data-testid="datalake-proposal-excerpt-toggle"
        >
          {expanded ? 'Show less' : 'Show more'}
        </Button>
      )}
    </Box>
  );
}

// Array.prototype.sort is stable, so ties (and unscored rows, which sink) keep the server's
// newest-first order.
const sortProposals = (proposals: IDataLakeProposalDocument[], sort: ProposalSort): IDataLakeProposalDocument[] =>
  sort === 'newest' ? proposals : [...proposals].sort((a, b) => (b.confidence ?? -1) - (a.confidence ?? -1));

/**
 * `producer` is deliberately free-form so a new producer needs no schema change, which means this
 * renders straight into a reviewer's sentence. Known producers get a human name; anything else falls
 * back to the raw token, so an unmapped producer reads oddly rather than disappearing.
 */
const producerLabel = (producer: string): string => (producer === RESEARCH_RUN_PRODUCER ? 'a research run' : producer);

const formatRetrieved = (value: Date | string | undefined): string => {
  if (!value) return 'unknown date';
  const date = value instanceof Date ? value : new Date(value);
  return Number.isNaN(date.getTime()) ? 'unknown date' : date.toLocaleDateString();
};

/**
 * The human half of the acquisition queue (#1671): one lake's pending proposals, each approved or
 * declined explicitly. There is no bulk-approve and no auto-approve control, deliberately - the
 * decision this panel exists to capture is per-source, and the relevance score is shown (and may
 * order the list) only as context a reviewer may weigh, never as a lever anything acts on. Declined
 * tombstones have their own view, where one can be restored to the queue.
 *
 * Pure/presentational - all data and mutations arrive via props - so it needs no
 * QueryClientProvider in tests.
 */
export function DataLakeProposalsPanel({
  proposals,
  isLoading,
  error,
  pendingProposalId,
  failure,
  onApprove,
  onDecline,
  view = 'pending',
  onViewChange,
  onRestore,
  pendingCanonicalSourceKeys,
}: DataLakeProposalsPanelProps) {
  const [decliningId, setDecliningId] = useState<string | null>(null);
  const [reason, setReason] = useState('');
  const [sort, setSort] = useState<ProposalSort>('relevance');
  const declinedView = view === 'declined';
  // The declined list is newest first, so a later occurrence of a source is a superseded tombstone
  // the server will refuse to restore (see restoreDataLakeProposal). A source that instead came back
  // as a still-pending proposal is the same refusal (`pending_exists`) under a different cause, so it
  // is folded into the same set.
  const supersededIds = useMemo(() => {
    const seen = new Set<string>();
    const superseded = new Set<string>();
    if (declinedView) {
      for (const p of proposals ?? []) {
        if (seen.has(p.canonicalSourceKey) || pendingCanonicalSourceKeys?.has(p.canonicalSourceKey)) {
          superseded.add(p.id);
        }
        seen.add(p.canonicalSourceKey);
      }
    }
    return superseded;
  }, [proposals, declinedView, pendingCanonicalSourceKeys]);
  const sorted = useMemo(
    () => (proposals && !declinedView ? sortProposals(proposals, sort) : proposals),
    [proposals, sort, declinedView]
  );

  const controls =
    onViewChange || !declinedView ? (
      <Stack direction="row" spacing={1} sx={{ alignItems: 'center', flexWrap: 'wrap', rowGap: 1 }}>
        {onViewChange && (
          <ToggleButtonGroup
            size="sm"
            value={view}
            onChange={(_e, value) => value && onViewChange(value as ProposalsView)}
            data-testid="datalake-proposals-view-toggle"
          >
            <Button value="pending" data-testid="datalake-proposals-view-pending">
              Waiting for review
            </Button>
            <Button value="declined" data-testid="datalake-proposals-view-declined">
              Declined
            </Button>
          </ToggleButtonGroup>
        )}
        {!declinedView && (
          <Select
            size="sm"
            value={sort}
            onChange={(_e, value) => value && setSort(value)}
            sx={{ ml: 'auto', minWidth: '10rem' }}
            aria-label="Sort proposals"
            data-testid="datalake-proposals-sort"
          >
            <Option value="relevance">Most relevant first</Option>
            <Option value="newest">Newest first</Option>
          </Select>
        )}
      </Stack>
    ) : null;

  const withControls = (node: React.ReactNode) => (
    <Stack spacing={2}>
      {controls}
      {node}
    </Stack>
  );

  if (isLoading) {
    return withControls(
      <Box sx={{ display: 'flex', justifyContent: 'center', py: 3 }} data-testid="datalake-proposals-loading">
        <CircularProgress size="sm" />
      </Box>
    );
  }

  if (error) {
    return withControls(
      <Alert color="danger" size="sm" data-testid="datalake-proposals-error">
        Could not load proposals for this data lake. Try again shortly.
      </Alert>
    );
  }

  if (!sorted?.length) {
    // Reachable now: the tab stays put for as long as the modal is open, so finishing the last
    // decision lands here instead of silently bouncing the reviewer into the Settings form.
    return withControls(
      declinedView ? (
        <Stack spacing={1} data-testid="datalake-proposals-empty">
          <Typography level="body-sm">Nothing has been declined for this lake.</Typography>
        </Stack>
      ) : (
        <Stack spacing={1} data-testid="datalake-proposals-empty">
          <Typography level="body-sm">All caught up - nothing is waiting for review.</Typography>
          <Typography level="body-xs" textColor="text.tertiary">
            When a research run finds something for this lake it appears here first. Nothing reaches the lake until you
            approve it.
          </Typography>
        </Stack>
      )
    );
  }

  return withControls(
    <Stack spacing={2} data-testid="datalake-proposals-list">
      {/* What the buttons actually DO. Approving is a live outbound fetch that can take a few
          seconds and can fail on a dead link, and declining is remembered - neither is guessable from
          a button label, and a reviewer meeting this queue for the first time has no other cue. */}
      {declinedView ? (
        <Typography level="body-xs" textColor="text.tertiary" data-testid="datalake-proposals-help">
          Restoring puts a proposal back in the review queue. The excerpt is not kept after a decline, so open the
          source to judge it again.
        </Typography>
      ) : (
        <Typography level="body-xs" textColor="text.tertiary" data-testid="datalake-proposals-help">
          Approving fetches the page now and adds it to this lake, chunked like any other file and tagged with the lake
          tag only - suggested tags are not applied. Declining is remembered, so the same source is not proposed again
          unless its content changes.
        </Typography>
      )}
      {sorted.map(proposal => {
        const busy = pendingProposalId === proposal.id;
        return (
          <Box
            key={proposal.id}
            data-testid="datalake-proposal-row"
            sx={{ border: '1px solid', borderColor: 'divider', borderRadius: 'sm', p: 1.5 }}
          >
            <Stack spacing={1}>
              <Stack direction="row" spacing={1} sx={{ alignItems: 'center', flexWrap: 'wrap' }}>
                <Typography level="title-sm" sx={{ flex: 1, minWidth: '12rem' }} data-testid="datalake-proposal-title">
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
                    {`Relevance ${Math.round(proposal.confidence * 100)}%`}
                  </Chip>
                )}
              </Stack>

              {proposal.rationale && (
                <Typography level="body-xs" data-testid="datalake-proposal-rationale">
                  {`Why it was proposed: ${proposal.rationale}`}
                </Typography>
              )}

              {/* `break-all`, not `break-word`: a producer-supplied URL is one long unbroken token, so
                  word-level breaking leaves it overflowing the card - observed on a real seeded
                  proposal with a deep path and a query string. */}
              <Link
                href={proposal.sourceUrl}
                target="_blank"
                rel="noopener noreferrer nofollow"
                level="body-xs"
                sx={{ wordBreak: 'break-all' }}
                data-testid="datalake-proposal-source"
              >
                {proposal.sourceUrl}
              </Link>

              <Typography level="body-xs" textColor="text.tertiary" data-testid="datalake-proposal-provenance">
                {`Found by ${producerLabel(proposal.provenance.producer)}`}
                {proposal.provenance.query ? ` while researching "${proposal.provenance.query}"` : ''}
                {` \u00b7 retrieved ${formatRetrieved(proposal.provenance.retrievedAt)}`}
              </Typography>

              {!declinedView && proposal.proposedTags.length > 0 && (
                <Stack
                  direction="row"
                  spacing={0.5}
                  sx={{ flexWrap: 'wrap', alignItems: 'center' }}
                  data-testid="datalake-proposal-tags"
                >
                  <Typography level="body-xs" textColor="text.tertiary">
                    Suggested tags (not applied):
                  </Typography>
                  {proposal.proposedTags.map(tag => (
                    <Chip key={tag} size="sm" variant="outlined" data-testid="datalake-proposal-tag">
                      {tag}
                    </Chip>
                  ))}
                </Stack>
              )}

              {proposal.excerpt && <ProposalExcerpt excerpt={proposal.excerpt} />}

              {declinedView && (
                <Typography level="body-xs" data-testid="datalake-proposal-decline-record">
                  {`Declined ${formatRetrieved(proposal.reviewedAt ?? undefined)}`}
                  {proposal.declineReason ? `: ${proposal.declineReason}` : ' with no reason given'}
                </Typography>
              )}

              {failure?.proposalId === proposal.id && !busy && (
                <Alert color="danger" size="sm" data-testid="datalake-proposal-failure">
                  <Typography level="body-xs">{failure.message}</Typography>
                </Alert>
              )}

              <Divider />

              {declinedView ? (
                onRestore && (
                  <Stack direction="row" spacing={1}>
                    <Button
                      size="sm"
                      variant="outlined"
                      color="neutral"
                      loading={busy}
                      disabled={supersededIds.has(proposal.id)}
                      onClick={() => onRestore(proposal.id)}
                      data-testid="datalake-proposal-restore-btn"
                    >
                      Restore to queue
                    </Button>
                    {supersededIds.has(proposal.id) && (
                      <Typography
                        level="body-xs"
                        textColor="text.tertiary"
                        sx={{ alignSelf: 'center' }}
                        data-testid="datalake-proposal-superseded"
                      >
                        This source was proposed again later.
                      </Typography>
                    )}
                  </Stack>
                )
              ) : decliningId === proposal.id ? (
                <Stack direction="row" spacing={1} sx={{ alignItems: 'center' }}>
                  <Input
                    size="sm"
                    value={reason}
                    autoFocus
                    disabled={busy}
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
                      // Stay in decline mode until the mutation settles. Clearing it here (as this
                      // did) unmounted the busy button in the same tick, so a decline showed NO
                      // in-flight feedback at all - the row just sat there looking unclicked.
                      onDecline(proposal.id, reason.trim() || undefined);
                    }}
                    data-testid="datalake-proposal-decline-confirm-btn"
                  >
                    Decline
                  </Button>
                  <Button
                    size="sm"
                    variant="plain"
                    color="neutral"
                    disabled={busy}
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

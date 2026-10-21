import React, { useState } from 'react';
import { Alert, Box, Button, Chip, CircularProgress, Sheet, Stack, Table, Typography } from '@mui/joy';
import ContentCopyIcon from '@mui/icons-material/ContentCopy';
import { toast } from 'sonner';
import type { IntegrationDemand, IntegrationStage } from '@bike4mind/common';
import {
  REQUESTER_EMAILS_MAX_ROWS,
  fetchAllRequesterEmails,
  isRateLimited,
  useIntegrationDemand,
  useIntegrationRequesters,
  type RequesterEmails,
} from '@client/app/hooks/data/integrationDemand';

const formatDate = (iso: string) => new Date(iso).toLocaleDateString();

const RATE_LIMITED_MESSAGE = 'Too many requests, try again in a minute';

type EmailLookup = { ok: true; found: RequesterEmails } | { ok: false; error: unknown };

/**
 * Put the emails on the clipboard. Safari only honours a clipboard write started inside the click
 * itself, so where ClipboardItem exists the write starts at once with the emails still being
 * fetched (ClipboardItem accepts a promise for its blob); elsewhere the fetch finishes first.
 * The lookup settles on its own, so the caller reads its outcome whatever the write did.
 */
async function copyRequesterEmails(lookup: Promise<EmailLookup>): Promise<boolean> {
  const text = async () => {
    const result = await lookup;
    if (!result.ok || result.found.emails.length === 0) throw new Error('Nothing to copy');
    return result.found.emails.join(', ');
  };
  try {
    if (typeof ClipboardItem !== 'undefined' && navigator.clipboard?.write) {
      const blob = text().then(joined => new Blob([joined], { type: 'text/plain' }));
      await navigator.clipboard.write([new ClipboardItem({ 'text/plain': blob })]);
    } else {
      await navigator.clipboard.writeText(await text());
    }
    return true;
  } catch {
    return false;
  }
}

const STAGE_CHIP: Record<IntegrationStage, { label: string; color: 'neutral' | 'warning' | 'success' }> = {
  planned: { label: 'Roadmap', color: 'neutral' },
  beta: { label: 'Beta', color: 'warning' },
  ga: { label: 'Live', color: 'success' },
};

const StageChip: React.FC<{ stage: IntegrationStage | null }> = ({ stage }) =>
  stage ? (
    <Chip size="sm" variant="soft" color={STAGE_CHIP[stage].color}>
      {STAGE_CHIP[stage].label}
    </Chip>
  ) : (
    <Chip size="sm" variant="outlined" color="neutral">
      Not in catalog
    </Chip>
  );

const RequestersPanel: React.FC<{ integration: IntegrationDemand }> = ({ integration }) => {
  const { integrationId, name } = integration;
  const requesters = useIntegrationRequesters(integrationId);
  const [copying, setCopying] = useState(false);
  const rows = requesters.data?.pages.flatMap(page => page.data) ?? [];

  // Not awaited before the clipboard write starts: see copyRequesterEmails.
  const copyEmails = async () => {
    setCopying(true);
    const lookup: Promise<EmailLookup> = fetchAllRequesterEmails(integrationId).then(
      found => ({ ok: true, found }),
      error => ({ ok: false, error })
    );
    const copied = await copyRequesterEmails(lookup);
    const result = await lookup;
    setCopying(false);
    if (!result.ok) {
      toast.error(isRateLimited(result.error) ? RATE_LIMITED_MESSAGE : "Couldn't copy the emails. Try again.");
      return;
    }
    const { emails, truncated } = result.found;
    if (emails.length === 0) {
      toast.info('None of these requesters has an email on file.');
    } else if (!copied) {
      toast.error("Couldn't copy the emails. Try again.");
    } else if (truncated) {
      toast.warning(
        `Copied ${emails.length} emails, but this list is longer than ${REQUESTER_EMAILS_MAX_ROWS.toLocaleString()} requesters and the rest are missing.`,
        { duration: 10_000 }
      );
    } else {
      toast.success(`Copied ${emails.length} email${emails.length === 1 ? '' : 's'}`);
    }
  };

  return (
    <Sheet variant="outlined" sx={{ p: 2, borderRadius: 'sm' }} data-testid="admin-integration-demand-requesters">
      <Stack direction="row" justifyContent="space-between" alignItems="center" spacing={2} sx={{ mb: 1 }}>
        <Typography level="title-md">Who requested {name}</Typography>
        <Button
          size="sm"
          variant="outlined"
          startDecorator={<ContentCopyIcon />}
          loading={copying}
          onClick={() => void copyEmails()}
          data-testid="admin-integration-demand-copy-emails-btn"
        >
          Copy emails
        </Button>
      </Stack>

      {requesters.error ? (
        <Alert color="danger" data-testid="admin-integration-demand-requesters-error">
          {isRateLimited(requesters.error) ? RATE_LIMITED_MESSAGE : "Couldn't load the requesters."}
        </Alert>
      ) : requesters.isPending ? (
        <CircularProgress size="sm" />
      ) : (
        <>
          <Table size="sm" data-testid="admin-integration-demand-requesters-table">
            <thead>
              <tr>
                <th>Name</th>
                <th>Email</th>
                <th>Organization</th>
                <th>Requested</th>
              </tr>
            </thead>
            <tbody>
              {rows.map(row => (
                <tr key={row.userId} data-testid={`admin-integration-demand-requester-${row.userId}`}>
                  <td>{row.deleted ? 'Deleted account' : (row.name ?? '-')}</td>
                  <td>{row.email ?? '-'}</td>
                  <td>{row.organizationName ?? (row.organizationId ? 'Deleted organization' : '-')}</td>
                  <td>{formatDate(row.requestedAt)}</td>
                </tr>
              ))}
            </tbody>
          </Table>
          {requesters.hasNextPage ? (
            <Button
              size="sm"
              variant="plain"
              loading={requesters.isFetchingNextPage}
              onClick={() => void requesters.fetchNextPage()}
              sx={{ mt: 1 }}
              data-testid="admin-integration-demand-load-more-btn"
            >
              Load more
            </Button>
          ) : null}
        </>
      )}
    </Sheet>
  );
};

/**
 * Roadmap demand from the Integrations page: totals per integration, and for the selected one,
 * who asked. Reads the admin demand API, which an admin-scoped API key can call too.
 */
export const IntegrationDemandTab: React.FC = () => {
  const demand = useIntegrationDemand();
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const integrations = demand.data?.integrations ?? [];
  const selected = integrations.find(row => row.integrationId === selectedId) ?? null;

  return (
    <Stack spacing={2} data-testid="admin-integration-demand-tab">
      <Box>
        <Typography level="h4">Integration demand</Typography>
        <Typography level="body-sm" textColor="text.secondary">
          Requests filed from the roadmap cards on the Integrations page, most requested first. An integration that has
          left the roadmap keeps its history and shows its current stage. Select a row to see who asked.
        </Typography>
      </Box>

      {demand.error ? (
        <Alert color="danger" data-testid="admin-integration-demand-error">
          Couldn&apos;t load integration demand.
        </Alert>
      ) : demand.isPending ? (
        <CircularProgress size="sm" />
      ) : integrations.length === 0 ? (
        <Alert color="neutral" data-testid="admin-integration-demand-empty">
          No integration requests yet.
        </Alert>
      ) : (
        <Table size="sm" hoverRow data-testid="admin-integration-demand-table">
          <thead>
            <tr>
              <th>Integration</th>
              <th>Stage</th>
              <th>Requests</th>
              <th>Organizations</th>
              <th>First request</th>
              <th>Latest request</th>
            </tr>
          </thead>
          <tbody>
            {integrations.map(row => {
              const isSelected = row.integrationId === selectedId;
              return (
                <tr
                  key={row.integrationId}
                  tabIndex={0}
                  aria-selected={isSelected}
                  onClick={() => setSelectedId(row.integrationId)}
                  onKeyDown={event => {
                    if (event.key === 'Enter' || event.key === ' ') {
                      event.preventDefault();
                      setSelectedId(row.integrationId);
                    }
                  }}
                  style={{ cursor: 'pointer' }}
                  data-testid={`admin-integration-demand-row-${row.integrationId}`}
                >
                  <td>
                    <Typography level="body-sm" fontWeight={isSelected ? 'lg' : undefined}>
                      {row.name}
                    </Typography>
                  </td>
                  <td>
                    <StageChip stage={row.stage} />
                  </td>
                  <td>{row.total}</td>
                  <td>{row.organizations}</td>
                  <td>{formatDate(row.firstRequestedAt)}</td>
                  <td>{formatDate(row.latestRequestedAt)}</td>
                </tr>
              );
            })}
          </tbody>
        </Table>
      )}

      {selected ? <RequestersPanel key={selected.integrationId} integration={selected} /> : null}
    </Stack>
  );
};

export default IntegrationDemandTab;

import { useRef, useState } from 'react';
import { Alert, Button, Stack, Typography } from '@mui/joy';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import type { DisposableSourceStatus, SignupDomainReview } from '@bike4mind/common';
import { api } from '@client/app/contexts/ApiContext';
import { getErrorMessage } from '@client/app/utils/error';
import { DataTable } from './shared/DataTable';

const QUERY_KEY = ['signup-domain-holds'];
const ENDPOINT = '/api/admin/signup-domain-holds';

export default function SignupDomainHoldsTab() {
  const [page, setPage] = useState(1);
  const [cursors, setCursors] = useState<Record<string, string | undefined>>({});
  // isPending only flips after a re-render, so a double-click would otherwise send two decisions.
  const decisionInFlight = useRef(false);
  const queryClient = useQueryClient();
  const query = useQuery({
    queryKey: [...QUERY_KEY, page],
    queryFn: async () =>
      (
        await api.get<{
          data: SignupDomainReview[];
          total: number;
          sources: DisposableSourceStatus[];
          intelCacheSize: number;
        }>(ENDPOINT, { params: { page } })
      ).data,
  });
  const decision = useMutation({
    mutationFn: async (input: { domain: string; action: 'confirm' | 'release'; afterUserId?: string }) =>
      (
        await api.post<{
          status: 'blocked' | 'released';
          creditsReleased: number;
          remaining: number;
          nextCursor: string | null;
        }>(ENDPOINT, input)
      ).data,
    onSuccess: async (result, input) => {
      if (result.status === 'released')
        setCursors(current => ({ ...current, [input.domain]: result.nextCursor ?? undefined }));
      await queryClient.invalidateQueries({ queryKey: QUERY_KEY });
    },
    onSettled: () => {
      decisionInFlight.current = false;
    },
  });
  const decide = (input: { domain: string; action: 'confirm' | 'release'; afterUserId?: string }) => {
    if (decisionInFlight.current) return;
    decisionInFlight.current = true;
    decision.mutate(input);
  };
  return (
    <Stack spacing={2} data-testid="signup-domain-holds-tab">
      <Typography level="h3">Signup Domain Holds</Typography>
      <Typography>
        Patterned signup bursts, domains only on the aggregate disposable list, freshly registered domains and domains
        whose mail runs through a disposable provider defer pending free credits. Confirm keeps credits held. Release
        allows future grants and retries existing pending grants. Granted balances are never changed. Configure
        detection in Users settings. Released domains stay exempt from automatic holds.
      </Typography>
      {decision.error && <Alert color="danger">{getErrorMessage(decision.error)}</Alert>}
      {decision.data?.status === 'blocked' && (
        <Alert color="success">Domain confirmed; pending credits remain held.</Alert>
      )}
      {decision.data?.status === 'released' && (
        <Alert color="success">
          Released {decision.data.creditsReleased} credits. {decision.data.remaining} pending grants remain; use Retry
          pending grants to continue or retry failures.
        </Alert>
      )}
      <Stack direction="row" spacing={1}>
        <Button
          data-testid="signup-domain-holds-previous"
          disabled={page === 1 || query.isPending}
          onClick={() => setPage(current => current - 1)}
        >
          Previous
        </Button>
        <Button
          data-testid="signup-domain-holds-next"
          disabled={query.isPending || page * 25 >= (query.data?.total ?? 0)}
          onClick={() => setPage(current => current + 1)}
        >
          Next
        </Button>
      </Stack>
      <DataTable<SignupDomainReview>
        rows={query.data?.data ?? []}
        getRowId={review => review.domain}
        label="Signup domain holds"
        loading={query.isPending}
        error={query.error ? getErrorMessage(query.error) : undefined}
        onRetry={() => {
          void query.refetch();
        }}
        pagination={false}
        empty={<Typography>No signup domains are held.</Typography>}
        columns={[
          {
            id: 'domain',
            label: 'Domain / reason',
            render: review => (
              <>
                {review.domain}
                <Typography level="body-sm">{review.reason}</Typography>
              </>
            ),
          },
          {
            id: 'signups',
            label: 'Signups / samples',
            render: review => (
              <>
                {review.signupCount}
                <Typography level="body-sm">{review.sampleEmails.join(', ')}</Typography>
              </>
            ),
          },
          { id: 'status', label: 'Status', render: review => review.status },
          {
            id: 'review',
            label: 'Review',
            render: review => (
              <Stack direction="row" spacing={1}>
                <Button
                  size="sm"
                  color="danger"
                  data-testid={`signup-domain-confirm-${review.domain}`}
                  disabled={decision.isPending || review.status !== 'held_pending_review'}
                  onClick={() => decide({ domain: review.domain, action: 'confirm' })}
                >
                  Confirm
                </Button>
                <Button
                  size="sm"
                  data-testid={`signup-domain-release-${review.domain}`}
                  disabled={decision.isPending}
                  onClick={() =>
                    decide({ domain: review.domain, action: 'release', afterUserId: cursors[review.domain] })
                  }
                >
                  {review.status === 'released' ? 'Retry pending grants' : 'Release'}
                </Button>
              </Stack>
            ),
          },
        ]}
      />
      <Typography level="title-md">Disposable list sources</Typography>
      <DataTable<DisposableSourceStatus>
        rows={query.data?.sources ?? []}
        getRowId={source => source.source}
        label="Disposable list sources"
        testId="signup-domain-holds-sources"
        loading={query.isPending}
        onRetry={() => {
          void query.refetch();
        }}
        pagination={false}
        empty={<Typography>The disposable list refresh has not run yet.</Typography>}
        columns={[
          { id: 'source', label: 'Source', render: source => source.source },
          { id: 'count', label: 'Domains', numeric: true, render: source => source.count },
          {
            id: 'lastSuccess',
            label: 'Last success',
            render: source => (source.lastSuccessAt ? new Date(source.lastSuccessAt).toLocaleString() : 'never'),
          },
          {
            id: 'lastError',
            label: 'Last error',
            render: source =>
              source.lastError
                ? `${source.lastError}${source.lastErrorAt ? ` (${new Date(source.lastErrorAt).toLocaleString()})` : ''}`
                : '-',
          },
        ]}
      />
      {query.data && <Typography level="body-sm">Cached domain lookups: {query.data.intelCacheSize}</Typography>}
    </Stack>
  );
}

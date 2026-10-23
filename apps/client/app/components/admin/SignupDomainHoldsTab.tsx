import { useState } from 'react';
import { Alert, Button, Stack, Table, Typography } from '@mui/joy';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import type { SignupDomainReview } from '@bike4mind/common';
import { api } from '@client/app/contexts/ApiContext';
import { getErrorMessage } from '@client/app/utils/error';

const QUERY_KEY = ['signup-domain-holds'];
const ENDPOINT = '/api/admin/signup-domain-holds';

export default function SignupDomainHoldsTab() {
  const [page, setPage] = useState(1);
  const [cursors, setCursors] = useState<Record<string, string | undefined>>({});
  const queryClient = useQueryClient();
  const query = useQuery({
    queryKey: [...QUERY_KEY, page],
    queryFn: async () =>
      (await api.get<{ data: SignupDomainReview[]; total: number }>(ENDPOINT, { params: { page } })).data,
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
  });
  return (
    <Stack spacing={2} data-testid="signup-domain-holds-tab">
      <Typography level="h3">Signup Domain Holds</Typography>
      <Typography>
        Patterned signup bursts defer pending free credits. Confirm keeps credits held. Release allows future grants and
        retries existing pending grants. Granted balances are never changed. Enable detection in Users settings.
        Released domains stay exempt from automatic holds.
      </Typography>
      {query.isPending && <Typography>Loading holds...</Typography>}
      {query.error && <Alert color="danger">{getErrorMessage(query.error)}</Alert>}
      {decision.error && <Alert color="danger">{getErrorMessage(decision.error)}</Alert>}
      {decision.data?.status === 'blocked' && (
        <Alert color="success">Domain confirmed; pending credits remain held.</Alert>
      )}
      {decision.data?.status === 'released' && (
        <Alert color="success">
          Released {decision.data.creditsReleased} credits.
          {decision.data.remaining} pending grants remain; use Retry pending grants to continue or retry failures.
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
      <Table aria-label="Signup domain holds">
        <thead>
          <tr>
            <th>Domain / reason</th>
            <th>Signups / samples</th>
            <th>Status</th>
            <th>Review</th>
          </tr>
        </thead>
        <tbody>
          {query.data?.data.map(review => (
            <tr key={review.domain}>
              <td>
                {review.domain}
                <Typography level="body-sm">{review.reason}</Typography>
              </td>
              <td>
                {review.signupCount}
                <Typography level="body-sm">{review.sampleEmails.join(', ')}</Typography>
              </td>
              <td>{review.status}</td>
              <td>
                <Stack direction="row" spacing={1}>
                  <Button
                    size="sm"
                    color="danger"
                    data-testid={`signup-domain-confirm-${review.domain}`}
                    disabled={decision.isPending || review.status !== 'held_pending_review'}
                    onClick={() => decision.mutate({ domain: review.domain, action: 'confirm' })}
                  >
                    Confirm
                  </Button>
                  <Button
                    size="sm"
                    data-testid={`signup-domain-release-${review.domain}`}
                    disabled={decision.isPending}
                    onClick={() =>
                      decision.mutate({ domain: review.domain, action: 'release', afterUserId: cursors[review.domain] })
                    }
                  >
                    {review.status === 'released' ? 'Retry pending grants' : 'Release'}
                  </Button>
                </Stack>
              </td>
            </tr>
          ))}
        </tbody>
      </Table>
      {query.data?.data.length === 0 && <Typography>No signup domains are held.</Typography>}
    </Stack>
  );
}

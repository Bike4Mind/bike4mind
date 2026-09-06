import { Alert, Box, Button, Chip, CircularProgress, Stack, Typography } from '@mui/joy';
import SpeedIcon from '@mui/icons-material/Speed';
import { useQuery } from '@tanstack/react-query';
import { api } from '@client/app/contexts/ApiContext';
import { useGetSettingsValue } from '@client/app/hooks/data/settings';
import { EMBEDDING_THROUGHPUT_SUGGESTED_SHARE } from '@bike4mind/common';

interface RateLimitSnapshot {
  limitTokens: number | null;
  limitRequests: number | null;
  remainingTokens: number | null;
  remainingRequests: number | null;
}

type LimitsResponse =
  | { supported: true; provider: string; model: string; limits: RateLimitSnapshot; measuredAt: string }
  | { supported: false; provider: string; model: string; reason: string };

const formatNumber = (value: number) => value.toLocaleString('en-US');

/** Configured value as a share of measured, for the "your lever is 6% of capacity" case. */
const sharePercent = (configured: number, measured: number) => Math.round((configured / measured) * 100);

/**
 * Shows what the configured embedding provider says its live rate limits are, beside the levers
 * meant to be set from them.
 *
 * The gap this closes is not "the number is hard to find", it is "nothing tells you the number is
 * wrong". A deployment can run indefinitely with a lever at a small fraction of its real ceiling,
 * throttling its own backfills, and no screen in the product would say so.
 *
 * Fires only when asked. Reading the ceiling costs a real (if tiny) provider call, and a settings
 * page that silently spent quota on every open would be a bad trade for a number that changes
 * about as often as a billing tier does.
 */
export function EmbeddingProviderLimits() {
  const configuredTokens = Number(useGetSettingsValue('dataLakeEmbeddingMaxTokensPerMinute'));
  const configuredCalls = Number(useGetSettingsValue('dataLakeEmbeddingMaxCallsPerMinute'));

  const {
    data,
    isFetching,
    error,
    refetch: check,
  } = useQuery<LimitsResponse>({
    queryKey: ['admin', 'embedding-limits'],
    queryFn: async () => (await api.get('/api/admin/embedding-limits')).data,
    enabled: false,
    // A reading is a measurement at a moment, not cacheable state - never serve a stale one to
    // someone about to set a lever from it.
    gcTime: 0,
    staleTime: 0,
    retry: false,
  });

  const measuredTokens = data?.supported ? data.limits.limitTokens : null;
  // A ceiling of 0 is a real provider answer - the snapshot contract reserves null for "did not
  // say" - but every readout below either divides by it or formats a value derived from it, so 0 is
  // excluded once here rather than at each use. The truthiness check this replaces left
  // suggestedTokens null while the `!== null` render gate still opened, and formatNumber(null)
  // throws on the way to the panel.
  const tokenCeiling = measuredTokens !== null && measuredTokens > 0 ? measuredTokens : null;
  const suggestedTokens =
    tokenCeiling !== null ? Math.floor(tokenCeiling * EMBEDDING_THROUGHPUT_SUGGESTED_SHARE) : null;

  return (
    <Box sx={{ p: 2 }} data-testid="embedding-provider-limits">
      <Stack direction="row" alignItems="center" spacing={1} sx={{ mb: 1 }}>
        <SpeedIcon fontSize="small" />
        <Typography level="title-sm">Provider limits</Typography>
      </Stack>

      <Typography level="body-sm" textColor="inherit" sx={{ mb: 1.5 }}>
        Ask the configured embedding provider what it currently allows, and compare it to the levers above. Costs one
        small embedding call.
      </Typography>

      <Button
        size="sm"
        variant="outlined"
        onClick={() => check()}
        loading={isFetching}
        data-testid="embedding-limits-check-btn"
      >
        Check provider limits
      </Button>

      {isFetching && (
        <Stack direction="row" spacing={1} alignItems="center" sx={{ mt: 1.5 }}>
          <CircularProgress size="sm" />
          <Typography level="body-sm" textColor="inherit">
            Asking the provider...
          </Typography>
        </Stack>
      )}

      {/* A failed request is distinct from a provider that cannot report limits: this one means we
          do not know, and must not be read as "no ceiling". */}
      {!isFetching && error && (
        <Alert color="danger" variant="soft" size="sm" sx={{ mt: 1.5 }} data-testid="embedding-limits-error">
          <Typography level="body-sm">
            Could not read the provider limits. This is unknown, not unlimited - leave the levers as they are and retry.
          </Typography>
        </Alert>
      )}

      {!isFetching && !error && data && !data.supported && (
        <Alert color="neutral" variant="soft" size="sm" sx={{ mt: 1.5 }} data-testid="embedding-limits-unavailable">
          <Typography level="body-sm">
            Not available for {data.provider} ({data.model}): {data.reason}
          </Typography>
        </Alert>
      )}

      {!isFetching && !error && data?.supported && (
        <Stack spacing={1} sx={{ mt: 1.5 }} data-testid="embedding-limits-result">
          <Stack direction="row" spacing={1} flexWrap="wrap" useFlexGap>
            <Chip size="sm" variant="soft" data-testid="embedding-limits-tokens">
              {data.limits.limitTokens !== null
                ? `${formatNumber(data.limits.limitTokens)} tokens/min`
                : 'tokens/min not reported'}
            </Chip>
            <Chip size="sm" variant="soft" data-testid="embedding-limits-requests">
              {data.limits.limitRequests !== null
                ? `${formatNumber(data.limits.limitRequests)} requests/min`
                : 'requests/min not reported'}
            </Chip>
            <Chip size="sm" variant="outlined">
              {data.provider} / {data.model}
            </Chip>
          </Stack>

          {tokenCeiling !== null && suggestedTokens !== null && Number.isFinite(configuredTokens) && (
            <Typography level="body-sm" textColor="inherit" data-testid="embedding-limits-comparison">
              Embedding Max Tokens Per Minute is set to {formatNumber(configuredTokens)} -{' '}
              {sharePercent(configuredTokens, tokenCeiling)}% of measured capacity. Suggested:{' '}
              <strong>{formatNumber(suggestedTokens)}</strong>, leaving the rest for query-side embedding, which shares
              this pool.
            </Typography>
          )}

          {data.limits.limitRequests !== null && data.limits.limitRequests > 0 && Number.isFinite(configuredCalls) && (
            <Typography level="body-sm" textColor="inherit" data-testid="embedding-limits-calls-comparison">
              Embedding Max Calls Per Minute is set to {formatNumber(configuredCalls)} -{' '}
              {sharePercent(configuredCalls, data.limits.limitRequests)}% of measured capacity.
            </Typography>
          )}

          <Typography level="body-xs" textColor="inherit">
            Measured {new Date(data.measuredAt).toLocaleTimeString()}. Limits belong to the provider organization behind
            the configured key, so they can differ per environment.
          </Typography>
        </Stack>
      )}
    </Box>
  );
}

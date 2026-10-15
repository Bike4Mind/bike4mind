import { StorageBreakdownBucket, isLakeIngestSource } from '@bike4mind/common';
import { useGetStorageBreakdown } from '@client/app/hooks/data/storageBreakdown';
import { useDataLakeWizardStore } from '@client/app/stores/useDataLakeWizardStore';
import { Box, Button, CircularProgress, LinearProgress, Link, Stack, Typography } from '@mui/joy';
import prettyBytes from 'pretty-bytes';
import { FC, useState } from 'react';
import { useTranslation } from 'react-i18next';

type Translate = ReturnType<typeof useTranslation>['t'];

export const storageBucketLabel = (bucket: StorageBreakdownBucket, t: Translate): string => {
  if (bucket.mediaKind) return t(`profile.storage_breakdown.media.${bucket.mediaKind}`);
  const source = t(`profile.storage_breakdown.source.${bucket.sourceType}`);
  if (!isLakeIngestSource(bucket.sourceType)) return source;
  if (!bucket.lakeId) return t('profile.storage_breakdown.no_lake', { source });
  if (!bucket.lakeName) return t('profile.storage_breakdown.unavailable_lake', { source });
  return `${source}: ${bucket.lakeName}`;
};

const ShareBar: FC<{ bytes: number; totalBytes: number }> = ({ bytes, totalBytes }) => (
  <LinearProgress
    determinate
    size="sm"
    value={totalBytes > 0 ? Math.min(100, (Math.max(bytes, 0) / totalBytes) * 100) : 0}
    sx={{ mt: 0.5 }}
  />
);

/**
 * Collapsible "what is using my storage" list under a usage figure. Fetches only once opened, so
 * the aggregate never runs for a user who does not ask. `overlay` floats the list over what follows
 * instead of pushing it down - for headers inside a fixed-height dialog.
 */
const StorageBreakdown: FC<{ overlay?: boolean }> = ({ overlay = false }) => {
  const { t } = useTranslation();
  const [open, setOpen] = useState(false);
  const { data, isLoading, isError, refetch } = useGetStorageBreakdown({ enabled: open });
  const openManager = useDataLakeWizardStore(s => s.openManager);

  const denominator = data ? Math.max(data.totalBytes, data.accountedBytes) : 0;

  return (
    <Box data-testid="storage-breakdown" sx={{ position: 'relative' }}>
      <Link
        component="button"
        level="body-sm"
        data-testid="storage-breakdown-toggle-btn"
        aria-expanded={open}
        onClick={() => setOpen(value => !value)}
      >
        {open ? t('profile.storage_breakdown.hide') : t('profile.storage_breakdown.show')}
      </Link>

      {open && (
        <Box
          data-testid="storage-breakdown-panel"
          sx={{
            mt: 1,
            maxHeight: 280,
            overflowY: 'auto',
            pr: 0.5,
            ...(overlay && {
              position: 'absolute',
              top: '100%',
              left: 0,
              right: 0,
              zIndex: 'var(--joy-zIndex-popup)',
              p: 1.5,
              bgcolor: 'background.surface',
              border: '1px solid',
              borderColor: 'divider',
              borderRadius: 'sm',
              boxShadow: 'md',
            }),
          }}
        >
          {isLoading && (
            <Stack direction="row" gap={1} alignItems="center" data-testid="storage-breakdown-loading">
              <CircularProgress size="sm" />
              <Typography level="body-sm">{t('profile.storage_breakdown.loading')}</Typography>
            </Stack>
          )}

          {isError && (
            <Stack direction="row" gap={1} alignItems="center" data-testid="storage-breakdown-error">
              <Typography level="body-sm" color="danger">
                {t('profile.storage_breakdown.error')}
              </Typography>
              <Button size="sm" variant="plain" data-testid="storage-breakdown-retry-btn" onClick={() => refetch()}>
                {t('profile.storage_breakdown.retry')}
              </Button>
            </Stack>
          )}

          {data && data.buckets.length === 0 && data.unaccountedBytes === 0 && (
            <Typography level="body-sm" data-testid="storage-breakdown-empty">
              {t('profile.storage_breakdown.empty')}
            </Typography>
          )}

          {data && (
            <Stack component="ul" gap={1} sx={{ listStyle: 'none', m: 0, p: 0 }}>
              {data.buckets.map(bucket => (
                <Box component="li" key={bucket.key} data-testid={`storage-breakdown-row-${bucket.key}`}>
                  <Stack direction="row" justifyContent="space-between" gap={1}>
                    <Typography level="body-sm" sx={{ minWidth: 0, overflowWrap: 'anywhere' }}>
                      {storageBucketLabel(bucket, t)}
                    </Typography>
                    <Typography level="body-sm" sx={{ fontWeight: 500, flexShrink: 0 }}>
                      {prettyBytes(bucket.bytes)}
                    </Typography>
                  </Stack>
                  <Stack direction="row" gap={1} alignItems="center" flexWrap="wrap">
                    <Typography level="body-xs">
                      {t('profile.storage_breakdown.files', { count: bucket.fileCount })}
                    </Typography>
                    {bucket.archivedBytes > 0 && (
                      <Typography level="body-xs" data-testid={`storage-breakdown-archived-${bucket.key}`}>
                        {t('profile.storage_breakdown.archived', { size: prettyBytes(bucket.archivedBytes) })}
                      </Typography>
                    )}
                    {bucket.lakeId && bucket.lakeName && (
                      <Link
                        component="button"
                        level="body-xs"
                        data-testid={`storage-breakdown-open-lake-${bucket.lakeId}`}
                        onClick={() => openManager('mine', bucket.lakeId)}
                      >
                        {t('profile.storage_breakdown.open_lake')}
                      </Link>
                    )}
                  </Stack>
                  <ShareBar bytes={bucket.bytes} totalBytes={denominator} />
                </Box>
              ))}

              {data.unaccountedBytes !== 0 && (
                <Box component="li" data-testid="storage-breakdown-row-unaccounted">
                  <Stack direction="row" justifyContent="space-between" gap={1}>
                    <Typography level="body-sm">{t('profile.storage_breakdown.unaccounted')}</Typography>
                    <Typography level="body-sm" sx={{ fontWeight: 500, flexShrink: 0 }}>
                      {prettyBytes(data.unaccountedBytes)}
                    </Typography>
                  </Stack>
                  <Typography level="body-xs">{t('profile.storage_breakdown.unaccounted_hint')}</Typography>
                </Box>
              )}
            </Stack>
          )}
        </Box>
      )}
    </Box>
  );
};

export default StorageBreakdown;

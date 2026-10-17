import { FC } from 'react';
import { Box, Button, CircularProgress, LinearProgress, Stack, Typography } from '@mui/joy';
import prettyBytes from 'pretty-bytes';
import { useOrgStorageUsage } from '@client/app/hooks/data/useOrgStorageUsage';

const percentOf = (bytes: number, totalBytes: number) =>
  totalBytes > 0 ? Math.min(100, (Math.max(bytes, 0) / totalBytes) * 100) : 0;

/** The org's shared storage pool against its limit, and which members' uploads fill it. */
const OrganizationStorageUsage: FC<{ organizationId: string }> = ({ organizationId }) => {
  const { data, isLoading, isError, refetch } = useOrgStorageUsage(organizationId);

  if (isLoading) return <CircularProgress size="sm" data-testid="org-storage-usage-loading" />;
  if (isError || !data) {
    return (
      <Stack direction="row" spacing={1} alignItems="center" data-testid="org-storage-usage-error">
        <Typography level="body-sm">Could not load storage usage.</Typography>
        <Button size="sm" variant="plain" onClick={() => void refetch()} data-testid="org-storage-usage-retry-btn">
          Retry
        </Button>
      </Stack>
    );
  }

  const uploadedBytes = data.uploaders.reduce((sum, uploader) => sum + uploader.bytes, 0);

  return (
    <Stack spacing={3} data-testid="org-storage-usage">
      <Box>
        <Typography level="title-md">Storage</Typography>
        <Typography level="body-sm" data-testid="org-storage-usage-total">
          {prettyBytes(data.usedBytes)} of {prettyBytes(data.limitBytes)} used
        </Typography>
        <LinearProgress determinate value={percentOf(data.usedBytes, data.limitBytes)} sx={{ mt: 1 }} />
      </Box>

      <Box>
        <Typography level="title-sm" sx={{ mb: 1 }}>
          By uploader
        </Typography>
        {data.uploaders.length === 0 ? (
          <Typography level="body-sm">No files are stored in this organization yet.</Typography>
        ) : (
          <Stack spacing={1.5}>
            {data.uploaders.map(uploader => (
              <Box key={uploader.userId} data-testid="org-storage-usage-uploader">
                <Stack direction="row" justifyContent="space-between" spacing={2}>
                  <Typography level="body-sm" noWrap>
                    {uploader.name ?? uploader.email ?? 'Deleted user'}
                  </Typography>
                  <Typography level="body-sm" sx={{ flexShrink: 0 }}>
                    {prettyBytes(uploader.bytes)} ({uploader.fileCount} {uploader.fileCount === 1 ? 'file' : 'files'})
                  </Typography>
                </Stack>
                <LinearProgress
                  determinate
                  size="sm"
                  value={percentOf(uploader.bytes, Math.max(data.usedBytes, uploadedBytes))}
                  sx={{ mt: 0.5 }}
                />
              </Box>
            ))}
            {data.uploadersTruncated && (
              <Typography level="body-xs">Showing the {data.uploaders.length} largest uploaders.</Typography>
            )}
          </Stack>
        )}
      </Box>
    </Stack>
  );
};

export default OrganizationStorageUsage;

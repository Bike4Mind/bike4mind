import { useEffect, useRef } from 'react';
import { isAxiosError } from 'axios';
import { useNavigate, useParams } from '@tanstack/react-router';
import { Box, Button, CircularProgress, Container, Link, Sheet, Stack, Typography } from '@mui/joy';
import { useAccountDataExportDownload } from '@client/app/hooks/data/user';
import { getErrorMessage } from '@client/app/utils/error';

function failureMessage(error: unknown): string {
  const status = isAxiosError(error) ? error.response?.status : undefined;
  if (status === 404)
    return "We couldn't find this export. It may still be building, or it belongs to another account.";
  if (status === 410) return 'This download link has expired. Request a new export from your account settings.';
  return getErrorMessage(error);
}

/** Target of the "your data export is ready" email: trades the job id for a short-lived link and starts the download. */
const AccountDataExportPage = () => {
  const navigate = useNavigate();
  const { jobId = '' } = useParams({ strict: false });
  const download = useAccountDataExportDownload(jobId);
  const started = useRef(false);

  useEffect(() => {
    if (download.data && !started.current) {
      started.current = true;
      window.location.assign(download.data.url);
    }
  }, [download.data]);

  return (
    <Box
      sx={theme => ({
        backgroundColor: theme.palette.background.surface,
        minHeight: '100vh',
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        p: 2,
      })}
    >
      <Container maxWidth="sm">
        <Sheet
          variant="outlined"
          sx={{ p: 4, borderRadius: 'lg', boxShadow: 'lg' }}
          data-testid="account-data-export-page"
        >
          <Stack spacing={3}>
            <Typography level="h3" sx={{ textAlign: 'center' }}>
              Your data export
            </Typography>
            {download.isPending && (
              <Stack direction="row" spacing={1.5} alignItems="center" data-testid="account-data-export-loading">
                <CircularProgress size="sm" />
                <Typography level="body-md">Preparing your download...</Typography>
              </Stack>
            )}
            {download.data && (
              <Typography level="body-md" data-testid="account-data-export-ready">
                Your download should start shortly. If it does not,{' '}
                <Link href={download.data.url} data-testid="account-data-export-download-link">
                  download {download.data.filename}
                </Link>
                . This export is available until{' '}
                {new Date(download.data.expiresAt).toLocaleString(undefined, { dateStyle: 'long', timeStyle: 'short' })}
                .
              </Typography>
            )}
            {download.isError && (
              <Typography level="body-md" color="danger" data-testid="account-data-export-error">
                {failureMessage(download.error)}
              </Typography>
            )}
            <Stack direction="row" justifyContent="flex-end">
              <Button
                variant="plain"
                color="neutral"
                onClick={() => void navigate({ to: '/' })}
                data-testid="account-data-export-home-btn"
              >
                Back to the app
              </Button>
            </Stack>
          </Stack>
        </Sheet>
      </Container>
    </Box>
  );
};

export default AccountDataExportPage;

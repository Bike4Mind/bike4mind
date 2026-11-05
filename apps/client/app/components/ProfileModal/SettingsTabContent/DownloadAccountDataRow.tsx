import { isAxiosError } from 'axios';
import { toast } from 'sonner';
import { Box, Button, Typography } from '@mui/joy';
import { cardSurfaceSx } from '@client/app/components/ProfileModal/settingsStyles';
import { useRequestAccountDataExport } from '@client/app/hooks/data/user';
import { getErrorMessage } from '@client/app/utils/error';
import { isStepUpCancelled } from '@client/app/utils/stepUpInterceptor';

/** Settings "Danger zone": request a zip of the account's data, emailed as a 24-hour download link. */
export default function DownloadAccountDataRow() {
  const requestExport = useRequestAccountDataExport();

  const handleRequest = () =>
    requestExport.mutate(undefined, {
      onSuccess: () => toast.success("We're preparing your data. We'll email you a download link when it's ready."),
      onError: error => {
        if (isStepUpCancelled(error)) return;
        if (isAxiosError(error) && error.response?.status === 429) {
          toast.error('You can request one data export per hour. Please try again later.');
          return;
        }
        toast.error(getErrorMessage(error));
      },
    });

  return (
    <Box
      data-testid="settings-data-export-section"
      sx={theme => ({
        ...cardSurfaceSx(theme),
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'space-between',
        flexWrap: 'wrap',
        gap: '12px',
        mb: 2,
      })}
    >
      <Box sx={{ flex: 1, minWidth: 0 }}>
        <Typography level="title-md" sx={{ fontSize: '16px', fontWeight: 500 }}>
          Download your data
        </Typography>
        <Typography level="body-sm" sx={{ mt: 0.5 }}>
          Get a copy of your profile, notebooks, files, memories, artifacts, agents and projects as a zip file. We email
          you a download link that works for 24 hours.
        </Typography>
      </Box>
      <Button
        variant="outlined"
        color="neutral"
        loading={requestExport.isPending}
        onClick={handleRequest}
        data-testid="settings-data-export-btn"
      >
        Request export
      </Button>
    </Box>
  );
}

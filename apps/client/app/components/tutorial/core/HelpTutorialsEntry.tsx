import { Button, Stack, Typography } from '@mui/joy';
import SchoolOutlinedIcon from '@mui/icons-material/SchoolOutlined';
import { useTutorialsEnabled } from '@client/app/hooks/data/tutorials';
import { closeHelpPanel } from '@client/app/hooks/useHelpPanel';
import { useTutorialPicker } from './tutorialPickerStore';

/** The Help Center's way into the tutorials picker, to take a tour again or pick up one left part way. */
export function HelpTutorialsEntry() {
  const enabled = useTutorialsEnabled();
  const openPicker = useTutorialPicker(s => s.setOpen);
  // Help also opens on admin pages, where no host runs the picker.
  const hostMounted = useTutorialPicker(s => s.hostMounted);
  if (!enabled || !hostMounted) return null;
  return (
    <Stack direction="row" alignItems="center" gap={1.5} sx={{ mb: 3 }}>
      <Typography level="body-sm" sx={{ flex: 1 }}>
        Prefer to be shown around? Take a short guided tutorial.
      </Typography>
      <Button
        size="sm"
        variant="soft"
        startDecorator={<SchoolOutlinedIcon fontSize="small" />}
        onClick={() => {
          // The Help panel sits above every modal, so it makes way for the picker.
          closeHelpPanel();
          openPicker(true);
        }}
        data-testid="help-open-tutorials"
      >
        Tutorials
      </Button>
    </Stack>
  );
}

import {
  Box,
  Button,
  Chip,
  DialogContent,
  DialogTitle,
  Modal,
  ModalClose,
  ModalDialog,
  Stack,
  Typography,
} from '@mui/joy';
import type { TutorialProgressEntry, TutorialRunModule } from '@bike4mind/common';
import { ABOVE_COACH_CARD } from '../CoachMark';
import { groupByTrack, statusOf, type PickerStatus } from './pickerModel';

const STATUS_CHIP: Record<PickerStatus, { label: string; color: 'neutral' | 'primary' | 'success' }> = {
  not_started: { label: 'Not started', color: 'neutral' },
  in_progress: { label: 'In progress', color: 'primary' },
  finished: { label: 'Finished', color: 'success' },
};

export interface TutorialPickerProps {
  open: boolean;
  onClose: () => void;
  modules: readonly TutorialRunModule[];
  progress: Readonly<Record<string, TutorialProgressEntry>> | undefined;
  /** The tutorial whose walk runs now, which always reads as in progress. */
  liveModuleId?: string | null;
  loading?: boolean;
  onStart: (moduleId: string) => void;
  onResume: (moduleId: string) => void;
}

/** Every tutorial the user may run, grouped by track, each with where the user stands and what they can do next. */
export function TutorialPicker({
  open,
  onClose,
  modules,
  progress,
  liveModuleId,
  loading,
  onStart,
  onResume,
}: TutorialPickerProps) {
  const groups = groupByTrack(modules);
  return (
    // Above the coach card, since the card's Steps button opens the picker mid-walk.
    <Modal open={open} onClose={onClose} sx={{ zIndex: ABOVE_COACH_CARD }}>
      <ModalDialog
        data-testid="tutorial-picker"
        aria-labelledby="tutorial-picker-title"
        sx={{ width: 'min(520px, calc(100vw - 32px))', maxHeight: 'calc(100dvh - 32px)' }}
      >
        <ModalClose data-testid="tutorial-picker-close" />
        <DialogTitle id="tutorial-picker-title">Tutorials</DialogTitle>
        <DialogContent sx={{ gap: 2, overflowY: 'auto' }}>
          <Typography level="body-sm">
            Short guided tours. Each step can be skipped, and you can leave and pick up where you stopped.
          </Typography>
          {loading && groups.length === 0 && (
            <Typography level="body-sm" data-testid="tutorial-picker-loading">
              Loading tutorials...
            </Typography>
          )}
          {!loading && groups.length === 0 && (
            <Typography level="body-sm" data-testid="tutorial-picker-empty">
              No tutorials are available right now.
            </Typography>
          )}
          {groups.map(group => (
            <Box key={group.key} component="section" data-testid={`tutorial-picker-group-${group.key}`}>
              <Typography level="title-md">{group.title}</Typography>
              <Typography level="body-xs" sx={{ color: 'text.secondary', mb: 1 }}>
                {group.blurb}
              </Typography>
              <Stack gap={0.75}>
                {group.modules.map(tutorial => {
                  const status = statusOf(tutorial, progress?.[tutorial.id], liveModuleId);
                  const chip = STATUS_CHIP[status];
                  return (
                    <Stack
                      key={tutorial.id}
                      data-testid={`tutorial-picker-row-${tutorial.id}`}
                      direction={{ xs: 'column', sm: 'row' }}
                      alignItems={{ xs: 'stretch', sm: 'center' }}
                      gap={1}
                      sx={{
                        px: 1.25,
                        py: 1,
                        borderRadius: 'sm',
                        border: '1px solid',
                        borderColor: 'neutral.outlinedBorder',
                      }}
                    >
                      <Box sx={{ flex: 1, minWidth: 0 }}>
                        <Stack direction="row" alignItems="center" gap={1} flexWrap="wrap">
                          <Typography level="title-sm">{tutorial.title}</Typography>
                          <Chip
                            size="sm"
                            variant="soft"
                            color={chip.color}
                            data-testid={`tutorial-picker-status-${tutorial.id}`}
                            data-status={status}
                          >
                            {chip.label}
                          </Chip>
                        </Stack>
                        {tutorial.pitch && (
                          <Typography
                            level="body-xs"
                            noWrap
                            title={tutorial.pitch}
                            sx={{ color: 'text.secondary', mt: 0.25 }}
                          >
                            {tutorial.pitch}
                          </Typography>
                        )}
                      </Box>
                      <Stack direction="row" gap={1} justifyContent="flex-end">
                        {status === 'in_progress' && (
                          <>
                            <Button
                              size="sm"
                              variant="plain"
                              color="neutral"
                              onClick={() => onStart(tutorial.id)}
                              data-testid={`tutorial-picker-restart-${tutorial.id}`}
                            >
                              Start over
                            </Button>
                            <Button
                              size="sm"
                              onClick={() => onResume(tutorial.id)}
                              data-testid={`tutorial-picker-resume-${tutorial.id}`}
                            >
                              Resume
                            </Button>
                          </>
                        )}
                        {status !== 'in_progress' && (
                          <Button
                            size="sm"
                            variant={status === 'finished' ? 'soft' : 'solid'}
                            onClick={() => onStart(tutorial.id)}
                            data-testid={`tutorial-picker-start-${tutorial.id}`}
                          >
                            {status === 'finished' ? 'Replay' : 'Start'}
                          </Button>
                        )}
                      </Stack>
                    </Stack>
                  );
                })}
              </Stack>
            </Box>
          ))}
        </DialogContent>
      </ModalDialog>
    </Modal>
  );
}

import { useEffect, useState } from 'react';
import {
  Box,
  Button,
  Chip,
  DialogTitle,
  Drawer,
  List,
  ListItem,
  ListItemButton,
  ModalClose,
  Stack,
  Typography,
} from '@mui/joy';
import KeyboardArrowDownIcon from '@mui/icons-material/KeyboardArrowDown';
import type { TutorialStep } from '@bike4mind/common';
import { ABOVE_COACH_CARD } from './CoachMark';

export interface JourneyModule {
  id: string;
  title: string;
  steps: readonly TutorialStep[];
  /** The step the module is on, or last stood on. Absent when it was never started. */
  currentStepId?: string;
  finished?: boolean;
  /** The module running now, which the panel opens on. */
  active?: boolean;
  /** Can be picked up where it stands: saved part way, left part way, or running on a session the user is not on. */
  resumable?: boolean;
  /** Left part way through, so no step is marked as where the user is. */
  stopped?: boolean;
}

type StepStatus = 'done' | 'current' | 'ahead';

const STATUS_LABEL: Record<StepStatus, string> = { done: 'Done', current: 'You are here', ahead: '' };

function statuses(module: JourneyModule): StepStatus[] {
  const current = module.currentStepId ? module.steps.findIndex(s => s.id === module.currentStepId) : -1;
  return module.steps.map((_, i) => {
    if (module.finished) return 'done';
    if (current < 0) return 'ahead';
    if (i === current && module.stopped) return 'ahead';
    return i < current ? 'done' : i === current ? 'current' : 'ahead';
  });
}

/** The module whose steps show when the panel opens: the running one, else one in progress, else the first not finished. */
const openOnArrival = (modules: readonly JourneyModule[]) =>
  (
    modules.find(m => m.active) ??
    modules.find(m => m.currentStepId && !m.finished) ??
    modules.find(m => !m.finished) ??
    modules[0]
  )?.id;

function summary(module: JourneyModule, steps: readonly TutorialStep[]): string | null {
  if (module.finished) return 'Finished';
  const current = module.currentStepId ? steps.findIndex(s => s.id === module.currentStepId) : -1;
  if (current < 0) return null;
  return `${module.stopped ? 'Stopped at step' : 'Step'} ${current + 1} of ${steps.length}`;
}

/** Every module, each opening onto its steps with where the user stands. Any step can be picked, back or ahead. */
export function JourneyPanel({
  open,
  onClose,
  modules,
  onJump,
  onRestart,
  onResume,
}: {
  open: boolean;
  onClose: () => void;
  modules: readonly JourneyModule[];
  onJump: (moduleId: string, stepId: string) => void;
  /** Starts the module from its first step: Start on a module never begun, Start over on one begun. */
  onRestart?: (moduleId: string) => void;
  /** Picks a module up where it stopped. Offered on every resumable module. */
  onResume?: (moduleId: string) => void;
}) {
  const [expanded, setExpanded] = useState<ReadonlySet<string>>(() => new Set([openOnArrival(modules) ?? '']));
  useEffect(() => {
    if (open) setExpanded(new Set([openOnArrival(modules) ?? '']));
    // Only on opening: a jump made from the open panel keeps the user's own choice of what is shown.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);
  const toggle = (id: string) =>
    setExpanded(prev => {
      const next = new Set(prev);
      if (!next.delete(id)) next.add(id);
      return next;
    });

  return (
    <Drawer open={open} onClose={onClose} size="sm" slotProps={{ root: { sx: { zIndex: ABOVE_COACH_CARD } } }}>
      <Box data-testid="tutorial-journey-panel" sx={{ display: 'flex', flexDirection: 'column', minHeight: 0 }}>
        <ModalClose data-testid="tutorial-journey-close" sx={{ top: 14, right: 12 }} />
        <DialogTitle sx={{ px: 2, pt: 2, pb: 1 }}>Tutorials</DialogTitle>
        <Box sx={{ overflowY: 'auto', px: 2, pb: 2 }}>
          {modules.map(module => {
            const status = statuses(module).filter((_, i) => module.steps[i].type !== 'bridge');
            const steps = module.steps.filter(step => step.type !== 'bridge');
            const isOpen = expanded.has(module.id);
            const note = summary(module, steps);
            const begun = Boolean(module.currentStepId || module.finished || module.resumable);
            return (
              <Box key={module.id} sx={{ mt: 1.5 }}>
                <Stack direction="row" alignItems="center" justifyContent="space-between" gap={1}>
                  <Button
                    size="sm"
                    variant="plain"
                    color="neutral"
                    onClick={() => toggle(module.id)}
                    data-testid={`journey-module-${module.id}`}
                    startDecorator={
                      <KeyboardArrowDownIcon
                        fontSize="small"
                        sx={{ transition: 'transform 0.15s', transform: isOpen ? 'none' : 'rotate(-90deg)' }}
                      />
                    }
                    sx={{ flex: 1, minWidth: 0, justifyContent: 'flex-start', textAlign: 'left', px: 0.5 }}
                  >
                    <Stack sx={{ minWidth: 0 }}>
                      <Typography level="title-sm">{module.title}</Typography>
                      {note && (
                        <Typography level="body-xs" color={module.finished ? 'success' : 'neutral'}>
                          {note}
                        </Typography>
                      )}
                    </Stack>
                  </Button>
                  {onResume && module.resumable && (
                    <Button
                      size="sm"
                      variant="soft"
                      onClick={() => onResume(module.id)}
                      data-testid={`journey-resume-${module.id}`}
                    >
                      Resume
                    </Button>
                  )}
                  {onRestart && (
                    <Button
                      size="sm"
                      variant={begun ? 'plain' : 'soft'}
                      color={begun ? 'neutral' : 'primary'}
                      onClick={() => onRestart(module.id)}
                      data-testid={begun ? `journey-restart-${module.id}` : `journey-start-${module.id}`}
                    >
                      {begun ? 'Start over' : 'Start'}
                    </Button>
                  )}
                </Stack>
                {isOpen && (
                  <List size="sm" sx={{ pl: 2 }}>
                    {steps.map((step, i) => (
                      <ListItem key={step.id}>
                        <ListItemButton
                          selected={status[i] === 'current'}
                          onClick={() => onJump(module.id, step.id)}
                          data-testid={`journey-step-${module.id}-${step.id}`}
                          data-status={status[i]}
                        >
                          <Typography
                            level="body-sm"
                            sx={{ flex: 1, color: status[i] === 'ahead' ? 'text.secondary' : undefined }}
                          >
                            {step.title ?? step.action ?? step.id}
                          </Typography>
                          {STATUS_LABEL[status[i]] && (
                            <Chip size="sm" variant="soft" color={status[i] === 'current' ? 'primary' : 'success'}>
                              {STATUS_LABEL[status[i]]}
                            </Chip>
                          )}
                        </ListItemButton>
                      </ListItem>
                    ))}
                  </List>
                )}
              </Box>
            );
          })}
        </Box>
      </Box>
    </Drawer>
  );
}

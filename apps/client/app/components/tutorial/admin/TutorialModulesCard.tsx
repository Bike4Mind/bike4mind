import { FC, useCallback, useRef, useState } from 'react';
import {
  Box,
  Button,
  Card,
  Chip,
  CircularProgress,
  FormControl,
  FormHelperText,
  Input,
  Stack,
  Switch,
  Typography,
} from '@mui/joy';
import {
  useSetTutorialModule,
  useTutorialAnchorChoices,
  useTutorialModules,
} from '@client/app/hooks/tutorials/useTutorialModules';
import type { TutorialStepRegistry } from '../types';
import TutorialOverrideEditor from './TutorialOverrideEditor';

const REASON_MAX = 500;
const DISCARD_PROMPT = 'Discard your unsaved edits to this tutorial?';

interface Props {
  apiBase: string;
  /** The host's own step renderers, so the editor can flag a step type nothing renders. */
  steps?: TutorialStepRegistry;
}

/** Admin card for switching a tutorial module off, or editing its words, without a deploy. */
const TutorialModulesCard: FC<Props> = ({ apiBase, steps }) => {
  const modules = useTutorialModules(apiBase);
  const choices = useTutorialAnchorChoices(apiBase);
  const save = useSetTutorialModule(apiBase);
  const [reason, setReason] = useState('');
  const [editing, setEditing] = useState<string | null>(null);
  const dirty = useRef(false);
  const setDirty = useCallback((value: boolean) => {
    dirty.current = value;
  }, []);
  const toggleEditor = (moduleId: string) => {
    if (dirty.current && !window.confirm(DISCARD_PROMPT)) return;
    setEditing(prev => (prev === moduleId ? null : moduleId));
  };
  const reasonGiven = reason.trim().length > 0;

  return (
    <Card variant="outlined" data-testid="tutorial-modules-card">
      <Box>
        <Typography level="title-md">Tutorial modules</Typography>
        <Typography level="body-sm" sx={{ color: 'text.tertiary', mt: 0.5 }}>
          Switch one tutorial off, or fix its words, without a deploy. A learner part way through it is told the
          tutorial changed on their next step. A module the code holds off stays off here.
        </Typography>
      </Box>
      <FormControl>
        <Input
          size="sm"
          placeholder="Reason for the change"
          value={reason}
          onChange={event => setReason(event.target.value.slice(0, REASON_MAX))}
          slotProps={{ input: { 'data-testid': 'tutorial-modules-reason', 'aria-label': 'Reason for the change' } }}
        />
        <FormHelperText>Required before a switch moves. It is kept with the change.</FormHelperText>
      </FormControl>
      {modules.isLoading ? (
        <CircularProgress size="sm" />
      ) : modules.isError ? (
        <Typography level="body-sm" color="danger">
          Could not read the tutorial modules.
        </Typography>
      ) : (modules.data ?? []).length === 0 ? (
        <Typography level="body-sm" sx={{ color: 'text.tertiary' }} data-testid="tutorial-modules-empty">
          No tutorials are registered here yet.
        </Typography>
      ) : (
        <Stack gap={1}>
          {(modules.data ?? []).map(row => (
            <Box key={row.moduleId}>
              <Box
                data-testid={`tutorial-module-row-${row.moduleId}`}
                sx={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 2 }}
              >
                <Box sx={{ minWidth: 0 }}>
                  <Stack direction="row" gap={1} alignItems="center">
                    <Typography level="title-sm">{row.title}</Typography>
                    <Typography level="body-xs" sx={{ color: 'text.tertiary' }}>
                      v{row.version}.{row.revision}
                    </Typography>
                    {row.overridden && (
                      <Chip size="sm" variant="soft" color="warning">
                        overridden
                      </Chip>
                    )}
                    {!row.repoEnabled && (
                      <Chip size="sm" variant="soft" color="neutral">
                        off in code
                      </Chip>
                    )}
                  </Stack>
                  {row.lastChange && (
                    <Typography level="body-xs" sx={{ color: 'text.tertiary', overflowWrap: 'anywhere' }}>
                      {new Date(row.lastChange.at).toLocaleString()}: {row.lastChange.reason}
                    </Typography>
                  )}
                </Box>
                <Stack direction="row" gap={1} alignItems="center">
                  <Button
                    size="sm"
                    variant="plain"
                    disabled={!choices.data}
                    onClick={() => toggleEditor(row.moduleId)}
                    data-testid={`tutorial-module-edit-${row.moduleId}`}
                  >
                    {editing === row.moduleId ? 'Close' : 'Edit'}
                  </Button>
                  <Switch
                    checked={row.enabled}
                    disabled={!row.repoEnabled || !reasonGiven || save.isPending}
                    onChange={event =>
                      save.mutate(
                        { moduleId: row.moduleId, enabled: event.target.checked, reason: reason.trim() },
                        { onSuccess: () => setReason('') }
                      )
                    }
                    slotProps={{
                      input: {
                        'aria-label': `${row.title} tutorial`,
                        'data-testid': `tutorial-module-switch-${row.moduleId}`,
                      } as Record<string, unknown>,
                    }}
                  />
                </Stack>
              </Box>
              {editing === row.moduleId && choices.data && (
                <TutorialOverrideEditor
                  key={row.moduleId}
                  apiBase={apiBase}
                  row={row}
                  choices={choices.data}
                  steps={steps}
                  onDirtyChange={setDirty}
                />
              )}
            </Box>
          ))}
        </Stack>
      )}
    </Card>
  );
};

export default TutorialModulesCard;

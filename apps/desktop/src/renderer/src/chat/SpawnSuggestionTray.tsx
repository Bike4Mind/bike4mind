import { useEffect, useRef, useState } from 'react';
import Box from '@mui/joy/Box';
import Button from '@mui/joy/Button';
import FormControl from '@mui/joy/FormControl';
import FormHelperText from '@mui/joy/FormHelperText';
import FormLabel from '@mui/joy/FormLabel';
import IconButton from '@mui/joy/IconButton';
import Input from '@mui/joy/Input';
import Sheet from '@mui/joy/Sheet';
import Stack from '@mui/joy/Stack';
import Textarea from '@mui/joy/Textarea';
import Typography from '@mui/joy/Typography';
import type { ChatSpawnSuggestion, SpawnSuggestionResult, StartSpawnSuggestionRequest } from '@shared/chat';
import { BranchIcon, ChevronIcon } from './icons';
import { contentColumnSx } from './layout';
import {
  acceptAssistant,
  editDraft,
  keepMine,
  readDraft,
  resolveDraft,
  writeDraft,
  type DraftField,
  type SuggestionDraft,
} from './spawnSuggestionDraft';

/** Long enough to be noticed beside a streaming reply, short enough not to linger. */
const UPDATE_HIGHLIGHT_MS = 1600;

type StartFn = (request: Omit<StartSpawnSuggestionRequest, 'sessionId'>) => Promise<SpawnSuggestionResult>;

/**
 * Tasks the model suggested handing to a new session, pinned above the composer.
 *
 * Above the composer rather than inline at the call, because a suggestion is something the user
 * acts on while the conversation keeps going: inline, the card scrolls away the moment the model
 * answers "also make it do X", and that is exactly when it needs to be in view. The turn is never
 * held on it, so the composer below stays fully usable.
 *
 * Only pending suggestions are drawn: once one starts, its session in the sidebar is the record.
 */
export function SpawnSuggestionTray({
  suggestions,
  onStart,
  onDismiss,
}: {
  suggestions: readonly ChatSpawnSuggestion[];
  onStart: StartFn;
  onDismiss: (suggestionId: string) => Promise<SpawnSuggestionResult>;
}) {
  const pending = suggestions.filter(suggestion => suggestion.status === 'pending');
  if (pending.length === 0) return null;
  return (
    <Stack
      spacing={0.75}
      sx={{ ...contentColumnSx, pt: 1.5, maxHeight: '45vh', overflowY: 'auto' }}
      data-testid="spawn-suggestion-tray"
    >
      {pending.map(suggestion => (
        <SpawnSuggestionCard key={suggestion.id} suggestion={suggestion} onStart={onStart} onDismiss={onDismiss} />
      ))}
    </Stack>
  );
}

/**
 * One pending suggestion. Edits stay local until it is started, so the model revising the card
 * (session_suggestion_update) and the user typing in it can overlap: a field the user has not
 * touched takes the new text and the card flashes; a field they have edited keeps their text and
 * asks "Updated by the assistant - apply?" instead of overwriting it.
 */
export function SpawnSuggestionCard({
  suggestion,
  onStart,
  onDismiss,
}: {
  suggestion: ChatSpawnSuggestion;
  onStart: StartFn;
  onDismiss: (suggestionId: string) => Promise<SpawnSuggestionResult>;
}) {
  const [draft, setDraftState] = useState<SuggestionDraft | undefined>(() => readDraft(suggestion.id));
  const [expanded, setExpanded] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [highlight, setHighlight] = useState(false);
  const seenRevision = useRef(suggestion.revision);

  useEffect(() => {
    if (suggestion.revision === seenRevision.current) return;
    seenRevision.current = suggestion.revision;
    setHighlight(true);
    const timer = setTimeout(() => setHighlight(false), UPDATE_HIGHLIGHT_MS);
    return () => clearTimeout(timer);
  }, [suggestion.revision]);

  const setDraft = (next: SuggestionDraft | undefined) => {
    writeDraft(suggestion.id, next);
    setDraftState(next);
  };

  const { values, conflicts } = resolveDraft(suggestion, draft);
  const field = (name: DraftField) => ({
    value: values[name],
    onChange: (event: { target: { value: string } }) =>
      setDraft(editDraft(suggestion, draft, name, event.target.value)),
  });

  const start = async (placement: 'worktree' | 'local') => {
    setBusy(true);
    setError(null);
    const result = await onStart({
      suggestionId: suggestion.id,
      placement,
      prompt: values.prompt,
      title: values.title,
      ...(placement === 'worktree' ? { branch: values.branch } : {}),
    });
    setBusy(false);
    if (result.ok) writeDraft(suggestion.id, undefined);
    else setError(result.error);
  };

  const dismiss = async () => {
    setBusy(true);
    const result = await onDismiss(suggestion.id);
    setBusy(false);
    if (result.ok) writeDraft(suggestion.id, undefined);
    else setError(result.error);
  };

  return (
    <Sheet
      variant={highlight ? 'soft' : 'outlined'}
      color={highlight ? 'primary' : 'neutral'}
      sx={{ borderRadius: 'sm', px: 1.5, py: 1, transition: 'background-color 300ms' }}
      data-testid="spawn-suggestion-card"
      data-highlight={highlight ? 'true' : undefined}
    >
      <Stack direction="row" alignItems="flex-start" spacing={1}>
        <Box sx={{ flex: 1, minWidth: 0 }}>
          <Typography level="body-xs" textColor="text.tertiary">
            Suggested task
          </Typography>
          <Typography level="title-sm" sx={{ overflowWrap: 'anywhere' }} data-testid="spawn-suggestion-title">
            {values.title}
          </Typography>
          {suggestion.summary && (
            <Typography level="body-sm" textColor="text.secondary" data-testid="spawn-suggestion-summary">
              {suggestion.summary}
            </Typography>
          )}
        </Box>
        <IconButton
          size="sm"
          variant="plain"
          color="neutral"
          onClick={() => setExpanded(open => !open)}
          aria-label={expanded ? 'Hide the task' : 'Show and edit the task'}
          aria-expanded={expanded}
          data-testid="spawn-suggestion-expand-btn"
        >
          <ChevronIcon open={expanded} />
        </IconButton>
      </Stack>

      {expanded && (
        <Stack spacing={1} sx={{ mt: 1 }}>
          <FormControl size="sm">
            <FormLabel sx={{ fontSize: 'xs' }}>Title</FormLabel>
            <Input
              size="sm"
              {...field('title')}
              slotProps={{ input: { 'data-testid': 'spawn-suggestion-title-input' } }}
            />
          </FormControl>
          <FormControl size="sm">
            <FormLabel sx={{ fontSize: 'xs' }}>Prompt</FormLabel>
            <Textarea
              size="sm"
              minRows={3}
              maxRows={14}
              {...field('prompt')}
              slotProps={{ textarea: { 'data-testid': 'spawn-suggestion-prompt-input' } }}
            />
          </FormControl>
        </Stack>
      )}

      <FormControl size="sm" sx={{ mt: 1 }}>
        <FormLabel sx={{ fontSize: 'xs' }}>Branch</FormLabel>
        <Input
          size="sm"
          startDecorator={<BranchIcon />}
          {...field('branch')}
          slotProps={{ input: { 'data-testid': 'spawn-suggestion-branch-input' } }}
        />
        <FormHelperText sx={{ fontSize: 'xs' }} data-testid="spawn-suggestion-base">
          Based on {suggestion.base}
        </FormHelperText>
      </FormControl>

      {conflicts.map(name => (
        <Stack
          key={name}
          direction="row"
          alignItems="center"
          spacing={1}
          sx={{ mt: 1, flexWrap: 'wrap' }}
          data-testid={`spawn-suggestion-conflict-${name}`}
        >
          <Typography level="body-xs" color="warning" sx={{ flex: 1 }}>
            The {name} was updated by the assistant - apply?
          </Typography>
          <Button
            size="sm"
            variant="soft"
            color="warning"
            onClick={() => setDraft(acceptAssistant(suggestion, draft, name))}
            data-testid={`spawn-suggestion-apply-${name}-btn`}
          >
            Apply
          </Button>
          <Button
            size="sm"
            variant="plain"
            color="neutral"
            onClick={() => setDraft(keepMine(suggestion, draft, name))}
            data-testid={`spawn-suggestion-keep-${name}-btn`}
          >
            Keep mine
          </Button>
        </Stack>
      ))}

      {error && (
        <Typography level="body-xs" color="danger" sx={{ mt: 1 }} data-testid="spawn-suggestion-error">
          {error}
        </Typography>
      )}

      <Stack direction="row" spacing={1} useFlexGap sx={{ mt: 1, flexWrap: 'wrap', alignItems: 'center' }}>
        <Button
          size="sm"
          disabled={busy || !values.prompt.trim() || !values.branch.trim()}
          onClick={() => void start('worktree')}
          data-testid="spawn-suggestion-start-btn"
        >
          Start with worktree
        </Button>
        <Button
          size="sm"
          variant="outlined"
          color="neutral"
          disabled={busy || !values.prompt.trim()}
          onClick={() => void start('local')}
          data-testid="spawn-suggestion-start-local-btn"
        >
          Start locally
        </Button>
        <Button
          size="sm"
          variant="plain"
          color="neutral"
          disabled={busy}
          onClick={() => void dismiss()}
          data-testid="spawn-suggestion-dismiss-btn"
        >
          Dismiss
        </Button>
      </Stack>
    </Sheet>
  );
}

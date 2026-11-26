import React, { useState } from 'react';
import { Alert, Box, Button, Chip, FormControl, FormLabel, Input, Stack, Table, Textarea, Typography } from '@mui/joy';
import type {
  CallableFunctionCallRowOutcome,
  CallableFunctionCallSummary,
  CallableFunctionExample,
  FunctionContract,
  FunctionContractProblem,
  ICallableFunctionPublic,
} from '@bike4mind/common';
import {
  callableFunctionCasesLeft,
  callableFunctionErrorMessage,
  callableFunctionErrorProblems,
  useCallableFunctionCalls,
  usePromoteCallableFunction,
  useSetCallableFunctionExamples,
  useStopSharingCallableFunction,
} from '@client/app/hooks/data/callableFunctions';
import ProblemList, { dangerAlertSx } from './FunctionProblemList';
import ShareFunctionDialog from './ShareFunctionDialog';

const OUTCOME_LABELS: Record<CallableFunctionCallRowOutcome, string> = {
  ok: 'Returned',
  input_invalid: 'Inputs refused',
  output_invalid: 'Outputs refused',
  error: 'Error',
  timeout: 'Timed out',
  memory: 'Out of memory',
  output_too_large: 'Output too large',
  refused: 'Refused',
  queued: 'Queued',
  running: 'Running',
  data_mismatch: 'Data file changed',
  cancelled: 'Cancelled',
};

// A pending or cancelled call's row holds only the time its checks took, not a run.
const NO_RUN_TIME: ReadonlySet<CallableFunctionCallRowOutcome> = new Set(['queued', 'running', 'cancelled']);

type RecentCall = CallableFunctionCallSummary['recent'][number];

function callDuration(call: RecentCall): string {
  if (NO_RUN_TIME.has(call.outcome)) return '-';
  if (call.durationMs < 1000) return `${call.durationMs} ms`;
  if (call.durationMs < 60_000) return `${(call.durationMs / 1000).toFixed(1)} s`;
  const seconds = Math.round(call.durationMs / 1000);
  return `${Math.floor(seconds / 60)} min ${seconds % 60} s`;
}

function callCaller(call: RecentCall): string {
  if (call.byRecipient) return 'A recipient';
  if (call.surface === 'test') return 'You, a test on the server';
  if (!call.apiKey) return 'You';
  return call.apiKey.name === null ? 'You, with a deleted API key' : `You, with API key "${call.apiKey.name}"`;
}

const LABEL_HELP = {
  platform: 'Platform: curated and checked by Bike4Mind. A cited worked example passed on the server.',
  verified: 'A cited worked example passed on the server.',
  unverified: 'Only declared tests ran on the server. Add a cited worked example and promote again to verify it.',
} as const;

const json = (value: unknown) => JSON.stringify(value);

interface Draft {
  name: string;
  input: string;
  expected: string;
  rel: string;
  /** The form edits only `rel`; an absolute tolerance from an earlier save goes back unchanged. */
  abs?: number;
  citation: string;
}

const emptyDraft = (contract: FunctionContract): Draft => ({
  name: '',
  input: json(Object.fromEntries(Object.keys(contract.inputs.properties).map(key => [key, 0]))),
  expected: json(Object.fromEntries(Object.keys(contract.outputs.properties).map(key => [key, 0]))),
  rel: '',
  citation: '',
});

const toDraft = (example: CallableFunctionExample): Draft => ({
  name: example.name,
  input: json(example.input),
  expected: json(example.expected),
  rel: example.tolerance?.rel !== undefined ? String(example.tolerance.rel) : '',
  ...(example.tolerance?.abs !== undefined ? { abs: example.tolerance.abs } : {}),
  citation: example.citation,
});

function parseObject(text: string): Record<string, unknown> | null {
  try {
    const value: unknown = JSON.parse(text);
    return typeof value === 'object' && value !== null && !Array.isArray(value)
      ? (value as Record<string, unknown>)
      : null;
  } catch {
    return null;
  }
}

/** The draft as an example, or the first thing wrong with it; the server checks the rest against the contract. */
function fromDraft(draft: Draft): CallableFunctionExample | string {
  const input = parseObject(draft.input);
  if (!input) return 'Input must be a JSON object of input values.';
  const expected = parseObject(draft.expected);
  if (!expected) return 'Expected output must be a JSON object naming at least one output.';
  const rel = draft.rel.trim() === '' ? undefined : Number(draft.rel);
  if (rel !== undefined && !(Number.isFinite(rel) && rel >= 0)) {
    return 'Relative tolerance must be a number of 0 or more.';
  }
  if (!draft.citation.trim()) return 'Cite a source a reader can check the expected output against.';
  const tolerance = {
    ...(draft.abs !== undefined ? { abs: draft.abs } : {}),
    ...(rel !== undefined ? { rel } : {}),
  };
  return {
    name: draft.name.trim(),
    input,
    expected,
    ...(Object.keys(tolerance).length > 0 ? { tolerance } : {}),
    citation: draft.citation.trim(),
  };
}

function ExampleForm({
  contract,
  initial,
  saving,
  onSave,
  onCancel,
}: {
  contract: FunctionContract;
  initial: CallableFunctionExample | null;
  saving: boolean;
  onSave: (example: CallableFunctionExample) => void;
  onCancel: () => void;
}) {
  const [draft, setDraft] = useState<Draft>(() => (initial ? toDraft(initial) : emptyDraft(contract)));
  const [problem, setProblem] = useState<string | null>(null);
  const field = (key: keyof Draft) => (event: React.ChangeEvent<HTMLInputElement | HTMLTextAreaElement>) =>
    setDraft(previous => ({ ...previous, [key]: event.target.value }));
  const submit = () => {
    const example = fromDraft(draft);
    if (typeof example === 'string') return setProblem(example);
    setProblem(null);
    onSave(example);
  };
  return (
    <Stack spacing={1} data-testid="python-function-example-form">
      <FormControl size="sm">
        <FormLabel>Name</FormLabel>
        <Input
          value={draft.name}
          onChange={field('name')}
          slotProps={{ input: { 'data-testid': 'python-function-example-name' } }}
        />
      </FormControl>
      <FormControl size="sm">
        <FormLabel>Input (JSON)</FormLabel>
        <Textarea
          minRows={1}
          value={draft.input}
          onChange={field('input')}
          sx={{ fontFamily: 'monospace' }}
          slotProps={{ textarea: { 'data-testid': 'python-function-example-input' } }}
        />
      </FormControl>
      <FormControl size="sm">
        <FormLabel>Expected output (JSON)</FormLabel>
        <Textarea
          minRows={1}
          value={draft.expected}
          onChange={field('expected')}
          sx={{ fontFamily: 'monospace' }}
          slotProps={{ textarea: { 'data-testid': 'python-function-example-expected' } }}
        />
      </FormControl>
      <FormControl size="sm">
        <FormLabel>Relative tolerance (optional)</FormLabel>
        <Input
          value={draft.rel}
          onChange={field('rel')}
          slotProps={{ input: { 'data-testid': 'python-function-example-rel' } }}
        />
      </FormControl>
      <FormControl size="sm">
        <FormLabel>Citation</FormLabel>
        <Input
          value={draft.citation}
          onChange={field('citation')}
          placeholder="A source a reader can check, such as a URL or a handbook table"
          slotProps={{ input: { 'data-testid': 'python-function-example-citation' } }}
        />
      </FormControl>
      {problem && (
        <Typography level="body-sm" color="danger" data-testid="python-function-example-problem">
          {problem}
        </Typography>
      )}
      <Stack direction="row" spacing={1}>
        <Button size="sm" loading={saving} onClick={submit} data-testid="python-function-example-save-btn">
          Save example
        </Button>
        <Button size="sm" variant="plain" color="neutral" onClick={onCancel} disabled={saving}>
          Cancel
        </Button>
      </Stack>
    </Stack>
  );
}

function ExamplesBlock({ tool, contract }: { tool: ICallableFunctionPublic; contract: FunctionContract }) {
  const setExamples = useSetCallableFunctionExamples();
  // null: no form; -1: adding; otherwise the index being edited.
  const [editing, setEditing] = useState<number | null>(null);
  const [error, setError] = useState<{ message: string; problems: FunctionContractProblem[] } | null>(null);
  const examples = tool.examples;

  const save = (next: CallableFunctionExample[], onDone?: () => void) =>
    setExamples.mutate(
      { id: tool.id, examples: next },
      {
        onSuccess: () => {
          setError(null);
          onDone?.();
        },
        onError: failure =>
          setError({
            message: callableFunctionErrorMessage(failure, 'The worked examples could not be saved.'),
            problems: callableFunctionErrorProblems(failure),
          }),
      }
    );

  return (
    <Stack spacing={1} data-testid="python-function-examples">
      <Typography level="title-sm">Worked examples</Typography>
      <Typography level="body-xs" sx={{ color: 'text.secondary' }}>
        Cases you add here with a source, never read from the code. Promotion runs each on the server.
      </Typography>
      {examples.length > 0 && (
        <Table size="sm" sx={{ '& td': { verticalAlign: 'top', wordBreak: 'break-word' } }}>
          <thead>
            <tr>
              <th>Example</th>
              <th>Source</th>
              <th style={{ width: 130 }} aria-label="Actions" />
            </tr>
          </thead>
          <tbody>
            {examples.map((example, index) => (
              <tr key={`${example.name}-${index}`} data-testid="python-function-example-row">
                <td>
                  <Typography level="body-sm">{example.name}</Typography>
                  <Typography level="body-xs" sx={{ fontFamily: 'monospace' }}>
                    {json(example.input)} {'->'} {json(example.expected)}
                  </Typography>
                </td>
                <td>
                  <Typography level="body-xs" data-testid="python-function-example-citation-text">
                    {example.citation}
                  </Typography>
                </td>
                <td>
                  <Stack direction="row" spacing={0.5}>
                    <Button
                      size="sm"
                      variant="plain"
                      disabled={setExamples.isPending}
                      onClick={() => setEditing(index)}
                      data-testid="python-function-example-edit-btn"
                    >
                      Edit
                    </Button>
                    <Button
                      size="sm"
                      variant="plain"
                      color="danger"
                      disabled={setExamples.isPending}
                      data-testid="python-function-example-remove-btn"
                      onClick={() => save(examples.filter((_, at) => at !== index))}
                    >
                      Remove
                    </Button>
                  </Stack>
                </td>
              </tr>
            ))}
          </tbody>
        </Table>
      )}
      {editing === null ? (
        <Box>
          <Button
            size="sm"
            variant="outlined"
            color="neutral"
            data-testid="python-function-example-add-btn"
            onClick={() => setEditing(-1)}
          >
            Add worked example
          </Button>
        </Box>
      ) : (
        <ExampleForm
          key={editing}
          contract={contract}
          initial={editing >= 0 ? (examples[editing] ?? null) : null}
          saving={setExamples.isPending}
          onCancel={() => setEditing(null)}
          onSave={example =>
            save(
              editing >= 0
                ? examples.map((current, at) => (at === editing ? example : current))
                : [...examples, example],
              () => setEditing(null)
            )
          }
        />
      )}
      {error &&
        (error.problems.length > 0 ? (
          <ProblemList heading={error.message} problems={error.problems} />
        ) : (
          <Alert color="danger" variant="soft" sx={dangerAlertSx} data-testid="python-function-examples-error">
            {error.message}
          </Alert>
        ))}
    </Stack>
  );
}

export function CallsBlock({ tool }: { tool: ICallableFunctionPublic }) {
  const { data, isError } = useCallableFunctionCalls(tool.id);
  const counts = data
    ? Object.entries(data.outcomes)
        .map(([outcome, count]) => `${OUTCOME_LABELS[outcome as CallableFunctionCallRowOutcome] ?? outcome} ${count}`)
        .join(', ')
    : '';
  return (
    <Stack spacing={0.5} data-testid="python-function-calls">
      <Typography level="title-sm">Calls in the last 30 days</Typography>
      <Typography level="body-xs" sx={{ color: 'text.secondary' }} data-testid="python-function-calls-note">
        Call function on the Function tab runs in your browser and is not listed here.
      </Typography>
      {isError && (
        <Typography level="body-xs" sx={{ color: 'text.secondary' }}>
          The calls could not be loaded.
        </Typography>
      )}
      {data && (
        <>
          <Typography level="body-sm" data-testid="python-function-calls-total">
            {data.total === 0 ? 'No calls.' : `${data.total} ${data.total === 1 ? 'call' : 'calls'}: ${counts}.`}
          </Typography>
          {data.recent.length > 0 && (
            <Table size="sm" sx={{ tableLayout: 'auto' }} data-testid="python-function-calls-recent">
              <thead>
                <tr>
                  <th>Time</th>
                  <th>Outcome</th>
                  <th>By</th>
                  <th>Promotion</th>
                  <th>Duration</th>
                </tr>
              </thead>
              <tbody>
                {data.recent.map(call => (
                  <tr key={call.id} data-testid="python-function-call-row">
                    <td>
                      {new Date(call.startedAt).toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' })}
                    </td>
                    <td>{OUTCOME_LABELS[call.outcome] ?? call.outcome}</td>
                    <td>{callCaller(call)}</td>
                    <td>{call.pinSeq === undefined ? '-' : call.pinSeq}</td>
                    <td>{callDuration(call)}</td>
                  </tr>
                ))}
              </tbody>
            </Table>
          )}
        </>
      )}
    </Stack>
  );
}

/** A private share whose named people were all erased reaches nobody, so it reads as not shared. */
function isShared(tool: ICallableFunctionPublic): boolean {
  const grants = tool.grants;
  return !!grants && (grants.visibility !== 'private' || grants.userIds.length > 0);
}

function shareSummary(tool: ICallableFunctionPublic): string {
  const grants = tool.grants;
  if (!grants || !isShared(tool)) return 'Not shared.';
  const parts = [
    ...(grants.userIds.length > 0
      ? [`${grants.userIds.length} ${grants.userIds.length === 1 ? 'person' : 'people'}`]
      : []),
    ...(grants.visibility === 'project' ? ['the members of a project'] : []),
    ...(grants.visibility === 'organization' ? ['the members of an organization'] : []),
  ];
  return `Shared with ${parts.join(' and ')}.`;
}

function ShareBlock({ tool, live }: { tool: ICallableFunctionPublic; live: boolean }) {
  const [open, setOpen] = useState(false);
  const [stopError, setStopError] = useState<string | null>(null);
  const stop = useStopSharingCallableFunction();
  return (
    <Stack spacing={1} data-testid="python-function-share-section">
      <Typography level="title-sm">Sharing</Typography>
      <Typography level="body-xs" sx={{ color: 'text.secondary' }} data-testid="python-function-share-status">
        {live
          ? shareSummary(tool)
          : isShared(tool)
            ? 'Paused until the next promotion, which shares it again.'
            : 'Promote the tool to share it. A share covers the live version.'}
      </Typography>
      <Stack direction="row" spacing={1}>
        <Button
          size="sm"
          variant="outlined"
          color="neutral"
          disabled={!live}
          onClick={() => setOpen(true)}
          data-testid="python-function-share-btn"
        >
          {isShared(tool) ? 'Edit share' : 'Share'}
        </Button>
        {isShared(tool) && (
          <Button
            size="sm"
            variant="plain"
            color="danger"
            loading={stop.isPending}
            onClick={() => {
              setStopError(null);
              stop.mutate(tool.id, {
                onError: failure =>
                  setStopError(callableFunctionErrorMessage(failure, 'The tool could not stop being shared.')),
              });
            }}
            data-testid="python-function-share-stop-btn"
          >
            Stop sharing
          </Button>
        )}
      </Stack>
      {stopError && (
        <Alert color="danger" variant="soft" sx={dangerAlertSx} data-testid="python-function-share-stop-error">
          {stopError}
        </Alert>
      )}
      {open && (
        <ShareFunctionDialog
          tool={tool}
          dataPins={tool.dataPins.map(pin => pin.name)}
          sources={(tool.sources ?? []).map(source => source.name)}
          onClose={() => setOpen(false)}
        />
      )}
    </Stack>
  );
}

/**
 * Promote, the trust label once live, the worked examples, and the owner's recent calls for one saved tool.
 * `blocked` says why promotion cannot run now, such as an artifact version newer than the pin.
 */
export default function PromoteFunctionSection({
  tool,
  contract,
  blocked,
}: {
  tool: ICallableFunctionPublic;
  contract: FunctionContract;
  blocked: string | null;
}) {
  const promote = usePromoteCallableFunction();
  const [refusal, setRefusal] = useState<{ key: string; message: string; left: string[] } | null>(null);
  const key = `${tool.id}:${tool.pin.version}`;
  const shownRefusal = refusal && refusal.key === key ? refusal : null;
  const live = tool.state === 'live' && tool.trustLabel !== null;

  return (
    <Stack spacing={2} data-testid="python-function-promote-section">
      <Stack spacing={1}>
        <Stack direction="row" spacing={1} alignItems="center" flexWrap="wrap" useFlexGap>
          <Typography level="title-sm">Promotion</Typography>
          {live && tool.trustLabel && (
            <Chip
              size="sm"
              variant="soft"
              color={tool.trustLabel === 'unverified' ? 'neutral' : 'success'}
              data-testid="python-function-trust-chip"
            >
              {tool.trustLabel}
            </Chip>
          )}
        </Stack>
        <Typography level="body-xs" sx={{ color: 'text.secondary' }} data-testid="python-function-promote-status">
          {live && tool.trustLabel
            ? `Live at promotion ${tool.pin.seq ?? ''}. ${LABEL_HELP[tool.trustLabel]}`
            : 'A draft. Promoting runs every declared test and worked example on the server and makes the tool live only if all pass.'}
        </Typography>
        <Box>
          <Button
            size="sm"
            variant="outlined"
            color="primary"
            loading={promote.isPending}
            disabled={blocked !== null}
            data-testid="python-function-promote-btn"
            onClick={() =>
              promote.mutate(tool.id, {
                onSuccess: () => setRefusal(null),
                onError: error =>
                  setRefusal({
                    key,
                    message: callableFunctionErrorMessage(error, 'The tool could not be promoted.'),
                    left: callableFunctionCasesLeft(error).map(entry =>
                      entry.kind === 'example' ? `${entry.name} (worked example)` : entry.name
                    ),
                  }),
              })
            }
          >
            {live ? 'Promote again' : 'Promote'}
          </Button>
        </Box>
        {blocked && (
          <Typography level="body-xs" sx={{ color: 'text.secondary' }} data-testid="python-function-promote-blocked">
            {blocked}
          </Typography>
        )}
        {shownRefusal && shownRefusal.left.length > 0 && (
          <Alert color="warning" variant="soft" data-testid="python-function-promote-cases-left">
            <Stack spacing={0.5}>
              <Typography level="title-sm">Not promoted yet</Typography>
              <Typography level="body-sm">{shownRefusal.message}</Typography>
              <Typography level="body-xs">Still to run: {shownRefusal.left.join(', ')}</Typography>
            </Stack>
          </Alert>
        )}
        {shownRefusal && shownRefusal.left.length === 0 && (
          <Alert color="danger" variant="soft" sx={dangerAlertSx} data-testid="python-function-promote-refusal">
            <Stack spacing={0.5}>
              <Typography level="title-sm" color="danger">
                Not promoted
              </Typography>
              <Typography level="body-sm">{shownRefusal.message}</Typography>
            </Stack>
          </Alert>
        )}
      </Stack>
      <ShareBlock tool={tool} live={live} />
      <ExamplesBlock tool={tool} contract={contract} />
      <CallsBlock tool={tool} />
    </Stack>
  );
}

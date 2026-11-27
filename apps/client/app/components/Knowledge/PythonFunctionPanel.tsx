import React, { useCallback, useEffect, useRef, useState } from 'react';
import {
  Alert,
  Box,
  Button,
  Checkbox,
  CircularProgress,
  Divider,
  FormControl,
  FormHelperText,
  FormLabel,
  Input,
  Modal,
  ModalClose,
  ModalDialog,
  Option,
  Select,
  Stack,
  Table,
  Textarea,
  Typography,
} from '@mui/joy';
import {
  FUNCTION_CONTRACT_GLOBAL,
  FUNCTION_ENTRY_POINT,
  PYODIDE_VERSION,
  capFunctionProblems,
  compareFunctionOutput,
  parseFunctionContract,
  validateFunctionValue,
  type FunctionContract,
  type FunctionContractChange,
  type FunctionContractProblem,
  type FunctionField,
  type FunctionObjectField,
  type FunctionOutputMismatch,
  type FunctionTestCase,
  type CallableFunctionStampData,
  type ICallableFunctionPublic,
  type McpToolApprovalMode,
  MAX_CALLABLE_FUNCTIONS_PER_TURN,
} from '@bike4mind/common';
import { toast } from 'sonner';
import {
  callableFunctionBreakingChanges,
  callableFunctionBreakingSincePromotion,
  callableFunctionContractUnreadable,
  callableFunctionErrorMessage,
  fetchCallableFunctionDataFiles,
  fetchCallableFunctionSources,
  useArtifactCallableFunction,
  useCallableFunctionsServerRuntime,
  useDeleteCallableFunction,
  useRepinCallableFunction,
  useRunCallableFunctionTests,
  useSetCallableFunctionApproval,
  useSetCallableFunctionEnabled,
} from '@client/app/hooks/data/callableFunctions';
import type {
  CallableFunctionTestCaseResult,
  CallableFunctionTestRun,
} from '@pages/api/callable-functions/[id]/test-run';
import { usePyodide } from '@client/app/hooks/usePyodide';
import { PYTHON_SCRIPT_BUSY } from '@client/app/utils/pyodideManager';
import ProblemList, { dangerAlertSx } from './FunctionProblemList';
import BreakingChangeDialog from './BreakingChangeDialog';
import { ContractTable, unitLabel } from './FunctionContractTable';
import PromoteFunctionSection from './PromoteFunctionSection';
import FunctionDataSection from './FunctionDataSection';
import FunctionSourcesSection from './FunctionSourcesSection';
import SaveFunctionDialog from './SaveFunctionDialog';

/** Where saving this artifact as a tool would pin it, or why it cannot be saved yet. */
export interface PythonFunctionSave {
  /** Also read while the artifact is not in the database, so a tool whose artifact was deleted still shows. */
  artifactId: string;
  /** The artifact version the viewer shows. */
  version: number;
  /** Why the artifact cannot be saved as a tool right now; null when it can. */
  blocked: string | null;
}

interface PythonFunctionPanelProps {
  code: string;
  packages: string[];
  /** True while Pyodide is loading or a script run is in flight. */
  disabled: boolean;
  /** Null offers no save controls: the viewer is read only or the person does not own the artifact. */
  save: PythonFunctionSave | null;
}

const DESCRIBE_DEBOUNCE_MS = 500;
// The sandbox wrapper raises this exact text; sandboxWorkerBody.test.ts pins it to the same constant.
const NO_CONTRACT_ERROR = `${FUNCTION_CONTRACT_GLOBAL} is not defined`;

type Described =
  | { status: 'reading' }
  | { status: 'ready'; contract: FunctionContract; code: string }
  | { status: 'invalid'; problems: FunctionContractProblem[] }
  | { status: 'failed'; error: string; output: string };

type CallOutcome =
  | { status: 'inputs'; problems: FunctionContractProblem[] }
  | {
      status: 'returned';
      value: Record<string, unknown>;
      problems: FunctionContractProblem[];
      output: string;
      executionTime: number;
    }
  | { status: 'failed'; error: string; output: string; executionTime: number };

type TestOutcome = (
  | { status: 'passed' }
  | { status: 'mismatch'; mismatch: FunctionOutputMismatch }
  | { status: 'invalid'; problems: FunctionContractProblem[] }
  | { status: 'failed'; error: string }
) & { ms?: number };

type FormValues = Record<string, string | boolean>;

// Decimal only: Number() would also read `0x10`, `0b1`, and `Infinity`.
const DECIMAL_NUMBER = /^[+-]?(\d+\.?\d*|\.\d+)(e[+-]?\d+)?$/i;

const errorMessage = (error: unknown): string => (error instanceof Error ? error.message : String(error));

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

function formatValue(value: unknown): string {
  if (typeof value === 'string') return value;
  if (typeof value === 'number' || typeof value === 'boolean') return String(value);
  return JSON.stringify(value);
}

// A field may be named after an inherited key such as `constructor`, so only own entries count.
const ownValue = (values: FormValues, name: string): string | boolean | undefined =>
  Object.prototype.hasOwnProperty.call(values, name) ? values[name] : undefined;

function initialValues(inputs: FunctionObjectField, previous: FormValues): FormValues {
  return Object.fromEntries(
    Object.entries(inputs.properties).map(([name, field]): [string, string | boolean] => {
      const kept = ownValue(previous, name);
      if (kept !== undefined) return [name, kept];
      if (field.type === 'boolean') return [name, field.default ?? false];
      if ('default' in field && field.default !== undefined) return [name, String(field.default)];
      return [name, ''];
    })
  );
}

/** Turn the form into `run` keyword arguments. Empty fields are left out, so a required one reads as missing. */
function buildParams(inputs: FunctionObjectField, values: FormValues) {
  const entries: [string, unknown][] = [];
  const problems: FunctionContractProblem[] = [];
  for (const [name, field] of Object.entries(inputs.properties)) {
    const raw = ownValue(values, name);
    if (field.type === 'boolean') {
      entries.push([name, raw === true]);
      continue;
    }
    const text = typeof raw === 'string' ? raw.trim() : '';
    if (text === '') continue;
    if (field.type === 'number' || field.type === 'integer') {
      // Text that is not a decimal number is passed through so the contract check names the field.
      entries.push([name, DECIMAL_NUMBER.test(text) ? Number(text) : text]);
    } else if (field.type === 'array' || field.type === 'object') {
      try {
        entries.push([name, JSON.parse(text)]);
      } catch {
        problems.push({ path: name, message: 'must be valid JSON' });
      }
    } else {
      entries.push([name, typeof raw === 'string' ? raw : '']);
    }
  }
  const params = Object.fromEntries(entries);
  const reported = new Set(problems.map(problem => problem.path));
  for (const problem of validateFunctionValue(inputs, params)) {
    if (!reported.has(problem.path)) problems.push(problem);
  }
  return { params, problems };
}

/** The sandbox's type problems (seen before JSON turned 3.0 into 3) first, then the contract check's, one per path. */
function outputProblems(
  outputs: FunctionObjectField,
  value: unknown,
  fromSandbox: FunctionContractProblem[]
): FunctionContractProblem[] {
  const problems = [...fromSandbox];
  const reported = new Set(problems.map(problem => problem.path));
  for (const problem of validateFunctionValue(outputs, value)) {
    if (!reported.has(problem.path)) problems.push(problem);
  }
  return capFunctionProblems(problems);
}

const codeBlockSx = {
  backgroundColor: 'background.level1',
  borderRadius: 'sm',
  p: 1.5,
  m: 0,
  fontFamily: 'monospace',
  fontSize: '13px',
  whiteSpace: 'pre-wrap',
  wordBreak: 'break-word',
  maxHeight: '300px',
  overflow: 'auto',
} as const;

const PrintedOutput = ({ output }: { output: string }) =>
  output ? (
    <Box component="details" data-testid="python-function-printed-output">
      <Typography component="summary" level="title-sm" sx={{ cursor: 'pointer' }}>
        Printed output
      </Typography>
      <Box component="pre" sx={{ ...codeBlockSx, mt: 1 }}>
        {output}
      </Box>
    </Box>
  ) : null;

const FailureBlock = ({ error, output }: { error: string; output: string }) => (
  <Stack spacing={1}>
    <Alert color="danger" variant="solid" data-testid="python-function-error" sx={dangerAlertSx}>
      <Box sx={{ minWidth: 0 }}>
        <Typography level="title-sm">The function raised an error:</Typography>
        <Typography
          component="pre"
          level="body-sm"
          sx={{
            m: 0,
            mt: 0.5,
            fontFamily: 'monospace',
            whiteSpace: 'pre-wrap',
            wordBreak: 'break-word',
            maxHeight: '300px',
            overflow: 'auto',
          }}
        >
          {error}
        </Typography>
      </Box>
    </Alert>
    <PrintedOutput output={output} />
  </Stack>
);

function FieldControl({
  name,
  field,
  value,
  disabled,
  onChange,
}: {
  name: string;
  field: FunctionField;
  value: string | boolean | undefined;
  disabled: boolean;
  onChange: (value: string | boolean) => void;
}) {
  const testId = `python-function-input-${name}`;
  const text = typeof value === 'string' ? value : '';
  switch (field.type) {
    case 'number':
    case 'integer':
      return (
        <Input
          value={text}
          disabled={disabled}
          onChange={event => onChange(event.target.value)}
          endDecorator={<Typography level="body-sm">{unitLabel(field)}</Typography>}
          slotProps={{ input: { 'data-testid': testId, inputMode: 'decimal', 'aria-label': name } }}
        />
      );
    case 'boolean':
      return (
        <Checkbox
          checked={value === true}
          disabled={disabled}
          onChange={event => onChange(event.target.checked)}
          label={name}
          slotProps={{ input: { 'data-testid': testId } }}
        />
      );
    case 'string':
      if (field.enum) {
        return (
          <Select
            value={text || null}
            disabled={disabled}
            onChange={(_event, next) => onChange(next ?? '')}
            slotProps={{ button: { 'data-testid': testId, 'aria-label': name } }}
          >
            {field.enum.map(option => (
              <Option key={option} value={option}>
                {option}
              </Option>
            ))}
          </Select>
        );
      }
      return (
        <Input
          value={text}
          disabled={disabled}
          onChange={event => onChange(event.target.value)}
          slotProps={{ input: { 'data-testid': testId, 'aria-label': name } }}
        />
      );
    default:
      return (
        <Textarea
          value={text}
          disabled={disabled}
          minRows={2}
          placeholder={field.type === 'array' ? '[1, 2, 3]' : '{"name": 1}'}
          onChange={event => onChange(event.target.value)}
          slotProps={{ textarea: { 'data-testid': testId, 'aria-label': name } }}
          sx={{ fontFamily: 'monospace' }}
        />
      );
  }
}

const ResultTable = ({ outputs, value }: { outputs: FunctionObjectField; value: Record<string, unknown> }) => (
  <Box sx={{ overflowX: 'auto' }}>
    <Table size="sm" borderAxis="xBetween" data-testid="python-function-result" sx={{ tableLayout: 'auto' }}>
      <thead>
        <tr>
          <th>Name</th>
          <th>Value</th>
          <th>Unit</th>
        </tr>
      </thead>
      <tbody>
        {Object.entries(outputs.properties)
          .filter(([name]) => Object.prototype.hasOwnProperty.call(value, name))
          .map(([name, field]) => (
            <tr key={name}>
              <td>
                <code>{name}</code>
              </td>
              <td style={{ fontFamily: 'monospace' }}>{formatValue(value[name])}</td>
              <td>{unitLabel(field)}</td>
            </tr>
          ))}
      </tbody>
    </Table>
  </Box>
);

const TEST_STATUS: Record<TestOutcome['status'] | 'running' | 'not_run', { label: string; color: string }> = {
  passed: { label: 'Passed', color: 'success.plainColor' },
  mismatch: { label: 'Failed', color: 'danger.plainColor' },
  invalid: { label: 'Failed', color: 'danger.plainColor' },
  failed: { label: 'Failed', color: 'danger.plainColor' },
  running: { label: 'Running', color: 'text.secondary' },
  not_run: { label: 'Not run', color: 'text.tertiary' },
};

function toleranceText(tolerance: FunctionTestCase['tolerance']): string {
  const parts = [
    tolerance?.abs !== undefined ? `${tolerance.abs} absolute` : null,
    tolerance?.rel !== undefined ? `${tolerance.rel} relative` : null,
  ].filter(Boolean);
  return parts.length > 0 ? ` (tolerance ${parts.join(' or ')})` : '';
}

function TestFailure({ test, outcome }: { test: FunctionTestCase; outcome: TestOutcome }) {
  if (outcome.status === 'passed') return null;
  if (outcome.status === 'invalid') {
    return (
      <ProblemList
        heading={`${test.name}: the function returned values that do not match the contract:`}
        problems={outcome.problems}
      />
    );
  }
  if (outcome.status === 'failed') return <FailureBlock error={`${test.name}: ${outcome.error}`} output="" />;
  return <MismatchAlert test={test} mismatch={outcome.mismatch} testId="python-function-test-failure" />;
}

function MismatchAlert({
  test,
  mismatch,
  testId,
}: {
  test: FunctionTestCase;
  mismatch: FunctionOutputMismatch;
  testId: string;
}) {
  const { path, expected, actual } = mismatch;
  // Quoted, so an empty or blank expected string is still visible.
  const shown = (value: unknown) => (typeof value === 'string' ? JSON.stringify(value) : formatValue(value));
  return (
    <Alert color="danger" variant="soft" data-testid={testId} sx={{ alignItems: 'flex-start' }}>
      <Typography level="body-sm" sx={{ wordBreak: 'break-word' }}>
        {test.name}: output <code>{path || 'result'}</code> expected <code>{shown(expected)}</code>, got{' '}
        <code>{actual === undefined ? 'nothing' : shown(actual)}</code>
        {toleranceText(test.tolerance)}.
      </Typography>
    </Alert>
  );
}

const SERVER_OUTCOME_TEXT: Record<Exclude<CallableFunctionTestCaseResult['outcome'], 'ok' | 'not_run'>, string> = {
  timeout: 'stopped at the time limit',
  memory: 'ran out of memory',
  error: 'failed to run',
  output_invalid: 'returned values that do not match the contract',
  output_too_large: 'returned more than the output size limit',
  input_invalid: 'has inputs that do not match the contract',
  refused: 'was refused',
  data_mismatch: 'read a data file whose bytes no longer match its pin',
};

function ServerTestFailure({ test, result }: { test: FunctionTestCase; result: CallableFunctionTestCaseResult }) {
  if (result.passed || result.outcome === 'not_run') return null;
  if (result.mismatch) {
    return <MismatchAlert test={test} mismatch={result.mismatch} testId="python-function-test-server-failure" />;
  }
  const text =
    result.outcome === 'ok'
      ? 'did not match'
      : result.outcome === 'error' && result.errorClass
        ? `raised ${result.errorClass}`
        : SERVER_OUTCOME_TEXT[result.outcome];
  return (
    <Alert color="danger" variant="soft" data-testid="python-function-test-server-failure">
      <Typography level="body-sm" sx={{ wordBreak: 'break-word' }}>
        {test.name}: {text}.
      </Typography>
    </Alert>
  );
}

function StatusCell({ status, ms, testId }: { status: { label: string; color: string }; ms?: number; testId: string }) {
  return (
    <Typography level="body-sm" sx={{ color: status.color }}>
      <span data-testid={testId}>{status.label}</span>
      {ms !== undefined && (
        <Typography component="span" sx={{ color: 'text.tertiary' }} data-testid={`${testId}-ms`}>
          {` (${Math.round(ms)} ms)`}
        </Typography>
      )}
    </Typography>
  );
}

/** The saved tool's server run: why it cannot run (null when it can), and its last result or error. */
interface ServerTests {
  blocked: string | null;
  running: boolean;
  run: CallableFunctionTestRun | null;
  error: string | null;
  onRun: () => void;
  /** Runs only the cases the last run left not run. */
  onRunRemaining: () => void;
}

const serverStatus = (result: CallableFunctionTestCaseResult) =>
  result.passed
    ? TEST_STATUS.passed
    : result.outcome === 'not_run'
      ? TEST_STATUS.not_run
      : result.outcome === 'timeout'
        ? { label: 'Timed out', color: 'danger.plainColor' }
        : TEST_STATUS.failed;

/** Server results pair with the declared tests by name, never by position. */
const resultFor = (run: CallableFunctionTestRun | null | undefined, name: string) =>
  run?.results.find(result => result.name === name);

/** The earlier run with each case it left not run replaced by the later run's result for that name. */
function mergeTestRuns(earlier: CallableFunctionTestRun, later: CallableFunctionTestRun): CallableFunctionTestRun {
  const results = earlier.results.map(result =>
    result.outcome === 'not_run' ? (resultFor(later, result.name) ?? result) : result
  );
  const passed = results.filter(result => result.passed).length;
  const notRun = results.filter(result => result.outcome === 'not_run').length;
  return { ...later, passed, failed: results.length - passed - notRun, notRun, results };
}

interface BrowserTestsProps {
  tests: FunctionTestCase[];
  outcomes: TestOutcome[];
  running: boolean;
  disabled: boolean;
  onRun: () => void;
  /** The data list of the last browser run's stamp. */
  browserData?: CallableFunctionStampData[] | null;
}

interface BrowserStamp {
  runtime: { kind: 'pyodide-browser'; version: string };
  data: CallableFunctionStampData[];
}

const shortHash = (sha256: string) => `${sha256.slice(0, 12)}...`;

/** What each run's stamp says it read, so the two can be compared by hash. */
function StampData({ label, data, testId }: { label: string; data: CallableFunctionStampData[]; testId: string }) {
  return (
    <Stack spacing={0.25} data-testid={testId}>
      <Typography level="body-xs" sx={{ color: 'text.secondary' }}>
        {label}
      </Typography>
      {data.map(entry => (
        <Typography key={entry.name} level="body-xs" title={entry.sha256}>
          <code>/data/{entry.name}</code> {entry.mode} sha256 <code>{shortHash(entry.sha256)}</code>{' '}
          {entry.bytes.toLocaleString()} bytes{entry.fetched_at ? `, fetched ${entry.fetched_at}` : ''}
        </Typography>
      ))}
    </Stack>
  );
}

/**
 * The contract's declared cases, run one at a time through `run`; the browser run stops at the first failure. With a
 * saved tool, the server column runs every case against the pinned code.
 */
function TestsSection({
  tests,
  outcomes,
  running,
  disabled,
  onRun,
  server,
  browserData,
}: BrowserTestsProps & { server?: ServerTests }) {
  const failedAt = outcomes.findIndex(outcome => outcome.status !== 'passed');
  const serverData = server?.run?.results.flatMap(result =>
    result.outcome !== 'not_run' && result.stamp ? [result.stamp.data] : []
  )[0];
  const started = running || outcomes.length > 0;
  const statusOf = (index: number): keyof typeof TEST_STATUS => {
    if (index < outcomes.length) return outcomes[index].status;
    if (running && index === outcomes.length) return 'running';
    return 'not_run';
  };
  const serverCell = (name: string): { status: { label: string; color: string }; ms?: number } => {
    const result = resultFor(server?.run, name);
    if (server?.running && (!result || result.outcome === 'not_run')) return { status: TEST_STATUS.running };
    if (result)
      return { status: serverStatus(result), ms: result.outcome === 'not_run' ? undefined : result.durationMs };
    if (server?.running) return { status: TEST_STATUS.running };
    return { status: { label: '-', color: 'text.tertiary' } };
  };
  const serverFailures = server?.run?.results.filter(result => !result.passed && result.outcome !== 'not_run') ?? [];
  const notRun = server?.run?.notRun ?? 0;
  const failureDetails = failedAt >= 0 || serverFailures.length > 0;
  return (
    <Stack spacing={1} data-testid="python-function-tests">
      <Stack direction="row" spacing={2} alignItems="center" flexWrap="wrap" useFlexGap>
        <Typography level="title-sm">Tests</Typography>
        <Button
          size="sm"
          variant="outlined"
          color="neutral"
          data-testid="python-function-tests-run-btn"
          disabled={disabled}
          loading={running}
          onClick={onRun}
        >
          Run tests
        </Button>
        {server && (
          <Button
            size="sm"
            variant="outlined"
            color="neutral"
            data-testid="python-function-tests-server-run-btn"
            disabled={disabled || server.blocked !== null || server.running}
            loading={server.running}
            onClick={server.onRun}
          >
            Run tests on the server
          </Button>
        )}
      </Stack>
      {server?.blocked && (
        <Typography level="body-xs" sx={{ color: 'text.secondary' }} data-testid="python-function-tests-server-note">
          {server.blocked}
        </Typography>
      )}
      <Box sx={{ overflowX: 'auto' }} aria-live="polite" data-testid="python-function-test-results">
        <Table size="sm" borderAxis="xBetween" sx={{ tableLayout: 'auto' }}>
          <thead>
            <tr>
              <th>Test</th>
              <th>{server ? 'Browser' : 'Result'}</th>
              {server && <th>Server</th>}
            </tr>
          </thead>
          <tbody>
            {tests.map((test, index) => {
              const status = started ? TEST_STATUS[statusOf(index)] : { label: '-', color: 'text.tertiary' };
              return (
                <tr key={index} data-testid="python-function-test-row">
                  <td>{test.name}</td>
                  <td>
                    <StatusCell status={status} ms={outcomes[index]?.ms} testId="python-function-test-status" />
                  </td>
                  {server && (
                    <td>
                      <StatusCell {...serverCell(test.name)} testId="python-function-test-server-status" />
                    </td>
                  )}
                </tr>
              );
            })}
          </tbody>
        </Table>
      </Box>
      {server && notRun > 0 && (
        <Stack direction="row" spacing={2} alignItems="center" flexWrap="wrap" useFlexGap>
          <Typography
            level="body-sm"
            sx={{ color: 'text.secondary' }}
            data-testid="python-function-tests-server-not-run"
          >
            {notRun === 1 ? '1 test' : `${notRun} tests`} did not fit in the time for one server run.
          </Typography>
          <Button
            size="sm"
            variant="outlined"
            color="neutral"
            data-testid="python-function-tests-server-run-remaining-btn"
            disabled={disabled || server.blocked !== null || server.running}
            loading={server.running}
            onClick={server.onRunRemaining}
          >
            Run remaining on the server
          </Button>
        </Stack>
      )}
      {server?.error && (
        <Alert color="danger" variant="soft" data-testid="python-function-tests-server-error">
          <Typography level="body-sm">{server.error}</Typography>
        </Alert>
      )}
      {browserData && browserData.length > 0 && (
        <StampData label="Browser run read" data={browserData} testId="python-function-tests-browser-data" />
      )}
      {serverData && serverData.length > 0 && (
        <StampData label="Server run read" data={serverData} testId="python-function-tests-server-data" />
      )}
      {failureDetails && (
        <Box sx={{ display: 'grid', gap: 1, gridTemplateColumns: 'repeat(auto-fit, minmax(min(240px, 100%), 1fr))' }}>
          {failedAt >= 0 && (
            <Stack spacing={0.5} data-testid="python-function-test-browser-failures">
              {server && <Typography level="body-xs">Browser</Typography>}
              <TestFailure test={tests[failedAt]} outcome={outcomes[failedAt]} />
            </Stack>
          )}
          {serverFailures.length > 0 && (
            <Stack spacing={0.5} data-testid="python-function-test-server-failures">
              <Typography level="body-xs">Server</Typography>
              {tests.map((test, index) => {
                const result = resultFor(server?.run, test.name);
                return result ? <ServerTestFailure key={index} test={test} result={result} /> : null;
              })}
            </Stack>
          )}
        </Box>
      )}
    </Stack>
  );
}

/** Tests for the owner's artifact: the server column runs the saved tool when it pins this version. */
function SavedTestsSection({
  save,
  contract,
  ...browser
}: BrowserTestsProps & { save: PythonFunctionSave; contract: FunctionContract }) {
  const { data } = useArtifactCallableFunction(save.artifactId, save.version, contract.name);
  const saved = data?.saved ?? null;
  const serverRuntime = useCallableFunctionsServerRuntime();
  const runTests = useRunCallableFunctionTests();
  const [last, setLast] = useState<{ key: string; run?: CallableFunctionTestRun; error?: string } | null>(null);
  const key = saved ? `${saved.id}:${saved.pin.version}` : null;
  const blocked =
    save.blocked ??
    (!serverRuntime
      ? 'Server test runs are not set up here.'
      : !saved
        ? 'Save this version as a tool to run its tests on the server.'
        : saved.status === 'source_deleted'
          ? 'The artifact behind this tool was deleted.'
          : saved.status === 'disabled'
            ? 'Turn the tool on to run its tests on the server.'
            : saved.pin.version !== save.version
              ? `The server runs the saved version ${saved.pin.version}. Update the tool to test this version there.`
              : null);
  const shown = blocked === null && last && last.key === key ? last : null;
  const run = (earlier: CallableFunctionTestRun | null) => {
    if (blocked !== null || !saved || !key) return;
    const tests = earlier?.results.filter(result => result.outcome === 'not_run').map(result => result.name);
    runTests.mutate(
      { id: saved.id, ...(tests?.length ? { tests } : {}) },
      {
        onSuccess: next => setLast({ key, run: earlier ? mergeTestRuns(earlier, next) : next }),
        onError: error =>
          setLast({
            key,
            ...(earlier ? { run: earlier } : {}),
            error: callableFunctionErrorMessage(error, 'The tests could not run on the server.'),
          }),
      }
    );
  };
  const onRun = () => run(null);
  const onRunRemaining = () => run(shown?.run ?? null);
  return (
    <TestsSection
      {...browser}
      server={{
        blocked,
        running: blocked === null && runTests.isPending,
        run: shown?.run ?? null,
        error: shown?.error ?? null,
        onRun,
        onRunRemaining,
      }}
    />
  );
}

function savedStatusLines(saved: ICallableFunctionPublic): string[] {
  if (saved.status === 'source_deleted') return ['The artifact this tool was saved from was deleted.'];
  const pinned =
    saved.updateAvailable && saved.latestVersion !== null
      ? `A newer version is available. This tool is pinned to version ${saved.pin.version}, and the artifact is at version ${saved.latestVersion}.`
      : saved.state === 'live'
        ? `Live tool, pinned to version ${saved.pin.version}.`
        : `Saved as a draft tool, pinned to version ${saved.pin.version}.`;
  return saved.enabled ? [pinned] : ['This tool is turned off.', pinned];
}

const failureToast = (title: string) => (error: unknown) => {
  const reason = callableFunctionErrorMessage(error, '');
  toast.error(title, reason ? { description: reason } : undefined);
};

const DELETE_TITLE = 'Delete this tool?';

const FUNCTION_OFFER_CAP_LINE = `Chat and agent runs offer up to ${MAX_CALLABLE_FUNCTIONS_PER_TURN} of your live tools, oldest first.`;

// A function cannot write anywhere, so `default` already runs it without a card; `always_allow` would read the same.
type FunctionApproval = Extract<McpToolApprovalMode, 'default' | 'always_ask'>;
const FUNCTION_APPROVALS: readonly FunctionApproval[] = ['default', 'always_ask'];
const FUNCTION_APPROVAL_LABELS: Record<FunctionApproval, string> = {
  default: 'Run without asking',
  always_ask: 'Always ask',
};

/** Turn off or Turn on, and Delete, for one tool; `testIdPrefix` keeps the named tool's ids apart from the others'. */
function ToolControls({
  tool,
  testIdPrefix,
  onDelete,
}: {
  tool: ICallableFunctionPublic;
  testIdPrefix: string;
  onDelete: (tool: ICallableFunctionPublic) => void;
}) {
  const setEnabled = useSetCallableFunctionEnabled();
  const setApproval = useSetCallableFunctionApproval();
  // The button is disabled while loading, which drops focus to the page body; put it back once it settles.
  const enableRef = useRef<HTMLButtonElement>(null);
  const [refocus, setRefocus] = useState(false);
  useEffect(() => {
    if (!refocus || setEnabled.isPending) return;
    enableRef.current?.focus();
    setRefocus(false);
  }, [refocus, setEnabled.isPending]);

  return (
    <>
      {tool.status !== 'source_deleted' && (
        <Button
          ref={enableRef}
          size="sm"
          variant="outlined"
          color="neutral"
          loading={setEnabled.isPending}
          aria-label={`${tool.enabled ? 'Turn off' : 'Turn on'} ${tool.slug}`}
          data-testid={`${testIdPrefix}-enable-btn`}
          onClick={() =>
            setEnabled.mutate(
              { id: tool.id, enabled: !tool.enabled },
              {
                onError: failureToast(tool.enabled ? 'Could not turn off the tool.' : 'Could not turn on the tool.'),
                onSettled: () => setRefocus(true),
              }
            )
          }
        >
          {tool.enabled ? 'Turn off' : 'Turn on'}
        </Button>
      )}
      {tool.status !== 'source_deleted' && (
        <Select<FunctionApproval>
          size="sm"
          value={tool.approval === 'always_ask' ? 'always_ask' : 'default'}
          disabled={setApproval.isPending}
          onChange={(_, approval) =>
            approval &&
            approval !== tool.approval &&
            setApproval.mutate(
              { id: tool.id, approval },
              { onError: failureToast('Could not change when chat asks before a call.') }
            )
          }
          slotProps={{
            button: { 'aria-label': `When chat runs ${tool.slug}`, 'data-testid': `${testIdPrefix}-approval` },
          }}
          sx={{ minWidth: '170px' }}
        >
          {FUNCTION_APPROVALS.map(mode => (
            <Option key={mode} value={mode} data-testid={`${testIdPrefix}-approval-${mode}`}>
              {FUNCTION_APPROVAL_LABELS[mode]}
            </Option>
          ))}
        </Select>
      )}
      <Button
        size="sm"
        variant="outlined"
        color="danger"
        aria-label={`Delete ${tool.slug}`}
        data-testid={`${testIdPrefix}-delete-btn`}
        onClick={() => onDelete(tool)}
      >
        Delete
      </Button>
    </>
  );
}

const StatusLines = ({ tool }: { tool: ICallableFunctionPublic }) => (
  <>
    {savedStatusLines(tool).map(line => (
      <Typography level="body-sm" key={line}>
        {line}
      </Typography>
    ))}
  </>
);

type FocusWhen = 'saved' | 'repinned' | { deletedId: string };

interface Refusal {
  version: number;
  changes: FunctionContractChange[];
  unreadable: boolean;
  promotedSeq: number | null;
}

/**
 * Make this a tool, or the saved tool's status with Update, Turn off or Turn on, and Delete; then the artifact's
 * tools under other names, each with Turn off or Turn on, and Delete.
 */
function FunctionSaveSection({ save, contract }: { save: PythonFunctionSave; contract: FunctionContract }) {
  const { data, isLoading } = useArtifactCallableFunction(save.artifactId, save.version, contract.name);
  const saved = data?.saved ?? null;
  const others = data?.others ?? [];
  const repin = useRepinCallableFunction();
  const remove = useDeleteCallableFunction();
  const [dialogOpen, setDialogOpen] = useState(false);
  const [deleting, setDeleting] = useState<ICallableFunctionPublic | null>(null);
  const [refused, setRefused] = useState<Refusal | null>(null);
  const target = save.blocked === null ? save : null;
  // A save, delete, or update replaces the button that started it, so focus would fall back to the page body.
  const stateRef = useRef<HTMLDivElement>(null);
  const [focusWhen, setFocusWhen] = useState<FocusWhen | null>(null);

  useEffect(() => {
    if (focusWhen === null || isLoading || dialogOpen || deleting) return;
    const landed =
      focusWhen === 'saved'
        ? Boolean(saved)
        : focusWhen === 'repinned'
          ? saved?.updateAvailable === false
          : ![saved, ...others].some(tool => tool?.id === focusWhen.deletedId);
    if (!landed) return;
    stateRef.current?.querySelector('button')?.focus();
    setFocusWhen(null);
  }, [focusWhen, isLoading, dialogOpen, deleting, saved, others]);

  const renderOthers = () =>
    others.length > 0 && (
      <Stack spacing={1} sx={{ mt: 2 }} data-testid="python-function-other-tools">
        <Typography level="body-xs" sx={{ color: 'text.secondary' }}>
          Other tools saved from this artifact:
        </Typography>
        {others.map(tool => (
          <Stack key={tool.id} spacing={0.5} data-testid="python-function-other-tool">
            <Typography level="title-sm">
              <code>{tool.slug}</code>
            </Typography>
            <Box data-testid="python-function-other-tool-status">
              <StatusLines tool={tool} />
            </Box>
            <Stack direction="row" spacing={1} flexWrap="wrap" useFlexGap>
              <ToolControls tool={tool} testIdPrefix="python-function-other-tool" onDelete={setDeleting} />
            </Stack>
          </Stack>
        ))}
      </Stack>
    );

  const renderState = () => {
    if (isLoading) return null;
    if (!saved) {
      if (!target) {
        return (
          <Typography level="body-xs" sx={{ color: 'text.secondary' }} data-testid="python-function-save-blocked">
            {save.blocked}
          </Typography>
        );
      }
      return (
        <Box>
          <Button
            size="sm"
            variant="outlined"
            color="neutral"
            data-testid="python-function-save-btn"
            onClick={() => setDialogOpen(true)}
          >
            Make this a tool
          </Button>
        </Box>
      );
    }
    return (
      <Stack spacing={1}>
        <Box data-testid="python-function-saved-status">
          <StatusLines tool={saved} />
        </Box>
        <Stack direction="row" spacing={1} flexWrap="wrap" useFlexGap>
          {target && saved.updateAvailable && saved.latestVersion !== null && (
            <Button
              size="sm"
              variant="outlined"
              color="primary"
              loading={repin.isPending}
              data-testid="python-function-repin-btn"
              onClick={() =>
                repin.mutate(
                  { id: saved.id, expectedVersion: target.version, contract },
                  {
                    onSuccess: () => setFocusWhen('repinned'),
                    onError: error => {
                      const changes = callableFunctionBreakingChanges(error);
                      const unreadable = callableFunctionContractUnreadable(error);
                      if (changes.length > 0 || unreadable) {
                        setRefused({
                          version: target.version,
                          changes,
                          unreadable,
                          promotedSeq: callableFunctionBreakingSincePromotion(error),
                        });
                      } else failureToast('Could not update the tool.')(error);
                    },
                  }
                )
              }
            >
              Update to version {saved.latestVersion}
            </Button>
          )}
          <ToolControls key={saved.id} tool={saved} testIdPrefix="python-function" onDelete={setDeleting} />
        </Stack>
        {saved.status !== 'source_deleted' && (
          <Typography level="body-xs" textColor="text.tertiary" data-testid="python-function-offer-cap">
            {FUNCTION_OFFER_CAP_LINE}
          </Typography>
        )}
        {saved.status !== 'source_deleted' && (
          <Box sx={{ pt: 1 }}>
            <FunctionDataSection tool={saved} />
          </Box>
        )}
        {saved.status !== 'source_deleted' && (
          <Box sx={{ pt: 1 }}>
            <FunctionSourcesSection tool={saved} />
          </Box>
        )}
        {saved.status !== 'source_deleted' && (
          <Box sx={{ pt: 1 }}>
            <PromoteFunctionSection
              tool={saved}
              contract={contract}
              blocked={
                saved.status === 'disabled'
                  ? 'Turn the tool on to promote it.'
                  : saved.pin.version !== save.version
                    ? `Promotion runs the saved version ${saved.pin.version}. Update the tool to promote this version.`
                    : null
              }
            />
          </Box>
        )}
      </Stack>
    );
  };

  return (
    <>
      <Box ref={stateRef}>
        {renderState()}
        {!isLoading && renderOthers()}
      </Box>
      {/* Mounted apart from the state above, which turns into the saved status as soon as the save lands. */}
      {target && dialogOpen && (
        <SaveFunctionDialog
          open
          onClose={didSave => {
            setDialogOpen(false);
            if (didSave) setFocusWhen('saved');
          }}
          artifactId={target.artifactId}
          version={target.version}
          contract={contract}
        />
      )}
      {deleting && (
        <Modal open onClose={() => !remove.isPending && setDeleting(null)}>
          <ModalDialog
            variant="outlined"
            role="alertdialog"
            aria-label={DELETE_TITLE}
            data-testid="python-function-delete-dialog"
            sx={{ maxWidth: 500 }}
          >
            <ModalClose disabled={remove.isPending} />
            <Typography level="h4">{DELETE_TITLE}</Typography>
            <Divider sx={{ my: 2 }} />
            <Typography level="body-md">
              This deletes the tool <code>{deleting.slug}</code>. The artifact is not changed.
            </Typography>
            <Stack direction="row" spacing={1} sx={{ mt: 3, justifyContent: 'flex-end' }}>
              <Button
                variant="outlined"
                color="neutral"
                disabled={remove.isPending}
                data-testid="python-function-delete-cancel-btn"
                onClick={() => setDeleting(null)}
              >
                Cancel
              </Button>
              <Button
                variant="solid"
                color="danger"
                loading={remove.isPending}
                data-testid="python-function-delete-confirm-btn"
                onClick={() =>
                  remove.mutate(deleting.id, {
                    onSuccess: () => setFocusWhen({ deletedId: deleting.id }),
                    onError: failureToast('Could not delete the tool.'),
                    onSettled: () => setDeleting(null),
                  })
                }
              >
                Delete
              </Button>
            </Stack>
          </ModalDialog>
        </Modal>
      )}
      {saved && refused && (
        <BreakingChangeDialog
          onClose={() => {
            setRefused(null);
            // Update was disabled while loading, so the dialog would hand focus back to the page body.
            requestAnimationFrame(() =>
              stateRef.current?.querySelector<HTMLElement>('[data-testid="python-function-repin-btn"]')?.focus()
            );
          }}
          slug={saved.slug}
          pinnedVersion={saved.pin.version}
          version={refused.version}
          changes={refused.changes}
          unreadable={refused.unreadable}
          promotedSeq={refused.promotedSeq}
        />
      )}
    </>
  );
}

/**
 * The Python viewer's Function tab: reads the FUNCTION contract in the sandbox, offers a typed form, and calls
 * `run`. The contract and every returned value are checked here against the contract. The owner can save the
 * artifact's current version as a draft tool.
 */
const PythonFunctionPanel: React.FC<PythonFunctionPanelProps> = ({ code, packages, disabled, save }) => {
  const { callFunction } = usePyodide();
  const [described, setDescribed] = useState<Described>({ status: 'reading' });
  const [values, setValues] = useState<FormValues>({});
  const [calling, setCalling] = useState(false);
  const [outcome, setOutcome] = useState<CallOutcome | null>(null);
  const [testing, setTesting] = useState(false);
  const [testOutcomes, setTestOutcomes] = useState<TestOutcome[]>([]);
  const describedCode = useRef<string | null>(null);
  const describeRequest = useRef(0);
  const { data: savedTools } = useArtifactCallableFunction(
    save?.artifactId ?? null,
    save?.version ?? 0,
    described.status === 'ready' ? described.contract.name : ''
  );
  const savedTool = savedTools?.saved;
  const savedData = savedTool && (savedTool.dataPins?.length || savedTool.sources?.length) ? savedTool : null;
  const [browserStamp, setBrowserStamp] = useState<BrowserStamp | null>(null);
  // The saved tool's pinned files and sources, each checked against its hash, so a browser run reads what the
  // server run reads and stamps it the same way.
  const loadDataFiles = async (): Promise<{
    files: { name: string; bytes: ArrayBuffer }[];
    data: CallableFunctionStampData[];
  }> => {
    if (!savedData) return { files: [], data: [] };
    const pins = savedData.dataPins ?? [];
    const [pinned, sources] = await Promise.all([
      fetchCallableFunctionDataFiles(savedData.id, pins),
      fetchCallableFunctionSources(savedData.id, savedData.sources ?? []),
    ]);
    return {
      files: [...pinned, ...sources.map(({ name, bytes }) => ({ name, bytes }))],
      data: [
        ...pins.map(({ name, sha256, bytes }): CallableFunctionStampData => ({ name, mode: 'pinned', sha256, bytes })),
        ...sources.map(source => source.entry),
      ],
    };
  };

  const describe = useCallback(
    async (source: string, sourcePackages: string[]) => {
      describedCode.current = source;
      const request = ++describeRequest.current;
      setDescribed({ status: 'reading' });
      setOutcome(null);
      setTestOutcomes([]);
      try {
        const result = await callFunction(source, null, sourcePackages);
        if (request !== describeRequest.current) return;
        if (!result.success) {
          setDescribed({ status: 'failed', error: result.error ?? '', output: result.output });
          return;
        }
        const parsed = parseFunctionContract(result.contract);
        if (!parsed.ok) {
          setDescribed({ status: 'invalid', problems: parsed.problems });
          return;
        }
        setValues(previous => initialValues(parsed.contract.inputs, previous));
        setDescribed({ status: 'ready', contract: parsed.contract, code: source });
      } catch (error) {
        if (request !== describeRequest.current) return;
        // The sandbox was busy or failed to start; read again once it is free.
        describedCode.current = null;
        const message = errorMessage(error);
        setDescribed(
          message === PYTHON_SCRIPT_BUSY ? { status: 'reading' } : { status: 'failed', error: message, output: '' }
        );
      }
    },
    [callFunction]
  );

  // Waits for the sandbox to be free, and reads each version of the code once.
  useEffect(() => {
    if (disabled || describedCode.current === code) return;
    const timer = setTimeout(() => void describe(code, packages), DESCRIBE_DEBOUNCE_MS);
    return () => clearTimeout(timer);
  }, [code, packages, disabled, describe]);

  // Called with the code the contract was read from; the controls are held while a newer edit waits to be read.
  const handleCall = async (contract: FunctionContract, source: string) => {
    const { params, problems } = buildParams(contract.inputs, values);
    if (problems.length > 0) {
      setOutcome({ status: 'inputs', problems });
      return;
    }
    setCalling(true);
    setOutcome(null);
    try {
      const result = await callFunction(source, params, packages, (await loadDataFiles()).files);
      if (!result.success) {
        setOutcome({
          status: 'failed',
          error: result.error ?? 'The call failed.',
          output: result.output,
          executionTime: result.executionTime,
        });
        return;
      }
      setOutcome({
        status: 'returned',
        value: isRecord(result.value) ? result.value : {},
        problems: outputProblems(contract.outputs, result.value, result.outputProblems ?? []),
        output: result.output,
        executionTime: result.executionTime,
      });
    } catch (error) {
      setOutcome({ status: 'failed', error: errorMessage(error), output: '', executionTime: 0 });
    } finally {
      setCalling(false);
    }
  };

  const runTest = async (
    contract: FunctionContract,
    source: string,
    test: FunctionTestCase,
    files: { name: string; bytes: ArrayBuffer }[]
  ): Promise<TestOutcome> => {
    try {
      const result = await callFunction(source, test.input, packages, files);
      const ms = result.executionTime;
      if (!result.success) return { status: 'failed', error: result.error ?? 'The call failed.', ms };
      const problems = outputProblems(contract.outputs, result.value, result.outputProblems ?? []);
      if (problems.length > 0) return { status: 'invalid', problems, ms };
      const mismatch = compareFunctionOutput(test.expected, result.value, test.tolerance);
      return mismatch ? { status: 'mismatch', mismatch, ms } : { status: 'passed', ms };
    } catch (error) {
      return { status: 'failed', error: errorMessage(error) };
    }
  };

  const handleRunTests = async (contract: FunctionContract, source: string) => {
    const request = describeRequest.current;
    setTesting(true);
    setTestOutcomes([]);
    setOutcome(null);
    const outcomes: TestOutcome[] = [];
    setBrowserStamp(null);
    try {
      let loaded: Awaited<ReturnType<typeof loadDataFiles>>;
      try {
        loaded = await loadDataFiles();
      } catch (error) {
        setTestOutcomes([{ status: 'failed', error: errorMessage(error) }]);
        return;
      }
      const { files } = loaded;
      setBrowserStamp({ runtime: { kind: 'pyodide-browser', version: PYODIDE_VERSION }, data: loaded.data });
      for (const test of contract.tests ?? []) {
        // Each case gets its own copies: a call transfers its buffers to the sandbox.
        const caseFiles = files.map(file => ({ name: file.name, bytes: file.bytes.slice(0) }));
        const next = await runTest(contract, source, test, caseFiles);
        // A newer read of the code replaced this contract; its results would describe other code.
        if (request !== describeRequest.current) return;
        outcomes.push(next);
        setTestOutcomes([...outcomes]);
        if (next.status !== 'passed') return;
      }
    } finally {
      setTesting(false);
    }
  };

  const renderBody = () => {
    switch (described.status) {
      case 'reading':
        return (
          <Stack direction="row" spacing={1} alignItems="center" sx={{ color: 'text.secondary' }}>
            <CircularProgress size="sm" />
            <Typography level="body-sm" data-testid="python-function-status">
              Reading the function contract
            </Typography>
          </Stack>
        );
      case 'failed':
        return described.error === NO_CONTRACT_ERROR ? (
          <Typography level="body-sm" data-testid="python-function-status">
            This artifact needs a {FUNCTION_CONTRACT_GLOBAL} contract and a {FUNCTION_ENTRY_POINT} function to be
            called.
          </Typography>
        ) : (
          <FailureBlock error={described.error} output={described.output} />
        );
      case 'invalid':
        return <ProblemList heading="The function contract has problems:" problems={described.problems} />;
      case 'ready': {
        const { contract } = described;
        const current = described.code === code;
        const controlsDisabled = disabled || calling || testing || !current;
        return (
          <Stack spacing={2}>
            <Box>
              <Typography level="title-md" sx={{ fontFamily: 'monospace' }}>
                {contract.name}
              </Typography>
              <Typography level="body-sm">{contract.description}</Typography>
            </Box>
            {/* The contract belongs to the code it was read from; saving waits until the new code is read. */}
            {save && current && (
              <>
                <FunctionSaveSection save={save} contract={contract} />
                <Divider />
              </>
            )}

            <Box>
              <Typography level="title-sm" sx={{ mb: 0.5 }}>
                Inputs
              </Typography>
              <ContractTable schema={contract.inputs} testId="python-function-contract-inputs" />
            </Box>
            <Box>
              <Typography level="title-sm" sx={{ mb: 0.5 }}>
                Outputs
              </Typography>
              <ContractTable schema={contract.outputs} testId="python-function-contract-outputs" />
            </Box>
            {contract.tests &&
              contract.tests.length > 0 &&
              (save && current ? (
                <SavedTestsSection
                  save={save}
                  contract={contract}
                  tests={contract.tests}
                  outcomes={testOutcomes}
                  running={testing}
                  disabled={controlsDisabled}
                  onRun={() => void handleRunTests(contract, described.code)}
                  browserData={browserStamp?.data ?? null}
                />
              ) : (
                <TestsSection
                  tests={contract.tests}
                  outcomes={testOutcomes}
                  running={testing}
                  disabled={controlsDisabled}
                  onRun={() => void handleRunTests(contract, described.code)}
                  browserData={browserStamp?.data ?? null}
                />
              ))}

            <Box
              sx={{
                display: 'grid',
                gridTemplateColumns: 'repeat(auto-fill, minmax(min(220px, 100%), 1fr))',
                gap: 1.5,
              }}
            >
              {Object.entries(contract.inputs.properties).map(([name, field]) => (
                <FormControl key={name} size="sm">
                  {field.type !== 'boolean' && <FormLabel sx={{ fontFamily: 'monospace' }}>{name}</FormLabel>}
                  <FieldControl
                    name={name}
                    field={field}
                    value={ownValue(values, name)}
                    disabled={controlsDisabled}
                    onChange={next => setValues(previous => ({ ...previous, [name]: next }))}
                  />
                  {field.description && <FormHelperText>{field.description}</FormHelperText>}
                </FormControl>
              ))}
            </Box>

            <Stack direction="row" spacing={2} alignItems="center" flexWrap="wrap" useFlexGap>
              <Button
                size="sm"
                data-testid="python-function-call-btn"
                disabled={controlsDisabled}
                loading={calling}
                onClick={() => void handleCall(contract, described.code)}
              >
                Call function
              </Button>
              <Typography level="body-xs" sx={{ color: 'text.secondary' }}>
                Calls run in your browser. They are not saved and do not appear in the call log.
              </Typography>
            </Stack>

            {outcome?.status === 'inputs' && (
              <ProblemList heading="These inputs do not match the contract:" problems={outcome.problems} />
            )}
            {outcome?.status === 'failed' && <FailureBlock error={outcome.error} output={outcome.output} />}
            {outcome?.status === 'returned' && (
              <Stack spacing={1}>
                <Typography level="title-sm">Result</Typography>
                {outcome.problems.length > 0 ? (
                  <ProblemList
                    heading="The function returned values that do not match the contract:"
                    problems={outcome.problems}
                  />
                ) : (
                  <ResultTable outputs={contract.outputs} value={outcome.value} />
                )}
                <Typography level="body-xs" sx={{ color: 'text.tertiary' }}>
                  Ran in {Math.round(outcome.executionTime)} ms.
                </Typography>
                <PrintedOutput output={outcome.output} />
              </Stack>
            )}
          </Stack>
        );
      }
    }
  };

  return (
    <Box data-testid="python-function-panel" sx={{ position: 'absolute', inset: 0, overflow: 'auto', p: 2 }}>
      {renderBody()}
    </Box>
  );
};

export default PythonFunctionPanel;

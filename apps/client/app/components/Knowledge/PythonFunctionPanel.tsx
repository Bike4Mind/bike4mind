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
  DIMENSIONLESS_UNIT,
  FUNCTION_CONTRACT_GLOBAL,
  FUNCTION_CONTRACT_LIMITS,
  FUNCTION_ENTRY_POINT,
  capFunctionProblems,
  parseFunctionContract,
  validateFunctionValue,
  type FunctionContract,
  type FunctionContractProblem,
  type FunctionField,
  type FunctionObjectField,
  type ICallableFunctionPublic,
} from '@bike4mind/common';
import { toast } from 'sonner';
import {
  callableFunctionErrorMessage,
  useArtifactCallableFunction,
  useDeleteCallableFunction,
  useRepinCallableFunction,
  useSetCallableFunctionEnabled,
} from '@client/app/hooks/data/callableFunctions';
import { usePyodide } from '@client/app/hooks/usePyodide';
import { PYTHON_SCRIPT_BUSY } from '@client/app/utils/pyodideManager';
import ProblemList, { dangerAlertSx } from './FunctionProblemList';
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

type FormValues = Record<string, string | boolean>;

const errorMessage = (error: unknown): string => (error instanceof Error ? error.message : String(error));

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

/** "a", "a or b", "a, b, or c". */
const listWithOr = (items: string[]): string =>
  items.length < 3 ? items.join(' or ') : `${items.slice(0, -1).join(', ')}, or ${items[items.length - 1]}`;

const unitLabel = (field: FunctionField): string =>
  field.type === 'number' || field.type === 'integer' ? (field.unit === DIMENSIONLESS_UNIT ? 'none' : field.unit) : '-';

const TYPE_LABELS: Record<FunctionField['type'], string> = {
  number: 'Number',
  integer: 'Whole number',
  string: 'Text',
  boolean: 'True or false',
  array: 'List',
  object: 'Group',
};

const typeLabel = (field: FunctionField): string =>
  field.type === 'string' && field.enum ? 'Choice' : TYPE_LABELS[field.type];

function rangeLabel(field: FunctionField): string {
  switch (field.type) {
    case 'number':
    case 'integer': {
      if (field.enum) return `one of ${listWithOr(field.enum.map(String))}`;
      const lower =
        field.exclusiveMinimum !== undefined
          ? `greater than ${field.exclusiveMinimum}`
          : field.minimum !== undefined
            ? `at least ${field.minimum}`
            : null;
      const upper =
        field.exclusiveMaximum !== undefined
          ? `less than ${field.exclusiveMaximum}`
          : field.maximum !== undefined
            ? `at most ${field.maximum}`
            : null;
      return [lower, upper].filter(Boolean).join(' and ') || 'any';
    }
    case 'string':
      return field.enum
        ? `one of ${listWithOr(field.enum)}`
        : `up to ${field.maxLength ?? FUNCTION_CONTRACT_LIMITS.maxStringLength} characters`;
    case 'array':
      if (field.minItems !== undefined && field.maxItems !== undefined) {
        return `${field.minItems} to ${field.maxItems} items`;
      }
      if (field.minItems !== undefined) return `at least ${field.minItems} items`;
      if (field.maxItems !== undefined) return `at most ${field.maxItems} items`;
      return 'any';
    default:
      return '-';
  }
}

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
      const parsed = Number(text);
      // Text that is not a number is passed through so the contract check names the field.
      entries.push([name, Number.isNaN(parsed) ? text : parsed]);
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

const ContractTable = ({ schema, testId }: { schema: FunctionObjectField; testId: string }) => {
  const required = new Set(schema.required ?? []);
  return (
    <Box sx={{ overflowX: 'auto' }}>
      <Table
        size="sm"
        borderAxis="xBetween"
        data-testid={testId}
        sx={{ tableLayout: 'auto', '& th': { whiteSpace: 'nowrap' } }}
      >
        <thead>
          <tr>
            <th>Name</th>
            <th>Type</th>
            <th>Unit</th>
            <th>Range</th>
            <th>Required</th>
          </tr>
        </thead>
        <tbody>
          {Object.entries(schema.properties).map(([name, field]) => (
            <tr key={name}>
              <td>
                <code>{name}</code>
              </td>
              <td>{typeLabel(field)}</td>
              <td>{unitLabel(field)}</td>
              <td>{rangeLabel(field)}</td>
              <td>{required.has(name) ? 'Yes' : 'No'}</td>
            </tr>
          ))}
        </tbody>
      </Table>
    </Box>
  );
};

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

function savedStatusLines(saved: ICallableFunctionPublic): string[] {
  if (saved.status === 'source_deleted') return ['The artifact this tool was saved from was deleted.'];
  const pinned =
    saved.updateAvailable && saved.latestVersion !== null
      ? `A newer version is available. This tool is pinned to version ${saved.pin.version}, and the artifact is at version ${saved.latestVersion}.`
      : `Saved as a draft tool, pinned to version ${saved.pin.version}.`;
  return saved.enabled ? [pinned] : ['This tool is turned off.', pinned];
}

const failureToast = (title: string) => (error: unknown) => {
  const reason = callableFunctionErrorMessage(error, '');
  toast.error(title, reason ? { description: reason } : undefined);
};

/** Make this a tool, or the saved tool's status with Update, Turn off or Turn on, and Delete. */
function FunctionSaveSection({ save, contract }: { save: PythonFunctionSave; contract: FunctionContract }) {
  const { data: saved, isLoading } = useArtifactCallableFunction(save.artifactId, save.version);
  const repin = useRepinCallableFunction();
  const setEnabled = useSetCallableFunctionEnabled();
  const remove = useDeleteCallableFunction();
  const [dialogOpen, setDialogOpen] = useState(false);
  const [confirmingDelete, setConfirmingDelete] = useState(false);
  const target = save.blocked === null ? save : null;
  // A save, delete, or update replaces the button that started it, so focus would fall back to the page body.
  const stateRef = useRef<HTMLDivElement>(null);
  const [focusWhen, setFocusWhen] = useState<'saved' | 'unsaved' | 'repinned' | null>(null);

  useEffect(() => {
    if (focusWhen === null || isLoading || dialogOpen || confirmingDelete) return;
    const landed =
      focusWhen === 'unsaved' ? !saved : focusWhen === 'saved' ? Boolean(saved) : saved?.updateAvailable === false;
    if (!landed) return;
    stateRef.current?.querySelector('button')?.focus();
    setFocusWhen(null);
  }, [focusWhen, isLoading, dialogOpen, confirmingDelete, saved]);

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
          {savedStatusLines(saved).map(line => (
            <Typography level="body-sm" key={line}>
              {line}
            </Typography>
          ))}
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
                  { onSuccess: () => setFocusWhen('repinned'), onError: failureToast('Could not update the tool.') }
                )
              }
            >
              Update to version {saved.latestVersion}
            </Button>
          )}
          {saved.status !== 'source_deleted' && (
            <Button
              size="sm"
              variant="outlined"
              color="neutral"
              loading={setEnabled.isPending}
              data-testid="python-function-enable-btn"
              onClick={() =>
                setEnabled.mutate(
                  { id: saved.id, enabled: !saved.enabled },
                  {
                    onError: failureToast(
                      saved.enabled ? 'Could not turn off the tool.' : 'Could not turn on the tool.'
                    ),
                  }
                )
              }
            >
              {saved.enabled ? 'Turn off' : 'Turn on'}
            </Button>
          )}
          <Button
            size="sm"
            variant="outlined"
            color="danger"
            data-testid="python-function-delete-btn"
            onClick={() => setConfirmingDelete(true)}
          >
            Delete
          </Button>
        </Stack>
      </Stack>
    );
  };

  return (
    <>
      <Box ref={stateRef}>{renderState()}</Box>
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
      {saved && (
        <Modal open={confirmingDelete} onClose={() => !remove.isPending && setConfirmingDelete(false)}>
          <ModalDialog
            variant="outlined"
            role="alertdialog"
            data-testid="python-function-delete-dialog"
            sx={{ maxWidth: 500 }}
          >
            <ModalClose disabled={remove.isPending} />
            <Typography level="h4">Delete this tool?</Typography>
            <Divider sx={{ my: 2 }} />
            <Typography level="body-md">
              This deletes the tool <code>{saved.slug}</code>. The artifact is not changed.
            </Typography>
            <Stack direction="row" spacing={1} sx={{ mt: 3, justifyContent: 'flex-end' }}>
              <Button
                variant="outlined"
                color="neutral"
                disabled={remove.isPending}
                data-testid="python-function-delete-cancel-btn"
                onClick={() => setConfirmingDelete(false)}
              >
                Cancel
              </Button>
              <Button
                variant="solid"
                color="danger"
                loading={remove.isPending}
                data-testid="python-function-delete-confirm-btn"
                onClick={() =>
                  remove.mutate(saved.id, {
                    onSuccess: () => setFocusWhen('unsaved'),
                    onError: failureToast('Could not delete the tool.'),
                    onSettled: () => setConfirmingDelete(false),
                  })
                }
              >
                Delete
              </Button>
            </Stack>
          </ModalDialog>
        </Modal>
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
  const describedCode = useRef<string | null>(null);
  const describeRequest = useRef(0);

  const describe = useCallback(
    async (source: string, sourcePackages: string[]) => {
      describedCode.current = source;
      const request = ++describeRequest.current;
      setDescribed({ status: 'reading' });
      setOutcome(null);
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

  const handleCall = async (contract: FunctionContract) => {
    const { params, problems } = buildParams(contract.inputs, values);
    if (problems.length > 0) {
      setOutcome({ status: 'inputs', problems });
      return;
    }
    setCalling(true);
    setOutcome(null);
    try {
      const result = await callFunction(code, params, packages);
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
        const controlsDisabled = disabled || calling;
        return (
          <Stack spacing={2}>
            <Box>
              <Typography level="title-md" sx={{ fontFamily: 'monospace' }}>
                {contract.name}
              </Typography>
              <Typography level="body-sm">{contract.description}</Typography>
            </Box>
            {/* The contract belongs to the code it was read from; saving waits until the new code is read. */}
            {save && described.code === code && (
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
                onClick={() => void handleCall(contract)}
              >
                Call function
              </Button>
              <Typography level="body-xs" sx={{ color: 'text.secondary' }}>
                Calls run in your browser. Call results are not saved.
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

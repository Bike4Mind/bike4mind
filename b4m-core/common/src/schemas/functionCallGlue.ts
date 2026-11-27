import { FUNCTION_CONTRACT_LIMITS } from './functionContract';

/** The Pyodide release both runtimes load: the browser sandbox from its CDN, the server runtime from local disk. */
export const PYODIDE_VERSION = '0.25.1';

/** Every form of the glue's refusal for a result over its cap starts with this. */
export const FUNCTION_RESULT_TOO_LARGE_PREFIX = 'The function returned a result larger than';

const KIB = 1024;
const MIB = 1024 * 1024;

const sizeLabel = (bytes: number): string =>
  bytes % MIB === 0 ? `${bytes / MIB} MB` : bytes % KIB === 0 ? `${bytes / KIB} KB` : `${bytes} bytes`;

export const functionResultTooLargeMessage = (maxResultBytes: number): string =>
  `${FUNCTION_RESULT_TOO_LARGE_PREFIX} ${sizeLabel(maxResultBytes)}.`;

/** The browser's refusal, at `FUNCTION_CONTRACT_LIMITS.maxResultBytes`. */
export const FUNCTION_RESULT_TOO_LARGE_MESSAGE = functionResultTooLargeMessage(FUNCTION_CONTRACT_LIMITS.maxResultBytes);

/**
 * The Python that loads function code as module `b4m_function`, reads FUNCTION and, given params, calls
 * `run(**params)`, with the number type refusals and a result cap. It expects the globals `_fn_code` and
 * `_fn_params_json` and evaluates to a dict of strings.
 */
export function functionCallGluePy(maxResultBytes: number): string {
  // The cap is written into Python source.
  if (!Number.isSafeInteger(maxResultBytes) || maxResultBytes <= 0) {
    throw new RangeError('maxResultBytes must be a positive whole number');
  }
  return `
import sys
import json
import inspect
import traceback
from io import StringIO

_MAX_OUTPUT_CHARS = 100000
_MAX_CONTRACT_BYTES = ${FUNCTION_CONTRACT_LIMITS.maxContractBytes}
_MAX_RESULT_BYTES = ${maxResultBytes}
_MAX_PROBLEMS = ${FUNCTION_CONTRACT_LIMITS.maxProblems}

class _FunctionCallError(Exception):
    pass

# JSON turns 3.0 into 3 and True into true, so number types are checked while Python still knows them.
def _output_type_problems(field, value, path, problems):
    if len(problems) > _MAX_PROBLEMS or not isinstance(field, dict):
        return
    kind = field.get('type')
    if kind in ('number', 'integer'):
        if isinstance(value, bool) or not isinstance(value, (int, float)):
            problems.append({'path': path, 'message': 'must be a number'})
        elif kind == 'integer' and not isinstance(value, int):
            problems.append({'path': path, 'message': 'must be a whole number'})
    elif kind == 'array' and isinstance(value, (list, tuple)):
        for index, item in enumerate(value):
            _output_type_problems(field.get('items'), item, path + '.' + str(index) if path else str(index), problems)
    elif kind == 'object' and isinstance(value, dict) and isinstance(field.get('properties'), dict):
        for name, item in value.items():
            if isinstance(name, str) and name in field['properties']:
                _output_type_problems(field['properties'][name], item, path + '.' + name if path else name, problems)

# The class name as traceback prints it, taken from the exception's type so a message cannot change it.
def _error_class(e):
    try:
        kind = type(e)
        name = kind.__qualname__ if kind.__module__ in ('builtins', '__main__') else kind.__module__ + '.' + kind.__qualname__
        return str(name)[:100]
    except Exception:
        return 'Exception'

def _b4m_call_function(code, params_json):
    stdout = StringIO()
    stderr = StringIO()
    original_stdout = sys.stdout
    original_stderr = sys.stderr
    sys.stdout = stdout
    sys.stderr = stderr
    contract_json = None
    value_json = None
    output_problems = []
    error = None
    error_class = None
    try:
        namespace = {'__name__': 'b4m_function'}
        exec(compile(code, 'function.py', 'exec'), namespace)
        contract = namespace.get('FUNCTION')
        if contract is None:
            raise _FunctionCallError('FUNCTION is not defined')
        try:
            contract_text = json.dumps(contract, allow_nan=False)
        except (TypeError, ValueError) as e:
            raise _FunctionCallError('FUNCTION is not valid JSON: ' + str(e))
        if len(contract_text) > _MAX_CONTRACT_BYTES:
            raise _FunctionCallError('The function contract is larger than ${sizeLabel(FUNCTION_CONTRACT_LIMITS.maxContractBytes)}.')
        contract_json = contract_text
        if params_json is not None:
            run = namespace.get('run')
            if not callable(run):
                raise _FunctionCallError('run is not defined as a function')
            if inspect.iscoroutinefunction(run):
                raise _FunctionCallError('run must be defined with def, not async def')
            value = run(**json.loads(params_json))
            if not isinstance(value, dict):
                raise _FunctionCallError('run must return a dict')
            try:
                value_text = json.dumps(value, allow_nan=False)
            except (TypeError, ValueError) as e:
                raise _FunctionCallError('run returned a value that is not valid JSON: ' + str(e))
            if len(value_text) > _MAX_RESULT_BYTES:
                raise _FunctionCallError('${functionResultTooLargeMessage(maxResultBytes)}')
            value_json = value_text
            _output_type_problems(contract.get('outputs'), value, '', output_problems)
    except _FunctionCallError as e:
        error = str(e)
    except BaseException as e:
        error = traceback.format_exc()
        error_class = _error_class(e)
    finally:
        sys.stdout = original_stdout
        sys.stderr = original_stderr
    return {
        'contract_json': contract_json,
        'value_json': value_json,
        'output_problems_json': json.dumps(output_problems) if output_problems else None,
        'stdout': stdout.getvalue()[:_MAX_OUTPUT_CHARS],
        'stderr': stderr.getvalue()[:_MAX_OUTPUT_CHARS],
        'error': None if error is None else error[:_MAX_OUTPUT_CHARS],
        'error_class': error_class,
    }

_b4m_call_function(_fn_code, _fn_params_json)
`;
}

/**
 * The glue at the browser's cap. The browser worker cannot import this (it is serialized with
 * `Function.prototype.toString()`), so `sandboxWorkerBody.test.ts` checks that its copy is this text.
 */
export const FUNCTION_CALL_GLUE_PY = functionCallGluePy(FUNCTION_CONTRACT_LIMITS.maxResultBytes);

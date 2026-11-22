/** The Pyodide release both runtimes load: the browser sandbox from its CDN, the server runtime from local disk. */
export const PYODIDE_VERSION = '0.25.1';

/** The glue's fixed refusal for a result over `FUNCTION_CONTRACT_LIMITS.maxResultBytes`. */
export const FUNCTION_RESULT_TOO_LARGE_MESSAGE = 'The function returned a result larger than 256 KB.';

/**
 * The Python that loads function code as module `b4m_function`, reads FUNCTION and, given params, calls
 * `run(**params)`, with the number type refusals. It expects the globals `_fn_code` and `_fn_params_json`
 * and evaluates to a dict of strings. The browser worker cannot import this (it is serialized with
 * `Function.prototype.toString()`), so `sandboxWorkerBody.test.ts` checks that its copy is this text.
 */
export const FUNCTION_CALL_GLUE_PY = `
import sys
import json
import inspect
import traceback
from io import StringIO

_MAX_OUTPUT_CHARS = 100000
_MAX_CONTRACT_BYTES = 32768
_MAX_RESULT_BYTES = 262144
_MAX_PROBLEMS = 50

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
    elif kind == 'array' and isinstance(value, list):
        for index, item in enumerate(value):
            _output_type_problems(field.get('items'), item, path + '.' + str(index) if path else str(index), problems)
    elif kind == 'object' and isinstance(value, dict) and isinstance(field.get('properties'), dict):
        for name, item in value.items():
            if isinstance(name, str) and name in field['properties']:
                _output_type_problems(field['properties'][name], item, path + '.' + name if path else name, problems)

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
            raise _FunctionCallError('The function contract is larger than 32 KB.')
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
                raise _FunctionCallError('${FUNCTION_RESULT_TOO_LARGE_MESSAGE}')
            value_json = value_text
            _output_type_problems(contract.get('outputs'), value, '', output_problems)
    except _FunctionCallError as e:
        error = str(e)
    except Exception:
        error = traceback.format_exc()
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
    }

_b4m_call_function(_fn_code, _fn_params_json)
`;

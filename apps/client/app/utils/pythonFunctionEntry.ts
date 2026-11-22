const FUNCTION_CONTRACT_LINE = /^FUNCTION\s*=/m;
const RUN_DEFINITION_LINE = /^(async\s+)?def\s+run\s*\(/m;

/**
 * Whether Python code looks like a callable function: a column-0 `FUNCTION =` assignment and a
 * column-0 `def run(`. Decides only whether the Function tab is shown; the sandbox is the authority.
 */
export function hasFunctionEntryPoint(code: string): boolean {
  return FUNCTION_CONTRACT_LINE.test(code) && RUN_DEFINITION_LINE.test(code);
}

import { FUNCTION_CONTRACT_GLOBAL, FUNCTION_ENTRY_POINT } from '@bike4mind/common';

const FUNCTION_CONTRACT_LINE = new RegExp(`^${FUNCTION_CONTRACT_GLOBAL}\\s*=`, 'm');
const RUN_DEFINITION_LINE = new RegExp(`^(async\\s+)?def\\s+${FUNCTION_ENTRY_POINT}\\s*\\(`, 'm');

/**
 * Whether Python code looks like a callable function: a column-0 `FUNCTION =` assignment and a
 * column-0 `def run(`. Decides only whether the Function tab is shown; the sandbox is the authority.
 */
export function hasFunctionEntryPoint(code: string): boolean {
  return FUNCTION_CONTRACT_LINE.test(code) && RUN_DEFINITION_LINE.test(code);
}

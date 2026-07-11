import { setToolFinishObserver } from '@bike4mind/services';
import { stampGear, type StampedGearKey } from './stampGear';

/**
 * Gears - registers the host's tool-finish observer on the shared tool pipeline
 * (see setToolFinishObserver in b4m-core sharedToolBuilder). Fire-and-forget by
 * contract: sync call, never awaited, exceptions swallowed core-side, and
 * stampGear is a non-blocking upsert - zero latency added to any tool call.
 * Idempotent registration: safe to call from every lambda entry family.
 */
const TOOL_GEAR_STAMPS: Record<string, StampedGearKey> = {
  web_search: 'websearch',
  web_fetch: 'webfetch',
  wolfram_alpha: 'wolfram',
  math_evaluate: 'matheval',
};

let registered = false;

export function registerToolGearObserver(): void {
  if (registered) return;
  registered = true;
  try {
    // Try/caught: a partially-mocked @bike4mind/services throws on a missing
    // export, and a missing seam must never break a lambda. Named import (not
    // `import *`): the namespace form trips this package's restricted-exports lint.
    setToolFinishObserver(({ toolName, userId }) => {
      const key = TOOL_GEAR_STAMPS[toolName];
      if (key) stampGear(userId, key);
    });
  } catch {
    // mocked or older services build without the seam - gears just don't stamp
  }
}

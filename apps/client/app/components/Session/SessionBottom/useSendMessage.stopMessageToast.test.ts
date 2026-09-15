import { describe, it, expect } from 'vitest';
import { readFileSync } from 'fs';
import { resolve } from 'path';

/**
 * Regression guard: handleStopMessage must not fire a success toast on cancel.
 *
 * The bottom-right global Toaster (apps/client/app/providers.tsx) is fixed to the
 * viewport, not scoped to the chat panel. On narrow layouts - e.g. chat docked to
 * the right - a bottom-right toast can cover the entire prompt input area. The
 * inline chatCompletion.statusMessage already surfaces "Generation cancelled by
 * user" next to the composer, so the success toast was redundant as well as
 * blocking. Only the error path should still toast, since there is no inline
 * error surface for a failed cancel.
 *
 * A source-level assertion is used (rather than a full renderHook) because
 * useSendMessage consumes ~15 context providers; this mirrors the existing
 * useSendMessage.killSwitch.test.ts pattern.
 */
describe('useSendMessage - handleStopMessage toast (regression)', () => {
  const source = readFileSync(resolve(__dirname, 'useSendMessage.ts'), 'utf8');
  const handleStopMessageMatch = source.match(/const handleStopMessage[\s\S]*?\n {2}\};/);

  it('locates handleStopMessage in the source', () => {
    expect(handleStopMessageMatch).not.toBeNull();
  });

  const handleStopMessageSource = handleStopMessageMatch?.[0] ?? '';

  it('does not toast a success message on successful cancellation', () => {
    expect(handleStopMessageSource).not.toMatch(/toast\.success\(/);
  });

  it('still toasts on a failed cancellation (no inline error surface exists)', () => {
    expect(handleStopMessageSource).toContain("toast.error('Error cancelling generation')");
  });
});

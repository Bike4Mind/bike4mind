import { describe, it, expect, vi } from 'vitest';
import { navigateViewTool } from './index';

const makeContext = (isAdmin: boolean) =>
  ({
    logger: { log: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
    user: { isAdmin },
    // eslint-disable-next-line @typescript-eslint/no-explicit-any -- minimal tool context for this unit test
  }) as any;

describe('navigate_view tool', () => {
  it('is flagged to end the turn once the answer text has streamed', () => {
    expect(navigateViewTool.implementation(makeContext(true), {}).endsTurnAfterText).toBe(true);
  });

  it('tells the model the buttons are shown and not to write more text', async () => {
    const output = await navigateViewTool
      .implementation(makeContext(true), {})
      .toolFn({ suggestions: [{ viewId: 'admin.users', reason: 'Manage users' }] });

    const parsed = JSON.parse(output);
    expect(parsed.__navigationIntents).toBe(true);
    expect(parsed.intents.map((intent: { viewId: string }) => intent.viewId)).toEqual(['admin.users']);
    expect(parsed.message).toContain('Navigation buttons shown to the user: User Management.');
    expect(parsed.message).toContain('already visible');
    expect(parsed.message).toContain('do not write any more text');
  });

  it('describes the tool as part of the answer, never followed by more prose', () => {
    const { description } = navigateViewTool.implementation(makeContext(false), {}).toolSchema;
    expect(description).toContain('in the same response as your answer');
    expect(description).toContain('never followed by more prose');
  });
});

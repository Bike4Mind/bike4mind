/**
 * The chat hop that injects `decide`: the host's options -> ChatCompletionProcess -> ToolBuilderDeps.
 * Every link is an optional prop, so dropping one typechecks and silently disables the tool on the
 * chat surface. The deps-building block sits inside the completion method, which has no unit harness,
 * so the two lines are pinned against the source - the same way the agent executor's toolDeps are.
 */
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const source = readFileSync(new URL('./ChatCompletionProcess.ts', import.meta.url), 'utf8');

describe('ChatCompletionProcess decide seam', () => {
  it('stores the injected hook', () => {
    expect(source).toContain('this.decide = options.decide;');
  });

  it('forwards it into exactly one ToolBuilderDeps literal', () => {
    expect(source.match(/^\s*decide: this\.decide,$/gm)).toHaveLength(1);
  });
});

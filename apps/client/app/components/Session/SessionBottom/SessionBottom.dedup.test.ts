import { describe, it, expect } from 'vitest';
import { readFileSync } from 'fs';
import { resolve } from 'path';

// Regression guard: SessionBottom previously rendered a hidden
// duplicate <AdvancedAISettings>, mounting two drawer instances and silently
// intercepting pointer events on model selection. The single visible mount
// now lives in SessionToolbar; SessionBottom must never render the drawer
// itself. A source-level assertion is used here because a full SessionBottom
// render requires a large web of context providers that adds little signal
// beyond locking this invariant.
describe('SessionBottom — single AdvancedAISettings mount (regression)', () => {
  const sessionBottom = readFileSync(resolve(__dirname, 'SessionBottom.tsx'), 'utf8');
  const sessionToolbar = readFileSync(resolve(__dirname, 'SessionToolbar.tsx'), 'utf8');

  it('SessionBottom.tsx does not render <AdvancedAISettings> as JSX', () => {
    const jsxMounts = sessionBottom.match(/<AdvancedAISettings[\s/>]/g) ?? [];
    expect(jsxMounts).toHaveLength(0);
  });

  it('SessionToolbar.tsx renders exactly one <AdvancedAISettings>', () => {
    const jsxMounts = sessionToolbar.match(/<AdvancedAISettings[\s/>]/g) ?? [];
    expect(jsxMounts).toHaveLength(1);
  });
});

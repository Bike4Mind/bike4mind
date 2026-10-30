import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

// jsdom does not apply :hover, so this guards the source: the frame comes from the sidenav kit and the
// row's own action-reveal rules survive next to it. Behaviour is covered by the SidenavItem suites.
describe('conversation row frame', () => {
  const src = readFileSync(join(__dirname, 'SidenavItem.tsx'), 'utf8');

  it('takes its frame from the sidenav kit', () => {
    expect(src).toMatch(/conversationRowSx\(theme, isSelected/);
    expect(src).not.toMatch(/'&::before': isSelected/);
  });

  it('still reveals the row menu on hover and focus', () => {
    expect(src).toMatch(/'&:hover': \{\s*'& \.item-actions:not\(\.isProcessing\)'/);
    expect(src).toMatch(/'&:focus-within \.item-actions:not\(\.isProcessing\)'/);
  });
});

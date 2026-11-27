// @vitest-environment node
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

describe('Analytics shell frame', () => {
  it('does not opt the analytics panel out of the shared frame', () => {
    const source = readFileSync(new URL('./AdminPage.tsx', import.meta.url), 'utf8');
    expect(source).toMatch(/<TabPanel value=\{AdminTab\.Analytics\}>/);
  });
});

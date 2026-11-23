import { expect, it } from 'vitest';
import { readFileSync } from 'node:fs';

it('reads source without importing it', () => {
  expect(readFileSync(new URL('./source.fixture.mjs', import.meta.url), 'utf8')).toContain('42');
});

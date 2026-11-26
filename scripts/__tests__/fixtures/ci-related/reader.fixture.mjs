import { expect, it } from 'vitest';
import { readSource } from './test-utils/readSource.mjs';

it('reads source without importing it', () => {
  expect(readSource(new URL('./source.fixture.mjs', import.meta.url))).toContain('42');
});

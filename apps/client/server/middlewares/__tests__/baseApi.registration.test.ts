import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

describe('baseApi contributed settings registration', () => {
  it('imports the registration module so every API route resolves contributed settings', () => {
    const source = readFileSync(join(__dirname, '..', 'baseApi.ts'), 'utf8');
    expect(source).toMatch(/^import '@client\/lib\/settings\/registerContributedSettings';$/m);
  });
});

import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { PrBindingStore } from './PrBindingStore';
import { REF } from './prTestSupport';

const SESSION = 'session-1';

function storeWith(binding: unknown): PrBindingStore {
  const path = join(mkdtempSync(join(tmpdir(), 'b4m-pr-')), 'pull-requests.json');
  writeFileSync(path, JSON.stringify({ [SESSION]: binding }));
  return new PrBindingStore(path);
}

const raw = { ...REF, source: 'shell', boundAt: '', lastState: 'OPEN', autoFix: true };

describe('PrBindingStore auto-fix budget', () => {
  it('keeps a whole positive budget', async () => {
    expect((await storeWith({ ...raw, autoFixMax: 5 }).get(SESSION))?.autoFixMax).toBe(5);
  });

  it.each([
    ['a string', 'x'],
    ['zero', 0],
    ['a negative number', -1],
    ['a fraction', 2.5],
  ])('drops %s so the default applies', async (_label, autoFixMax) => {
    expect((await storeWith({ ...raw, autoFixMax }).get(SESSION))?.autoFixMax).toBeUndefined();
  });
});

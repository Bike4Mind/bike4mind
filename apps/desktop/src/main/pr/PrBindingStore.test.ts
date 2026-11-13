import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
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

  it('keeps a saved budget above the current Settings maximum', async () => {
    expect((await storeWith({ ...raw, autoFixMax: 21 }).get(SESSION))?.autoFixMax).toBe(21);
  });

  it.each([
    ['a string', 'x'],
    ['zero', 0],
    ['a negative number', -1],
    ['a fraction', 2.5],
  ])('drops %s so the legacy fallback applies', async (_label, autoFixMax) => {
    expect((await storeWith({ ...raw, autoFixMax }).get(SESSION))?.autoFixMax).toBeUndefined();
  });
});

describe('PrBindingStore.updateEach', () => {
  it('changes only the bindings it answers for, in one write', async () => {
    const path = join(mkdtempSync(join(tmpdir(), 'b4m-pr-')), 'pull-requests.json');
    writeFileSync(path, JSON.stringify({ a: { ...raw, autoFixMax: 2 }, b: { ...raw, autoFix: false } }));
    const store = new PrBindingStore(path);
    const changed = await store.updateEach(binding => (binding.autoFix ? { ...binding, autoFixMax: 7 } : null));
    expect(changed).toEqual(['a']);
    const saved = JSON.parse(readFileSync(path, 'utf8')) as Record<string, { autoFixMax?: number }>;
    expect(saved.a.autoFixMax).toBe(7);
    expect(saved.b.autoFixMax).toBeUndefined();
  });

  it('writes nothing when nothing changes', async () => {
    const path = join(mkdtempSync(join(tmpdir(), 'b4m-pr-')), 'pull-requests.json');
    const original = JSON.stringify({ a: raw });
    writeFileSync(path, original);
    expect(await new PrBindingStore(path).updateEach(() => null)).toEqual([]);
    expect(readFileSync(path, 'utf8')).toBe(original);
  });
});

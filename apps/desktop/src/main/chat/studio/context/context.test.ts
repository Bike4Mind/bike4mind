import { mkdtemp, mkdir, realpath, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ContextCollector, hash } from './collector';
import { createContextFileReader } from './fileReader';
import { ContextPreparationService } from './preparation';
import { selectSessions } from './selection';
import type { ContextReaders, SessionContext } from './types';

const signal = () => new AbortController().signal;
const message = (id: string, content: string) => ({ id, role: 'user' as const, content });
const attachment = {
  id: 'a',
  kind: 'text' as const,
  name: 'a.txt',
  mediaType: 'text/plain',
  byteSize: 4,
  sourceBytes: 8,
  truncated: true,
};
const session: SessionContext = { id: 'current', messages: [message('m', 'hello')] };

function readers(overrides: Partial<ContextReaders> = {}): ContextReaders {
  return {
    scopeKey: () => 'account',
    listSessions: vi.fn(async () => []),
    readSession: vi.fn(async () => ({ status: 'ok' as const, value: session })),
    readAttachment: vi.fn(async () => ({ status: 'missing' as const })),
    readFile: vi.fn(async () => ({ status: 'denied' as const })),
    ...overrides,
  };
}

describe('Studio context collection', () => {
  it('selects connected family including ancestors and siblings, bounded and cycle safe', () => {
    const origin = (parentSessionId: string) => ({ parentSessionId, depth: 1, seedPrompt: '' });
    const candidates = [
      { id: 'sibling', origin: origin('root') },
      { id: 'current', origin: origin('root') },
      { id: 'child', origin: origin('current') },
      { id: 'root', origin: origin('child') },
      { id: 'other' },
    ];
    expect(selectSessions('current', { kind: 'family' }, candidates, 12).ids).toEqual([
      'current',
      'root',
      'child',
      'sibling',
    ]);
    expect(selectSessions('current', { kind: 'family' }, candidates, 2)).toEqual({
      ids: ['current', 'root'],
      truncated: true,
    });
    expect(selectSessions('current', { kind: 'explicit', sessionIds: ['sibling', 'sibling', 'other'] }, [], 1)).toEqual(
      { ids: ['sibling'], truncated: true }
    );
  });

  it('collects current only, deduplicates messages and attachments with immutable provenance', async () => {
    const source = {
      id: 'current',
      messages: [{ ...message('m', 'hello'), attachments: [attachment, attachment] }, message('m', 'duplicate')],
    };
    const deps = readers({
      readSession: vi.fn<ContextReaders['readSession']>(async () => ({ status: 'ok', value: source })),
      readAttachment: vi.fn<ContextReaders['readAttachment']>(async () => ({ status: 'ok', value: { text: 'file' } })),
    });
    const snapshot = await new ContextCollector(deps).collect(
      { sessionId: 'current', selection: { kind: 'current' } },
      signal()
    );
    source.messages[0].content = 'changed';
    expect(deps.listSessions).not.toHaveBeenCalled();
    expect(deps.readAttachment).toHaveBeenCalledOnce();
    expect(snapshot.entries).toHaveLength(2);
    expect(snapshot.entries[0]).toMatchObject({
      text: 'hello',
      sha256: hash('hello'),
      source: { sessionId: 'current', messageId: 'm' },
    });
    expect(snapshot.entries[1].truncated).toBe(true);
    expect(Object.isFrozen(snapshot.entries[0].source)).toBe(true);
    expect(() => Object.assign(snapshot.entries[0], { text: 'tampered' })).toThrow();
    const { sha256, ...body } = snapshot;
    expect(sha256).toBe(hash(JSON.stringify(body)));
  });

  it('bounds UTF-8 content and total bytes, and reports truncation', async () => {
    const deps = readers({
      readSession: async () => ({
        status: 'ok',
        value: {
          id: 'current',
          messages: [message('1', '\u{1f600}\u{1f600}\u{1f600}'), message('2', 'abcdef'), message('3', 'omitted')],
        },
      }),
    });
    const result = await new ContextCollector(deps, { sourceBytes: 5, totalBytes: 7 }).collect(
      { sessionId: 'current', selection: { kind: 'current' } },
      signal()
    );
    expect(result.entries.map(entry => entry.text)).toEqual(['\u{1f600}', 'abc']);
    expect(result.totalBytes).toBe(7);
    expect(result.issues.map(issue => issue.reason)).toEqual(['truncated', 'truncated', 'limit']);
  });

  it('explicit selection uses requester authority and deduplicates canonical files', async () => {
    const deps = readers({
      readSession: vi.fn<ContextReaders['readSession']>(async (_requester, id) =>
        id === 'foreign' ? { status: 'denied' } : { status: 'missing' }
      ),
      readFile: vi.fn<ContextReaders['readFile']>(async () => ({
        status: 'ok',
        value: { text: 'same', canonicalPath: '/safe/a' },
      })),
    });
    const result = await new ContextCollector(deps).collect(
      {
        sessionId: 'current',
        selection: { kind: 'explicit', sessionIds: ['foreign', 'missing', 'foreign'] },
        files: ['/safe/a', '/safe/alias', '/safe/a'],
      },
      signal()
    );
    expect(deps.readSession).toHaveBeenCalledTimes(2);
    expect(deps.readSession).toHaveBeenCalledWith('current', 'foreign', expect.any(AbortSignal));
    expect(result.entries).toHaveLength(1);
    expect(result.issues.map(issue => issue.reason)).toEqual(['denied', 'missing']);
  });

  it('caps failed read attempts and rejects invalid limits', async () => {
    const deps = readers();
    const result = await new ContextCollector(deps, { sources: 2 }).collect(
      { sessionId: 'current', selection: { kind: 'explicit', sessionIds: [] }, files: ['/a', '/b', '/c'] },
      signal()
    );
    expect(deps.readFile).toHaveBeenCalledTimes(2);
    expect(result.issues.at(-1)?.reason).toBe('limit');
    expect(() => new ContextCollector(deps, { sessions: NaN })).toThrow(RangeError);
    expect(() => new ContextCollector(deps, { totalBytes: 100_000 })).toThrow(RangeError);
  });

  it('captures attachment identity before an asynchronous reader can mutate its source', async () => {
    const changing = { ...attachment };
    const deps = readers({
      readSession: async () => ({
        status: 'ok',
        value: { id: 'current', messages: [{ ...message('m', 'hello'), attachments: [changing] }] },
      }),
      readAttachment: async () => {
        changing.id = 'changed';
        changing.truncated = false;
        return { status: 'ok', value: { text: 'original attachment' } };
      },
    });
    const result = await new ContextCollector(deps).collect(
      { sessionId: 'current', selection: { kind: 'current' } },
      signal()
    );
    expect(result.entries[1]).toMatchObject({ source: { attachmentId: 'a' }, truncated: true });
  });

  it('bounds duplicate traversal and rejects oversized selections before reading', async () => {
    const deps = readers({
      readSession: async () => ({
        status: 'ok',
        value: { id: 'current', messages: Array.from({ length: 20 }, () => message('duplicate', 'text')) },
      }),
    });
    const collector = new ContextCollector(deps, { sources: 2 });
    const result = await collector.collect({ sessionId: 'current', selection: { kind: 'current' } }, signal());
    expect(result.entries).toHaveLength(1);
    expect(result.issues).toContainEqual({ source: 'current', reason: 'limit' });
    await expect(
      collector.collect(
        { sessionId: 'current', selection: { kind: 'explicit', sessionIds: Array(257).fill('x') } },
        signal()
      )
    ).rejects.toThrow(RangeError);
  });

  it('does not return data after cancellation or an account scope change', async () => {
    const controller = new AbortController();
    const deps = readers({
      readSession: async () => {
        controller.abort();
        return { status: 'ok', value: session };
      },
    });
    await expect(
      new ContextCollector(deps).collect({ sessionId: 'current', selection: { kind: 'current' } }, controller.signal)
    ).rejects.toThrow();
    let scope = 'one';
    const scoped = readers({
      scopeKey: () => scope,
      readSession: async () => {
        scope = 'two';
        return { status: 'ok', value: session };
      },
    });
    await expect(
      new ContextCollector(scoped).collect({ sessionId: 'current', selection: { kind: 'current' } }, signal())
    ).rejects.toThrow('scope changed');
  });
});

describe('permission-aware file reader', () => {
  let root: string | undefined;
  afterEach(async () => {
    if (root) await rm(root, { recursive: true, force: true });
  });

  it('refuses sibling grants, relative paths and symlink escapes; reports missing and truncated files', async () => {
    root = await realpath(await mkdtemp(join(tmpdir(), 'studio-context-')));
    const current = join(root, 'current');
    const sibling = join(root, 'sibling');
    await mkdir(current);
    await mkdir(sibling);
    await writeFile(join(current, 'text'), '\u{1f600}hello');
    await writeFile(join(sibling, 'secret'), 'private');
    await symlink(join(sibling, 'secret'), join(current, 'escape'));
    await symlink(join(current, 'text'), join(current, 'alias'));
    const read = createContextFileReader(async id => (id === 'current' ? [current] : [sibling]));
    expect(await read('current', join(sibling, 'secret'), 5, signal())).toEqual({ status: 'denied' });
    expect(await read('current', join(current, 'escape'), 5, signal())).toEqual({ status: 'denied' });
    expect(await read('current', 'text', 5, signal())).toEqual({ status: 'denied' });
    expect(await read('current', join(current, 'missing'), 5, signal())).toEqual({ status: 'missing' });
    expect(await read('current', join(current, 'alias'), 5, signal())).toEqual({
      status: 'ok',
      value: { text: '\u{1f600}h', canonicalPath: join(current, 'text'), truncated: true },
    });
    expect(await read('current', join(current, 'text'), 3, signal())).toMatchObject({
      status: 'ok',
      value: { text: '', truncated: true },
    });
  });

  it('fails closed if requester roots are revoked while reading', async () => {
    root = await realpath(await mkdtemp(join(tmpdir(), 'studio-context-')));
    const path = join(root, 'text');
    await writeFile(path, 'hello');
    let calls = 0;
    const read = createContextFileReader(async () => (++calls === 1 ? [root!] : []));
    expect(await read('current', path, 5, signal())).toEqual({ status: 'denied' });
  });
});

describe('draft preparation', () => {
  it.each(['prompt', 'script'] as const)(
    'returns a review-only %s with frozen context and request provenance',
    async kind => {
      const provider = { prepare: vi.fn(async () => 'draft') };
      const service = new ContextPreparationService(new ContextCollector(readers()), provider);
      const result = await service.prepare(
        { context: { sessionId: 'current', selection: { kind: 'current' } }, kind, instruction: 'make a draft' },
        signal()
      );
      expect(result).toMatchObject({
        status: 'review-required',
        kind,
        text: 'draft',
        instruction: 'make a draft',
        sha256: hash('draft'),
      });
      expect(Object.isFrozen(result.context.entries)).toBe(true);
      expect(provider.prepare).toHaveBeenCalledOnce();
      expect(provider.prepare.mock.calls[0]).toBeDefined();
    }
  );

  it('cancels before collection and after a provider ignores cancellation', async () => {
    const controller = new AbortController();
    const deps = readers();
    const provider = {
      prepare: vi.fn(async () => {
        controller.abort();
        return 'must not return';
      }),
    };
    const service = new ContextPreparationService(new ContextCollector(deps), provider);
    const request = {
      context: { sessionId: 'current', selection: { kind: 'current' as const } },
      kind: 'script' as const,
      instruction: 'draft',
    };
    await expect(service.prepare(request, controller.signal)).rejects.toThrow();
    provider.prepare.mockClear();
    await expect(service.prepare(request, controller.signal)).rejects.toThrow();
    expect(provider.prepare).not.toHaveBeenCalled();
  });

  it('bounds output and refuses empty drafts or oversized instructions', async () => {
    const provider = { prepare: vi.fn(async () => 'x'.repeat(40_000)) };
    const service = new ContextPreparationService(new ContextCollector(readers()), provider);
    const request = {
      context: { sessionId: 'current', selection: { kind: 'current' as const } },
      kind: 'prompt' as const,
      instruction: 'draft',
    };
    expect(await service.prepare(request, signal())).toMatchObject({ text: 'x'.repeat(32_768), truncated: true });
    provider.prepare.mockResolvedValue(' ');
    await expect(service.prepare(request, signal())).rejects.toThrow('empty draft');
    await expect(service.prepare({ ...request, instruction: 'x'.repeat(20_000) }, signal())).rejects.toThrow(
      RangeError
    );
  });

  it('rejects a draft after an account change during preparation', async () => {
    let scope = 'one';
    const service = new ContextPreparationService(new ContextCollector(readers({ scopeKey: () => scope })), {
      prepare: async () => {
        scope = 'two';
        return 'draft';
      },
    });
    await expect(
      service.prepare(
        { context: { sessionId: 'current', selection: { kind: 'current' } }, kind: 'prompt', instruction: 'draft' },
        signal()
      )
    ).rejects.toThrow('scope changed');
  });
});

it('checks the captured scope after collection and before dispatching preparation', async () => {
  let scope = 'first';
  const collector = new ContextCollector(readers({ scopeKey: () => scope }));
  const original = collector.collect.bind(collector);
  vi.spyOn(collector, 'collect').mockImplementationOnce(async (...args) => {
    const collected = await original(...args);
    scope = 'second';
    return collected;
  });
  const prepare = vi.fn(async () => 'Prepared');
  const service = new ContextPreparationService(collector, { prepare });
  await expect(
    service.prepare(
      {
        context: { sessionId: 'current', selection: { kind: 'current' } },
        kind: 'prompt',
        instruction: 'First account instruction',
      },
      signal()
    )
  ).rejects.toThrow('scope changed');
  expect(prepare).not.toHaveBeenCalled();
});

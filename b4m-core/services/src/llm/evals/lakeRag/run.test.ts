import { describe, expect, it } from 'vitest';
import { loadLakeRagBank, type LakeRagBankRow } from './bank';
import type { LakeRagApi, ProvisionedLake } from './provision';
import { detectRetrieval, lakeRagSessionBody, LakeRagUnauthorizedError, runLakeRagArms } from './run';

const LAKES: Record<string, ProvisionedLake> = {
  'planetary-moons': { id: 'lake-moons', datalakeTag: 'tag-moons' },
  'si-units': { id: 'lake-si', datalakeTag: 'tag-si' },
  'us-census': { id: 'lake-census', datalakeTag: 'tag-census' },
};

const bank = loadLakeRagBank();
const row = (id: string): LakeRagBankRow => {
  const found = bank.find(r => r.id === id);
  if (!found) throw new Error(`no bank row ${id}`);
  return found;
};
const SATURN = row('moons-same-name-saturn-count');
const PLUTO = row('moons-absent-pluto');

type Call = { method: string; path: string; body?: Record<string, unknown> };
type Quest = Record<string, unknown>;

/** A fake deployment: `quests` scripts successive GET bodies per quest (the last one repeats). */
function fakeServer(opts: { quests?: (n: number) => Quest[]; chatStatus?: (n: number) => number } = {}) {
  const calls: Call[] = [];
  let chats = 0;
  const reads = new Map<string, number>();
  const json = (status: number, body: unknown) => new Response(JSON.stringify(body), { status });
  const fetchImpl = (async (input: URL | string, init: RequestInit = {}) => {
    const url = new URL(String(input));
    const method = init.method ?? 'GET';
    const body = init.body ? (JSON.parse(String(init.body)) as Record<string, unknown>) : undefined;
    calls.push({ method, path: url.pathname, body });
    if (method === 'POST' && url.pathname === '/api/v1/sessions') return json(200, { id: `s${calls.length}` });
    if (method === 'POST' && url.pathname === '/api/chat') {
      const n = chats++;
      const status = opts.chatStatus?.(n) ?? 200;
      return status === 200 ? json(200, { id: `q${n}`, status: 'queued' }) : json(status, { error: 'nope' });
    }
    const match = /^\/api\/v1\/quests\/(q\d+)$/.exec(url.pathname);
    if (method === 'GET' && match) {
      const n = Number(match[1].slice(1));
      const script = opts.quests?.(n) ?? [{ status: 'done', reply: 'Saturn has 146 moons [1].' }];
      const read = reads.get(match[1]) ?? 0;
      reads.set(match[1], read + 1);
      return json(200, script[Math.min(read, script.length - 1)]);
    }
    return json(404, {});
  }) as typeof fetch;
  const api: LakeRagApi = {
    baseUrl: 'https://eval.example.com',
    authorization: 'Bearer b4m_live_secret-token',
    fetch: fetchImpl,
    sleep: async () => {},
  };
  return { api, calls };
}

describe('detectRetrieval', () => {
  it('counts a document citable', () => {
    expect(detectRetrieval({ citables: [{ type: 'web_url' }, { type: 'document', title: 'a.md' }] })).toEqual({
      ran: true,
      via: 'citables',
    });
  });

  it('counts a knowledge-base search tool call with no document citable', () => {
    expect(detectRetrieval({ citables: [], functionCalls: [{ name: 'search_knowledge_base' }] }).via).toBe('tool');
    expect(detectRetrieval({ functionCalls: [{ name: 'retrieve_knowledge_content' }] }).ran).toBe(true);
  });

  it('reports none for unrelated tools, empty arrays, malformed fields and undefined', () => {
    expect(detectRetrieval({ citables: [{ type: 'web_url' }], functionCalls: [{ name: 'web_search' }] }).ran).toBe(
      false
    );
    expect(detectRetrieval({ citables: [], functionCalls: [] })).toEqual({ ran: false, via: 'none' });
    expect(detectRetrieval({ citables: 'x', functionCalls: { name: 'search_knowledge_base' } }).ran).toBe(false);
    expect(detectRetrieval(undefined)).toEqual({ ran: false, via: 'none' });
  });

  it('records promptMeta.retrieval as a diagnostic without letting it decide', () => {
    expect(detectRetrieval({ retrieval: { attempted: true, outcome: 'ok' } })).toEqual({
      ran: false,
      via: 'none',
      summary: { attempted: true, outcome: 'ok' },
    });
  });
});

describe('lakeRagSessionBody', () => {
  it('binds the lake arm to its own lake with indexed citations', () => {
    expect(lakeRagSessionBody('lake', SATURN, LAKES)).toEqual({
      name: `lakerag-eval-lake-${SATURN.id}`,
      dataLakeId: 'lake-moons',
      citationStyle: 'indexed',
    });
  });

  it('lists the own tag first plus both distractor tags on the multi-lake arm', () => {
    const body = lakeRagSessionBody('multi-lake', SATURN, LAKES);
    expect(body.dataLakeId).toBe('lake-moons');
    expect(body.retrievalTags).toEqual(['tag-moons', 'tag-si', 'tag-census']);
  });

  it('names no lake on the plain arm', () => {
    expect(lakeRagSessionBody('plain', SATURN, LAKES)).toEqual({ name: `lakerag-eval-plain-${SATURN.id}` });
  });
});

describe('runLakeRagArms', () => {
  it('sends promptMode raw on the plain arm only, and reads citables from the quest poll', async () => {
    const { api, calls } = fakeServer({
      quests: n =>
        n === 0
          ? [
              { status: 'running' },
              {
                status: 'done',
                reply: 'Saturn has 146 confirmed moons [1].',
                promptMeta: { citables: [{ type: 'document', title: 'giant-planet-moons.md' }] },
              },
            ]
          : [{ status: 'done', reply: 'Saturn has 146 moons.' }],
    });
    const turns = await runLakeRagArms(api, [SATURN], LAKES, { model: 'm', arms: ['lake', 'plain'] });

    const chats = calls.filter(c => c.path === '/api/chat');
    expect(chats.map(c => c.body?.promptMode)).toEqual([undefined, 'raw']);
    expect(chats.every(c => c.body?.wait === false && c.body?.model === 'm')).toBe(true);
    expect(calls.filter(c => c.path === '/api/v1/quests/q0')).toHaveLength(2);

    expect(turns.map(t => [t.arm, t.grade.passed, t.retrieval.ran])).toEqual([
      ['lake', true, true],
      ['plain', true, false],
    ]);
  });

  it('grades the lake arm on the indexed citation', async () => {
    const { api } = fakeServer({
      quests: () => [
        {
          status: 'done',
          reply: 'Saturn has 146 confirmed moons [1].',
          promptMeta: { citables: [{ type: 'document', title: 'galilean-moons.md' }] },
        },
      ],
    });
    const [turn] = await runLakeRagArms(api, [SATURN], LAKES, { model: 'm', arms: ['lake'] });
    expect(turn.grade.passed).toBe(false);
    expect(turn.grade.citation.status).toBe('wrong-source');
  });

  it('records an error quest or a failed chat as an empty grade and keeps going', async () => {
    const { api } = fakeServer({
      chatStatus: n => (n === 1 ? 500 : 200),
      quests: n => [
        n === 0 ? { status: 'done', type: 'error', reply: 'credits exhausted' } : { status: 'done', reply: '' },
      ],
    });
    const turns = await runLakeRagArms(api, [SATURN, PLUTO], LAKES, { model: 'm', arms: ['lake'], samples: 2 });
    expect(turns).toHaveLength(4);
    expect(turns.map(t => t.grade.passed)).toEqual([false, false, false, false]);
    expect(turns[0].grade.reason).toMatch(/quest error: credits exhausted/);
    expect(turns[1].grade.reason).toMatch(/turn failed: POST \/api\/chat -> 500/);
    expect(turns[1].questId).toBeUndefined();
    expect(turns[2].grade.reason).toBe('empty reply');
  });

  it('aborts the run on a 401 without leaking the credential', async () => {
    const { api } = fakeServer({ chatStatus: () => 401 });
    const run = runLakeRagArms(api, [SATURN, PLUTO], LAKES, { model: 'm', arms: ['lake'] });
    await expect(run).rejects.toBeInstanceOf(LakeRagUnauthorizedError);
    await expect(run).rejects.not.toThrow(/secret-token/);
  });

  it.each([0, 1.5, -1])('rejects samples %s without touching the network', async samples => {
    const { api, calls } = fakeServer();
    await expect(runLakeRagArms(api, [SATURN], LAKES, { model: 'm', samples })).rejects.toThrow(
      /samples must be a positive integer/
    );
    expect(calls).toHaveLength(0);
  });

  it('refuses a lake arm for a subject with no provisioned lake', async () => {
    const { api } = fakeServer();
    await expect(runLakeRagArms(api, [SATURN], {}, { model: 'm', arms: ['lake'] })).rejects.toThrow(/planetary-moons/);
  });
});

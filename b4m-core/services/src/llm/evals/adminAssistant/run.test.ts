import { describe, expect, it } from 'vitest';
import type { LakeRagApi } from '../lakeRag/provision';
import type { AdminEvalCase } from './cases';
import { AdminEvalUnauthorizedError, runAdminEval } from './run';

type Sent = { method: string; path: string; body?: Record<string, unknown> };

const rows: AdminEvalCase[] = [
  { id: 'a', category: 'where-is', question: 'Where is the audit log?', expectViewIds: ['admin.audit_log'] },
  {
    id: 'b',
    category: 'data',
    question: 'Credits for {target}?',
    expectTools: ['admin_get_user_credits'],
    needsTarget: true,
  },
];

const navQuest = {
  status: 'done',
  reply: 'It is on the Audit log tab.',
  promptMeta: {
    functionCalls: [{ name: 'navigate_view', parameters: { suggestions: [{ viewId: 'admin.audit_log' }] } }],
  },
};

function server(quests: Record<string, unknown>[], opts: { llmStatus?: number } = {}) {
  const sent: Sent[] = [];
  let session = 0;
  let quest = 0;
  const fetchImpl = (async (input: URL | string, init: RequestInit = {}) => {
    const url = new URL(String(input));
    const body = init.body ? (JSON.parse(String(init.body)) as Record<string, unknown>) : undefined;
    sent.push({ method: init.method ?? 'GET', path: url.pathname, body });
    const json = (data: unknown, status = 200) => new Response(JSON.stringify(data), { status });
    if (url.pathname === '/api/sessions/create') return json({ id: `s${++session}` }, 201);
    if (url.pathname === '/api/ai/llm') {
      return opts.llmStatus ? json({ error: 'no' }, opts.llmStatus) : json({ quest: { id: `q${++quest}` } });
    }
    const id = Number(url.pathname.split('/').pop()!.slice(1));
    return json(quests[id - 1]);
  }) as typeof fetch;
  const api: LakeRagApi = {
    baseUrl: 'https://app.example.com',
    authorization: 'Bearer t',
    fetch: fetchImpl,
    sleep: async () => {},
    pollIntervalMs: 1,
  };
  return { api, sent };
}

describe('runAdminEval', () => {
  it('drives the admin-assistant surface with the /admin view context, one fresh session per turn', async () => {
    const { api, sent } = server([
      navQuest,
      { status: 'done', reply: 'It is 4321.', promptMeta: { functionCalls: [{ name: 'admin_get_user_credits' }] } },
    ]);
    const turns = await runAdminEval(api, rows, { model: 'm1', target: 'x-e2e@test.com' });

    expect(turns.map(t => t.grade.passed)).toEqual([true, true]);
    const sessions = sent.filter(s => s.path === '/api/sessions/create');
    expect(sessions).toHaveLength(2);
    expect(sessions[0].body).toMatchObject({ surface: 'admin-assistant' });
    const chats = sent.filter(s => s.path === '/api/ai/llm');
    expect(chats[0].body).toMatchObject({
      sessionId: 's1',
      message: 'Where is the audit log?',
      params: { model: 'm1' },
    });
    expect(chats[0].body?.extraContextMessages).toEqual([
      expect.objectContaining({ perTurn: true, content: expect.stringContaining('Path: /admin') }),
    ]);
    expect(chats[1].body).toMatchObject({ sessionId: 's2', message: 'Credits for x-e2e@test.com?' });
  });

  it('polls the quest until it is terminal', async () => {
    const { api, sent } = server([{ status: 'running' }, { status: 'running' }]);
    let n = 0;
    const real = api.fetch!;
    api.fetch = (async (input: URL | string, init?: RequestInit) => {
      if (String(input).includes('/api/v1/quests/') && ++n === 3) return new Response(JSON.stringify(navQuest));
      return real(input, init);
    }) as typeof fetch;
    const turns = await runAdminEval(api, [rows[0]], { model: 'm' });
    expect(turns[0].grade.passed).toBe(true);
    // The third poll is served by the override above, so only the two running polls reach `sent`.
    expect(n).toBe(3);
    expect(sent.filter(s => s.path.startsWith('/api/v1/quests/')).map(s => s.path)).toEqual([
      '/api/v1/quests/q1',
      '/api/v1/quests/q1',
    ]);
  });

  it('records a stopped quest with no reply as an empty reply', async () => {
    const { api } = server([{ status: 'stopped', reply: '' }]);
    const turns = await runAdminEval(api, [rows[0]], { model: 'm', turnTimeoutMs: 50 });
    expect(turns[0].grade.reason).toBe('empty reply');
  });

  it('grades a navigate_view-only turn on its view', async () => {
    const { api } = server([{ ...navQuest, reply: '' }]);
    const turns = await runAdminEval(api, [rows[0]], { model: 'm' });
    expect(turns[0].grade).toMatchObject({ passed: true, checks: { view: true } });
  });

  it('turns a quest that never ends into one failed turn and keeps going', async () => {
    let clock = 0;
    const { api } = server([{ status: 'running' }, navQuest]);
    api.now = () => clock;
    api.sleep = async ms => {
      clock += ms;
    };
    api.pollIntervalMs = 1_000;
    const seen: string[] = [];
    const turns = await runAdminEval(api, [rows[0], rows[0]], {
      model: 'm',
      turnTimeoutMs: 5_000,
      onTurn: t => seen.push(t.grade.reason),
    });
    expect(turns[0].grade.reason).toMatch(/turn failed: quest q1: still running after 5000ms/);
    expect(turns[1].grade.passed).toBe(true);
    expect(seen).toHaveLength(2);
  });

  it('records a turn once when onTurn throws, and rejects', async () => {
    const { api } = server([navQuest]);
    const seen: string[] = [];
    await expect(
      runAdminEval(api, [rows[0]], {
        model: 'm',
        onTurn: t => {
          seen.push(t.grade.reason);
          throw new Error('EACCES');
        },
      })
    ).rejects.toThrow('EACCES');
    expect(seen).toHaveLength(1);
  });

  it('records an empty reply and a quest error as failures', async () => {
    const { api } = server([
      { status: 'done', reply: '  ' },
      { status: 'done', type: 'error', reply: 'boom' },
    ]);
    const turns = await runAdminEval(api, rows, { model: 'm', target: 't' });
    expect(turns.map(t => t.grade.reason)).toEqual(['empty reply', 'quest error: boom']);
  });

  it('records a non-401 failure and continues', async () => {
    const { api } = server([], { llmStatus: 500 });
    const turns = await runAdminEval(api, [rows[0]], { model: 'm' });
    expect(turns[0].grade.reason).toMatch(/turn failed: .*500/);
  });

  it('aborts on a 401', async () => {
    const { api } = server([], { llmStatus: 401 });
    await expect(runAdminEval(api, rows, { model: 'm', target: 't' })).rejects.toBeInstanceOf(
      AdminEvalUnauthorizedError
    );
  });

  it('runs each row `samples` times and validates its inputs', async () => {
    const { api } = server([navQuest, navQuest]);
    expect(await runAdminEval(api, [rows[0]], { model: 'm', samples: 2 })).toHaveLength(2);
    await expect(runAdminEval(api, rows, { model: 'm' })).rejects.toThrow(/target/);
    await expect(runAdminEval(api, [rows[0]], { model: 'm', samples: 0 })).rejects.toThrow(/samples/);
  });
});

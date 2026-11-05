import { describe, expect, it } from 'vitest';
import { PERSONA_NAMES, assignPersonas, distinctTitle, epithetFor, type PersonaSubject } from './agentPersona';

const agentFixture = (id: string, extra: Partial<PersonaSubject> = {}): PersonaSubject => ({
  id,
  title: `Agent ${id}`,
  seedPrompt: '',
  createdAt: '2026-10-01T00:00:00.000Z',
  ...extra,
});

describe('distinctTitle', () => {
  it('strips the longest shared prefix ending at a separator', () => {
    const titles = ['Desktop audit: unused files', 'Desktop audit: large files', 'Other work'];
    expect(distinctTitle(titles[0] ?? '', titles)).toBe('unused files');
    expect(distinctTitle(titles[1] ?? '', titles)).toBe('large files');
  });

  it('handles dash and pipe separators and prefers the longest shared prefix', () => {
    const titles = ['Audit - desktop - unused', 'Audit - desktop - large', 'Audit - web'];
    expect(distinctTitle('Audit - desktop - unused', titles)).toBe('unused');
    expect(distinctTitle('Audit - web', titles)).toBe('web');
    const piped = ['Repo | alpha', 'Repo | beta'];
    expect(distinctTitle('Repo | alpha', piped)).toBe('alpha');
  });

  it('leaves a title alone when nothing is shared', () => {
    const titles = ['Fix login: now', 'Write docs: later'];
    expect(distinctTitle('Fix login: now', titles)).toBe('Fix login: now');
    expect(distinctTitle('Solo', ['Solo'])).toBe('Solo');
  });

  it('does not treat a prefix that is not separator-terminated as shared', () => {
    const titles = ['Desktop audit one', 'Desktop audit two'];
    expect(distinctTitle('Desktop audit one', titles)).toBe('Desktop audit one');
  });

  it('falls back to the full title when stripping would leave nothing', () => {
    const titles = ['Audit:', 'Audit: more'];
    expect(distinctTitle('Audit:', titles)).toBe('Audit:');
    expect(distinctTitle('Audit:  ', ['Audit:  ', 'Audit: more'])).toBe('Audit:  ');
  });
});

describe('epithetFor', () => {
  it.each([
    ['Check permissions', '', 'Warden'],
    ['Update the README', '', 'Scribe'],
    ['Fix the bug', '', 'Tinkerer'],
    ['Largest files', '', 'Cartographer'],
    ['Find stale branches', '', 'Seeker'],
    ['Say hello', 'be friendly', 'Wanderer'],
  ])('%s -> %s', (title, seed, expected) => {
    expect(epithetFor(title, seed)).toBe(expected);
  });

  it('matches case-insensitively and reads the seed prompt too', () => {
    expect(epithetFor('Task', 'REVIEW the diff')).toBe('Warden');
  });

  it('applies precedence in the stated order', () => {
    expect(epithetFor('Review and document the tests', '')).toBe('Warden');
    expect(epithetFor('Document and fix', '')).toBe('Scribe');
    expect(epithetFor('Fix the structure', '')).toBe('Tinkerer');
    expect(epithetFor('List unused files', '')).toBe('Cartographer');
  });
});

describe('assignPersonas', () => {
  const roster = (count: number) =>
    Array.from({ length: count }, (_, index) =>
      agentFixture(`session-${index}`, {
        createdAt: `2026-10-01T00:00:${String(index).padStart(2, '0')}.000Z`,
      })
    );

  it('has a pool of 48 unique ASCII names', () => {
    expect(PERSONA_NAMES).toHaveLength(48);
    expect(new Set(PERSONA_NAMES).size).toBe(48);
    expect(PERSONA_NAMES.every(name => /^[A-Za-z]+$/.test(name))).toBe(true);
  });

  it('is deterministic regardless of input order', () => {
    const agents = roster(12);
    const first = assignPersonas(agents);
    const second = assignPersonas([...agents].reverse());
    expect(Object.fromEntries(second)).toEqual(Object.fromEntries(first));
  });

  it('adds the title part that differs from its siblings as shortTitle', () => {
    const personas = assignPersonas([
      agentFixture('a', { title: 'Desktop audit: unused files' }),
      agentFixture('b', { title: 'Desktop audit: large files' }),
      agentFixture('c', { title: 'Standalone' }),
    ]);
    expect(personas.get('a')?.shortTitle).toBe('unused files');
    expect(personas.get('b')?.shortTitle).toBe('large files');
    expect(personas.get('c')?.shortTitle).toBe('Standalone');
  });

  it('gives a 12-agent roster 12 distinct names and labels', () => {
    const personas = [...assignPersonas(roster(12)).values()];
    expect(new Set(personas.map(persona => persona.name)).size).toBe(12);
    for (const persona of personas) expect(persona.label).toBe(`${persona.name} the ${persona.epithet}`);
  });

  it('keeps existing names when a newer agent joins', () => {
    const agents = roster(12);
    const before = assignPersonas(agents);
    const after = assignPersonas([...agents, agentFixture('session-new', { createdAt: '2026-10-02T00:00:00.000Z' })]);
    for (const agent of agents) expect(after.get(agent.id)?.name).toBe(before.get(agent.id)?.name);
  });

  it('breaks createdAt ties by id', () => {
    const same = '2026-10-01T00:00:00.000Z';
    const personas = assignPersonas(['b', 'a', 'c'].map(id => agentFixture(id, { createdAt: same })));
    expect(new Set([...personas.values()].map(persona => persona.name)).size).toBe(3);
  });

  it('terminates when the roster outgrows the name pool', () => {
    expect(assignPersonas(roster(60)).size).toBe(60);
  });
});

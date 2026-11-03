import YAML from 'yaml';
import { describe, expect, it } from 'vitest';
import type { IQuestMasterPlanDocument } from '../types/entities/QuestTypes';
import type { IQuestGraph, IQuestNode } from '../types/entities/QuestNodeTypes';
import { questGraphToMarkdown, questPlanToMarkdown } from './questMarkdown';

const options = { exportedOn: '2026-10-29' };

const plan = {
  id: 'plan-1',
  goal: 'Ship the app',
  state: 'active',
  tags: ['mobile'],
  priority: 'high',
  metrics: { totalTimeSpent: 0, completionRate: 50, subQuestsCompleted: 1, subQuestsTotal: 2 },
  quests: [
    {
      id: 'quest-1',
      title: 'Set up',
      description: 'Bootstrap the project.',
      complexity: 'Easy',
      subQuests: [
        { id: 'sq-1', title: 'Init', status: 'completed' },
        { id: 'sq-2', title: 'Configure', status: 'in_progress', startedAt: Date.UTC(2026, 0, 2, 3, 4, 5) },
      ],
    },
  ],
} as unknown as IQuestMasterPlanDocument;

const splitFrontMatter = (md: string): { data: unknown; body: string } => {
  const match = /^---\n([\s\S]*?)\n---\n\n([\s\S]*)$/.exec(md);
  if (!match) throw new Error('no front-matter');
  return { data: YAML.parse(match[1]), body: match[2] };
};

describe('questPlanToMarkdown', () => {
  it('renders the exact document the in-app export has always produced', () => {
    expect(questPlanToMarkdown(plan, { ...options, formatTimestamp: () => '<started>' })).toBe(
      [
        '# Ship the app',
        '',
        '> Exported from QuestMaster on 2026-10-29',
        '> Status: active | Progress: 1/2 tasks (50%)',
        '',
        '> Tags: mobile',
        '',
        '---',
        '',
        '## Table of Contents',
        '',
        '1. **Set up** (Easy)',
        '   1.1. Init \u2713',
        '   1.2. Configure \u{1F504}',
        '',
        '---',
        '',
        '## Quest 1: Set up',
        '',
        '**Complexity:** Easy | **Progress:** 1/2',
        '',
        'Bootstrap the project.',
        '',
        '### 1.1. Init \u2713',
        '',
        '- **Status:** Completed',
        '',
        '### 1.2. Configure \u{1F504}',
        '',
        '- **Status:** In Progress',
        '- **Started:** <started>',
        '',
        '---',
        '',
        '',
      ].join('\n')
    );
  });

  it('formats timestamps as ISO 8601 unless the caller supplies a formatter', () => {
    expect(questPlanToMarkdown(plan, options)).toContain('- **Started:** 2026-01-02T03:04:05.000Z');
  });

  it('renders a corrupt timestamp as Invalid Date instead of throwing', () => {
    const corrupt = {
      ...plan,
      quests: [
        { ...plan.quests[0], subQuests: [{ id: 'sq-x', title: 'Bad', status: 'in_progress', startedAt: 'garbage' }] },
      ],
    } as unknown as IQuestMasterPlanDocument;

    expect(() => questPlanToMarkdown(corrupt, options)).not.toThrow();
    expect(questPlanToMarkdown(corrupt, options)).toContain('- **Started:** Invalid Date');
  });

  it('is deterministic - the clock is an input, not a read', () => {
    expect(questPlanToMarkdown(plan, options)).toBe(questPlanToMarkdown(plan, options));
  });

  it('adds no front-matter unless asked', () => {
    expect(questPlanToMarkdown(plan, options).startsWith('# Ship the app')).toBe(true);
  });

  it('carries the plan structure and the source id in front-matter', () => {
    const { data, body } = splitFrontMatter(questPlanToMarkdown(plan, { ...options, frontMatter: true }));

    expect(data).toEqual({
      source: { kind: 'quest-plan', id: 'plan-1' },
      goal: 'Ship the app',
      state: 'active',
      priority: 'high',
      tags: ['mobile'],
      quests: [
        {
          id: 'quest-1',
          title: 'Set up',
          complexity: 'Easy',
          subQuests: [
            { id: 'sq-1', title: 'Init', status: 'completed' },
            { id: 'sq-2', title: 'Configure', status: 'in_progress' },
          ],
        },
      ],
    });
    expect(body).toBe(questPlanToMarkdown(plan, options));
  });

  it('keeps front-matter well-formed when the goal needs YAML quoting', () => {
    const tricky = { ...plan, goal: 'Fix: "quotes" #1\nsecond line' } as IQuestMasterPlanDocument;
    const { data } = splitFrontMatter(questPlanToMarkdown(tricky, { ...options, frontMatter: true }));

    expect((data as { goal: string }).goal).toBe('Fix: "quotes" #1\nsecond line');
  });

  it('keeps a long goal on one front-matter line', () => {
    const goal = 'Research the competitive landscape for AI-assisted note taking tools across consumer and enterprise';
    const long = { ...plan, goal } as IQuestMasterPlanDocument;
    const md = questPlanToMarkdown(long, { ...options, frontMatter: true });

    expect(md).toContain(`goal: ${goal}\n`);
    expect((splitFrontMatter(md).data as { goal: string }).goal).toBe(goal);
  });

  it('serializes an empty plan', () => {
    const empty = { id: 'plan-empty', goal: 'Nothing yet', quests: [] } as unknown as IQuestMasterPlanDocument;
    const md = questPlanToMarkdown(empty, { ...options, frontMatter: true });
    const { data, body } = splitFrontMatter(md);

    expect(data).toMatchObject({ source: { id: 'plan-empty' }, state: 'active', tags: [], quests: [] });
    expect(body).toContain('> Status: active | Progress: 0/0 tasks');
    expect(body).toContain('## Table of Contents');
  });
});

const graph: IQuestGraph = {
  id: 'graph-1',
  goal: 'Research the market',
  userId: 'user-1',
  rootNodeIds: ['n1'],
  state: 'active',
  visibility: 'private',
  budget: { maxDepth: 3, maxNodes: 10 },
};

const node = (overrides: Partial<IQuestNode> & Pick<IQuestNode, 'id' | 'title'>): IQuestNode => ({
  graphId: 'graph-1',
  parentId: null,
  dependsOn: [],
  order: 0,
  kind: 'task',
  task: `Do ${overrides.title}`,
  status: 'pending',
  enabledTools: [],
  artifactIds: [],
  depth: 0,
  ...overrides,
});

describe('questGraphToMarkdown', () => {
  const nodes = [
    node({ id: 'n1', title: 'Spine', kind: 'spine', status: 'in_progress' }),
    node({ id: 'n3', title: 'Second child', parentId: 'n1', order: 2, depth: 1, dependsOn: ['n2'] }),
    node({
      id: 'n2',
      title: 'First child',
      parentId: 'n1',
      order: 1,
      depth: 1,
      status: 'completed',
      score: 0.9,
      reviewVerdict: 'approved',
      acceptanceCriteria: 'It works',
      completedAt: new Date('2026-01-02T03:04:05.000Z'),
    }),
  ];

  it('renders roots then children by order, nested one heading level per depth', () => {
    const md = questGraphToMarkdown(graph, nodes, options);
    const headings = md.split('\n').filter(line => line.startsWith('#'));

    expect(headings).toEqual(['# Research the market', '## Spine', '### First child', '### Second child']);
  });

  it('reports state and progress', () => {
    expect(questGraphToMarkdown(graph, nodes, options)).toContain('> State: active | Progress: 1/3 nodes');
  });

  it('names dependencies by title and renders review fields', () => {
    const md = questGraphToMarkdown(graph, nodes, options);

    expect(md).toContain('- **Depends on:** First child');
    expect(md).toContain('- **Score:** 0.9');
    expect(md).toContain('- **Review:** approved');
    expect(md).toContain('- **Completed:** 2026-01-02T03:04:05.000Z');
    expect(md).toContain('**Acceptance criteria:** It works');
  });

  it('carries the graph structure and the source id in front-matter', () => {
    const { data, body } = splitFrontMatter(questGraphToMarkdown(graph, nodes, { ...options, frontMatter: true }));
    const parsed = data as {
      source: unknown;
      rootNodeIds: string[];
      nodes: Array<{ id: string; parentId: string | null }>;
    };

    expect(parsed.source).toEqual({ kind: 'quest-graph', id: 'graph-1' });
    expect(parsed.rootNodeIds).toEqual(['n1']);
    expect(parsed.nodes.map(n => [n.id, n.parentId])).toEqual([
      ['n1', null],
      ['n3', 'n1'],
      ['n2', 'n1'],
    ]);
    expect(body).toBe(questGraphToMarkdown(graph, nodes, options));
  });

  it('renders a corrupt node timestamp as Invalid Date instead of throwing', () => {
    const corrupt = [node({ id: 'n1', title: 'Spine', startedAt: new Date('garbage') })];

    expect(() => questGraphToMarkdown(graph, corrupt, options)).not.toThrow();
    expect(questGraphToMarkdown(graph, corrupt, options)).toContain('- **Started:** Invalid Date');
  });

  it('serializes an empty graph', () => {
    const empty = { ...graph, rootNodeIds: [] };
    const { data, body } = splitFrontMatter(questGraphToMarkdown(empty, [], { ...options, frontMatter: true }));

    expect(data).toMatchObject({ source: { id: 'graph-1' }, rootNodeIds: [], nodes: [] });
    expect(body).toContain('> State: active | Progress: 0/0 nodes');
    expect(body).not.toContain('Unattached');
  });

  it('keeps an orphan and a parent cycle instead of dropping them', () => {
    const md = questGraphToMarkdown(
      graph,
      [
        node({ id: 'n1', title: 'Spine' }),
        node({ id: 'orphan', title: 'Lost', parentId: 'missing', order: 1 }),
        node({ id: 'a', title: 'Cycle A', parentId: 'b', order: 2 }),
        node({ id: 'b', title: 'Cycle B', parentId: 'a', order: 3 }),
      ],
      options
    );

    expect(md).toContain('## Unattached nodes');
    for (const title of ['Lost', 'Cycle A', 'Cycle B'])
      expect(md.match(new RegExp(`# ${title}\\n`, 'g'))).toHaveLength(1);
  });

  it('caps heading depth at six and keeps titles on one line', () => {
    const chain = Array.from({ length: 8 }, (_, i) =>
      node({
        id: `c${i}`,
        title: i === 0 ? 'Line one\nline two' : `Level ${i}`,
        parentId: i === 0 ? null : `c${i - 1}`,
        order: 0,
      })
    );
    const md = questGraphToMarkdown({ ...graph, rootNodeIds: ['c0'] }, chain, options);

    expect(md).toContain('## Line one line two\n');
    expect(md).not.toContain('#######');
  });
});

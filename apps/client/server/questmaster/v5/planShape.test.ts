import { describe, expect, it } from 'vitest';
import { MAX_PHASES, MAX_TASKS_PER_PHASE, buildPlanPrompt, extractPlan, planToNodes } from './planShape';

const phase = (title: string, taskTitles: string[]) => ({
  title,
  objective: `${title} objective`,
  tasks: taskTitles.map(t => ({ title: t, task: `do ${t}` })),
});

describe('planToNodes', () => {
  it('turns each phase into a spine root with its tasks as children', () => {
    const nodes = planToNodes({ phases: [phase('Research', ['a', 'b'])] });

    expect(nodes).toHaveLength(3);
    expect(nodes[0]).toMatchObject({ kind: 'spine', title: 'Research', parentIndex: null });
    expect(nodes[1]).toMatchObject({ kind: 'task', title: 'a', parentIndex: 0 });
    expect(nodes[2]).toMatchObject({ kind: 'task', title: 'b', parentIndex: 0 });
  });

  // Parallelism within a phase is the point: sequencing tasks that do not
  // actually depend on each other would make the graph slower for no reason.
  it('leaves tasks in the first phase with no dependencies', () => {
    const nodes = planToNodes({ phases: [phase('Research', ['a', 'b'])] });

    expect(nodes[1].dependsOnIndices).toEqual([]);
    expect(nodes[2].dependsOnIndices).toEqual([]);
  });

  it('makes every task of a phase wait for the whole previous phase', () => {
    const nodes = planToNodes({ phases: [phase('One', ['a', 'b']), phase('Two', ['c'])] });

    // 0 spine One, 1 a, 2 b, 3 spine Two, 4 c
    expect(nodes[4].dependsOnIndices).toEqual([1, 2]);
  });

  it('never gives a spine node dependencies - it is legibility, not work', () => {
    const nodes = planToNodes({ phases: [phase('One', ['a']), phase('Two', ['b'])] });

    for (const node of nodes.filter(n => n.kind === 'spine')) {
      expect(node.dependsOnIndices).toEqual([]);
    }
  });

  // Acyclic by construction: every edge points strictly backwards, so a cycle
  // is not expressible no matter what the model returns.
  it('only ever points dependencies at earlier nodes', () => {
    const nodes = planToNodes({
      phases: [phase('One', ['a', 'b']), phase('Two', ['c', 'd']), phase('Three', ['e'])],
    });

    nodes.forEach((node, index) => {
      for (const dep of node.dependsOnIndices) expect(dep).toBeLessThan(index);
      if (node.parentIndex !== null) expect(node.parentIndex).toBeLessThan(index);
    });
  });

  it('stays inside the graph node budget at maximum size', () => {
    const phases = Array.from({ length: MAX_PHASES }, (_, i) =>
      phase(
        `P${i}`,
        Array.from({ length: MAX_TASKS_PER_PHASE }, (_, j) => `t${i}-${j}`)
      )
    );

    // spine + tasks per phase, comfortably under the graph's 200-node default.
    expect(planToNodes({ phases }).length).toBe(MAX_PHASES * (1 + MAX_TASKS_PER_PHASE));
  });

  it('keeps acceptance criteria on the task that carries them', () => {
    const nodes = planToNodes({
      phases: [
        { title: 'P', objective: 'o', tasks: [{ title: 't', task: 'do t', acceptanceCriteria: 'must be true' }] },
      ],
    });

    expect(nodes[1].acceptanceCriteria).toBe('must be true');
  });
});

describe('extractPlan', () => {
  const valid = '{"phases":[{"title":"P","objective":"o","tasks":[{"title":"t","task":"do t"}]}]}';

  it('reads a bare JSON reply', () => {
    expect(extractPlan(valid)?.phases).toHaveLength(1);
  });

  // Models wrap JSON in prose and fences even when told not to.
  it('reads JSON wrapped in prose or a code fence', () => {
    expect(extractPlan(`Sure!\n\`\`\`json\n${valid}\n\`\`\`\nHope that helps.`)?.phases).toHaveLength(1);
  });

  it('returns null for a reply with no JSON at all', () => {
    expect(extractPlan('I cannot help with that.')).toBeNull();
  });

  it('returns null for malformed JSON rather than throwing', () => {
    expect(extractPlan('{"phases":[{"title":')).toBeNull();
  });

  // Schema-invalid is not the same as unparseable, and both must be survivable.
  it('rejects JSON that parses but is not a plan', () => {
    expect(extractPlan('{"phases":[]}')).toBeNull();
    expect(extractPlan('{"something":"else"}')).toBeNull();
    expect(extractPlan('{"phases":[{"title":"P","objective":"o","tasks":[]}]}')).toBeNull();
  });

  it('rejects a plan that exceeds the phase ceiling', () => {
    const many = Array.from({ length: MAX_PHASES + 1 }, (_, i) => phase(`P${i}`, ['t']));
    expect(extractPlan(JSON.stringify({ phases: many }))).toBeNull();
  });
});

describe('buildPlanPrompt', () => {
  it('carries the goal and the ceilings the schema enforces', () => {
    const prompt = buildPlanPrompt('conquer the world');

    expect(prompt).toContain('conquer the world');
    expect(prompt).toContain(String(MAX_PHASES));
    expect(prompt).toContain(String(MAX_TASKS_PER_PHASE));
  });
});

import { describe, it, expect } from 'vitest';
import mongoose from 'mongoose';
import { setupMongoTest } from '../../../__test__/utils';
import { hasCycle, isNodeReady, questGraphRepository, questNodeRepository } from '../QuestNodeModel';

const makeGraph = (overrides = {}) =>
  questGraphRepository.createGraph({
    goal: 'ship questmaster v5',
    userId: 'u1',
    ...overrides,
  });

const makeNode = (graphId: string, overrides = {}) =>
  questNodeRepository.addNode({
    graphId,
    title: 'a node',
    task: 'do the thing',
    ...overrides,
  });

describe('isNodeReady', () => {
  const statuses = (entries: [string, string][]) => new Map(entries) as Map<string, never>;

  it('is ready when pending with no dependencies', () => {
    expect(isNodeReady({ status: 'pending', dependsOn: [] }, statuses([]))).toBe(true);
  });

  it('is not ready while a dependency is unfinished', () => {
    expect(isNodeReady({ status: 'pending', dependsOn: ['a'] }, statuses([['a', 'in_progress']]))).toBe(false);
  });

  // A skipped dependency has to satisfy readiness, or deliberately dropping one
  // node would permanently wedge everything downstream of it.
  it('treats a skipped dependency as satisfied', () => {
    expect(isNodeReady({ status: 'pending', dependsOn: ['a'] }, statuses([['a', 'skipped']]))).toBe(true);
  });

  it('is not ready once the node itself has moved past pending/ready', () => {
    for (const status of ['in_progress', 'completed', 'failed', 'needs_review', 'blocked', 'skipped'] as const) {
      expect(isNodeReady({ status, dependsOn: [] }, statuses([]))).toBe(false);
    }
  });

  // A dependency id with no entry in the map (deleted node, or an id from
  // another graph) must read as unsatisfied, not silently as done.
  it('is not ready when a dependency is unknown', () => {
    expect(isNodeReady({ status: 'pending', dependsOn: ['ghost'] }, statuses([]))).toBe(false);
  });
});

describe('hasCycle', () => {
  it('returns false for a DAG and true for a back-edge', () => {
    expect(
      hasCycle(
        new Map([
          ['a', ['b']],
          ['b', ['c']],
          ['c', []],
        ])
      )
    ).toBe(false);
    expect(
      hasCycle(
        new Map([
          ['a', ['b']],
          ['b', ['a']],
        ])
      )
    ).toBe(true);
  });
});

describe('QuestGraph / QuestNode model', () => {
  setupMongoTest();

  it('creates a graph, a root node (depth 0) and a child (depth 1)', async () => {
    const graph = await makeGraph();
    expect(graph.state).toBe('draft');
    expect(graph.visibility).toBe('private');
    expect(graph.budget.maxDepth).toBe(5);
    expect(graph.budget.maxNodes).toBe(200);

    const root = await makeNode(graph.id, { kind: 'spine' });
    expect(root.depth).toBe(0);
    expect(root.status).toBe('pending');

    const updated = await questGraphRepository.addRootNode(graph.id, root.id);
    expect(updated?.rootNodeIds).toContain(root.id);

    const child = await makeNode(graph.id, { parentId: root.id });
    expect(child.depth).toBe(1);
  });

  it('rejects a node deeper than maxDepth', async () => {
    const graph = await makeGraph({ budget: { maxDepth: 1 } });
    const root = await makeNode(graph.id);
    const child = await makeNode(graph.id, { parentId: root.id }); // depth 1, allowed
    await expect(makeNode(graph.id, { parentId: child.id })).rejects.toThrow('max depth exceeded');
  });

  it('rejects a node beyond maxNodes', async () => {
    const graph = await makeGraph({ budget: { maxNodes: 1 } });
    await makeNode(graph.id);
    await expect(makeNode(graph.id)).rejects.toThrow('node budget exceeded');
  });

  it('rejects a dependency on a missing node', async () => {
    const graph = await makeGraph();
    const missing = new mongoose.Types.ObjectId().toString();
    await expect(makeNode(graph.id, { dependsOn: [missing] })).rejects.toThrow('dependency not found');
  });

  it('rejects an edge that would form a cycle', async () => {
    const graph = await makeGraph();
    const a = await makeNode(graph.id);
    const b = await makeNode(graph.id, { dependsOn: [a.id] }); // b -> a
    await expect(questNodeRepository.addDependency(a.id, b.id)).rejects.toThrow('dependency cycle detected');
  });

  it('addDependency canonicalizes a non-canonical dependency id before persisting', async () => {
    const graph = await makeGraph();
    const a = await makeNode(graph.id);
    const b = await makeNode(graph.id);

    // An ObjectId accepts differently-cased hex; the stored edge must be the
    // canonical lowercase String(_id), never the raw input.
    const updated = await questNodeRepository.addDependency(a.id, b.id.toUpperCase());
    expect(updated?.dependsOn).toContain(b.id);
    expect(updated?.dependsOn?.every(id => id === new mongoose.Types.ObjectId(id).toHexString())).toBe(true);
  });

  it('rejects a cycle even when the closing edge is supplied as a non-canonical id', async () => {
    const graph = await makeGraph();
    const a = await makeNode(graph.id);
    const b = await makeNode(graph.id, { dependsOn: [a.id] }); // b -> a
    // Uppercased hex of b closes a -> b -> a; a raw-id edge map would miss it.
    await expect(questNodeRepository.addDependency(a.id, b.id.toUpperCase())).rejects.toThrow(
      'dependency cycle detected'
    );
  });

  it('addDependency rejects ids that are not valid ObjectIds', async () => {
    const graph = await makeGraph();
    const a = await makeNode(graph.id);
    await expect(questNodeRepository.addDependency(a.id, 'not-an-id')).rejects.toThrow('dependency not found');
    await expect(questNodeRepository.addDependency('not-an-id', a.id)).rejects.toThrow('node not found');
  });

  it('addNode persists de-duplicated dependency ids', async () => {
    const graph = await makeGraph();
    const dep = await makeNode(graph.id);
    const node = await makeNode(graph.id, { dependsOn: [dep.id, dep.id] });
    expect(node.dependsOn).toEqual([dep.id]);
  });

  it('computeReadyNodes gates on dependency completion', async () => {
    const graph = await makeGraph();
    const dep = await makeNode(graph.id);
    const gated = await makeNode(graph.id, { dependsOn: [dep.id] });

    let ready = await questNodeRepository.computeReadyNodes(graph.id);
    expect(ready.map(n => n.id)).toContain(dep.id);
    expect(ready.map(n => n.id)).not.toContain(gated.id);

    await questNodeRepository.updateStatus(dep.id, 'completed');

    ready = await questNodeRepository.computeReadyNodes(graph.id);
    expect(ready.map(n => n.id)).toContain(gated.id);
  });

  it('claimForRun moves a runnable node to in_progress and stamps startedAt', async () => {
    const graph = await makeGraph();
    const node = await makeNode(graph.id);

    const claimed = await questNodeRepository.claimForRun(node.id);

    expect(claimed?.status).toBe('in_progress');
    expect(claimed?.startedAt).toBeInstanceOf(Date);
  });

  // The whole point of the atomic claim: two dispatches racing on one node
  // (double-clicked Run, or two scheduler ticks) must bill exactly one run.
  it('claimForRun lets exactly one of two concurrent claims win', async () => {
    const graph = await makeGraph();
    const node = await makeNode(graph.id);

    const results = await Promise.all([
      questNodeRepository.claimForRun(node.id),
      questNodeRepository.claimForRun(node.id),
    ]);

    expect(results.filter(Boolean)).toHaveLength(1);
  });

  it('claimForRun refuses a node that already completed', async () => {
    const graph = await makeGraph();
    const node = await makeNode(graph.id);
    await questNodeRepository.updateStatus(node.id, 'completed');

    expect(await questNodeRepository.claimForRun(node.id)).toBeNull();
  });

  it('claimForRun allows a retry of a failed node', async () => {
    const graph = await makeGraph();
    const node = await makeNode(graph.id);
    await questNodeRepository.updateStatus(node.id, 'failed');

    expect((await questNodeRepository.claimForRun(node.id))?.status).toBe('in_progress');
  });

  it('claimForRun returns null for a malformed id instead of throwing a cast error', async () => {
    expect(await questNodeRepository.claimForRun('not-an-object-id')).toBeNull();
  });

  it('updateStatus sets score, reviewVerdict and completedAt', async () => {
    const graph = await makeGraph();
    const node = await makeNode(graph.id);
    const when = new Date();

    const updated = await questNodeRepository.updateStatus(node.id, 'completed', {
      score: 0.92,
      reviewVerdict: 'approved',
      completedAt: when,
    });

    expect(updated?.status).toBe('completed');
    expect(updated?.score).toBe(0.92);
    expect(updated?.reviewVerdict).toBe('approved');
    expect(updated?.completedAt?.getTime()).toBe(when.getTime());
  });

  it('linkArtifacts is additive and de-duplicates', async () => {
    const graph = await makeGraph();
    const node = await makeNode(graph.id);

    await questNodeRepository.linkArtifacts(node.id, ['art1', 'art2']);
    const after = await questNodeRepository.linkArtifacts(node.id, ['art2', 'art3']);

    expect([...(after?.artifactIds ?? [])].sort()).toEqual(['art1', 'art2', 'art3']);
  });

  it('findByUserId is owner-scoped', async () => {
    const mine = await makeGraph({ userId: 'owner' });
    await makeGraph({ userId: 'someone-else' });

    const graphs = await questGraphRepository.findByUserId('owner');
    expect(graphs.map(g => g.id)).toEqual([mine.id]);
  });
});

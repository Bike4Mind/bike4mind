import { Artifact, QuestGraph, QuestNode } from '@bike4mind/database';
import { Types, mongo } from 'mongoose';
import { type MigrationFile } from './index';

const LOG = '[detach-foreign-quest-node-artifacts]';
const BATCH_SIZE = 500;

interface NodeRow {
  _id: Types.ObjectId;
  graphId: string;
  artifactIds: string[];
}

/**
 * Pull artifact ids off QuestMaster v5 nodes when the artifact belongs to someone other than the
 * graph's owner.
 *
 * The node read path (`linkNodeArtifacts`) joins artifacts by `sourceQuestId` and persists the
 * result onto the node with `$addToSet`. `sourceQuestId` is caller-supplied on the artifact create
 * endpoint, so before the join was scoped to the graph owner another user could get their artifact
 * attached to a victim's node. The scoped join stops new links; this removes the ids already
 * persisted. A node's run executes as the graph owner and writes its artifacts under that user, so
 * an owner mismatch is never the run's own output.
 *
 * Reads through the raw collections so soft-deleted nodes, graphs and artifacts are judged too: a
 * restored node must not come back carrying a planted ref. Ids whose artifact or graph no longer
 * exists are left alone, since ownership cannot be established for them.
 *
 * Idempotent: a re-run finds nothing foreign left to pull. The id is backdated below
 * BackfillOAuthClientTokenEndpointAuthMethod's 20260922000001, which must stay the highest on disk
 * (see that migration's docstring).
 */
// Typed to the projected row so the driver accepts a `$pull` on `artifactIds`; the model's own
// collection is untyped (`Document`), against which `$pull` does not typecheck.
const nodeCollection = () => QuestNode.collection as unknown as mongo.Collection<NodeRow>;

async function detachForeignNodeArtifacts(): Promise<{ scanned: number; nodesUpdated: number; detached: number }> {
  const cursor = nodeCollection().find(
    { 'artifactIds.0': { $exists: true } },
    { projection: { _id: 1, graphId: 1, artifactIds: 1 } }
  );

  let scanned = 0;
  let nodesUpdated = 0;
  let detached = 0;
  let batch: NodeRow[] = [];

  const flush = async () => {
    if (!batch.length) return;
    const result = await detachInBatch(batch);
    nodesUpdated += result.nodesUpdated;
    detached += result.detached;
    batch = [];
  };

  for await (const node of cursor) {
    scanned += 1;
    batch.push(node);
    if (batch.length >= BATCH_SIZE) await flush();
  }
  await flush();

  return { scanned, nodesUpdated, detached };
}

async function detachInBatch(nodes: NodeRow[]): Promise<{ nodesUpdated: number; detached: number }> {
  const graphObjectIds = [...new Set(nodes.map(n => n.graphId))]
    .filter(id => Types.ObjectId.isValid(id))
    .map(id => new Types.ObjectId(id));
  const graphs = await QuestGraph.collection
    .find<{ _id: Types.ObjectId; userId: string }>({ _id: { $in: graphObjectIds } }, { projection: { userId: 1 } })
    .toArray();
  const ownerByGraph = new Map(graphs.map(g => [String(g._id), g.userId]));

  const artifactIds = [...new Set(nodes.flatMap(n => n.artifactIds))];
  const artifacts = await Artifact.collection
    .find<{ id: string; userId: string }>({ id: { $in: artifactIds } }, { projection: { _id: 0, id: 1, userId: 1 } })
    .toArray();
  const ownerByArtifact = new Map(artifacts.map(a => [a.id, a.userId]));

  let detached = 0;
  const ops = nodes.flatMap((node): mongo.AnyBulkWriteOperation<NodeRow>[] => {
    const graphOwner = ownerByGraph.get(node.graphId);
    if (!graphOwner) return [];
    const foreign = node.artifactIds.filter(id => {
      const owner = ownerByArtifact.get(id);
      return owner !== undefined && owner !== graphOwner;
    });
    if (!foreign.length) return [];
    detached += foreign.length;
    return [{ updateOne: { filter: { _id: node._id }, update: { $pull: { artifactIds: { $in: foreign } } } } }];
  });

  if (ops.length) await nodeCollection().bulkWrite(ops);
  return { nodesUpdated: ops.length, detached };
}

const migration: MigrationFile = {
  id: 20260921235996,
  name: 'detach-foreign-quest-node-artifacts',

  up: async () => {
    const { scanned, nodesUpdated, detached } = await detachForeignNodeArtifacts();
    console.log(
      `${LOG} scanned ${scanned} node(s) with artifacts; detached ${detached} foreign artifact id(s) from ${nodesUpdated} node(s)`
    );
  },

  // No-op: re-attaching another user's artifact to a node is exactly what this migration removes.
  down: async () => {},
};

export default migration;

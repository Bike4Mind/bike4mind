import { ToolContext, ToolDefinition } from '../../base/types';
import {
  DATALAKE_TAG_PREFIX,
  effectiveTagPrefixArm,
  folderKeyOf,
  formatFileSize,
  UNCATEGORIZED_TAG_SUFFIX,
  type IFabFileRepository,
} from '@bike4mind/common';
import {
  filterRetrievalExcluded,
  normalizeExclusionMarkers,
  type RetrievalExclusionOptions,
} from '@bike4mind/utils/retrievalExclusion';
import { resolveSessionLakeAccess } from '../../base/resolveSessionLakeAccess';
import type { ResolvedLakeAccess } from '../../../../dataLakeService/getDynamicDataLakeTags';

/**
 * The SHAPE of a knowledge base - topics, folders, pipeline health - alongside
 * count_knowledge_base's cardinality (#1292). Without it the model could say how many documents a
 * lake holds but nothing about what they cover, so "what topics does this cover", "what folders
 * exist" or "is it fully indexed yet" got a guess or a flat refusal instead of an answer grounded
 * in the corpus's own metadata.
 *
 * Deliberately read-only and metadata-only, and every number here is self-labeled as a corpus
 * total: raw counts do not belong in the grounded context (see ChatCompletionFeatures.reportCoverage
 * for why), so this reaches the model only through an explicit tool call, exactly like
 * count_knowledge_base - never as ambient text a reply could be mistaken for having reviewed.
 */

/** Top-N content tags reported per lake - a rank, not the whole tag tree (design note: cap and rank). */
const TOPIC_TAG_LIMIT = 15;
/** Files sampled per lake to derive folder structure. A sample, not a census - see summarizeFolders. */
const FOLDER_SCAN_LIMIT = 500;
const FOLDER_TOP_N = 10;
/** Page size for the exclusion-enabled walk. Mirrors knowledgeBaseCount's own scan bounds. */
const SCAN_PAGE_SIZE = 200;
/** Bounds that walk. Past it the section reports a floor and says so, rather than a wrong total. */
const SCAN_MAX_PAGES = 10;
/** Bounds the `$in` behind the embedding-model sample - a diagnostic must not become the slow read. */
const EMBEDDING_SAMPLE_LIMIT = 200;

type SearchResultFile = Awaited<ReturnType<IFabFileRepository['search']>>['data'][number];

/** What one lake's section reports, however it was derived. See the two `collect*` functions. */
interface LakeShape {
  fileCount: number;
  totalSizeBytes: number;
  topics: { tag: string; count: number }[];
  folders: { folder: string; count: number }[];
  foldersSampled: boolean;
  health: {
    chunkedFiles: number;
    fullyVectorizedFiles: number;
    failedFiles: number;
    inFlightFiles: number;
    totalChunks: number;
    totalEmbeddedChunks: number;
  };
  /** Member ids the section was derived from, for the embedding-model read. Bounded, so a sample. */
  sampledFileIds: string[];
  /** True when a scan bound was reached, so the counts above are floors rather than totals. */
  partial: boolean;
}

/**
 * Whether the session withholds documents from retrieval. Same predicate, and the same reason, as
 * knowledgeBaseCount's: the DB clause is best-effort (it leans on a regex engine and a lowercase
 * field that may not be populated), so the authoritative pass runs in memory - which an aggregation
 * cannot do. An exclusion-enabled session therefore cannot use the aggregate path at all.
 */
function hasRetrievalExclusion(filter?: RetrievalExclusionOptions): boolean {
  return !!filter?.vectorizedOnly || normalizeExclusionMarkers(filter?.excludeFilenameMarkers).length > 0;
}

function formatTagList(tags: { tag: string; count: number }[]): string {
  return tags.length ? tags.map(t => `${t.tag} (${t.count})`).join(', ') : 'none';
}

/**
 * Folder counts derived from a bounded set of the lake's files, not a census - large lakes are
 * capped so this tool call stays fast; the model is told when it was.
 *
 * Uses the shared relativePath discriminator (folderKeyOf) rather than a truthy/separator check: the
 * lake wizard's flat picker sets relativePath to a file's own bare name on an ordinary single-file
 * upload, which is NOT folder evidence - a naive check would report a "folder" for nearly every file.
 */
function summarizeFolders(
  files: { fileName?: string | null; relativePath?: string | null }[]
): { folder: string; count: number }[] {
  const counts = new Map<string, number>();
  let unfiled = 0;
  for (const file of files) {
    const folder = file.relativePath && file.fileName ? folderKeyOf(file.relativePath, file.fileName) : null;
    if (folder) {
      counts.set(folder, (counts.get(folder) ?? 0) + 1);
    } else {
      unfiled += 1;
    }
  }
  const folders = [...counts.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, FOLDER_TOP_N)
    .map(([folder, count]) => ({ folder, count }));
  if (unfiled > 0) folders.push({ folder: '(no folder)', count: unfiled });
  return folders;
}

/**
 * The membership-signal tags that are not topics: the bare lake prefix, and the
 * `<prefix>uncategorized` placeholder the write doors stamp on a member no other content tag
 * covers. countDataLakeTopicTags excludes both in Mongo; this is the in-memory twin the walked
 * path needs, and the two must agree or a vectorizedOnly session would see a different topic list
 * from the same lake.
 *
 * `prefixArm` must come from `effectiveTagPrefixArm`, NOT from the lake's raw `fileTagPrefix`: the
 * membership filter drops the prefix arm for an unusable, reserved, or creator-less prefix, and a
 * lake whose arm was dropped never had those tags as membership evidence in the first place. It is
 * null in exactly that case, and then nothing under the prefix is excluded here either.
 */
function isMembershipSignalTag(name: string, prefixArm: string | null): boolean {
  if (name.toLowerCase().startsWith(DATALAKE_TAG_PREFIX)) return true;
  if (!prefixArm) return false;
  return name === prefixArm || name === `${prefixArm}${UNCATEGORIZED_TAG_SUFFIX}`;
}

/** Rank in-memory tag counts the same way the aggregate does: by document count, ties by name. */
function rankTopics(files: { tags?: { name?: unknown }[] | null }[], prefixArm: string | null) {
  const counts = new Map<string, number>();
  for (const file of files) {
    // Dedupe a document's own tag array: a file carrying the same tag twice (a real ingestion
    // shape) is ONE document for that topic. Same rule as countDataLakeTopicTags' $setUnion.
    const names = new Set(
      (file.tags ?? [])
        .map(t => t?.name)
        .filter((n): n is string => typeof n === 'string' && !isMembershipSignalTag(n, prefixArm))
    );
    for (const name of names) counts.set(name, (counts.get(name) ?? 0) + 1);
  }
  return [...counts.entries()]
    .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
    .slice(0, TOPIC_TAG_LIMIT)
    .map(([tag, count]) => ({ tag, count }));
}

/**
 * The health buckets, derived in memory from file rows. Field-for-field the same definitions as
 * FabFileRepository.summarizeDataLakeIndexingHealth's `$group`, which in turn tracks
 * evaluateMemberHealth - keep all three in step. `embeddedChunkCount`, NOT `vectorizedChunkCount`:
 * the latter counts an oversized un-embeddable chunk as done.
 */
function summarizeHealth(files: SearchResultFile[]): LakeShape['health'] {
  const health = {
    chunkedFiles: 0,
    fullyVectorizedFiles: 0,
    failedFiles: 0,
    inFlightFiles: 0,
    totalChunks: 0,
    totalEmbeddedChunks: 0,
  };
  for (const file of files) {
    const chunkCount = file.chunkCount ?? 0;
    const embedded = typeof file.embeddedChunkCount === 'number' ? file.embeddedChunkCount : null;
    const failed = typeof file.error === 'string' && file.error.length > 0;
    const vectorized = chunkCount > 0 && embedded !== null && embedded >= chunkCount;
    health.totalChunks += chunkCount;
    health.totalEmbeddedChunks += embedded ?? 0;
    if (failed) health.failedFiles += 1;
    if (chunkCount > 0) {
      health.chunkedFiles += 1;
      if (vectorized) health.fullyVectorizedFiles += 1;
      else if (!failed) health.inFlightFiles += 1;
    }
  }
  return health;
}

/**
 * The fast path: three scalar aggregations plus one bounded, lean member read for folder names -
 * no whole-lake hydration. Correct ONLY when the session withholds nothing, because the
 * retrieval-exclusion contract's authoritative pass is in-memory by design and an aggregation
 * cannot run it (see hasRetrievalExclusion).
 */
async function collectAggregated(context: ToolContext, lake: ResolvedLakeAccess): Promise<LakeShape> {
  const fabfiles = context.db.fabfiles!;
  const [stats, topics, health, members] = await Promise.all([
    fabfiles.computeDataLakeStats(lake.membership),
    fabfiles.countDataLakeTopicTags(lake.membership, TOPIC_TAG_LIMIT),
    fabfiles.summarizeDataLakeIndexingHealth(lake.membership),
    // Not `search`: that pays a full countDocuments for a `total` this path already has from
    // computeDataLakeStats. Same lean membership rows, one extra past the bound to detect overflow.
    fabfiles.findDataLakeMembershipMembers(lake.membership, FOLDER_SCAN_LIMIT),
  ]);
  const foldersSampled = members.length > FOLDER_SCAN_LIMIT;
  const sample = foldersSampled ? members.slice(0, FOLDER_SCAN_LIMIT) : members;
  return {
    fileCount: stats.fileCount,
    totalSizeBytes: stats.totalSizeBytes,
    topics,
    folders: summarizeFolders(sample),
    foldersSampled,
    health,
    sampledFileIds: sample.map(m => m.fabFileId),
    partial: false,
  };
}

/**
 * The exclusion path: walk the lake's members and derive every figure from the rows that SURVIVE
 * `filterRetrievalExcluded`.
 *
 * A session carrying `excludeFilenameMarkers`/`vectorizedOnly` has a contract that those documents
 * stay out of grounding, and `types.ts` documents that contract as failing OPEN for any tool that
 * skips it. A corpus size, a topic list or a folder name computed over the withheld documents
 * discloses exactly what the session said to withhold, so this path exists rather than an
 * exclusion arm bolted onto four aggregations - the same fork, for the same reason, that
 * knowledgeBaseCount makes. Bounded like that one, and reported as a floor when the bound is hit.
 */
async function collectWalked(
  context: ToolContext,
  lake: ResolvedLakeAccess,
  filter: RetrievalExclusionOptions
): Promise<LakeShape> {
  const fabfiles = context.db.fabfiles!;
  const options = {
    restrictToDataLake: true,
    includeShared: true,
    userGroups: context.user.groups ?? [],
    lakeMemberships: [lake.membership],
    excludeContent: true,
    ...filter,
  };

  const kept: SearchResultFile[] = [];
  let partial = true;
  for (let page = 1; page <= SCAN_MAX_PAGES; page++) {
    const result = await fabfiles.search(
      context.userId,
      '',
      {},
      { page, limit: SCAN_PAGE_SIZE },
      { by: 'fileName', direction: 'asc' },
      options
    );
    kept.push(...filterRetrievalExcluded(result.data, filter));
    if (!result.hasMore) {
      partial = false;
      break;
    }
  }

  return {
    fileCount: kept.length,
    totalSizeBytes: kept.reduce((n, f) => n + (f.fileSize ?? 0), 0),
    topics: rankTopics(kept, effectiveTagPrefixArm(lake.membership)),
    folders: summarizeFolders(kept),
    // The walk itself is the sample, so there is no second, folder-specific bound to disclose.
    foldersSampled: false,
    health: summarizeHealth(kept),
    sampledFileIds: kept.map(f => String(f.id ?? '')).filter(Boolean),
    partial,
  };
}

/**
 * The models this lake's chunks were ACTUALLY embedded with, from a bounded sample of its members.
 *
 * The platform default answers "what would a new ingest use", which is not the question a corpus-
 * shape tool is asked: a lake still carrying an older model is exactly the lake where retrieval
 * quietly returns less than the user expects, and reporting the default alone hides that. Sampled
 * from `sampledFileIds`, which arrive `_id`-ascending and so skew OLDEST-first - the direction that
 * surfaces a stale model rather than hiding it.
 *
 * Degrades to `null` (the caller then reports the platform default alone) when the chunk repo is
 * not wired or the read fails: a diagnostic must never be what fails the tool call.
 */
async function sampleCorpusEmbeddingModels(context: ToolContext, fileIds: string[]): Promise<string[] | null> {
  const chunks = context.db.fabfilechunks;
  if (!chunks?.distinctRetrievalIndexModelsByFabFileIds || fileIds.length === 0) return null;
  try {
    return await chunks.distinctRetrievalIndexModelsByFabFileIds(fileIds.slice(0, EMBEDDING_SAMPLE_LIMIT));
  } catch (error) {
    context.logger.warn('Knowledge Base Describe: embedding-model sample failed:', error);
    return null;
  }
}

/**
 * One lake's corpus-shape section. Every read is scoped through `lake.membership` - the SAME
 * membership predicate count_knowledge_base counts through - rather than a second, independently
 * written predicate; see countDataLakeTopicTags's own docblock for the parity bug that mistake
 * already caused once on this codebase.
 */
async function describeLake(
  context: ToolContext,
  lake: ResolvedLakeAccess,
  filter: RetrievalExclusionOptions
): Promise<string> {
  const [doc, shape] = await Promise.all([
    findLakeDocument(context, lake),
    hasRetrievalExclusion(filter) ? collectWalked(context, lake, filter) : collectAggregated(context, lake),
  ]);
  const models = await sampleCorpusEmbeddingModels(context, shape.sampledFileIds);
  const { health } = shape;

  const lines = [`## ${lake.name} (${lake.source} lake)`];
  if (doc?.description) lines.push(`- Description: ${doc.description}`);
  if (doc?.status) lines.push(`- Status: ${doc.status}`);
  lines.push(
    `- Corpus size: ${shape.partial ? 'at least ' : ''}${shape.fileCount} document(s), ` +
      `${formatFileSize(shape.totalSizeBytes)}`
  );
  lines.push(
    `- Pipeline health, live: ${health.chunkedFiles} chunked, ${health.fullyVectorizedFiles} fully vectorized, ` +
      `${health.inFlightFiles} still indexing, ${health.failedFiles} failed, ` +
      `${health.totalChunks} chunk(s) total (${health.totalEmbeddedChunks} carrying a vector)`
  );
  lines.push(`- Top topics: ${formatTagList(shape.topics)}`);
  lines.push(
    `- Folders${shape.foldersSampled ? ` (sampled from ${FOLDER_SCAN_LIMIT} files)` : ''}: ` +
      (shape.folders.length ? shape.folders.map(f => `${f.folder} (${f.count})`).join(', ') : 'none')
  );
  if (models?.length) {
    lines.push(`- Embedded with (sampled from this corpus): ${models.join(', ')}`);
  }
  if (doc?.lastSyncAt) lines.push(`- Last ingest: ${doc.lastSyncAt.toISOString()}`);
  if (shape.partial) {
    lines.push(
      `- Note: this session withholds part of the corpus from retrieval, so the figures above are ` +
        `counted over what it can retrieve and stopped at a scan limit - read them as floors.`
    );
  }

  return lines.join('\n');
}

/**
 * The lake's backing document, for description/status/last-ingest. Dynamic lakes ONLY: a registry
 * lake's id is a string slug (`'opti-knowledge'`), and findById has no ObjectId guard, so asking
 * for one throws a Mongoose CastError on the NORMAL case - which would then be logged as the
 * genuine DB error this warn exists for. A registry lake has no such document by design.
 */
async function findLakeDocument(context: ToolContext, lake: ResolvedLakeAccess) {
  if (lake.source !== 'dynamic' || !context.db.dataLakes) return null;
  try {
    return await context.db.dataLakes.findById(lake.id);
  } catch (error) {
    // Logged rather than swallowed: with the registry case ruled out above, a failure here is a
    // real DB error, and the omitted fields would otherwise look like an intentional design choice.
    context.logger.warn(`Knowledge Base Describe: lake document lookup failed for ${lake.id}:`, error);
    return null;
  }
}

/** Closing instruction shared by every arm: distinguish the corpus from what this turn retrieved. */
const REPORTING_NOTE =
  '\n\nThese are live corpus totals, not what was retrieved this turn - always keep the two distinct ' +
  '(e.g. "the corpus holds 585 documents; this turn retrieved 12 chunks from 8 of them"). Topics and ' +
  'folders are the top entries by document count, not the full list. Never present a corpus total as ' +
  'something you have read or reviewed - it describes the library, not what is in front of you.';

export const describeKnowledgeBaseTool: ToolDefinition = {
  name: 'describe_knowledge_base',
  implementation: context => ({
    toolFn: async () => {
      await context.onStart?.('describe_knowledge_base', {});

      if (!context.db.fabfiles) {
        return 'Knowledge base description is not available at this time.';
      }

      try {
        // Agent-scoped KB restriction (see KbScope): a fixed file set has no lake metadata, tag
        // tree or folder structure to describe, so this arm stays a plain count rather than
        // pretending to a breakdown the scope cannot supply.
        const scope = context.kbScope;
        if (scope) {
          if (scope.fileIds.length === 0) {
            return "This agent's knowledge base contains no documents.";
          }
          return (
            `This agent's knowledge base is a fixed set of ${scope.fileIds.length} document(s). Topic, folder ` +
            `and pipeline-health detail is only available for a data lake.${REPORTING_NOTE}`
          );
        }

        // Narrowed to the session's lake, same as count_knowledge_base and for the same reason: a
        // session scoped to one lake must not enumerate, or name, every other lake its owner can reach.
        const { lakes } = await resolveSessionLakeAccess(context);

        if (lakes.length === 0) {
          return (
            'You have no data lake / curated library available in this session, so there is no corpus shape ' +
            'to describe. Your knowledge base is your own and shared files - use count_knowledge_base for a total.'
          );
        }

        const filter = context.retrievalFilter ?? {};
        const [embeddingModel, ...descriptions] = await Promise.all([
          context.db.adminSettings.getSettingsValue('defaultEmbeddingModel').catch(() => undefined),
          ...lakes.map(lake => describeLake(context, lake, filter)),
        ]);

        context.logger.log(`📚 Knowledge Base Describe: ${lakes.length} lake(s)`);

        return (
          `Corpus shape for the knowledge base (Data Lake) you can access:\n\n${descriptions.join('\n\n')}` +
          `\n\nEmbedding model for new ingests (platform default): ${embeddingModel ?? 'not configured'}.` +
          `${REPORTING_NOTE}`
        );
      } catch (error) {
        context.logger.error('❌ Knowledge Base Describe: failed:', error);
        return (
          'Could not describe the knowledge base right now. Tell the user the corpus shape is unavailable ' +
          'rather than guessing at topics, folders or pipeline health.'
        );
      }
    },
    toolSchema: {
      name: 'describe_knowledge_base',
      description:
        'The SHAPE of the knowledge base / Data Lake: top topics (content tags), folder structure, pipeline ' +
        'health (how much is chunked/vectorized/failed), corpus size, and the embedding model in use. Use this ' +
        'for "what topics does this cover", "what folders exist", "is it fully indexed yet", or before scoping ' +
        'a search to part of the corpus. For a simple document count use count_knowledge_base instead. Takes ' +
        'no arguments and returns per-library detail.',
      parameters: { type: 'object', properties: {}, required: [] },
    },
  }),
};

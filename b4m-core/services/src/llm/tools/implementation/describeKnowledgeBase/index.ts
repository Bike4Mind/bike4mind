import { ToolContext, ToolDefinition } from '../../base/types';
import { folderKeyOf, formatFileSize, type IFabFileRepository } from '@bike4mind/common';
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
/** Bounds the per-file health scan so one very large lake cannot stall this tool call. */
const HEALTH_SCAN_LIMIT = 10_000;

type SearchResultFile = Awaited<ReturnType<IFabFileRepository['search']>>['data'][number];

function formatTagList(tags: { tag: string; count: number }[]): string {
  return tags.length ? tags.map(t => `${t.tag} (${t.count})`).join(', ') : 'none';
}

/**
 * Folder counts derived from a SAMPLE of the lake's files (FOLDER_SCAN_LIMIT), not a census - large
 * lakes are capped so this tool call stays fast; the model is told when it was.
 *
 * Uses the shared relativePath discriminator (folderKeyOf) rather than a truthy/separator check: the
 * lake wizard's flat picker sets relativePath to a file's own bare name on an ordinary single-file
 * upload, which is NOT folder evidence - a naive check would report a "folder" for nearly every file.
 */
function summarizeFolders(files: Pick<SearchResultFile, 'fileName' | 'relativePath'>[]): {
  folders: { folder: string; count: number }[];
  sampled: boolean;
} {
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
  return { folders, sampled: files.length >= FOLDER_SCAN_LIMIT };
}

/**
 * One lake's corpus-shape section. Every read is scoped through `lake.membership` - the SAME
 * membership predicate count_knowledge_base counts through - rather than a second, independently
 * written predicate; see countDataLakeTopicTags's own docblock for the parity bug that mistake
 * already caused once on this codebase.
 */
async function describeLake(context: ToolContext, lake: ResolvedLakeAccess): Promise<string> {
  const fabfiles = context.db.fabfiles!;
  const searchOptions = {
    restrictToDataLake: true,
    includeShared: true,
    userGroups: context.user.groups ?? [],
    lakeMemberships: [lake.membership],
    excludeContent: true,
  };

  const [doc, stats, topics, health, filesPage] = await Promise.all([
    // Registry lakes have no backing document to find by id; a lookup miss just omits
    // description/status/last-ingest for that lake rather than failing the whole call. Logged (not
    // swallowed silently) so a genuine DB error is distinguishable from "no such document" - the
    // omission would otherwise be indistinguishable from an intentional design choice.
    context.db.dataLakes?.findById(lake.id).catch(error => {
      context.logger.warn(`Knowledge Base Describe: lake document lookup failed for ${lake.id}:`, error);
      return null;
    }) ?? Promise.resolve(null),
    fabfiles.computeDataLakeStats(lake.membership),
    fabfiles.countDataLakeTopicTags(lake.membership, TOPIC_TAG_LIMIT),
    fabfiles.findDataLakeHealthMembers(lake.membership, HEALTH_SCAN_LIMIT),
    fabfiles.search(
      context.userId,
      '',
      {},
      { page: 1, limit: FOLDER_SCAN_LIMIT },
      { by: 'fileName', direction: 'asc' },
      searchOptions
    ),
  ]);

  // findDataLakeHealthMembers fetches one extra row past `limit` to signal overflow; trim it back
  // so a truncated lake's totals reflect exactly HEALTH_SCAN_LIMIT members, not limit + 1.
  const healthSampled = health.length > HEALTH_SCAN_LIMIT;
  const healthMembers = healthSampled ? health.slice(0, HEALTH_SCAN_LIMIT) : health;
  const chunkedFiles = healthMembers.filter(f => f.chunkCount > 0).length;
  const vectorizedFiles = healthMembers.filter(
    f => f.chunkCount > 0 && (f.vectorizedChunkCount ?? 0) >= f.chunkCount
  ).length;
  const failedFiles = healthMembers.filter(f => f.error !== null).length;
  const totalChunks = healthMembers.reduce((n, f) => n + f.chunkCount, 0);
  const totalVectorizedChunks = healthMembers.reduce((n, f) => n + (f.vectorizedChunkCount ?? 0), 0);

  const { folders, sampled: foldersSampled } = summarizeFolders(filesPage.data);

  const lines = [`## ${lake.name} (${lake.source} lake)`];
  if (doc?.description) lines.push(`- Description: ${doc.description}`);
  if (doc?.status) lines.push(`- Status: ${doc.status}`);
  lines.push(`- Corpus size: ${stats.fileCount} document(s), ${formatFileSize(stats.totalSizeBytes)}`);
  lines.push(
    `- Pipeline health, live${healthSampled ? ` (sampled at the first ${HEALTH_SCAN_LIMIT} members)` : ''}: ` +
      `${chunkedFiles} chunked, ${vectorizedFiles} fully vectorized, ${failedFiles} failed, ` +
      `${totalChunks} chunk(s) total (${totalVectorizedChunks} vectorized)`
  );
  lines.push(`- Top topics: ${formatTagList(topics)}`);
  lines.push(
    `- Folders${foldersSampled ? ` (sampled from the first ${FOLDER_SCAN_LIMIT} files)` : ''}: ` +
      (folders.length ? folders.map(f => `${f.folder} (${f.count})`).join(', ') : 'none')
  );
  if (doc?.lastSyncAt) lines.push(`- Last ingest: ${doc.lastSyncAt.toISOString()}`);

  return lines.join('\n');
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

        const [embeddingModel, ...descriptions] = await Promise.all([
          context.db.adminSettings.getSettingsValue('defaultEmbeddingModel').catch(() => undefined),
          ...lakes.map(lake => describeLake(context, lake)),
        ]);

        context.logger.log(`📚 Knowledge Base Describe: ${lakes.length} lake(s)`);

        return (
          `Corpus shape for the knowledge base (Data Lake) you can access:\n\n${descriptions.join('\n\n')}` +
          `\n\nEmbedding model in use: ${embeddingModel ?? 'not configured'}.${REPORTING_NOTE}`
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

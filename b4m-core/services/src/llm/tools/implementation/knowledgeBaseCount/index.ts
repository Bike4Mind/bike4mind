import { ToolContext, ToolDefinition } from '../../base/types';
import type { IFabFileRepository } from '@bike4mind/common';
import {
  filterRetrievalExcluded,
  normalizeExclusionMarkers,
  type RetrievalExclusionOptions,
} from '@bike4mind/utils/retrievalExclusion';
import { getDynamicDataLakeAccess, type ResolvedLakeAccess } from '../../../../dataLakeService/getDynamicDataLakeTags';

/**
 * How many documents a library holds - the one knowledge-base question ranked passage retrieval
 * cannot answer. Without it the model treated a count request as proof it had no access to the
 * corpus at all and improvised infrastructure advice (SQL, storage consoles, object counts), so
 * the fix is a real capability rather than better wording.
 *
 * Counts through the SAME membership predicate as the single-lake browse, so the number equals
 * the total on the lake's page in the product - the number a user checks it against.
 */

/** Page size for the walked count. Only the exclusion path pages; the plain path uses one count. */
const SCAN_PAGE_SIZE = 200;
/** Bounds the walked count. A library past this reports a floor rather than a guess. */
const SCAN_MAX_PAGES = 10;

type SearchFilters = Parameters<IFabFileRepository['search']>[2];
type ScopeOptions = Parameters<IFabFileRepository['search']>[5];

/** Everything that narrows a count to one corpus: a lake, an agent's scope, or the caller's files. */
interface CountScope {
  filters?: SearchFilters;
  options: ScopeOptions;
}

interface CountResult {
  count: number;
  /** False when a scan bound was reached, so `count` is a floor rather than a total. */
  exact: boolean;
}

/**
 * Whether the session withholds documents from retrieval. When it does, the DB count is an
 * overstatement - the filter's own contract is that the authoritative pass runs in memory
 * (see isRetrievalExcluded), because the DB clause depends on a regex engine and a lowercase
 * field that may not be populated. So an exclusion-enabled session cannot use countDocuments.
 */
function hasRetrievalExclusion(filter?: RetrievalExclusionOptions): boolean {
  return !!filter?.vectorizedOnly || normalizeExclusionMarkers(filter?.excludeFilenameMarkers).length > 0;
}

/**
 * Count the files a scope matches. Reports a floor rather than a number it cannot stand behind:
 * on an exclusion-enabled session the count must be walked and filtered in memory, and a library
 * past SCAN_PAGE_SIZE * SCAN_MAX_PAGES stops short.
 */
async function countScope(context: ToolContext, scope: CountScope): Promise<CountResult> {
  const fabfiles = context.db.fabfiles!;
  const filter = context.retrievalFilter ?? {};
  const filters: SearchFilters = { tags: [], shared: false, ...scope.filters };
  const options: ScopeOptions = { ...scope.options, excludeContent: true, ...filter };

  if (!hasRetrievalExclusion(filter)) {
    const page = await fabfiles.search(
      context.userId,
      '',
      filters,
      { page: 1, limit: 1 },
      { by: 'fileName', direction: 'asc' },
      options
    );
    return { count: page.total, exact: true };
  }

  let count = 0;
  for (let page = 1; page <= SCAN_MAX_PAGES; page++) {
    const result = await fabfiles.search(
      context.userId,
      '',
      filters,
      { page, limit: SCAN_PAGE_SIZE },
      // Paging a non-total order can repeat or skip rows across pages; stableSort makes the
      // fileName sort a total order so the walk visits each document exactly once.
      { by: 'fileName', direction: 'asc' },
      { ...options, stableSort: true }
    );
    count += filterRetrievalExcluded(result.data, filter).length;
    if (!result.hasMore) return { count, exact: true };
  }
  return { count, exact: false };
}

/** The scope arm a lake is counted through - see ResolvedLakeAccess.source for why they differ. */
function lakeScope(lake: ResolvedLakeAccess, context: ToolContext): CountScope {
  return {
    options: {
      // Drops the broad owner/shared arms so the count covers ONLY this lake, matching the
      // single-lake browse rather than every file the caller happens to own.
      restrictToDataLake: true,
      includeShared: true,
      userGroups: context.user.groups ?? [],
      ...(lake.membership
        ? { lakeMembership: lake.membership }
        : { dataLakeTags: [lake.datalakeTag], dataLakeTagPrefixes: [lake.fileTagPrefix] }),
    },
  };
}

function describeCount({ count, exact }: CountResult): string {
  return exact ? `${count} document(s)` : `at least ${count} document(s) (counting stopped at a scan limit)`;
}

/** Closing instruction shared by every arm: the number is the answer, not the plumbing. */
const REPORTING_NOTE =
  '\n\nThese are live counts from the document records - the same totals the library shows on its page in the ' +
  'product. State the number plainly. Do not describe how it was obtained, do not guess beyond it, and never ' +
  'suggest SQL, storage consoles or other infrastructure steps for counting.';

export const knowledgeBaseCountTool: ToolDefinition = {
  name: 'count_knowledge_base',
  implementation: context => ({
    toolFn: async () => {
      await context.onStart?.('count_knowledge_base', {});

      if (!context.db.fabfiles) {
        return 'Knowledge base counting is not available at this time.';
      }

      try {
        // Agent-scoped KB restriction (see KbScope): the scope is the whole corpus this caller
        // can see, and owner-wide lake resolution must stay unreachable from here. Counted live
        // rather than as scope.fileIds.length so deleted or withheld files are not counted.
        const scope = context.kbScope;
        if (scope) {
          if (scope.fileIds.length === 0) {
            return "This agent's knowledge base contains no documents.";
          }
          const scoped = await countScope(context, {
            filters: { restrictToFileIds: scope.fileIds },
            options: { skipOwnership: true, includeShared: false, userGroups: [] },
          });
          return `This agent's knowledge base contains ${describeCount(scoped)}.${REPORTING_NOTE}`;
        }

        const { lakes } = await getDynamicDataLakeAccess(context);

        if (lakes.length === 0) {
          // No curated library, but the caller's own and shared files are still what
          // search_knowledge_base reads, so counting nothing here would misreport the corpus.
          const own = await countScope(context, {
            options: { includeShared: true, userGroups: context.user.groups ?? [] },
          });
          return (
            `You have no data lake / curated library available in this session. Your knowledge base is your own and ` +
            `shared files: ${describeCount(own)}.${REPORTING_NOTE}`
          );
        }

        const counted = await Promise.all(
          lakes.map(async lake => ({ lake, result: await countScope(context, lakeScope(lake, context)) }))
        );

        const lines = counted.map(({ lake, result }) => `- ${lake.name}: ${describeCount(result)}`);
        const total = counted.reduce((n, c) => n + c.result.count, 0);
        const totalExact = counted.every(c => c.result.exact);
        const totalLine =
          counted.length > 1
            ? `\n\nTotal across ${counted.length} libraries: ${describeCount({ count: total, exact: totalExact })}.`
            : '';

        context.logger.log(
          `🔢 Knowledge Base Count: ${counted.length} lake(s), total ${total}${totalExact ? '' : '+'}`
        );

        return `Document counts for the knowledge base (Data Lake) you can access:\n${lines.join(
          '\n'
        )}${totalLine}${REPORTING_NOTE}`;
      } catch (error) {
        context.logger.error('❌ Knowledge Base Count: failed:', error);
        return 'Could not count the knowledge base right now. Tell the user the count is unavailable rather than guessing a number.';
      }
    },
    toolSchema: {
      name: 'count_knowledge_base',
      description:
        'How MANY documents the knowledge base / Data Lake holds. Use this for any cardinality question ("how many documents/papers/files are in it", "how big is the library", "is anything in there") - search_knowledge_base ranks passages and can never answer that. Takes no arguments and returns per-library totals. Never estimate a corpus size without calling this.',
      parameters: { type: 'object', properties: {}, required: [] },
    },
  }),
};

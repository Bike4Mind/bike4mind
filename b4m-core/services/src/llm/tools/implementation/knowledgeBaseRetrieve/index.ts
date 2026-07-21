import { ToolDefinition } from '../../base/types';
import { CitableSource, IFabFileDocument } from '@bike4mind/common';
import { filterRetrievalExcluded, isRetrievalExcluded } from '@bike4mind/utils/retrievalExclusion';
import { getDynamicDataLakeAccess } from '../../../../dataLakeService/getDynamicDataLakeTags';

interface KnowledgeBaseRetrieveParams {
  file_id?: string;
  tags?: string[];
  query?: string;
  max_chars?: number;
}

const DEFAULT_MAX_CHARS = 8000;
const ABSOLUTE_MAX_CHARS = 16000;

/**
 * A directly-fetched file is eligible for retrieval only when it is live (not deleted/
 * archived) and not retrieval-excluded. Fail-closed: any excluded file reads as
 * not-found so a direct id probe leaks no existence. Shared by both direct-fetch sites.
 */
function isLiveVisibleFile(
  file: IFabFileDocument | null | undefined,
  retrievalFilter: Parameters<typeof isRetrievalExcluded>[1]
): file is IFabFileDocument {
  return !!file && !file.deletedAt && !file.archivedAt && !isRetrievalExcluded(file, retrievalFilter);
}

export const knowledgeBaseRetrieveTool: ToolDefinition = {
  name: 'retrieve_knowledge_content',
  implementation: context => {
    // Per-completion retrieve counter (closure created once per completion). Since
    // search_knowledge_base now returns passage content inline, retrieval is rarely needed;
    // eager models still over-retrieve, so cap it and steer them back to composing.
    let retrieveCallCount = 0;
    const MAX_RETRIEVES = 2;
    return {
      toolFn: async value => {
        const params = value as KnowledgeBaseRetrieveParams;
        await context.onStart?.('retrieve_knowledge_content', params);
        const { file_id, tags, query, max_chars } = params;
        const charBudget = Math.min(max_chars ?? DEFAULT_MAX_CHARS, ABSOLUTE_MAX_CHARS);

        retrieveCallCount++;
        if (retrieveCallCount > MAX_RETRIEVES) {
          context.logger.log(`📖 Knowledge Retrieve: call #${retrieveCallCount} — capped, instructing model to answer`);
          return (
            `You have already retrieved ${retrieveCallCount - 1} documents and the content is in the conversation above. ` +
            `STOP retrieving and compose your complete answer NOW from what you have.`
          );
        }

        context.logger.log('📖 Knowledge Retrieve: params', { file_id, tags, query, max_chars: charBudget });

        if (!file_id && !tags?.length && !query) {
          return 'Error: You must provide at least one of file_id, tags, or query.';
        }

        if (!context.db.fabfiles) {
          context.logger.error('❌ Knowledge Retrieve: fabfiles repository not available');
          return 'Knowledge base retrieval is not available at this time.';
        }

        if (!context.db.fabfilechunks) {
          context.logger.error('❌ Knowledge Retrieve: fabfilechunks repository not available');
          return 'Knowledge base retrieval is not available at this time (chunk reader unavailable).';
        }

        // Generic retrieval exclusion (opt-in). Path A below bypasses fabfiles.search entirely,
        // so the query-builder exclusion never runs on it - we apply the SAME predicate in memory
        // here (shared source of truth: isRetrievalExcluded) so an excluded file can't be pulled
        // by a direct id probe on either the owned or shared branch. Fail-closed.
        const retrievalFilter = context.retrievalFilter ?? {};

        // Agent-scoped KB restriction (see KbScope). One shared not-found message for
        // out-of-scope, excluded, and genuinely-missing ids: distinguishing them would be an
        // existence oracle for files outside the scope (tool params arrive from the
        // conversation, so an end-user can probe arbitrary ids through the model).
        const scope = context.kbScope;
        const notFoundMsg = (id: string) =>
          `No document found with ID "${id}". The file may not exist or you may not have access to it. Try using search_knowledge_base to find the correct file ID.`;
        if (scope && scope.fileIds.length === 0) {
          return file_id ? notFoundMsg(file_id) : 'No documents found matching your request in your knowledge base.';
        }

        try {
          let files: IFabFileDocument[] = [];

          // Path A: direct file_id lookup
          if (file_id) {
            if (scope) {
              // Positive membership assertion BEFORE any DB lookup: an out-of-scope id never
              // touches the database, and the owner/shared access machinery below (including
              // getDynamicDataLakeAccess) is unreachable on this branch. Scope membership IS
              // the authorization - the agent owner curated these files for this audience.
              if (!scope.fileIds.includes(file_id)) {
                return notFoundMsg(file_id);
              }
              const scopedFile = await context.db.fabfiles.findById(file_id);
              if (isLiveVisibleFile(scopedFile, retrievalFilter)) {
                files = [scopedFile];
              }
            } else {
              // Try owned file first (fast path)
              const ownedFile = await context.db.fabfiles.findByIdAndUserId(file_id, context.userId);
              if (ownedFile) {
                // An excluded owned file is treated as not-found (falls through to the message
                // below), so a direct id probe leaks nothing - not even that the file exists.
                if (!isRetrievalExcluded(ownedFile, retrievalFilter)) {
                  files = [ownedFile];
                }
              } else {
                // Fallback: file may be accessible via data lake or sharing - fetch by ID
                // without ownership filter, then verify access via data lake tags, prefixes, or group sharing
                const sharedFile = await context.db.fabfiles.findById(file_id);
                if (isLiveVisibleFile(sharedFile, retrievalFilter)) {
                  const { dataLakeTags, dataLakeTagPrefixes } = await getDynamicDataLakeAccess(context);
                  const fileTags = sharedFile.tags?.map(t => t.name) || [];
                  const hasMetaTagAccess = dataLakeTags.some(dlt => fileTags.includes(dlt));
                  const hasPrefixAccess = dataLakeTagPrefixes.some(p => fileTags.some(t => t.startsWith(p)));
                  const hasShareAccess = sharedFile.users?.some(
                    (u: { userId: string; permissions: string[] }) =>
                      u.userId === context.userId && u.permissions?.some(p => p === 'read' || p === 'write')
                  );
                  const userGroups = context.user.groups || [];
                  const hasGroupAccess =
                    userGroups.length > 0 &&
                    sharedFile.groups?.some(
                      (g: { groupId: string; permissions: string[] }) =>
                        userGroups.includes(g.groupId) && g.permissions?.some(p => p === 'read' || p === 'write')
                    );
                  if (hasMetaTagAccess || hasPrefixAccess || hasShareAccess || hasGroupAccess) {
                    files = [sharedFile];
                  }
                }
              }
            }

            if (files.length === 0) {
              return notFoundMsg(file_id);
            }
          }

          // Path B: tag/query-based search
          if (files.length === 0 && (tags?.length || query)) {
            let searchResults;
            if (scope) {
              // Scoped: restrictToFileIds is the sole authority (skipOwnership - curated
              // files match even when owned by another user, matching Path A's
              // membership-is-authorization). No owner/shared/org expansion and no
              // data-lake resolution on this branch.
              searchResults = await context.db.fabfiles.search(
                context.userId,
                query || '',
                { tags: tags || [], shared: false, restrictToFileIds: scope.fileIds },
                { page: 1, limit: 5 },
                { by: 'fileName', direction: 'asc' },
                {
                  textSearch: true,
                  includeShared: false,
                  userGroups: [],
                  skipOwnership: true,
                  excludeContent: true, // Content fetched via chunks below, not the document field
                  ...retrievalFilter,
                }
              );
            } else {
              const { dataLakeTags, dataLakeTagPrefixes, scopedTagPrefixes } = await getDynamicDataLakeAccess(context);
              searchResults = await context.db.fabfiles.search(
                context.userId,
                query || '',
                { tags: tags || [], shared: false },
                { page: 1, limit: 5 },
                { by: 'fileName', direction: 'asc' },
                {
                  textSearch: true,
                  includeShared: true,
                  userGroups: context.user.groups || [],
                  dataLakeTags,
                  dataLakeTagPrefixes, // Static-registry (open) prefixes — match shared KB files
                  scopedTagPrefixes, // Dynamic-lake prefixes — matched only within owner/org access
                  excludeContent: true, // Content fetched via chunks below, not the document field
                  // Retrieval exclusion (opt-in) - best-effort DB pre-filter; authoritative pass below. No-op when unset.
                  ...retrievalFilter,
                }
              );
            }
            // Authoritative exclusion pass on top of the DB pre-filter (see filterRetrievalExcluded).
            files = filterRetrievalExcluded(searchResults.data, retrievalFilter);

            if (files.length === 0) {
              const searchDesc = [query && `query "${query}"`, tags?.length && `tags [${tags.join(', ')}]`]
                .filter(Boolean)
                .join(' and ');
              return `No documents found matching ${searchDesc}. Try broadening your search with search_knowledge_base.`;
            }
          }

          // Fetch chunks for each file, respecting char budget
          let totalCharsUsed = 0;
          const sections: string[] = [];
          const retrievedFiles: IFabFileDocument[] = [];

          for (const file of files) {
            if (totalCharsUsed >= charBudget) break;

            const chunks = await context.db.fabfilechunks!.findByFabFileId(file.id);

            if (chunks.length === 0) {
              context.logger.log(`📖 Knowledge Retrieve: No chunks for file ${file.fileName} (${file.id})`);
              continue;
            }

            // Concatenate chunk text in order
            const fullText = chunks.map(c => c.text).join('\n');
            const remainingBudget = charBudget - totalCharsUsed;
            const truncated = fullText.length > remainingBudget;
            const content = truncated ? fullText.slice(0, remainingBudget) : fullText;

            const fileTags = file.tags?.map(t => t.name).join(', ') || 'none';
            const charLabel = truncated ? `${content.length} (truncated from ${fullText.length})` : `${content.length}`;

            sections.push(
              `### ${file.fileName} (ID: ${file.id})\n` +
                `Tags: ${fileTags}\n` +
                `Chunks: ${chunks.length} | Characters: ${charLabel}\n` +
                `---\n` +
                content
            );

            totalCharsUsed += content.length;
            retrievedFiles.push(file);
          }

          if (retrievedFiles.length === 0) {
            return 'Found matching documents but they have no indexed content. The files may not have been processed yet.';
          }

          // Create citable source chips for the UI - mirrors web_search pattern
          const citables: CitableSource[] = retrievedFiles.map((file, index) => {
            const fileTags = (file.tags?.map(t => t.name) || [])
              .filter(t => !t.startsWith('datalake:')) // Hide internal meta-tags
              .slice(0, 4) // Keep chip description concise
              .join(', ');
            return {
              id: file.id,
              type: 'document' as const,
              title: file.fileName,
              url: `/opti?mode=datalake&article=${file.id}`,
              description: fileTags || undefined,
              timestamp: new Date().toISOString(),
              status: 'complete' as const,
              metadata: {
                sourceSystem: 'knowledge_base',
                tags: file.tags?.map(t => t.name) || [],
                relevanceScore: 1 - index * 0.1,
              },
            };
          });

          if (citables.length > 0) {
            await context.statusUpdate(
              {
                promptMeta: {
                  citables,
                },
              } as any,
              'Knowledge base content retrieved'
            );
            context.logger.log(`📖 Knowledge Retrieve: Stored ${citables.length} citables`);
          }

          const header = `Retrieved content from ${retrievedFiles.length} of ${files.length} document(s):\n`;
          return header + '\n' + sections.join('\n\n---\n\n');
        } catch (error) {
          context.logger.error('❌ Knowledge Retrieve: Error during retrieval:', error);
          return 'An error occurred while retrieving document content. Please try again.';
        }
      },
      toolSchema: {
        name: 'retrieve_knowledge_content',
        description:
          "Read the actual text content of knowledge base documents. Use this after search_knowledge_base to read documents by file ID, or provide tags/query to find and read documents in one step. Returns the full text content (up to the character budget) for grounding your responses in the user's curated knowledge.",
        parameters: {
          type: 'object',
          properties: {
            file_id: {
              type: 'string',
              description:
                'The file ID to retrieve (from search_knowledge_base results). Most efficient for single-document retrieval.',
            },
            tags: {
              type: 'array',
              items: { type: 'string' },
              description:
                'OPTIONAL tag filter (usually unnecessary — search_knowledge_base already returns the content you need). If used, real examples: "acme:vertical:healthcare", "acme:competitor:globex", "acme:type:product-spec".',
            },
            query: {
              type: 'string',
              description: 'Search query to find documents. Can be combined with tags for more targeted retrieval.',
            },
            max_chars: {
              type: 'number',
              description:
                'Maximum characters of content to return (default: 8000, max: 16000). Lower values for quick lookups, higher for detailed reading.',
              minimum: 500,
              maximum: 16000,
            },
          },
        },
      },
    };
  },
};

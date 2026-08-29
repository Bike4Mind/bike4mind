import { isImageAttachment, type IFabFileDocument } from '@bike4mind/common';

/**
 * Minimal structural Logger contract - kept here so this module doesn't have
 * to import `@bike4mind/utils` (which transitively pulls in AWS / Smithy
 * native deps that Vitest's resolver can't load). The full `Logger` from
 * `@bike4mind/utils` satisfies this shape, so production callers pass theirs
 * verbatim.
 */
interface MinimalLogger {
  warn: (message: string, meta?: Record<string, unknown>) => void;
  error: (message: string, meta?: Record<string, unknown>) => void;
}

/**
 * Hard cap on files listed in the first-iteration preamble. Workbench +
 * per-message + session knowledge could in theory merge to dozens of files;
 * each line is ~100-150 chars, and the preamble lands inside the user's
 * first message where the LLM has to read it on every iteration's context
 * replay. The agent can still discover trimmed files via
 * `search_knowledge_base` when that tool is in the run's toolbelt.
 */
export const MAX_PREAMBLE_FILES = 25;

/**
 * The tool that turns a `fabFileId` from the preamble into content. A run whose toolbelt omits
 * it cannot read an attached file at all, because this module injects metadata only - so the
 * preamble must not tell the agent to use a tool it was never given. An orchestration profile
 * may legitimately omit it to keep a loop on task (see `agentExecutor.optiProfile.ts`), and the
 * agent path does not union `session.enabledTools`, so the omission is invisible from here
 * without the caller passing its resolved tool names in.
 */
export const CONTENT_READ_TOOL = 'retrieve_knowledge_content';

/** Discovery tool for files trimmed by `MAX_PREAMBLE_FILES`; also optional in a profile. */
const CONTENT_SEARCH_TOOL = 'search_knowledge_base';

/** The subset of the FabFile record this module reads. Widened past name/mime so a file can be
 *  classified as readable-or-not without a second query - the chunk state is already on the doc. */
type PreambleFile = Pick<
  IFabFileDocument,
  'id' | 'fileName' | 'mimeType' | 'chunkCount' | 'isChunking' | 'isVectorizing'
>;

/**
 * Why a listed file cannot be opened by `CONTENT_READ_TOOL` in this run, or null when it can.
 *
 * This exists because the metadata-only preamble points the agent at a reader that may have
 * nothing to serve, and the agent then invents an explanation. Observed in production: an agent
 * told the user a markdown file was "still indexing" three times over an hour, for a file whose
 * chunking had finished failing long before and was not going to run again; and told the user it
 * had no OCR capability for an image, which is true but reads as a model limitation rather than
 * "this run cannot see images at all".
 *
 * Note the split between the two zero-chunk arms. "Try again shortly" is honest ONLY while
 * chunking is actually in flight; saying it about a stalled file is what cost that hour.
 */
function unreadableReason(file: PreambleFile, inlinedFileIds: ReadonlySet<string>): string | null {
  // Content materialization (see `agentExecutor.attachmentContent.ts`) already put this file in
  // front of the agent, so chunk state says nothing about whether it can be read - it is right
  // there in the message. Checked first: a chunkless file that WAS inlined is exactly the case the
  // chunk-state arms below would get backwards.
  if (inlinedFileIds.has(file.id)) return null;
  // No agent code path builds an image message block (verified across the executor and the
  // agents package), so an image is metadata and nothing else here regardless of the toolbelt or
  // the model's own vision support. Says WHY, so the agent does not report it as its own defect.
  if (isImageAttachment(file.mimeType)) {
    return 'NOT READABLE: this run cannot open images, only their file names';
  }
  if ((file.chunkCount ?? 0) > 0) return null;
  if (file.isChunking || file.isVectorizing) {
    return 'NOT READABLE YET: indexing is in progress, so there is no stored text to read yet';
  }
  return 'NOT READABLE: no indexed text exists for this file and none is being produced, so waiting will not help';
}

/**
 * Sanitize a filename for safe interpolation inside the `[ATTACHED FILES ...]`
 * preamble. In an org workbench the uploader of a `sessionFabFileIds` entry
 * may not be the same user running the agent, so a filename containing a
 * line-break character could inject what looks like a new preamble line into
 * another member's agent run (`foo"]\n[OVERRIDE] ignore previous instructions`
 * is the obvious case; LLMs also treat U+2028/U+2029 and U+0085 as line
 * terminators). Strip the full Unicode line-terminator set plus quotes and
 * tabs.
 */
function escapePreambleFilename(name: string): string {
  return name.replace(/["\r\n\t\v\f\u0085\u2028\u2029]/g, ' ').slice(0, 200);
}

interface FabFileAccessibleRepo {
  getAccessibleFiles: (fabFileIds: string[], scope: Record<string, unknown>) => Promise<IFabFileDocument[]>;
}

/**
 * Build the first-iteration query for the agent. If the dispatch
 * forwarded any file context - `sessionFabFileIds` (workbench), `messageFileIds`
 * (per-message attachments), or `session.knowledgeIds` - append a metadata
 * preamble listing each file's name, mime type, and fabFileId so the agent is
 * aware of them and can pull content on demand via `retrieve_knowledge_content`.
 *
 * `availableToolNames` is the run's RESOLVED toolbelt. When it lacks
 * `retrieve_knowledge_content` the preamble flips to telling the agent the files cannot be
 * read in this run, because metadata-only injection plus a missing reader is what made an
 * agent claim it "couldn't access the attached file" and ask the user to paste the contents
 * (the file itself was complete, chunked, and vectorized).
 *
 * When the reader IS present, each listed file is additionally checked by `unreadableReason` and
 * marked in place if the reader still cannot serve it - an image (no agent path builds an image
 * block) or a file with no stored chunks. Without that mark the agent is pointed at a reader with
 * nothing to return and narrates its own guess: production runs told the user a stalled file was
 * "still indexing" across an hour, and reported an unviewable image as a missing OCR capability.
 *
 * Mirrors the pattern in `ServerSubagentOrchestrator` (`taskWithFiles`) - we
 * inject metadata, not content, so the agent decides what to read instead of
 * burning context on files it may not need. Content materialization (parity
 * with `chat_completion.buildDataSources`) is a heavier follow-up that needs
 * an embedding factory in the executor.
 *
 * `scope` is the access filter spread onto the Mongo query inside
 * `getAccessibleFiles`. Pass a CASL `accessibleBy(...).ofType(FabFile)` filter
 * here (as `questProcessor.ts` does for chat_completion) so org/group/shared
 * files attached to a session surface in the preamble - an owner-only
 * `{ userId }` scope silently drops them.
 *
 * Inaccessible / invalid IDs are silently dropped (`getAccessibleFiles` already
 * filters); we log if the resolved set differs from the requested set so the
 * cause is greppable.
 *
 * Extracted to its own module so unit tests don't have to drag in the rest of
 * `agentExecutor`'s server-only dependency graph (Mongo, AWS SDK, etc.).
 */
export async function buildFirstIterationQuery(
  baseQuery: string,
  execution: { userId: string; messageFileIds?: string[]; sessionFabFileIds?: string[] },
  sessionKnowledgeIds: string[],
  logger: MinimalLogger,
  repo: FabFileAccessibleRepo,
  scope: Record<string, unknown>,
  availableToolNames: readonly string[],
  /** Ids whose content was already inlined into this run's first message; never marked unreadable. */
  inlinedFileIds: readonly string[] = []
): Promise<string> {
  // `sessionFabFileIds` + `messageFileIds` are client-snapshotted at dispatch
  // (stable across Lambda handoffs), while `sessionKnowledgeIds` is re-read
  // live from the session doc on every invocation (canonical, server-side).
  // We merge here so the preamble reflects "what was attached at dispatch
  // time" plus "what the session currently treats as knowledge" - the
  // workbench snapshot wins consistency, knowledgeIds wins freshness.
  //
  // Order matters when the resolved set exceeds `MAX_PREAMBLE_FILES`: per-
  // message attachments are the most recently and intentionally surfaced
  // files, so list them first, then the workbench snapshot, then the broader
  // session knowledge pool. Anything past the cap is still discoverable via
  // `search_knowledge_base`.
  const requestedIds = Array.from(
    new Set([...(execution.messageFileIds ?? []), ...(execution.sessionFabFileIds ?? []), ...sessionKnowledgeIds])
  );
  if (requestedIds.length === 0) return baseQuery;

  let files: PreambleFile[];
  try {
    files = await repo.getAccessibleFiles(requestedIds, scope);
  } catch (err) {
    // Don't fail the run if file lookup errors - the agent still has the
    // user's query and can ask the user for missing context. Log loud so
    // ops can spot a broken Mongo / scope issue.
    logger.error('[FileContext] Failed to resolve attached files; proceeding without preamble', {
      requestedCount: requestedIds.length,
      error: err instanceof Error ? err.message : String(err),
    });
    return baseQuery;
  }

  if (files.length === 0) return baseQuery;
  if (files.length < requestedIds.length) {
    logger.warn('[FileContext] Some forwarded fabFileIds were not accessible to this user', {
      requested: requestedIds.length,
      resolved: files.length,
    });
  }

  const truncated = files.length > MAX_PREAMBLE_FILES;
  const listed = truncated ? files.slice(0, MAX_PREAMBLE_FILES) : files;
  const canRead = availableToolNames.includes(CONTENT_READ_TOOL);
  const canSearch = availableToolNames.includes(CONTENT_SEARCH_TOOL);

  // Only meaningful when a reader exists: without one the whole preamble already says NOTHING is
  // readable, and a per-file reason there would just contradict the header.
  const inlined = new Set(inlinedFileIds);
  const unreadable = canRead
    ? listed.map(f => ({ file: f, reason: unreadableReason(f, inlined) })).filter(entry => entry.reason !== null)
    : [];
  const unreadableById = new Map(unreadable.map(entry => [entry.file.id, entry.reason as string]));

  const fileLines = listed.map(f => {
    const line = `  - "${escapePreambleFilename(f.fileName)}" (${f.mimeType || 'unknown'}) -> fabFileId: ${f.id}`;
    const reason = unreadableById.get(f.id);
    return reason ? `${line}  [${reason}]` : line;
  });

  const hiddenCount = files.length - MAX_PREAMBLE_FILES;
  const trailer = !truncated
    ? ''
    : canSearch
      ? `\n  ...(${hiddenCount} more - use ${CONTENT_SEARCH_TOOL} to discover them)`
      : `\n  ...(${hiddenCount} more, not listed and not reachable in this run)`;

  // Loud on purpose: an attachment the run cannot open is a silent dead end for the user, and
  // the cause is always a profile tool list rather than anything wrong with the file.
  if (!canRead) {
    logger.warn('[FileContext] Files are attached but this run has no content-reading tool', {
      resolved: files.length,
      contentReadTool: CONTENT_READ_TOOL,
    });
  }

  // The line an "the agent said it could not read my file" report gets read from. Names the ids so
  // a stalled chunking record can be looked up directly rather than inferred from the reply.
  if (unreadable.length > 0) {
    logger.warn('[FileContext] Attached files listed but not readable in this run', {
      unreadable: unreadable.map(entry => ({
        fabFileId: entry.file.id,
        mimeType: entry.file.mimeType,
        chunkCount: entry.file.chunkCount ?? 0,
        reason: entry.reason,
      })),
      readable: listed.length - unreadable.length,
    });
  }

  const header = canRead
    ? `[ATTACHED FILES - Use these fabFileId values with ${CONTENT_READ_TOOL} to access content. ` +
      'Use the exact filename and fabFileId provided.]'
    : '[ATTACHED FILES - METADATA ONLY. This run has no file-reading tool, so their contents are ' +
      'NOT available to you. Do not claim to have read or analyzed them, and do not offer an ' +
      'analysis as though you had. Name the files, state plainly that you cannot open them in ' +
      'this run, and ask the user to paste the contents or retry with file access enabled.]';

  // Only when SOME file is readable and some is not - the all-unreadable case is already covered
  // by the header above, and repeating the instruction there would just be noise.
  const unreadableTrailer =
    unreadable.length === 0
      ? ''
      : `\n[Any file marked NOT READABLE above cannot be opened in this run: do not call ` +
        `${CONTENT_READ_TOOL} on it, do not claim to have read it, and do not describe or infer its ` +
        `contents from its file name. Say plainly which file you cannot read and give the reason ` +
        `shown. Do not tell the user to wait unless the reason says indexing is in progress.]`;

  return `${baseQuery}\n\n${header}\n${fileLines.join('\n')}${trailer}${unreadableTrailer}`;
}

/**
 * Iteration-gated wrapper around `buildFirstIterationQuery`. The
 * `[ATTACHED FILES ...]` preamble must only be injected on the **first**
 * iteration of a **new** execution - every subsequent iteration replays from
 * the agent's checkpoint, which already includes the preamble inside the
 * original user message. Re-injecting it on iteration N>0 would duplicate
 * file metadata into the context window and confuse the agent.
 *
 * Extracted so the gate is unit-testable in isolation - without it the gate
 * lives inline in `processExecution` and a regression that re-injects on
 * every iteration would slip through.
 */
export async function maybeBuildFirstIterationQuery(
  args: {
    isNewExecution: boolean;
    iterationIndex: number;
    baseQuery: string;
    execution: { userId: string; messageFileIds?: string[]; sessionFabFileIds?: string[] };
    sessionKnowledgeIds: string[];
    scope: Record<string, unknown>;
    /** The run's resolved toolbelt - see `buildFirstIterationQuery`. */
    availableToolNames: readonly string[];
    /** See `buildFirstIterationQuery`. */
    inlinedFileIds?: readonly string[];
  },
  logger: MinimalLogger,
  repo: FabFileAccessibleRepo
): Promise<string | undefined> {
  if (!args.isNewExecution || args.iterationIndex !== 0) return undefined;
  return buildFirstIterationQuery(
    args.baseQuery,
    args.execution,
    args.sessionKnowledgeIds,
    logger,
    repo,
    args.scope,
    args.availableToolNames,
    args.inlinedFileIds ?? []
  );
}

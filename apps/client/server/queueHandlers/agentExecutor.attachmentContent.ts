import type { MessageContentObject, IMessage, IFabFileDocument, IAttachmentDelivery } from '@bike4mind/common';
// Type-only, so it is erased at compile time and this module carries no runtime dependency on
// `@bike4mind/utils` (whose native deps the client test resolver cannot load).
import type { FabFileNotice } from '@bike4mind/utils';

/**
 * Content materialization for the agent path - the "heavier follow-up" named in
 * `agentExecutor.firstIterationQuery.ts`, which until now injected attachment METADATA only and
 * pointed the agent at `retrieve_knowledge_content`. That reader serves stored CHUNKS, so an
 * attachment with none was unreachable no matter how healthy the file was, and an image was
 * unreachable always - no agent code path builds an image message block.
 *
 * This runs the same extractor the chat path uses (`processFabFilesServer`), so an agent turn gets
 * the same raw-content fallback, cosine excerpting, truncation notices and image blocks that a chat
 * turn does. It is injected rather than imported so this module stays free of the
 * `@bike4mind/utils` dependency graph in tests, matching how that function already takes
 * `resizeImageForModel` (#660).
 */

/**
 * Ceiling on total base64 image bytes inlined into ONE agent run.
 *
 * Chat sends an image once. An agent checkpoints `messages` to Mongo after EVERY iteration and
 * replays them on every continuation Lambda, so an inlined image is paid repeatedly and counts
 * against the 16MB BSON document limit for the life of the run. `processFabFilesServer` already
 * caps a single image (~3.5MB pre-encode, and it downscales first); this bounds the SUM so a
 * handful of large screenshots cannot push a checkpoint past what Mongo will store. Images past
 * the ceiling are reported through the same notice channel as any other undelivered attachment
 * rather than dropped silently.
 */
export const MAX_INLINED_IMAGE_BYTES = 4_000_000;

/** Serialized size of an image block, used against MAX_INLINED_IMAGE_BYTES. */
function imageBlockBytes(block: MessageContentObject): number {
  if (block.type === 'image') return block.source?.data?.length ?? 0;
  if (block.type === 'image_url') return block.image_url?.url?.length ?? 0;
  return 0;
}

export interface MaterializedAttachments {
  /** Extracted text, ready to append to the first-iteration query string. Empty when none. */
  text: string;
  /** Image blocks for the first user message. Empty when the run inlined no image. */
  imageBlocks: MessageContentObject[];
  /**
   * Ids whose content actually reached the message. The preamble builder marks a file NOT READABLE
   * from its chunk state, which is the WRONG answer for a chunkless file that got inlined here -
   * pass this set in so an inlined file is never described as unreachable.
   */
  inlinedFileIds: string[];
  /**
   * Subset of `inlinedFileIds` whose ENTIRE content is present - not a cosine excerpt or a
   * budget-truncated head. Only this set may back a "you already have everything, no need to
   * search further" claim (#1163); saying it for a merely-inlined file asserts something false.
   */
  fullyInlinedFileIds: string[];
  /** Per-file delivery problems, already phrased for a reader. */
  notices: FabFileNotice[];
  /** Requested-vs-delivered counts for the run, persisted onto the linked quest so the agent path
   *  records attachment outcomes the way the chat path does. Present on every return, including
   *  the fallbacks - a run whose extraction failed wholesale still owes the caller that report. */
  delivery: IAttachmentDelivery;
}

const EMPTY: MaterializedAttachments = {
  text: '',
  imageBlocks: [],
  inlinedFileIds: [],
  fullyInlinedFileIds: [],
  notices: [],
  delivery: { requested: 0, delivered: 0, fullyDelivered: 0, dropped: 0, droppedIds: [] },
};

/** Nothing arrived, so every requested id is a drop. Shared by both fallback returns. */
function allDropped(requestedIds: string[]): IAttachmentDelivery {
  return {
    requested: requestedIds.length,
    delivered: 0,
    fullyDelivered: 0,
    dropped: requestedIds.length,
    droppedIds: requestedIds,
  };
}

interface MinimalLogger {
  info: (message: string, meta?: Record<string, unknown>) => void;
  warn: (message: string, meta?: Record<string, unknown>) => void;
  error: (message: string, meta?: Record<string, unknown>) => void;
}

/** The `processFabFilesServer` surface this module drives, structurally typed so tests need no stack. */
type ProcessFabFiles = (files: IFabFileDocument[]) => Promise<{
  userMessages: IMessage[];
  fileNotices: FabFileNotice[];
  deliveredFileIds: string[];
  fullyDeliveredFileIds: string[];
}>;

/**
 * Extract the content of `files` into a form the agent's first message can carry.
 *
 * `missingIds` are ids the caller could not resolve at all; they become `unresolved` notices here
 * so every id the turn was given is accounted for in one place.
 *
 * Never throws: extraction is an enhancement over the metadata preamble, and a failure here must
 * leave the run working exactly as it did before rather than killing the turn.
 */
export async function materializeAttachmentContent(
  files: IFabFileDocument[],
  missingIds: string[],
  processFabFiles: ProcessFabFiles,
  logger: MinimalLogger
): Promise<MaterializedAttachments> {
  const unresolvedNotices: FabFileNotice[] = missingIds.map(id => ({
    fabFileId: id,
    fileName: id,
    band: 'unresolved' as const,
    message: `An attached file (id ${id}) could not be found or is no longer accessible, so its content was not sent.`,
    delivered: false,
  }));

  // Every id the turn was given, in one list: the drop set of both fallbacks below, and the
  // denominator of the delivery report.
  const requestedIds = [...files.map(file => file.id), ...missingIds];

  if (files.length === 0) {
    return { ...EMPTY, notices: unresolvedNotices, delivery: allDropped(requestedIds) };
  }

  let result: Awaited<ReturnType<ProcessFabFiles>>;
  try {
    result = await processFabFiles(files);
  } catch (err) {
    logger.error('[AttachmentContent] Extraction failed; falling back to the metadata-only preamble', {
      fileCount: files.length,
      error: err instanceof Error ? err.message : String(err),
    });
    return { ...EMPTY, notices: unresolvedNotices, delivery: allDropped(requestedIds) };
  }

  const textParts: string[] = [];
  const imageBlocks: MessageContentObject[] = [];
  const notices = [...unresolvedNotices, ...result.fileNotices];
  // Ids that reached a text part or an image block.
  //
  // KNOWN LIMITATION, stated rather than papered over: an image cut at the run ceiling below stays
  // in this set. The extractor flattens every image into one message and the blocks carry encoded
  // bytes, not the fabFileId they came from, so a cut block cannot be attributed back to a file
  // without parsing the generated caption beside it - a coupling that would break silently. The
  // model is still told, by the `image_too_large` notice pushed below; what it does not get is a
  // per-file NOT READABLE mark in the preamble for that specific image. Only reachable when a run
  // exceeds MAX_INLINED_IMAGE_BYTES, which the extractor's own per-image cap makes uncommon.
  const inlined = new Set(result.deliveredFileIds);

  let imageBytes = 0;
  let droppedImages = 0;
  for (const message of result.userMessages) {
    if (typeof message.content === 'string') {
      textParts.push(message.content);
      continue;
    }
    for (const block of message.content) {
      if (block.type !== 'image' && block.type !== 'image_url') {
        // The text block that names the image and its fabFileId - keep it beside the image so the
        // model can still name the file correctly, and keep it even when the image itself is cut.
        if (block.type === 'text') imageBlocks.push(block);
        continue;
      }
      const bytes = imageBlockBytes(block);
      if (imageBytes + bytes > MAX_INLINED_IMAGE_BYTES) {
        droppedImages++;
        continue;
      }
      imageBytes += bytes;
      imageBlocks.push(block);
    }
  }

  if (droppedImages > 0) {
    // No fabFileId available: the blocks carry the encoded bytes, not the id they came from. The
    // count is still worth saying - a missing image with no explanation is the failure mode this
    // whole area exists to prevent.
    logger.warn('[AttachmentContent] Dropped image(s) at the per-run inline ceiling', {
      droppedImages,
      inlinedImageBytes: imageBytes,
      ceiling: MAX_INLINED_IMAGE_BYTES,
    });
    notices.push({
      fabFileId: '',
      fileName: `${droppedImages} image(s)`,
      band: 'image_too_large',
      message:
        `${droppedImages} attached image(s) were not sent: this run had already reached its limit for ` +
        'inlined image data. Ask about them one at a time, or attach smaller images.',
      delivered: false,
    });
  }

  const fullyInlinedFileIds = result.fullyDeliveredFileIds.filter(id => inlined.has(id));
  const delivery: IAttachmentDelivery = {
    requested: requestedIds.length,
    delivered: inlined.size,
    fullyDelivered: fullyInlinedFileIds.length,
    dropped: requestedIds.length - inlined.size,
    droppedIds: requestedIds.filter(id => !inlined.has(id)),
  };

  logger.info('[AttachmentContent] Materialized attachment content for the agent run', {
    ...delivery,
    textParts: textParts.length,
    inlinedImageBytes: imageBytes,
    notices: notices.length,
  });

  return {
    text: textParts.join('\n\n'),
    imageBlocks,
    inlinedFileIds: Array.from(inlined),
    // Intersected with `inlined` so the two sets cannot disagree; see the limitation noted there.
    fullyInlinedFileIds,
    notices,
    delivery,
  };
}

/**
 * Fold materialized content into the first-iteration message.
 *
 * Returns a plain string when there is no image, so the overwhelmingly common case keeps the exact
 * shape (and checkpoint size) it had before. Only an actual image promotes the message to a
 * `MessageContent` array - `ReActAgent.runIteration` accepts either.
 */
export function composeFirstIterationMessage(
  query: string,
  materialized: Pick<MaterializedAttachments, 'text' | 'imageBlocks'>
): string | MessageContentObject[] {
  const text = materialized.text ? `${query}\n\n${materialized.text}` : query;
  if (materialized.imageBlocks.length === 0) return text;
  return [{ type: 'text', text }, ...materialized.imageBlocks];
}

/**
 * Line cap for the notice block, matching MAX_ATTACHMENT_NOTICE_LINES in
 * `b4m-core/services/src/llm/attachmentNotices.ts` (kept as a local literal so this module keeps
 * its type-only imports). Reachable here: a run inlines every session knowledge id against ONE
 * shared budget, so a large workbench truncates every file and would otherwise bury the query
 * under a line per file. Change one, change the other.
 */
const MAX_NOTICE_LINES = 20;

/**
 * The transcript lines persisted onto the linked quest, mirroring `toAttachmentNoticeStrings` in
 * `b4m-core/services/src/llm/attachmentNotices.ts` - the chat path's version of the same list.
 * Duplicated rather than imported for the reason MAX_NOTICE_LINES is: this module's imports stay
 * type-only. Same cap, same one-sentence-per-file shape, so a reader cannot tell which door a
 * notice came from. Change one, change the other.
 */
export function attachmentNoticeStrings(notices: FabFileNotice[]): string[] {
  const overflow = Math.max(0, notices.length - MAX_NOTICE_LINES);
  const lines = notices.slice(0, MAX_NOTICE_LINES).map(notice => notice.message);
  if (overflow > 0) lines.push(`...and ${overflow} more attachment(s) not listed here.`);
  return lines;
}

/**
 * The block appended to the query for attachments that did NOT arrive intact. Mirrors the chat
 * path's system-message wording so the two surfaces tell the model the same thing.
 */
export function attachmentNoticeBlock(notices: FabFileNotice[]): string {
  if (notices.length === 0) return '';
  const overflow = Math.max(0, notices.length - MAX_NOTICE_LINES);
  const lines = notices.slice(0, MAX_NOTICE_LINES).map(notice => {
    const state = notice.delivered
      ? 'was delivered only in part - what is here is incomplete'
      : 'was NOT delivered and its content is not in this conversation';
    return `  - ${state}: ${notice.message}`;
  });
  if (overflow > 0) lines.push(`  - ...and ${overflow} more attachment(s) not listed here.`);
  return (
    `\n\n[ATTACHMENT PROBLEMS - these files did not arrive intact:\n${lines.join('\n')}\n` +
    'Do not answer as though these files were present or complete. If the answer depends on one of ' +
    'them, say plainly which file you do not have and why.]'
  );
}

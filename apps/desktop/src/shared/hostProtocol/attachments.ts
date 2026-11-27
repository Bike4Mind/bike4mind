import { z } from 'zod';
import type { AddAttachmentsResult, ChatAttachment, ChatImageRef } from '../chat';

/*
 * The attachment methods (since 1.4). The host stores attachment bytes by id, so a client sends a
 * file in chunks it can keep under the frame limit, and the host classifies and caps it on commit
 * exactly as it does a file picked on the host itself (main/chat/AttachmentStore).
 */

/** Raw bytes per `attachment/uploadChunk`; base64 makes a chunk about 342 KiB on the wire. */
export const ATTACHMENT_UPLOAD_CHUNK_BYTES = 256 * 1024;

/** Uploads one connection may have open at once; a fifth `attachment/uploadBegin` is refused. */
export const MAX_OPEN_ATTACHMENT_UPLOADS = 4;

/** An open upload that sees no chunk for this long is dropped, in ms. */
export const ATTACHMENT_UPLOAD_IDLE_MS = 10 * 60 * 1000;

/**
 * Why an attachment method refused, as the `reason` of an attachmentRefused error. A string on
 * the wire, as for pathUnavailable: a newer host may report one this client has not seen.
 */
export const ATTACHMENT_REFUSAL_REASONS = [
  /** The declared size is over the largest input the host takes. */
  'tooLarge',
  /** The connection already has MAX_OPEN_ATTACHMENT_UPLOADS open. */
  'tooManyUploads',
  /** No open upload has this id on this connection: never begun, committed, aborted or idle too long. */
  'unknownUpload',
  /** A chunk index other than the next one. */
  'outOfOrder',
  /** A chunk over ATTACHMENT_UPLOAD_CHUNK_BYTES, or one that runs past the declared size. */
  'chunkTooLarge',
  /** The bytes received do not add up to the declared size. */
  'sizeMismatch',
  /** The SHA-256 of the bytes received is not the one given. */
  'hashMismatch',
  /** The draft was discarded while the upload was open. */
  'draftDiscarded',
  /** `attachment/read` of a stored file that is neither an image nor text, such as a PDF. */
  'notReadable',
] as const;
export type AttachmentRefusalReason = (typeof ATTACHMENT_REFUSAL_REASONS)[number];

/** A session id or a composer draft's id (`draft-<uuid>`); the host checks the shape. */
const attachmentSessionId = z.string().min(1).max(64);
const draftId = attachmentSessionId.startsWith('draft-');
const attachmentId = z.string().min(1).max(64);

export const chatAttachmentSchema = z.strictObject({
  id: z.string(),
  kind: z.enum(['image', 'text', 'pdf']),
  name: z.string(),
  mediaType: z.string(),
  byteSize: z.number().int().nonnegative(),
  sourceBytes: z.number().int().nonnegative(),
  truncated: z.boolean().optional(),
  pages: z.number().int().positive().optional(),
}) satisfies z.ZodType<ChatAttachment>;

const rejectedAttachmentSchema = z.strictObject({ name: z.string(), reason: z.string() });

export const addAttachmentsResultSchema = z.strictObject({
  attachments: z.array(chatAttachmentSchema),
  rejected: z.array(rejectedAttachmentSchema),
}) satisfies z.ZodType<AddAttachmentsResult>;

/** The image refs a host resolves through its own stores; a 'remote' ref has nothing on disk to attach. */
const storedImageRefSchema = z.discriminatedUnion('source', [
  z.strictObject({
    source: z.literal('media'),
    url: z.string().min(1).max(2048),
    nameHint: z.enum(['screenshot', 'image']).optional(),
  }),
  z.strictObject({
    source: z.literal('attachment'),
    sessionId: attachmentSessionId,
    attachmentId,
    mediaType: z.string(),
    name: z.string().min(1).max(255),
  }),
]) satisfies z.ZodType<Exclude<ChatImageRef, { source: 'remote' }>>;

const emptyResult = z.strictObject({});

const SHA256_HEX = /^[0-9a-f]{64}$/;

export const attachmentMethods = {
  // `sessionId` may be a composer draft's id. Refused with attachmentRefused `tooLarge` when
  // `byteSize` is over the largest input the host takes, and `tooManyUploads` past
  // MAX_OPEN_ATTACHMENT_UPLOADS. `name` is a label for classification and display, never a path.
  'attachment/uploadBegin': {
    params: z.strictObject({
      sessionId: attachmentSessionId,
      name: z.string().min(1).max(1024),
      mediaType: z.string().min(1).max(255).optional(),
      byteSize: z.number().int().nonnegative(),
    }),
    result: z.strictObject({ uploadId: z.string(), chunkBytes: z.number().int().positive() }),
  },
  // `data` is base64 of at most `chunkBytes` raw bytes; `index` counts from 0, strictly in order.
  'attachment/uploadChunk': {
    params: z.strictObject({
      uploadId: z.string().min(1).max(64),
      index: z.number().int().nonnegative(),
      data: z.base64(),
    }),
    result: z.strictObject({ receivedBytes: z.number().int().nonnegative() }),
  },
  // Checks the size and the hash, then takes the file in as the host's own picker does: an
  // attachment, or the reason it was not taken. Either way the upload is closed.
  'attachment/uploadCommit': {
    params: z.strictObject({ uploadId: z.string().min(1).max(64), sha256: z.string().regex(SHA256_HEX) }),
    result: z.union([
      z.strictObject({ attachment: chatAttachmentSchema }),
      z.strictObject({ rejected: rejectedAttachmentSchema }),
    ]),
  },
  'attachment/uploadAbort': { params: z.strictObject({ uploadId: z.string().min(1).max(64) }), result: emptyResult },
  // An image as a `data:` URL whose type the host reads from the bytes, text as text, and null
  // when the file is gone. Anything else is refused with attachmentRefused `notReadable`.
  'attachment/read': {
    params: z.strictObject({ sessionId: attachmentSessionId, attachmentId }),
    result: z.strictObject({ content: z.string().nullable() }),
  },
  'attachment/discard': {
    params: z.strictObject({ sessionId: attachmentSessionId, attachmentId }),
    result: emptyResult,
  },
  // Copies a draft's attachments into the session the draft became.
  'attachment/copyDraft': {
    params: z.strictObject({
      draftId,
      sessionId: attachmentSessionId,
      attachmentIds: z.array(attachmentId),
    }),
    result: emptyResult,
  },
  // Deletes a draft's attachments; uploads into that draft fail from then on.
  'attachment/discardDraft': { params: z.strictObject({ draftId }), result: emptyResult },
  // An image the host saved (generated media, or another attachment) attached to `sessionId`.
  'attachment/fromMedia': {
    params: z.strictObject({ sessionId: attachmentSessionId, ref: storedImageRefSchema }),
    result: addAttachmentsResultSchema,
  },
  // A file a reply named, attached when it resolves inside a folder shared with the session.
  'attachment/fromPath': {
    params: z.strictObject({ sessionId: attachmentSessionId, path: z.string().min(1).max(1024) }),
    result: addAttachmentsResultSchema,
  },
} as const;

import { createHash, randomUUID, type Hash } from 'node:crypto';
import { mkdir, open, rm, type FileHandle } from 'node:fs/promises';
import { join } from 'node:path';
import type { ChatAttachment } from '@shared/chat';
import {
  ATTACHMENT_UPLOAD_CHUNK_BYTES,
  ATTACHMENT_UPLOAD_IDLE_MS,
  HOST_ERROR_CODES,
  MAX_OPEN_ATTACHMENT_UPLOADS,
  type AttachmentRefusalReason,
  type HostErrorData,
} from '@shared/hostProtocol';
import type { AttachmentStore } from '../../main/chat/AttachmentStore';
import { IMAGE_INPUT_MAX, PDF_INPUT_MAX, formatBytes } from '../../main/chat/attachments';
import { isValidSessionId } from '../../main/chat/SessionStore';
import { HostMethodError } from '../server/HostMethodError';

/** The largest file intake takes in any form; a larger upload is refused before a byte is sent. */
export const MAX_UPLOAD_BYTES = Math.max(IMAGE_INPUT_MAX, PDF_INPUT_MAX);

export type UploadStore = Pick<AttachmentStore, 'stagingDirectory' | 'addStaged' | 'isDiscardedDraft'>;

export type UploadBegin = { sessionId: string; name: string; mediaType?: string | undefined; byteSize: number };

export type UploadCommitResult = { attachment: ChatAttachment } | { rejected: { name: string; reason: string } };

type Upload = {
  readonly id: string;
  /** The connection that began it; no other may touch it. */
  readonly owner: object;
  readonly sessionId: string;
  readonly name: string;
  readonly mediaType: string | undefined;
  readonly byteSize: number;
  readonly path: string;
  readonly handle: FileHandle;
  readonly hash: Hash;
  nextIndex: number;
  receivedBytes: number;
  /** The chunks' writes, in order; rejects once one fails. */
  writes: Promise<void>;
  idle: ReturnType<typeof setTimeout> | null;
};

export type AttachmentUploadsOptions = {
  logger: { warn(message: string): void };
  /** In ms; ATTACHMENT_UPLOAD_IDLE_MS unless a test shortens it. */
  idleMs?: number;
};

function refuse(reason: AttachmentRefusalReason, message: string, extra: { uploadId?: string; limit?: number } = {}) {
  return new HostMethodError(HOST_ERROR_CODES.attachmentRefused, message, {
    reason,
    ...extra,
  } satisfies HostErrorData<'attachmentRefused'>);
}

/**
 * Attachments a client sends in chunks. Each upload is written to its own file in the store's
 * staging directory as its chunks arrive, so no upload is ever held in memory whole, and on
 * commit it goes through the store's own intake, which classifies and caps it as it would a
 * file picked on this machine. Upload ids are random; the client's file name is only a label.
 *
 * A staged file is removed on commit, on abort, when its connection closes, after
 * `idleMs` without a chunk, and (for files a previous run left) when this is constructed.
 */
export class AttachmentUploads {
  private readonly uploads = new Map<string, Upload>();
  /** Begins between their slot being taken and their file being open, counted against the limit. */
  private readonly opening = new Map<object, number>();
  /** Owners whose connection closed; a begin still opening its file for one drops it. */
  private readonly closedOwners = new WeakSet<object>();
  private disposed = false;
  private readonly swept: Promise<void>;
  private readonly idleMs: number;

  constructor(
    private readonly store: UploadStore,
    private readonly options: AttachmentUploadsOptions
  ) {
    this.idleMs = options.idleMs ?? ATTACHMENT_UPLOAD_IDLE_MS;
    this.swept = this.sweep();
  }

  async begin(owner: object, request: UploadBegin): Promise<{ uploadId: string; chunkBytes: number }> {
    const { sessionId, name, mediaType, byteSize } = request;
    if (!isValidSessionId(sessionId)) {
      throw new HostMethodError(HOST_ERROR_CODES.invalidParams, `Invalid session id: ${sessionId}`);
    }
    if (this.store.isDiscardedDraft(sessionId)) refuseDiscarded();
    if (byteSize > MAX_UPLOAD_BYTES) {
      throw refuse(
        'tooLarge',
        `That file is ${formatBytes(byteSize)}; the limit is ${formatBytes(MAX_UPLOAD_BYTES)}.`,
        {
          limit: MAX_UPLOAD_BYTES,
        }
      );
    }
    // Counted before the first await, so concurrent begins cannot all pass the check.
    if (this.openCount(owner) >= MAX_OPEN_ATTACHMENT_UPLOADS) {
      throw refuse('tooManyUploads', `At most ${MAX_OPEN_ATTACHMENT_UPLOADS} uploads may be open at once.`);
    }
    this.opening.set(owner, (this.opening.get(owner) ?? 0) + 1);
    try {
      await this.swept;
      const id = randomUUID();
      const path = join(this.store.stagingDirectory, id);
      await mkdir(this.store.stagingDirectory, { recursive: true });
      const handle = await open(path, 'wx');
      if (this.disposed || this.closedOwners.has(owner)) {
        await handle.close().catch(() => undefined);
        await this.remove(path);
        throw refuse('unknownUpload', 'The connection closed before the upload began.');
      }
      const upload: Upload = {
        id,
        owner,
        sessionId,
        name,
        mediaType,
        byteSize,
        path,
        handle,
        hash: createHash('sha256'),
        nextIndex: 0,
        receivedBytes: 0,
        writes: Promise.resolve(),
        idle: null,
      };
      this.uploads.set(id, upload);
      this.touch(upload);
      return { uploadId: id, chunkBytes: ATTACHMENT_UPLOAD_CHUNK_BYTES };
    } finally {
      const left = (this.opening.get(owner) ?? 1) - 1;
      if (left > 0) this.opening.set(owner, left);
      else this.opening.delete(owner);
    }
  }

  /**
   * Every check runs before the first await, so chunks are judged in the order they arrived and
   * a refused chunk leaves the upload as it was.
   */
  async chunk(owner: object, uploadId: string, index: number, data: string): Promise<{ receivedBytes: number }> {
    const upload = this.owned(owner, uploadId);
    if (index !== upload.nextIndex) {
      throw refuse('outOfOrder', `Expected chunk ${upload.nextIndex}, got ${index}.`, { uploadId });
    }
    const bytes = Buffer.from(data, 'base64');
    if (bytes.length > ATTACHMENT_UPLOAD_CHUNK_BYTES) {
      throw refuse('chunkTooLarge', `A chunk holds at most ${ATTACHMENT_UPLOAD_CHUNK_BYTES} bytes.`, {
        uploadId,
        limit: ATTACHMENT_UPLOAD_CHUNK_BYTES,
      });
    }
    if (upload.receivedBytes + bytes.length > upload.byteSize) {
      throw refuse('chunkTooLarge', `That chunk runs past the declared ${upload.byteSize} bytes.`, {
        uploadId,
        limit: upload.byteSize,
      });
    }
    upload.nextIndex += 1;
    upload.receivedBytes += bytes.length;
    upload.hash.update(bytes);
    this.touch(upload);
    const receivedBytes = upload.receivedBytes;
    upload.writes = upload.writes.then(async () => {
      const { bytesWritten } = await upload.handle.write(bytes);
      // A short write (a full disk) would leave the file shorter than the bytes hashed.
      if (bytesWritten !== bytes.length) throw new Error(`Wrote ${bytesWritten} of ${bytes.length} bytes.`);
    });
    try {
      await upload.writes;
    } catch (error) {
      await this.drop(upload);
      throw error;
    }
    return { receivedBytes };
  }

  /** Closes the upload whatever the outcome; a size or hash mismatch is refused and nothing is kept. */
  async commit(owner: object, uploadId: string, sha256: string): Promise<UploadCommitResult> {
    const upload = this.owned(owner, uploadId);
    this.forget(upload);
    try {
      await upload.writes;
      await upload.handle.close();
      if (upload.receivedBytes !== upload.byteSize) {
        throw refuse('sizeMismatch', `Received ${upload.receivedBytes} of the declared ${upload.byteSize} bytes.`, {
          uploadId,
        });
      }
      if (upload.hash.digest('hex') !== sha256) {
        throw refuse('hashMismatch', 'The bytes received do not match the given SHA-256.', { uploadId });
      }
      if (this.store.isDiscardedDraft(upload.sessionId)) refuseDiscarded(uploadId);
      const added = await this.store.addStaged(upload.sessionId, {
        path: upload.path,
        name: upload.name,
        mediaType: upload.mediaType,
      });
      const [attachment] = added.attachments;
      if (attachment) return { attachment };
      const [rejected] = added.rejected;
      return { rejected: rejected ?? { name: upload.name, reason: 'That file could not be read.' } };
    } catch (error) {
      // The draft can be discarded between the check above and the intake's write.
      if (this.store.isDiscardedDraft(upload.sessionId) && !(error instanceof HostMethodError)) {
        refuseDiscarded(uploadId);
      }
      throw error;
    } finally {
      await upload.handle.close().catch(() => undefined);
      await this.remove(upload.path);
    }
  }

  async abort(owner: object, uploadId: string): Promise<void> {
    await this.drop(this.owned(owner, uploadId));
  }

  /** Every upload the connection left open; for its close. */
  async abortOwner(owner: object): Promise<void> {
    this.closedOwners.add(owner);
    await Promise.all(
      [...this.uploads.values()].filter(upload => upload.owner === owner).map(upload => this.drop(upload))
    );
  }

  /** Every upload into `sessionId`, whoever began it; for a discarded draft. */
  async abortSession(sessionId: string): Promise<void> {
    await Promise.all(
      [...this.uploads.values()].filter(upload => upload.sessionId === sessionId).map(upload => this.drop(upload))
    );
  }

  async dispose(): Promise<void> {
    this.disposed = true;
    await Promise.all([...this.uploads.values()].map(upload => this.drop(upload)));
  }

  private openCount(owner: object): number {
    let count = this.opening.get(owner) ?? 0;
    for (const upload of this.uploads.values()) if (upload.owner === owner) count += 1;
    return count;
  }

  private owned(owner: object, uploadId: string): Upload {
    const upload = this.uploads.get(uploadId);
    if (!upload || upload.owner !== owner) {
      throw refuse('unknownUpload', `No open upload ${uploadId}.`, { uploadId });
    }
    return upload;
  }

  private touch(upload: Upload): void {
    if (upload.idle) clearTimeout(upload.idle);
    upload.idle = setTimeout(() => {
      void this.drop(upload);
    }, this.idleMs);
    upload.idle.unref?.();
  }

  private forget(upload: Upload): void {
    if (upload.idle) clearTimeout(upload.idle);
    upload.idle = null;
    this.uploads.delete(upload.id);
  }

  private async drop(upload: Upload): Promise<void> {
    if (this.uploads.get(upload.id) !== upload) return;
    this.forget(upload);
    await upload.writes.catch(() => undefined);
    await upload.handle.close().catch(() => undefined);
    await this.remove(upload.path);
  }

  private async remove(path: string): Promise<void> {
    await rm(path, { force: true }).catch((error: unknown) => {
      this.options.logger.warn(`HOST: could not remove a staged upload: ${String(error)}`);
    });
  }

  /** Files a previous run left mid-upload; nothing can resume them. */
  private async sweep(): Promise<void> {
    try {
      await rm(this.store.stagingDirectory, { recursive: true, force: true });
    } catch (error) {
      this.options.logger.warn(`HOST: could not clear the upload staging directory: ${String(error)}`);
    }
  }
}

function refuseDiscarded(uploadId?: string): never {
  throw refuse('draftDiscarded', 'This draft was discarded.', uploadId ? { uploadId } : {});
}

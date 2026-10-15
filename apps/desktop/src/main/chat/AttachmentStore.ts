import { open, mkdir, readdir, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { basename, join } from 'node:path';
import type { AddAttachmentsResult, ChatAttachmentInput } from '@shared/chat';
import { isValidSessionId } from './SessionStore';
import {
  IMAGE_INPUT_MAX,
  MAX_ATTACHMENTS_PER_TURN,
  TEXT_BYTE_CAP,
  formatBytes,
  imageMediaTypeForName,
  isImageMediaType,
  prepareImage,
  prepareText,
  type PrepareResult,
  type ShrinkImage,
} from './attachments';

/** Same shape as a session id, and validated for the same reason - both become path components. */
const ATTACHMENT_ID_PATTERN = /^[A-Za-z0-9_-]{1,64}$/;

export interface AttachmentStoreLogger {
  debug(message: string): void;
  warn(message: string): void;
}

/**
 * Attachment bytes, one file per attachment under `<base>/<sessionId>/<attachmentId>`.
 *
 * Kept OUT of the session JSON on purpose. SessionStore.list() reads and parses every session
 * file in full to build the sidebar, so a base64 screenshot inlined into one would be re-read
 * and re-parsed on every refresh of a list that only wants a title. The session keeps a small
 * descriptor; the bytes sit beside it and are read once per turn.
 *
 * The directory is deleted with the conversation, and pruned of anything unreferenced whenever
 * a turn is sent, so an attachment the user added and then removed does not linger.
 */
export class AttachmentStore {
  constructor(
    private readonly baseDirectory: string,
    private readonly logger: AttachmentStoreLogger,
    /** Absent in tests; images are then stored as-is and only the byte cap applies. */
    private readonly shrink?: ShrinkImage
  ) {}

  private sessionDirectory(sessionId: string): string {
    if (!isValidSessionId(sessionId)) throw new Error(`invalid session id: ${sessionId}`);
    return join(this.baseDirectory, sessionId);
  }

  private filePath(sessionId: string, attachmentId: string): string {
    if (!ATTACHMENT_ID_PATTERN.test(attachmentId)) throw new Error(`invalid attachment id: ${attachmentId}`);
    return join(this.sessionDirectory(sessionId), attachmentId);
  }

  /**
   * Take in a batch, keeping the ones that survive their caps and reporting the rest.
   *
   * A partial success is the right outcome: dropping three screenshots and one binary should
   * attach the three and say why the fourth did not, not refuse the gesture.
   */
  async add(sessionId: string, inputs: readonly ChatAttachmentInput[]): Promise<AddAttachmentsResult> {
    const result: AddAttachmentsResult = { attachments: [], rejected: [] };

    for (const input of inputs.slice(0, MAX_ATTACHMENTS_PER_TURN)) {
      const name = input.source === 'path' ? input.path : input.name;
      let prepared: PrepareResult;
      try {
        prepared = input.source === 'path' ? await this.readPath(input.path) : this.readBytes(input);
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        this.logger.warn(`CHAT: attachment intake failed for ${name}: ${message}`);
        prepared = { ok: false, reason: 'That file could not be read.' };
      }

      if (!prepared.ok) {
        result.rejected.push({ name: basename(name), reason: prepared.reason });
        continue;
      }

      const id = randomUUID();
      const path = this.filePath(sessionId, id);
      await mkdir(this.sessionDirectory(sessionId), { recursive: true });
      await writeFile(path, prepared.prepared.bytes);

      result.attachments.push({
        id,
        kind: prepared.prepared.kind,
        name: prepared.prepared.name,
        mediaType: prepared.prepared.mediaType,
        byteSize: prepared.prepared.bytes.length,
        sourceBytes: prepared.prepared.sourceBytes,
        ...(prepared.prepared.truncated ? { truncated: true } : {}),
      });
    }

    if (inputs.length > MAX_ATTACHMENTS_PER_TURN) {
      result.rejected.push({
        name: `${inputs.length - MAX_ATTACHMENTS_PER_TURN} more file(s)`,
        reason: `Only ${MAX_ATTACHMENTS_PER_TURN} attachments fit in one message.`,
      });
    }

    return result;
  }

  /** Raw bytes, or null when the file is gone. */
  async read(sessionId: string, attachmentId: string): Promise<Buffer | null> {
    try {
      return await readFile(this.filePath(sessionId, attachmentId));
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') return null;
      throw err;
    }
  }

  async discard(sessionId: string, attachmentId: string): Promise<void> {
    await rm(this.filePath(sessionId, attachmentId), { force: true });
  }

  async deleteSession(sessionId: string): Promise<void> {
    await rm(this.sessionDirectory(sessionId), { recursive: true, force: true });
  }

  /**
   * Drop every stored file for this session that no message references.
   *
   * Run when a turn is sent, which is the moment the set of attachments a conversation owns
   * becomes knowable: anything added and then removed from the composer is now unreachable and
   * would otherwise sit on disk until the conversation was deleted.
   */
  async prune(sessionId: string, keep: ReadonlySet<string>): Promise<void> {
    let entries: string[];
    try {
      entries = await readdir(this.sessionDirectory(sessionId));
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') return;
      throw err;
    }

    await Promise.all(
      entries
        .filter(entry => !keep.has(entry))
        .map(entry => rm(join(this.sessionDirectory(sessionId), entry), { force: true }).catch(() => undefined))
    );
  }

  /**
   * Read only what can be sent, never the whole file.
   *
   * A 50MB log is read as its first TEXT_BYTE_CAP+1 bytes: enough to fill the cap and to know
   * there is more, without pulling 50MB into the main process to throw away.
   */
  private async readPath(path: string): Promise<PrepareResult> {
    const info = await stat(path);
    if (info.isDirectory())
      return { ok: false, reason: 'That is a folder. Attach a file, or share the folder with the assistant.' };
    if (!info.isFile()) return { ok: false, reason: 'That is not a file.' };

    const imageType = imageMediaTypeForName(path);
    if (imageType) {
      if (info.size > IMAGE_INPUT_MAX) {
        return {
          ok: false,
          reason: `That image is ${formatBytes(info.size)}; the limit is ${formatBytes(IMAGE_INPUT_MAX)}.`,
        };
      }
      return prepareImage(path, imageType, await readFile(path), this.shrink);
    }

    const handle = await open(path, 'r');
    try {
      const head = Buffer.alloc(Math.min(info.size, TEXT_BYTE_CAP + 1));
      const { bytesRead } = await handle.read(head, 0, head.length, 0);
      return prepareText(path, head.subarray(0, bytesRead), info.size);
    } finally {
      await handle.close();
    }
  }

  /** The paste path: the bytes are already here, and the media type is the clipboard's word for it. */
  private readBytes(input: Extract<ChatAttachmentInput, { source: 'bytes' }>): PrepareResult {
    const bytes = Buffer.from(input.data);
    const mediaType =
      input.mediaType && isImageMediaType(input.mediaType) ? input.mediaType : imageMediaTypeForName(input.name);
    if (mediaType) return prepareImage(input.name, mediaType, bytes, this.shrink);
    return prepareText(input.name, bytes.subarray(0, TEXT_BYTE_CAP + 1), bytes.length);
  }
}

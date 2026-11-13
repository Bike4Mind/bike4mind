import { copyFile, open, mkdir, readdir, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { basename, join } from 'node:path';
import type { AddAttachmentsResult, ChatAttachmentInput } from '@shared/chat';
import { isValidSessionId } from './SessionStore';
import {
  IMAGE_INPUT_MAX,
  PDF_INPUT_MAX,
  MAX_ATTACHMENTS_PER_TURN,
  TEXT_BYTE_CAP,
  formatBytes,
  imageMediaTypeForName,
  isImageMediaType,
  looksLikePdf,
  prepareImage,
  prepareText,
  type PrepareResult,
  type ShrinkImage,
} from './attachments';
import { extractPdfPromptText, preparePdf, type PdfPromptText } from './pdfText';

/** Same shape as a session id, and validated for the same reason - both become path components. */
const ATTACHMENT_ID_PATTERN = /^[A-Za-z0-9_-]{1,64}$/;

/** Entries are capped text (at most TEXT_BYTE_CAP each), so this bounds the cache's memory too. */
const PDF_TEXT_CACHE_MAX = 16;

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

  /**
   * Keyed by attachment id, so replaying history does not re-parse every PDF on every turn.
   * Seeded at intake, which has just extracted the text; least recently used goes first.
   */
  private readonly pdfTexts = new Map<string, PdfPromptText>();
  private readonly disposedDrafts = new Set<string>();
  private readonly intakeWrites = new Map<string, Set<Promise<void>>>();

  private assertDraftActive(sessionId: string): void {
    if (this.disposedDrafts.has(sessionId)) throw new Error('This draft was discarded.');
  }

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
    this.sessionDirectory(sessionId);
    this.assertDraftActive(sessionId);
    let finish!: () => void;
    const completed = new Promise<void>(resolve => {
      finish = resolve;
    });
    const pending = this.intakeWrites.get(sessionId) ?? new Set<Promise<void>>();
    pending.add(completed);
    this.intakeWrites.set(sessionId, pending);
    try {
      return await this.intake(sessionId, inputs);
    } finally {
      finish();
      pending.delete(completed);
      if (pending.size === 0) this.intakeWrites.delete(sessionId);
    }
  }

  private async intake(sessionId: string, inputs: readonly ChatAttachmentInput[]): Promise<AddAttachmentsResult> {
    const result: AddAttachmentsResult = { attachments: [], rejected: [] };

    for (const input of inputs.slice(0, MAX_ATTACHMENTS_PER_TURN)) {
      const name = input.source === 'path' ? input.path : input.name;
      let prepared: PrepareResult;
      try {
        prepared = input.source === 'path' ? await this.readPath(input.path) : await this.readBytes(input);
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        this.logger.warn(`CHAT: attachment intake failed for ${name}: ${message}`);
        prepared = { ok: false, reason: 'That file could not be read.' };
      }

      if (!prepared.ok) {
        result.rejected.push({ name: basename(name), reason: prepared.reason });
        continue;
      }

      this.assertDraftActive(sessionId);
      const id = randomUUID();
      const path = this.filePath(sessionId, id);
      await mkdir(this.sessionDirectory(sessionId), { recursive: true });
      await writeFile(path, prepared.prepared.bytes);
      const { promptText, pages, truncated } = prepared.prepared;
      if (promptText !== undefined && pages) {
        this.rememberPdfText(id, { text: promptText, pages, truncated: truncated ?? false });
      }

      result.attachments.push({
        id,
        kind: prepared.prepared.kind,
        name: prepared.prepared.name,
        mediaType: prepared.prepared.mediaType,
        byteSize: prepared.prepared.bytes.length,
        sourceBytes: prepared.prepared.sourceBytes,
        ...(prepared.prepared.truncated ? { truncated: true } : {}),
        ...(prepared.prepared.pages ? { pages: prepared.prepared.pages } : {}),
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

  /**
   * A stored PDF's text as the model receives it, or null when the file is gone or no longer
   * parses. A failure here is logged: the turn goes out without the PDF, and the log is the only
   * place that says why.
   */
  async readPdfText(sessionId: string, attachmentId: string): Promise<PdfPromptText | null> {
    const cached = this.pdfTexts.get(attachmentId);
    if (cached) {
      this.rememberPdfText(attachmentId, cached);
      return cached;
    }

    const bytes = await this.read(sessionId, attachmentId);
    if (!bytes) return null;
    try {
      const extracted = await extractPdfPromptText(bytes);
      this.rememberPdfText(attachmentId, extracted);
      return extracted;
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      this.logger.warn(`CHAT: could not extract text from PDF attachment ${attachmentId}: ${message}`);
      return null;
    }
  }

  private rememberPdfText(attachmentId: string, text: PdfPromptText): void {
    this.pdfTexts.delete(attachmentId);
    this.pdfTexts.set(attachmentId, text);
    if (this.pdfTexts.size > PDF_TEXT_CACHE_MAX) {
      const oldest = this.pdfTexts.keys().next();
      if (!oldest.done) this.pdfTexts.delete(oldest.value);
    }
  }

  /**
   * The stored file's path, or null for a malformed id or a file that is gone. Anything else -
   * a permission or I/O error - is rethrown, as `read` does, so it is not reported as "gone".
   */
  async locate(sessionId: string, attachmentId: string): Promise<string | null> {
    let path: string;
    try {
      path = this.filePath(sessionId, attachmentId);
    } catch {
      return null;
    }
    try {
      return (await stat(path)).isFile() ? path : null;
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

  /** Terminal for renderer-only UUID drafts; ordinary persisted-session deletion is unchanged. */
  async disposeDraft(draftId: string): Promise<void> {
    if (!draftId.startsWith('draft-')) throw new Error('Invalid draft id.');
    const directory = this.sessionDirectory(draftId);
    this.disposedDrafts.add(draftId);
    // Intake callers own their errors; cleanup must settle every writer before removing its files.
    await Promise.allSettled([...(this.intakeWrites.get(draftId) ?? [])]);
    try {
      for (const id of await readdir(directory)) this.pdfTexts.delete(id);
    } catch (cause) {
      if ((cause as NodeJS.ErrnoException).code !== 'ENOENT') throw cause;
    }
    await this.deleteSession(draftId);
  }

  async copyDraft(draftId: string, sessionId: string, attachmentIds: string[]): Promise<void> {
    if (!draftId.startsWith('draft-') || sessionId.startsWith('draft-')) throw new Error('Invalid draft transfer.');
    const target = this.sessionDirectory(sessionId);
    if (attachmentIds.length > MAX_ATTACHMENTS_PER_TURN) throw new Error('Too many attachments.');
    if (attachmentIds.length === 0) return;
    await mkdir(target, { recursive: true });
    for (const id of attachmentIds) await copyFile(this.filePath(draftId, id), this.filePath(sessionId, id));
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
      const headBytes = head.subarray(0, bytesRead);
      if (looksLikePdf(path, undefined, headBytes)) {
        if (info.size > PDF_INPUT_MAX) {
          return {
            ok: false,
            reason: `That PDF is ${formatBytes(info.size)}; the limit is ${formatBytes(PDF_INPUT_MAX)}.`,
          };
        }
        return preparePdf(path, await readFile(path));
      }
      return prepareText(path, headBytes, info.size);
    } finally {
      await handle.close();
    }
  }

  /** The paste path: the bytes are already here, and the media type is the clipboard's word for it. */
  private async readBytes(input: Extract<ChatAttachmentInput, { source: 'bytes' }>): Promise<PrepareResult> {
    const bytes = Buffer.from(input.data);
    const mediaType =
      input.mediaType && isImageMediaType(input.mediaType) ? input.mediaType : imageMediaTypeForName(input.name);
    if (mediaType) return prepareImage(input.name, mediaType, bytes, this.shrink);
    if (looksLikePdf(input.name, input.mediaType, bytes)) return preparePdf(input.name, bytes);
    return prepareText(input.name, bytes.subarray(0, TEXT_BYTE_CAP + 1), bytes.length);
  }
}

import { appendFile, mkdir, rename, stat } from 'node:fs/promises';
import { dirname } from 'node:path';
import type { ChatApprovalMode, ChatToolApproval } from '@shared/chat';
import { redact } from '../../devlog/redact';

/** One line of the log: one approval decision. */
export type ApprovalLogEntry = {
  /** ISO. */
  ts: string;
  sessionId: string;
  sessionTitle?: string;
  mode?: ChatApprovalMode;
  tool: string;
  /** See summarizeToolInput. */
  input: string;
  approval: ChatToolApproval;
};

/** Rotated past this, so a long-lived install never grows the file without bound. */
const DEFAULT_MAX_BYTES = 5 * 1024 * 1024;
const INPUT_SUMMARY_MAX = 500;

/**
 * What a call was asked to do, short enough for a log line: the command for a shell tool, the
 * path for a file tool, otherwise the arguments as JSON. Credentials are scrubbed, because the
 * log outlives the conversation; capped at INPUT_SUMMARY_MAX characters.
 */
export function summarizeToolInput(input: Record<string, unknown>): string {
  const named = [input.command, input.path, input.file_path, input.url].find(
    (value): value is string => typeof value === 'string'
  );
  const text = redact(named ?? JSON.stringify(input));
  return text.length > INPUT_SUMMARY_MAX ? `${text.slice(0, INPUT_SUMMARY_MAX)}...` : text;
}

/**
 * An append-only JSON-lines record of every approval decision, across sessions, so "who let
 * this run?" has an answer even after the conversation is gone.
 *
 * Writes are serialized on one chain, so a rotation never races an append. `append` never
 * rejects: a log that cannot be written must not fail the tool call it describes, so a failure
 * is reported through `warn` and dropped.
 */
export class ApprovalLog {
  private chain: Promise<void> = Promise.resolve();

  constructor(
    private readonly filePath: string,
    private readonly warn: (message: string) => void,
    private readonly maxBytes: number = DEFAULT_MAX_BYTES
  ) {}

  /** The file the previous generation is rotated to: `approval-log.jsonl` -> `approval-log.1.jsonl`. */
  get rotatedPath(): string {
    return this.filePath.endsWith('.jsonl')
      ? `${this.filePath.slice(0, -'.jsonl'.length)}.1.jsonl`
      : `${this.filePath}.1`;
  }

  append(entry: ApprovalLogEntry): Promise<void> {
    this.chain = this.chain.then(() =>
      this.write(entry).catch((error: unknown) => {
        this.warn(`PERMISSIONS: could not write the approval log: ${String(error)}`);
      })
    );
    return this.chain;
  }

  private async write(entry: ApprovalLogEntry): Promise<void> {
    const line = `${JSON.stringify(entry)}\n`;
    await mkdir(dirname(this.filePath), { recursive: true });
    const size = await stat(this.filePath).then(
      info => info.size,
      (error: NodeJS.ErrnoException) => {
        if (error.code === 'ENOENT') return 0;
        throw error;
      }
    );
    // Only the one previous file is kept; the rename replaces any older one. On Windows a file
    // held open by another process cannot be renamed; keep appending rather than drop entries.
    if (size > 0 && size + Buffer.byteLength(line) > this.maxBytes) {
      await rename(this.filePath, this.rotatedPath).catch((error: NodeJS.ErrnoException) => {
        if (!['EPERM', 'EBUSY', 'EACCES'].includes(error.code ?? '')) throw error;
      });
    }
    await appendFile(this.filePath, line, { encoding: 'utf8', mode: 0o600 });
  }
}

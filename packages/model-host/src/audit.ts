import { appendFile, rename, stat } from 'node:fs/promises';
import { join } from 'node:path';

export const AUDIT_EVENTS = [
  'create',
  'admission-refused',
  'check-failed',
  'cancel',
  'pause',
  'resume',
  'dismiss',
  'remove',
  'digest-failed',
  'pull-failed',
  'cancelled',
  'interrupted',
  'done',
] as const;
export type AuditEvent = (typeof AUDIT_EVENTS)[number];

export interface AuditEntry {
  event: AuditEvent;
  job?: string | null;
  ref?: string | null;
  revision?: string | null;
  sha256?: string | null;
  licensesAccepted?: string[] | null;
  /** `device` and `login` are labels the client reports, never verified identities. */
  device?: string | null;
  login?: string | null;
  via?: 'ssh' | 'local';
  detail?: string | null;
}

export type Audit = (entry: AuditEntry) => void;

export const AUDIT_MAX_BYTES = 5 * 1024 * 1024;

/**
 * Appends one JSON line per entry to `audit.jsonl`, in order; a failed write is logged and the host carries on.
 * Past `maxBytes` the file moves to `audit.jsonl.1`, replacing the one before.
 */
export function createAuditLog(
  stateDir: string,
  log: (line: string) => void,
  now: () => Date = () => new Date(),
  maxBytes = AUDIT_MAX_BYTES
) {
  const path = join(stateDir, 'audit.jsonl');
  let size: number | null = null;
  let chain = Promise.resolve();
  const currentSize = () =>
    stat(path).then(
      info => info.size,
      () => 0
    );
  const write = async (line: string) => {
    size ??= await currentSize();
    const bytes = Buffer.byteLength(line);
    if (size > 0 && size + bytes > maxBytes) {
      try {
        await rename(path, `${path}.1`);
        size = 0;
      } catch (error) {
        // The file may have been moved or deleted meanwhile; the line is still appended.
        log(`audit log ${path}: rotating: ${error instanceof Error ? error.message : String(error)}`);
        size = await currentSize();
      }
    }
    await appendFile(path, line, { mode: 0o640 });
    size += bytes;
  };
  const audit: Audit = entry => {
    const line = `${JSON.stringify({ time: now().toISOString(), ...entry })}\n`;
    chain = chain
      .then(() => write(line))
      .catch((error: unknown) => log(`audit log ${path}: ${error instanceof Error ? error.message : String(error)}`));
  };
  return { audit, path, flush: () => chain };
}

import { createHash } from 'node:crypto';
import type { AuthLogger } from '@bike4mind/client-auth';

type StudioDiagnosticEvent =
  | 'workspace-cleanup'
  | 'asset-invalid'
  | 'asset-index'
  | 'job-recovery'
  | 'scheduler-workspace'
  | 'scheduler-recovery'
  | 'scheduler-enumeration';
type StudioDiagnosticIds = { sessionId?: string; workspaceId?: string; jobId?: string };
export type StudioDiagnosticSink = (event: StudioDiagnosticEvent, ids: StudioDiagnosticIds) => void;

/** Fixed categories and opaque identifiers keep recovery diagnostics bounded. */
export function createStudioDiagnostics(logger: Pick<AuthLogger, 'warn'>): StudioDiagnosticSink {
  return (event, ids) => {
    const hashed = Object.fromEntries(
      (['sessionId', 'workspaceId', 'jobId'] as const).flatMap(key => {
        const value = ids[key];
        return value === undefined ? [] : [[key, createHash('sha256').update(value).digest('hex').slice(0, 12)]];
      })
    );
    logger.warn(`STUDIO: ${JSON.stringify({ event, ...hashed })}`);
  };
}

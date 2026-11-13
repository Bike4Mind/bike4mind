import { isAbsolute, resolve } from 'node:path';
import type { SkillsScope } from '@shared/skills';

/** A renderer-supplied scope, or null when it is neither a session id nor an absolute draft folder. */
export function parseSkillsScope(raw: unknown): SkillsScope | null {
  if (typeof raw !== 'object' || raw === null) return null;
  if ('sessionId' in raw) return typeof raw.sessionId === 'string' ? { sessionId: raw.sessionId } : null;
  if (!('draftDirectory' in raw)) return null;
  const directory = raw.draftDirectory;
  if (directory === null) return { draftDirectory: null };
  return typeof directory === 'string' && isAbsolute(directory) ? { draftDirectory: resolve(directory) } : null;
}

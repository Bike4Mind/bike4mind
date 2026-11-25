import { isAbsolute, resolve } from 'node:path';
import { z } from 'zod';
import type { SkillsScope } from '@shared/skills';

/** The exact displayed trust target; a missing or relative target cannot grant trust. */
export const skillsTrustTargetSchema = z
  .string()
  .min(1)
  .refine(isAbsolute)
  .transform(directory => resolve(directory));

/** A renderer-supplied scope, or null when it is neither a session id nor an absolute draft folder. */
export function parseSkillsScope(raw: unknown): SkillsScope | null {
  if (typeof raw !== 'object' || raw === null) return null;
  if ('sessionId' in raw) return typeof raw.sessionId === 'string' ? { sessionId: raw.sessionId } : null;
  if (!('draftDirectory' in raw)) return null;
  const directory = raw.draftDirectory;
  if (directory === null) return { draftDirectory: null };
  return typeof directory === 'string' && isAbsolute(directory) ? { draftDirectory: resolve(directory) } : null;
}

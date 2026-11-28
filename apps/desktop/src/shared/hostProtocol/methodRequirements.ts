import type { HostMethod } from './methods';
import type { HostCapability } from './version';

type MethodRequirement = { capability: HostCapability; sinceMinor: number };

/**
 * What a host must offer before a client calls each method that is not in every host: the
 * capability it advertises and the lowest protocol minor both sides agreed on. A client checks
 * both with hostServesMethod rather than trying the call.
 */
export const hostMethodRequirements = {
  'attachment/uploadBegin': { capability: 'attachments', sinceMinor: 4 },
  'attachment/uploadChunk': { capability: 'attachments', sinceMinor: 4 },
  'attachment/uploadCommit': { capability: 'attachments', sinceMinor: 4 },
  'attachment/uploadAbort': { capability: 'attachments', sinceMinor: 4 },
  'attachment/read': { capability: 'attachments', sinceMinor: 4 },
  'attachment/discard': { capability: 'attachments', sinceMinor: 4 },
  'attachment/copyDraft': { capability: 'attachments', sinceMinor: 4 },
  'attachment/discardDraft': { capability: 'attachments', sinceMinor: 4 },
  'attachment/fromMedia': { capability: 'attachments', sinceMinor: 4 },
  'attachment/fromPath': { capability: 'attachments', sinceMinor: 4 },
  'session/configure': { capability: 'sessionSettings', sinceMinor: 4 },
  'turn/continue': { capability: 'turnRevision', sinceMinor: 4 },
  'turn/edit': { capability: 'turnRevision', sinceMinor: 4 },
  'turn/regenerate': { capability: 'turnRevision', sinceMinor: 4 },
} as const satisfies Partial<Record<HostMethod, MethodRequirement>>;

export type GatedHostMethod = keyof typeof hostMethodRequirements;

/** Whether a host with these capabilities, at the agreed minor, serves `method`. */
export function hostServesMethod(
  method: GatedHostMethod,
  host: { capabilities: readonly string[]; agreedMinor: number }
): boolean {
  const { capability, sinceMinor } = hostMethodRequirements[method];
  return host.agreedMinor >= sinceMinor && host.capabilities.includes(capability);
}

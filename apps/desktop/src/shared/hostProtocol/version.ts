import { z } from 'zod';

/*
 * Compatibility contract. Within a major version a change is additive only: new methods, new
 * optional fields, new capabilities. A receiver ignores notification methods and object keys it
 * does not know, so no wire schema here is strict. Anything else (removing or retyping a field,
 * changing what a method means) bumps the major, and hosts and clients of different majors
 * refuse to talk.
 */

export const hostProtocolVersionSchema = z.object({
  major: z.number().int().nonnegative(),
  minor: z.number().int().nonnegative(),
});
export type HostProtocolVersion = z.infer<typeof hostProtocolVersionSchema>;

export const HOST_PROTOCOL_VERSION = { major: 1, minor: 3 } as const satisfies HostProtocolVersion;

export type HostProtocolNegotiation =
  { ok: true; minor: number } | { ok: false; reason: 'client-too-old' | 'host-too-old' };

/** Majors must match; the agreed minor is the lower of the two, so neither side uses what the other lacks. */
export function negotiateHostProtocol(client: HostProtocolVersion, host: HostProtocolVersion): HostProtocolNegotiation {
  if (client.major < host.major) return { ok: false, reason: 'client-too-old' };
  if (client.major > host.major) return { ok: false, reason: 'host-too-old' };
  return { ok: true, minor: Math.min(client.minor, host.minor) };
}

export const KNOWN_HOST_CAPABILITIES = [
  'queue',
  'backgroundProcesses',
  'attachments',
  'filePreview',
  'terminals',
  'localModels',
  'browserTools',
  'loops',
  'videoJobs',
] as const;
export type HostCapability = (typeof KNOWN_HOST_CAPABILITIES)[number];

/** On the wire capabilities are plain strings: a newer host may advertise names this client has never heard of. */
export const hostCapabilitiesSchema = z.array(z.string());

export function hasHostCapability(capabilities: readonly string[], capability: HostCapability): boolean {
  return capabilities.includes(capability);
}

import { Config } from './config';

/**
 * Whether APNs push delivery to first-party native clients is configured, and its credentials.
 * Shared by the publishers (apps/client/server/utils/pushNotifications.ts and the workers that call
 * it) and the consumer (apps/workers/src/events/sendPush.apns.ts), so both sides agree on "off".
 */

/** The placeholder default infra/secrets.ts gives every APNS_* secret. */
const UNSET_SECRET = 'not-configured';

export type ApnsCredentials = {
  keyId: string;
  teamId: string;
  /** PKCS#8 PEM of the .p8 signing key. */
  key: string;
  /** The client's bundle id, sent as apns-topic. */
  topic: string;
};

type ApnsSourceKey = 'APNS_KEY_ID' | 'APNS_TEAM_ID' | 'APNS_KEY' | 'APNS_TOPIC';
export type ApnsSource = Partial<Record<ApnsSourceKey, string | undefined>>;

const configuredValue = (value: string | undefined): string | undefined => {
  const trimmed = value?.trim();
  return trimmed && trimmed !== UNSET_SECRET ? trimmed : undefined;
};

/**
 * Null unless all four values are set. Each is read from the linked secret first, then from plain
 * env (a self-host worker, or a process started without the SST link); missing, blank and the
 * 'not-configured' placeholder all count as unset. APNS_KEY may carry literal `\n` escapes when it
 * was set as a single-line value.
 */
export function readApnsCredentials(
  secrets: ApnsSource = Config,
  env: Readonly<Record<string, string | undefined>> = process.env
): ApnsCredentials | null {
  const read = (name: ApnsSourceKey) => configuredValue(secrets[name]) ?? configuredValue(env[name]);
  const keyId = read('APNS_KEY_ID');
  const teamId = read('APNS_TEAM_ID');
  const key = read('APNS_KEY')?.replace(/\\n/g, '\n');
  const topic = read('APNS_TOPIC');
  if (!keyId || !teamId || !key || !topic) return null;
  return { keyId, teamId, key, topic };
}

/** Publisher-side gate: with push unconfigured, no event is built, read for, or published. */
export function isPushDeliveryConfigured(): boolean {
  return readApnsCredentials() !== null;
}

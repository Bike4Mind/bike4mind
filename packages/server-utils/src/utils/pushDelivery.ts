import { z } from 'zod';
import { Config } from './config';

/**
 * Whether push delivery to first-party native clients (APNs for iOS, FCM for Android) is configured, and
 * its credentials. Shared by the publishers (./pushNotifications.ts and the workers that call
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

const FcmServiceAccountSchema = z.object({
  project_id: z.string().min(1),
  client_email: z.string().min(1),
  private_key: z.string().min(1),
});

export type FcmCredentials = {
  /** The Firebase project the Android client's google-services.json belongs to. */
  projectId: string;
  /** The service account that signs the OAuth assertion for the FCM HTTP v1 API. */
  clientEmail: string;
  /** PKCS#8 PEM (RSA) from the service account JSON. */
  privateKey: string;
};

/** `unset` disables Android push quietly; `invalid` is a deployment mistake the sender reports at error. */
export type FcmConfigResult =
  { status: 'unset' } | { status: 'invalid'; error: string } | { status: 'ok'; credentials: FcmCredentials };

/**
 * FCM credentials come from one secret, FCM_SERVICE_ACCOUNT: the service account JSON downloaded from the
 * Firebase console, verbatim. Read from the linked secret first, then plain env (self-host); blank and the
 * 'not-configured' placeholder count as unset.
 */
export function readFcmConfig(
  secrets: { FCM_SERVICE_ACCOUNT?: string | undefined } = Config,
  env: Readonly<Record<string, string | undefined>> = process.env
): FcmConfigResult {
  const raw = configuredValue(secrets.FCM_SERVICE_ACCOUNT) ?? configuredValue(env.FCM_SERVICE_ACCOUNT);
  if (!raw) return { status: 'unset' };
  let parsedJson: unknown;
  try {
    parsedJson = JSON.parse(raw);
  } catch {
    return { status: 'invalid', error: 'FCM_SERVICE_ACCOUNT is not valid JSON' };
  }
  const parsed = FcmServiceAccountSchema.safeParse(parsedJson);
  if (!parsed.success) {
    const missing = parsed.error.issues.map(issue => issue.path.join('.')).join(', ');
    return { status: 'invalid', error: `FCM_SERVICE_ACCOUNT lacks usable ${missing}` };
  }
  return {
    status: 'ok',
    credentials: {
      projectId: parsed.data.project_id,
      clientEmail: parsed.data.client_email,
      privateKey: parsed.data.private_key,
    },
  };
}

/** Publisher-side gate: with no push provider configured, no event is built, read for, or published. */
export function isPushDeliveryConfigured(): boolean {
  return readApnsCredentials() !== null || readFcmConfig().status === 'ok';
}

import crypto from 'crypto';

/**
 * Pure helpers for the self-host upload-readable check (selfhost-upload-readable.spec.ts): config
 * parsing, the byte comparison, the wrong-key URL, and the kubectl argument lists. No Playwright
 * import, so selfhost-upload-readable.selftest.spec.ts can exercise them without a target.
 */

export interface UploadReadableConfig {
  baseUrl: string;
  mailpitUrl: string;
  email: string;
  /** Only used when the email has no account yet and the login form asks for a username. */
  username: string;
  /** undefined = pod replacement explicitly skipped (SELFHOST_SKIP_POD_REPLACE=true). */
  kube?: { namespace: string; release: string; context?: string };
  /** Free-form source revision the operator deployed; copied into the receipt, never checked. */
  revision?: string;
  /** Flip one bit of the reference bytes, so a correct read MUST fail. See mutateOneBit. */
  mutateExpected: boolean;
  readyTimeoutMs: number;
}

const USAGE = [
  'Required: SELFHOST_URL=<app url> SELFHOST_EMAIL=<account email>',
  'Required unless SELFHOST_SKIP_POD_REPLACE=true: SELFHOST_KUBE_NAMESPACE=<namespace>',
  'Optional: SELFHOST_MAILPIT_URL (default http://localhost:8025), SELFHOST_USERNAME,',
  '  SELFHOST_KUBE_RELEASE (default b4m), SELFHOST_KUBE_CONTEXT, SELFHOST_REVISION,',
  '  SELFHOST_MUTATE_EXPECTED=true, SELFHOST_READY_TIMEOUT_MS (default 600000)',
].join('\n');

const MAX_READY_TIMEOUT_MS = 3_600_000;

const httpUrl = (name: string, raw: string): string => {
  if (!URL.canParse(raw) || !/^https?:$/.test(new URL(raw).protocol)) {
    throw new Error(`${name} must be an http: or https: URL\n${USAGE}`);
  }
  // Normalized the way a browser reports request URLs (lowercase host, default port dropped), so
  // the spec can match requests against it by prefix.
  const url = new URL(raw);
  return `${url.origin}${url.pathname}`.replace(/\/+$/, '');
};

// kubectl takes these as argv (never through a shell), but a value starting with '-' would still
// be read as a flag, so the shape is pinned here.
const KUBE_NAME = /^[a-z0-9]([-a-z0-9.]*[a-z0-9])?$/;
const KUBE_CONTEXT = /^[A-Za-z0-9][\w.@:/-]*$/;

const flag = (env: NodeJS.ProcessEnv, name: string): boolean => {
  const raw = env[name];
  if (raw === undefined || raw === '' || raw === 'false') return false;
  if (raw === 'true') return true;
  throw new Error(`${name} must be true or false\n${USAGE}`);
};

export function readUploadReadableConfig(env: NodeJS.ProcessEnv): UploadReadableConfig {
  if (!env.SELFHOST_URL) throw new Error(`SELFHOST_URL is required\n${USAGE}`);
  const email = env.SELFHOST_EMAIL?.trim();
  if (!email || !/^[^\s@]+@[^\s@]+$/.test(email)) throw new Error(`SELFHOST_EMAIL is required\n${USAGE}`);

  let kube: UploadReadableConfig['kube'];
  if (!flag(env, 'SELFHOST_SKIP_POD_REPLACE')) {
    const namespace = env.SELFHOST_KUBE_NAMESPACE;
    const release = env.SELFHOST_KUBE_RELEASE || 'b4m';
    const context = env.SELFHOST_KUBE_CONTEXT || undefined;
    if (!namespace) {
      throw new Error(`SELFHOST_KUBE_NAMESPACE is required unless SELFHOST_SKIP_POD_REPLACE=true\n${USAGE}`);
    }
    if (!KUBE_NAME.test(namespace)) throw new Error(`SELFHOST_KUBE_NAMESPACE is not a valid namespace name`);
    if (!KUBE_NAME.test(release)) throw new Error(`SELFHOST_KUBE_RELEASE is not a valid release name`);
    if (context !== undefined && !KUBE_CONTEXT.test(context)) {
      throw new Error(`SELFHOST_KUBE_CONTEXT is not a valid context name`);
    }
    kube = { namespace, release, context };
  }

  const rawTimeout = env.SELFHOST_READY_TIMEOUT_MS;
  const readyTimeoutMs = rawTimeout ? Number(rawTimeout) : 600_000;
  // Capped well below the 2^31-1 ms where Node timers overflow; the spec waits up to three of these.
  if (!Number.isInteger(readyTimeoutMs) || readyTimeoutMs <= 0 || readyTimeoutMs > MAX_READY_TIMEOUT_MS) {
    throw new Error(
      `SELFHOST_READY_TIMEOUT_MS must be a positive integer no greater than ${MAX_READY_TIMEOUT_MS}\n${USAGE}`
    );
  }

  return {
    baseUrl: httpUrl('SELFHOST_URL', env.SELFHOST_URL),
    mailpitUrl: httpUrl('SELFHOST_MAILPIT_URL', env.SELFHOST_MAILPIT_URL || 'http://localhost:8025'),
    email,
    username: env.SELFHOST_USERNAME || `upload-check-${crypto.randomBytes(4).toString('hex')}`,
    kube,
    revision: env.SELFHOST_REVISION || undefined,
    mutateExpected: flag(env, 'SELFHOST_MUTATE_EXPECTED'),
    readyTimeoutMs,
  };
}

export const sha256Hex = (bytes: Uint8Array): string => crypto.createHash('sha256').update(bytes).digest('hex');

export type ByteVerdict = { ok: true; bytes: number; sha256: string } | { ok: false; reason: string };

/**
 * The comparison the whole check rests on: every byte, not a hash of a decoded string. Length is
 * reported first because a text decode inflates each unrepresentable byte to U+FFFD's three, so a
 * length mismatch says "transcoded or truncated" before the first differing offset is read.
 */
export function compareBytes(expected: Uint8Array, actual: Uint8Array): ByteVerdict {
  if (actual.length !== expected.length) {
    return { ok: false, reason: `read ${actual.length} bytes, uploaded ${expected.length}` };
  }
  for (let i = 0; i < expected.length; i++) {
    if (actual[i] !== expected[i]) {
      return { ok: false, reason: `byte ${i} differs: read 0x${hex(actual[i])}, uploaded 0x${hex(expected[i])}` };
    }
  }
  return { ok: true, bytes: expected.length, sha256: sha256Hex(expected) };
}

const hex = (byte: number): string => byte.toString(16).padStart(2, '0');

/**
 * A copy with the lowest bit of the middle byte flipped: the smallest change a comparison can
 * miss. SELFHOST_MUTATE_EXPECTED applies it to the reference, so a run that still passes proves
 * the comparison is not looking at the bytes.
 */
export function mutateOneBit(bytes: Uint8Array): Buffer {
  if (bytes.length === 0) throw new Error('cannot mutate an empty payload');
  const copy = Buffer.from(bytes);
  copy[Math.floor(copy.length / 2)] ^= 0x01;
  return copy;
}

/**
 * The upload: a nonce line that makes each run's file distinct, then every byte value 0-255 (so
 * most of it is not valid UTF-8 and a text decode anywhere on the path changes it). The ASCII
 * line comes first so the header matches no binary magic number in the upload type sniff. Named
 * .txt by the spec because the upload route refuses unknown extensions.
 */
export function buildPayload(nonce: string): Buffer {
  return Buffer.concat([
    Buffer.from(`selfhost upload-readable check ${nonce}\r\n`, 'utf8'),
    Buffer.from(Array.from({ length: 256 }, (_, i) => i)),
  ]);
}

/** The sign-in code from a Mailpit message body. Length mirrors OTC_CODE_LENGTH in sendOTC.ts. */
export function extractSignInCode(text: string): string | undefined {
  return /(?<!\d)\d{8}(?!\d)/.exec(text)?.[0];
}

/**
 * The signed URL re-pointed at a different object key, signature left as issued. A store that
 * checks the signature must refuse it; one that serves it would be handing out any key.
 */
export function wrongKeyUrl(signedUrl: string, nonce: string): string {
  const url = new URL(signedUrl);
  const segments = url.pathname.split('/');
  const last = segments.pop();
  if (!last) throw new Error('signed URL has no object key');
  url.pathname = [...segments, `wrong-key-${nonce}-${last}`].join('/');
  return url.toString();
}

type Kube = NonNullable<UploadReadableConfig['kube']>;

const kubeBase = ({ namespace, context }: Kube): string[] => [
  ...(context ? ['--context', context] : []),
  '--namespace',
  namespace,
];

/** Labels and Deployment name mirror selfhost/kubernetes/templates/applications.yaml. */
export const appPodsArgs = (kube: Kube): string[] => [
  ...kubeBase(kube),
  'get',
  'pods',
  '--selector',
  `app.kubernetes.io/instance=${kube.release},app.kubernetes.io/component=app`,
  '--output',
  'json',
];

export const restartAppArgs = (kube: Kube): string[] => [
  ...kubeBase(kube),
  'rollout',
  'restart',
  `deployment/${kube.release}-app`,
];

export const rolloutStatusArgs = (kube: Kube, timeoutMs: number): string[] => [
  ...kubeBase(kube),
  'rollout',
  'status',
  `deployment/${kube.release}-app`,
  `--timeout=${Math.ceil(timeoutMs / 1000)}s`,
];

export interface AppPod {
  name: string;
  uid: string;
  images: string[];
}

/**
 * Running, non-terminating app pods from `kubectl get pods -o json`. Failed or Succeeded leftovers
 * (an evicted pod, say) match the selector too and keep their UID, so they are left out.
 */
export function parseAppPods(json: string): AppPod[] {
  const parsed = JSON.parse(json) as {
    items?: {
      metadata?: { name?: string; uid?: string; deletionTimestamp?: string };
      spec?: { containers?: { image?: string }[] };
      status?: { phase?: string };
    }[];
  };
  return (parsed.items ?? [])
    .filter(item => !item.metadata?.deletionTimestamp && item.status?.phase === 'Running')
    .map(item => ({
      name: item.metadata?.name ?? '',
      uid: item.metadata?.uid ?? '',
      images: (item.spec?.containers ?? []).map(c => c.image ?? '').filter(Boolean),
    }));
}

/**
 * Replacement means a different pod, not a restarted container: the set of pod UIDs after the
 * rollout must be non-empty and share nothing with the set before it.
 */
export function podsWereReplaced(before: AppPod[], after: AppPod[]): { ok: true } | { ok: false; reason: string } {
  if (before.length === 0) return { ok: false, reason: 'no app pod was running before the replacement' };
  if (after.length === 0) return { ok: false, reason: 'no app pod is running after the replacement' };
  if (after.some(pod => !pod.uid) || before.some(pod => !pod.uid)) {
    return { ok: false, reason: 'an app pod reported no UID' };
  }
  const survivors = after.filter(pod => before.some(old => old.uid === pod.uid));
  return survivors.length
    ? { ok: false, reason: `pod ${survivors.map(p => p.name).join(', ')} survived the replacement` }
    : { ok: true };
}

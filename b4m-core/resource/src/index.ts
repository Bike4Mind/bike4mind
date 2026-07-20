/**
 * Self-host Resource shim. Replaces `import { Resource } from 'sst'` in the
 * self-host build (via a build-time module alias), resolving every value the
 * app reads off `Resource.*` from plain environment variables instead of the
 * SST/AWS runtime.
 *
 * `Resource` is the only symbol the codebase imports from `sst` (all 190
 * importing files use `import { Resource } from 'sst'`), so aliasing the whole
 * module to this shim is safe and needs zero changes at the call sites.
 */
import { DEFAULT_MANIFEST } from './manifest';

export type Kind = 'secret' | 'bucket' | 'queue' | 'function' | 'service' | 'websocket' | 'record' | 'queueUrls';

export interface ManifestEntry {
  kind: Kind;
  /** When true, an unset value resolves to `undefined` instead of throwing.
   *  Use for feature/ops-gated resources a basic self-host install won't set. */
  optional?: boolean;
}

/** Maps each `Resource.<name>` the code reads to the kind of value it expects. */
export type Manifest = Record<string, ManifestEntry>;

interface App {
  name: string;
  stage: string;
}

type Optional<E extends ManifestEntry, T> = E extends { optional: true } ? T | undefined : T;

type Shape<E extends ManifestEntry> = E['kind'] extends 'secret'
  ? { value: Optional<E, string> }
  : E['kind'] extends 'bucket'
    ? { name: Optional<E, string> }
    : E['kind'] extends 'function'
      ? { name: Optional<E, string> }
      : E['kind'] extends 'queue'
        ? { url: Optional<E, string> }
        : E['kind'] extends 'service'
          ? { url: Optional<E, string> }
          : E['kind'] extends 'websocket'
            ? { managementEndpoint: string; url: string }
            : E['kind'] extends 'record'
              ? Optional<E, Record<string, string>>
              : E['kind'] extends 'queueUrls'
                ? Record<string, string | undefined>
                : never;

export type ResourceShim<M extends Manifest = Manifest> = { App: App } & {
  [K in keyof M]: Shape<M[K]>;
};

type Env = Record<string, string | undefined>;

/** camelCase / SCREAMING_SNAKE resource name to SCREAMING_SNAKE env-var key.
 *  Names already SCREAMING_SNAKE (secrets like `B4M_PROD_API_KEY`,
 *  `E2E_CLEANUP_SECRET`) pass through unchanged - splitting on their
 *  digit-to-uppercase boundaries would corrupt the real secret name. */
function toEnvKey(name: string): string {
  if (/^[A-Z0-9_]+$/.test(name)) return name;
  return name.replace(/([a-z0-9])([A-Z])/g, '$1_$2').toUpperCase();
}

function missing(key: string): never {
  throw new Error(
    `Self-host config missing: environment variable "${key}" is not set. ` +
      `Add it to your .env (see .env.selfhost.example).`
  );
}

/** Required read: throws with an actionable message if unset. */
function required(env: Env, key: string): string {
  const value = env[key];
  return value === undefined || value === '' ? missing(key) : value;
}

/** Optional-aware read: `undefined` if unset & optional, else required. */
function resolve(env: Env, key: string, optional?: boolean): string | undefined {
  const value = env[key];
  if (value === undefined || value === '') return optional ? undefined : missing(key);
  return value;
}

type Shaped =
  | { value: string | undefined }
  | { name: string | undefined }
  | { url: string | undefined }
  | { managementEndpoint: string; url: string }
  | Record<string, string>
  | Record<string, string | undefined>
  | undefined;

function buildShape(name: string, entry: ManifestEntry, env: Env): Shaped {
  const key = toEnvKey(name);
  switch (entry.kind) {
    case 'secret':
      return {
        get value() {
          return resolve(env, key, entry.optional);
        },
      };
    case 'bucket':
    case 'function':
      return {
        get name() {
          return resolve(env, key, entry.optional);
        },
      };
    case 'queue':
    case 'service':
      return {
        get url() {
          return resolve(env, key, entry.optional);
        },
      };
    case 'websocket':
      return {
        get managementEndpoint() {
          return required(env, 'WEBSOCKET_MANAGEMENT_ENDPOINT');
        },
        get url() {
          return required(env, 'WEBSOCKET_URL');
        },
      };
    case 'record': {
      const raw = env[key];
      return raw ? (JSON.parse(raw) as Record<string, string>) : undefined;
    }
    case 'queueUrls':
      // Hosted links a `sourceQueueUrls` Linkable (queue name -> URL) to the frontend, so
      // getSourceQueueUrl reads it rather than the individual queues. Reproduce that here by
      // lazily mapping each requested camelCase queue name to its SCREAMING_SNAKE env URL;
      // unset queues resolve to undefined (getSourceQueueUrl then reports "missing").
      return new Proxy({} as Record<string, string | undefined>, {
        get(_t, prop) {
          return typeof prop === 'string' ? resolve(env, toEnvKey(prop), true) : undefined;
        },
      });
  }
}

/**
 * Build a `Resource`-compatible object backed by `env`, using `manifest` to
 * know the shape of each property. Defaults to the real self-host manifest,
 * so `createResource(process.env)` is the drop-in self-host replacement for
 * `Resource` from `sst`. `App` is always available; any property not in the
 * manifest throws on access (a self-host misconfiguration, caught early).
 */
export function createResource<M extends Manifest = typeof DEFAULT_MANIFEST>(
  env: Env,
  manifest: M = DEFAULT_MANIFEST as unknown as M
): ResourceShim<M> {
  const app: App = {
    name: env.APP_NAME ?? 'bike4mind',
    stage: env.APP_STAGE ?? 'selfhost',
  };

  return new Proxy({} as ResourceShim<M>, {
    get(_target, prop: string | symbol) {
      if (prop === 'App') return app;
      if (typeof prop !== 'string') return undefined;
      const entry = manifest[prop];
      if (!entry) {
        throw new Error(
          `Resource.${prop} is not registered in the self-host manifest. ` +
            `If this is a real resource the app needs, add it to the manifest in @bike4mind/resource.`
        );
      }
      return buildShape(prop, entry, env);
    },
  });
}

/** The self-host `Resource`, backed by `process.env`. Drop-in for `sst`'s. */
export const Resource: ResourceShim<typeof DEFAULT_MANIFEST> = createResource(process.env);

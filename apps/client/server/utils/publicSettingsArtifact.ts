import { Resource } from 'sst';
import { S3Storage } from '@bike4mind/fab-pipeline';
import { AdminSettings } from '@bike4mind/database/infra';
import {
  buildPublicSettingsProjection,
  publicSafeSettingKeys,
  type AdminSettingDoc,
  type PublicSetting,
} from '@bike4mind/common';

/**
 * Static config artifact (M2.5 - docs/perf/mobile-startup-latency.md).
 *
 * Materializes the PUBLIC-safe settings projection to a CDN-fronted S3 object so the
 * client can hydrate startup config in milliseconds (no Lambda, no DB, no auth) and
 * reconcile against the authenticated endpoint in the background.
 *
 * SECURITY: only `publicSafe`-tagged settings ever reach this file (the artifact is
 * served unauthenticated from CloudFront). The boundary lives in @bike4mind/common's
 * buildPublicSettingsProjection - do not bypass it here.
 */

/** S3 key (and matching CloudFront path) for the public config artifact. */
export const PUBLIC_SETTINGS_KEY = 'app-config/public-settings.json';

/** Bump when the artifact's envelope shape changes (not its contents). */
const ARTIFACT_VERSION = 1;

/** ~1 change/day: short edge TTL, long SWR window. Client revalidation closes any gap. */
const ARTIFACT_CACHE_CONTROL = 'public, max-age=60, stale-while-revalidate=86400';

export interface PublicSettingsArtifact {
  version: number;
  updatedAt: string;
  settings: PublicSetting[];
}

interface MinimalLogger {
  info?: (msg: string) => void;
  error?: (msg: string) => void;
  warn?: (msg: string) => void;
}

/**
 * Rebuild and upload the public settings artifact. Best-effort by design: callers
 * (e.g. the settings update handler) must not let a materialization failure break the
 * underlying write - invoke inside try/catch or via materializePublicSettingsArtifactSafe.
 */
export async function materializePublicSettingsArtifact(logger?: MinimalLogger): Promise<void> {
  // Project to only the two fields at query time (defense in depth) so Mongo/soft-delete
  // metadata (_id/__v/createdAt/updatedAt/deletedAt) never reaches the unauthenticated file.
  // buildPublicSettingsProjection slims again regardless - belt and suspenders.
  const docs = await AdminSettings.find(
    { settingName: { $in: publicSafeSettingKeys() } },
    { settingName: 1, settingValue: 1, _id: 0 }
  ).lean();
  const settings = buildPublicSettingsProjection(docs as unknown as AdminSettingDoc[]);

  const artifact: PublicSettingsArtifact = {
    version: ARTIFACT_VERSION,
    updatedAt: new Date().toISOString(),
    settings,
  };

  const storage = new S3Storage(Resource.appFilesBucket.name);
  await storage.upload(JSON.stringify(artifact), PUBLIC_SETTINGS_KEY, {
    ContentType: 'application/json',
    CacheControl: ARTIFACT_CACHE_CONTROL,
  });

  logger?.info?.(`📦 Materialized public settings artifact (${settings.length} keys) → ${PUBLIC_SETTINGS_KEY}`);
}

/** Fire-and-forget wrapper: logs failures, never throws. */
export async function materializePublicSettingsArtifactSafe(logger?: MinimalLogger): Promise<void> {
  try {
    await materializePublicSettingsArtifact(logger);
  } catch (err) {
    logger?.error?.(
      `Failed to materialize public settings artifact: ${err instanceof Error ? err.message : String(err)}`
    );
  }
}

let bootstrapSucceeded = false;

/**
 * Bootstrap/self-heal: ensure the artifact exists at least once per warm Lambda instance.
 * Called from the authed settings read path so the artifact is created after a fresh deploy
 * (and refreshed if settings were changed out-of-band, e.g. via migration) without waiting
 * for the next publicSafe write.
 *
 * Returns a promise the caller MUST await before responding: in Lambda the execution
 * environment freezes once the handler responds, so an un-awaited materialization is
 * silently dropped (verified on a preview env - the artifact never appeared). It only does
 * work on the first call per instance; once it has succeeded, later calls resolve instantly.
 *
 * Retry-safe: the success flag is only set AFTER a successful materialization. A transient
 * S3/DB failure is swallowed (logged) and leaves the instance eligible to retry on the next
 * request, and never breaks the calling read.
 */
export async function ensurePublicSettingsArtifactOncePerInstance(logger?: MinimalLogger): Promise<void> {
  if (bootstrapSucceeded) return;
  try {
    await materializePublicSettingsArtifact(logger);
    bootstrapSucceeded = true;
  } catch (err) {
    logger?.error?.(
      `Public settings artifact bootstrap failed (will retry on next request): ${err instanceof Error ? err.message : String(err)}`
    );
  }
}

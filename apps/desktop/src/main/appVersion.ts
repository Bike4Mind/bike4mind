import { app } from 'electron';

/**
 * This run's version. An unpackaged run would report package.json's baseline, so it reports the one baked in
 * from the local checkout instead (scripts/dev-version.cjs). Every main-process reader goes through here
 * rather than app.getVersion(), which appVersion.test.ts enforces.
 */
export function currentVersion(): string {
  if (app.isPackaged || !__B4M_DEV_VERSION__) return app.getVersion();
  return __B4M_DEV_VERSION__;
}

/** How the unpackaged version was derived, for app info; undefined for a packaged build. */
export function currentVersionBasis(): string | undefined {
  if (app.isPackaged || !__B4M_DEV_VERSION__) return undefined;
  return __B4M_DEV_VERSION_BASIS__ || undefined;
}

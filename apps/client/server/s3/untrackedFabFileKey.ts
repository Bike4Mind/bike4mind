/** Fab-file bucket keys written without a FabFile row, skipped by both object-created paths before the lookup. */
export const isUntrackedFabFileKey = (key: string): boolean =>
  key.includes('/backups/') ||
  key.startsWith('temp/') ||
  key.startsWith('tmp/') ||
  key.startsWith('exports/') ||
  key.startsWith('proxied-images/') ||
  key.startsWith('tavern-sounds/') ||
  key.startsWith('cc-bridge/') ||
  key.startsWith('cc-bridge-downloads/') ||
  // Written by the libreoncology premium overlay's mock-oral storage, which owns this prefix; a
  // rename there silently disables the skip.
  key.startsWith('libreoncology/mock-oral/');

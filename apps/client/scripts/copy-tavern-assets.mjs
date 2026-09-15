/**
 * Copy Tavern public assets from the premium-tavern package to apps/client/public.
 *
 * No-ops gracefully when the package is absent (open-core fork without the
 * premium overlay) so the fork build stays green. Runs as part of postinstall.
 */

import fs from 'fs-extra';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

async function copyTavernAssets() {
  const src = path.resolve(__dirname, '../../../packages/premium/tavern/public/assets/tavern');
  const dst = path.resolve(__dirname, '../public/assets/tavern');

  const srcExists = await fs.pathExists(src);
  if (!srcExists) {
    // No-op: premium overlay not present (open-core fork or pre-bootstrap).
    return;
  }

  await fs.ensureDir(dst);
  await fs.copy(src, dst, { overwrite: true });
  console.log('[tavern-assets] copied', src, '→', dst);
}

copyTavernAssets().catch(err => {
  console.error('[tavern-assets] copy failed:', err);
  process.exit(1);
});

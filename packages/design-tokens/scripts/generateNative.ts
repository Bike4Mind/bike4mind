import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { findDrift, planNativeFiles, REPO_ROOT } from './nativeOutputs';

// Writes the native token files into the apps (`pnpm generate:native`), or with
// --check exits non-zero listing the files that drifted from the tokens.

const main = async (): Promise<void> => {
  if (process.argv.includes('--check')) {
    const drifted = await findDrift();
    if (drifted.length > 0) {
      console.error(`Native token files drifted from the tokens; run pnpm generate:native:\n  ${drifted.join('\n  ')}`);
      process.exitCode = 1;
    }
    return;
  }
  for (const file of planNativeFiles()) {
    const target = path.join(REPO_ROOT, file.repoPath);
    await mkdir(path.dirname(target), { recursive: true });
    await writeFile(target, file.contents);
    console.log(`wrote ${file.repoPath}`);
  }
};

await main();

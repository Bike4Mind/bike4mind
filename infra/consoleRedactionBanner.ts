import path from 'node:path';
import { buildSync } from 'esbuild';

/** Entry that installs the console redaction shim; resolved against the repo root. */
export const CONSOLE_REDACTION_ENTRY = 'packages/server-utils/src/bootstrap/lambdaConsoleRedaction.ts';

/**
 * The console redaction shim as a self-contained script for `nodejs.banner`. SST's Function
 * builder forwards only some esbuild options and silently drops `inject`, so the shim cannot be
 * bundled in as a module; a banner is emitted verbatim at the top of every bundle instead.
 * Needs `@bike4mind/observability` built (the core build every deploy already runs).
 */
export function consoleRedactionBanner(root: string): string {
  const result = buildSync({
    entryPoints: [path.join(root, CONSOLE_REDACTION_ENTRY)],
    absWorkingDir: root,
    bundle: true,
    write: false,
    format: 'iife',
    platform: 'node',
    target: 'node24',
    minify: true,
    legalComments: 'none',
    logLevel: 'silent',
  });
  return result.outputFiles[0].text.trim();
}

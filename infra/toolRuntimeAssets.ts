/**
 * Runtime assets that must sit next to the bundle of a Lambda able to execute the tool set.
 *
 * An `sst.aws.Function` ships one esbuild bundle plus whatever `copyFiles` names, and nothing
 * else. Any dependency that loads a sibling binary at runtime - rather than importing it - is
 * therefore invisible to the bundler and has to be listed here explicitly:
 *
 *  - `tiktoken` reads `tiktoken_bg.wasm` from the bundle root.
 *  - `highs` (premium overlay) resolves `highs.wasm` through its emscripten `locateFile`,
 *    which under Node returns a path next to the loader script, i.e. `/var/task/highs.wasm`.
 *    Without the copy the solver aborts with `ENOENT ... /var/task/highs.wasm`, so agent mode
 *    and the Slack quest path silently lose the solver while the chat path keeps it.
 *
 * The other compute surfaces are already covered by different mechanisms and need nothing
 * here: the ChatCompletion Fargate image and the Next.js server both carry real node_modules,
 * and the browser is served `apps/client/public/highs.wasm` by the postinstall copy.
 *
 * `infra/__tests__/toolRuntimeAssets.test.ts` fails the build if a Lambda whose handler can
 * reach the premium tool map stops using this list.
 */

import path from 'path';

import { resolveHighsWasm, isOptihashiOverlayPresent } from '../scripts/resolve-highs-wasm.mjs';

/** An `sst.aws.Function` `copyFiles` entry. */
export type RuntimeAsset = { from: string; to: string };

/** Needed by every LLM-executing Lambda, tool-capable or not. */
const TIKTOKEN_ASSET: RuntimeAsset = {
  from: 'apps/client/node_modules/tiktoken/tiktoken_bg.wasm',
  to: 'tiktoken_bg.wasm',
};

/**
 * The asset list for a given `highs.wasm` location. Split out from `toolRuntimeAssets()` so
 * both branches stay testable on a checkout where the overlay - and therefore highs - is absent.
 *
 * `appRoot` must be the same root SST resolves `copyFiles` against, since it does
 * `path.join($cli.paths.root, entry.from)`: an absolute `from` would be joined onto the root
 * rather than replacing it, so every entry has to be relative to it.
 */
export function buildToolRuntimeAssets(highsWasmPath: string | null, appRoot: string): RuntimeAsset[] {
  if (!highsWasmPath) return [TIKTOKEN_ASSET];
  return [TIKTOKEN_ASSET, { from: path.relative(appRoot, highsWasmPath), to: 'highs.wasm' }];
}

/**
 * `copyFiles` for a Lambda that can execute the tool set.
 *
 * The highs entry stays conditional on purpose: `highs` ships with the premium overlay, and
 * SST `stat()`s every `copyFiles` source, so an unconditional entry would fail `sst deploy`
 * outright on an open-core build.
 *
 * `appRoot` defaults to `$cli.paths.root` - read at call time, so tests can pass a root
 * without the SST global existing. Deriving it from `import.meta.url` instead would be wrong
 * the moment SST bundles the config.
 */
export function toolRuntimeAssets(appRoot: string = $cli.paths.root): RuntimeAsset[] {
  const highsWasm = resolveHighsWasm(appRoot);
  if (!highsWasm && isOptihashiOverlayPresent(appRoot)) {
    // A hydrated overlay whose highs did not resolve is a misconfiguration, not open-core:
    // the deploy would succeed and the solver would ENOENT on first use. Say so at synth time.
    console.warn(
      '[toolRuntimeAssets] optihashi overlay present but highs did not resolve - the highs solver will ENOENT in AgentExecutor and SlackQuestProcessor'
    );
  }
  return buildToolRuntimeAssets(highsWasm, appRoot);
}

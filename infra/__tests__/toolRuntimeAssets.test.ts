/**
 * @vitest-environment node
 *
 * Guard for the class of bug where a Lambda can execute the tool set but its bundle does not
 * carry an asset one of those tools loads at runtime (see infra/toolRuntimeAssets.ts). In the
 * instance that prompted it, both plain-Lambda surfaces copied only tiktoken_bg.wasm, so the
 * highs solver ENOENT'd on /var/task/highs.wasm while the identical request on the chat path
 * (Fargate, real node_modules) worked fine.
 *
 * "Can execute the tool set" is decided the same way the runtime decides it: the handler's
 * static import graph reaches the generated premium tool map. That makes this guard fire for
 * the NEXT such Lambda too, rather than pinning the two that exist today.
 *
 * Scope: functions declared in this repo's infra/. Overlays contribute their own functions
 * through `contributeInfra`, and those live - and must be guarded - in the overlay repo.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync, existsSync, readdirSync } from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

import { buildToolRuntimeAssets, toolRuntimeAssets } from '../toolRuntimeAssets';
import { resolveHighsWasm } from '../../scripts/resolve-highs-wasm.mjs';

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const INFRA_DIR = path.join(REPO_ROOT, 'infra');
const CLIENT_DIR = path.join(REPO_ROOT, 'apps/client');

/** The generated premium tool map. A handler that reaches it can execute the premium tools. */
const PREMIUM_TOOL_MAP = 'premium-generated/premiumLlmTools.generated';

/**
 * Handlers re-exported from the overlay through the stable premium-generated seam. They do
 * not exist in an open-core checkout, so their import graph is unwalkable here; the overlay
 * repo owns their bundle contents. Anything else that fails to resolve is a real break (a
 * moved or misspelled handler) and fails the test.
 */
const OVERLAY_HANDLER_PREFIX = 'apps/client/server/premium-generated/';

const SOURCE_EXTENSIONS = ['.ts', '.tsx', '.mts'];

/** tsconfig `paths` from apps/client, which is where every Lambda handler lives. */
const CLIENT_ALIASES: ReadonlyArray<readonly [string, string]> = [
  ['@server/', path.join(CLIENT_DIR, 'server')],
  ['@pages/', path.join(CLIENT_DIR, 'pages')],
  ['@public/', path.join(CLIENT_DIR, 'public')],
  ['@client/', CLIENT_DIR],
  ['@/', CLIENT_DIR],
];

function resolveSourceFile(withoutExtension: string): string | null {
  for (const extension of SOURCE_EXTENSIONS) {
    const candidate = `${withoutExtension}${extension}`;
    if (existsSync(candidate)) return candidate;
    const indexCandidate = path.join(withoutExtension, `index${extension}`);
    if (existsSync(indexCandidate)) return indexCandidate;
  }
  return null;
}

/** Resolves the local specifiers we can follow; returns null for node_modules and packages. */
function resolveImport(specifier: string, fromFile: string): string | null {
  if (specifier.startsWith('.')) {
    return resolveSourceFile(path.resolve(path.dirname(fromFile), specifier));
  }
  for (const [prefix, base] of CLIENT_ALIASES) {
    if (specifier.startsWith(prefix)) {
      return resolveSourceFile(path.join(base, specifier.slice(prefix.length)));
    }
  }
  return null;
}

/** Every module specifier in a source file: static, side-effect and dynamic imports alike. */
function moduleSpecifiers(source: string): string[] {
  const specifiers: string[] = [];
  for (const match of source.matchAll(/(?:from|import)\s*\(?\s*['"]([^'"]+)['"]/g)) {
    specifiers.push(match[1]);
  }
  return specifiers;
}

/** Whether the handler module's import graph reaches the premium tool map. */
function reachesPremiumToolMap(entryFile: string): boolean {
  const visited = new Set<string>();
  const queue = [entryFile];
  while (queue.length > 0) {
    const file = queue.shift() as string;
    if (visited.has(file)) continue;
    visited.add(file);
    for (const specifier of moduleSpecifiers(readFileSync(file, 'utf8'))) {
      if (specifier.includes(PREMIUM_TOOL_MAP)) return true;
      const resolved = resolveImport(specifier, file);
      if (resolved && !visited.has(resolved)) queue.push(resolved);
    }
  }
  return false;
}

type HandlerDeclaration = {
  /** infra file the declaration lives in, e.g. "agentExecutor.ts". */
  infraFile: string;
  /** SST handler string, e.g. "apps/client/server/queueHandlers/agentExecutor.handler". */
  handler: string;
  /** Source of the object literal declaring it, so `copyFiles` can be checked on it. */
  config: string;
};

/**
 * Every `handler: '...'` in infra/, paired with the source of the object literal it sits in.
 *
 * A brace-depth scan rather than a regex, because the config object holds nested objects and
 * arrays; strings and comments are skipped so a brace inside either cannot desync the depth.
 */
function findHandlerDeclarations(infraFile: string): HandlerDeclaration[] {
  const source = readFileSync(path.join(INFRA_DIR, infraFile), 'utf8');
  const declarations: HandlerDeclaration[] = [];
  const openBraces: number[] = [];
  let index = 0;

  while (index < source.length) {
    const character = source[index];

    if (character === '/' && source[index + 1] === '/') {
      index = source.indexOf('\n', index);
      if (index === -1) break;
      continue;
    }
    if (character === '/' && source[index + 1] === '*') {
      const end = source.indexOf('*/', index + 2);
      index = end === -1 ? source.length : end + 2;
      continue;
    }
    if (character === "'" || character === '"' || character === '`') {
      index += 1;
      while (index < source.length && source[index] !== character) {
        index += source[index] === '\\' ? 2 : 1;
      }
      index += 1;
      continue;
    }
    if (character === '{') {
      openBraces.push(index);
      index += 1;
      continue;
    }
    if (character === '}') {
      openBraces.pop();
      index += 1;
      continue;
    }

    // `startsWith` first: slicing the whole remainder at every index to feed the regex turns
    // the scan quadratic on files the size of infra/queues.ts.
    const handlerMatch = source.startsWith('handler:', index)
      ? /^handler:\s*'([^']+)'/.exec(source.slice(index, index + 200))
      : null;
    if (handlerMatch && openBraces.length > 0) {
      const start = openBraces[openBraces.length - 1];
      declarations.push({
        infraFile,
        handler: handlerMatch[1],
        config: sliceObjectLiteral(source, start),
      });
      index += handlerMatch[0].length;
      continue;
    }

    index += 1;
  }

  return declarations;
}

/** Source from an opening brace through its match, skipping strings and comments. */
function sliceObjectLiteral(source: string, openBraceIndex: number): string {
  let depth = 0;
  let index = openBraceIndex;
  while (index < source.length) {
    const character = source[index];
    if (character === '/' && source[index + 1] === '/') {
      index = source.indexOf('\n', index);
      if (index === -1) break;
      continue;
    }
    if (character === '/' && source[index + 1] === '*') {
      const end = source.indexOf('*/', index + 2);
      index = end === -1 ? source.length : end + 2;
      continue;
    }
    if (character === "'" || character === '"' || character === '`') {
      index += 1;
      while (index < source.length && source[index] !== character) {
        index += source[index] === '\\' ? 2 : 1;
      }
      index += 1;
      continue;
    }
    if (character === '{') depth += 1;
    if (character === '}') {
      depth -= 1;
      if (depth === 0) return source.slice(openBraceIndex, index + 1);
    }
    index += 1;
  }
  return source.slice(openBraceIndex);
}

const handlerDeclarations = readdirSync(INFRA_DIR)
  .filter((file) => file.endsWith('.ts'))
  .flatMap(findHandlerDeclarations);

describe('buildToolRuntimeAssets', () => {
  const HIGHS_WASM = path.join(REPO_ROOT, 'node_modules/.pnpm/node_modules/highs/build/highs.wasm');

  it('always copies the tiktoken binary', () => {
    expect(buildToolRuntimeAssets(null, REPO_ROOT)).toEqual([
      { from: 'apps/client/node_modules/tiktoken/tiktoken_bg.wasm', to: 'tiktoken_bg.wasm' },
    ]);
  });

  it('copies highs.wasm to the bundle root, where the emscripten glue looks for it', () => {
    expect(buildToolRuntimeAssets(HIGHS_WASM, REPO_ROOT)).toContainEqual({
      from: 'node_modules/.pnpm/node_modules/highs/build/highs.wasm',
      to: 'highs.wasm',
    });
  });

  it('emits app-root-relative sources, since SST joins `from` onto the app root', () => {
    for (const asset of buildToolRuntimeAssets(HIGHS_WASM, REPO_ROOT)) {
      expect(path.isAbsolute(asset.from)).toBe(false);
    }
  });

  it('names a source that exists whenever highs resolves in this checkout', () => {
    // SST stat()s every copyFiles source, so a path that does not exist fails the deploy.
    for (const asset of buildToolRuntimeAssets(resolveHighsWasm(REPO_ROOT), REPO_ROOT)) {
      expect(existsSync(path.join(REPO_ROOT, asset.from))).toBe(true);
    }
  });

  it('feeds the real resolver through to the list infra actually ships', () => {
    // The wiring between resolver and list, which the pure builder above cannot cover.
    expect(toolRuntimeAssets(REPO_ROOT)).toEqual(buildToolRuntimeAssets(resolveHighsWasm(REPO_ROOT), REPO_ROOT));
  });
});

describe('Lambdas that can execute the premium tool set', () => {
  it('finds handler declarations to check', () => {
    expect(handlerDeclarations.length).toBeGreaterThan(0);
  });

  it('declares every handler as a resolvable module, or as an overlay re-export', () => {
    const unresolvable = handlerDeclarations
      .filter((declaration) => !declaration.handler.startsWith(OVERLAY_HANDLER_PREFIX))
      .filter(
        (declaration) =>
          resolveSourceFile(path.join(REPO_ROOT, declaration.handler.split('.').slice(0, -1).join('.'))) === null
      )
      .map((declaration) => `${declaration.infraFile}: ${declaration.handler}`);
    expect(unresolvable.join('\n')).toBe('');
  });

  it('copies the tool runtime assets on every Lambda whose handler reaches the tool map', () => {
    const missing = handlerDeclarations
      .filter((declaration) => !declaration.handler.startsWith(OVERLAY_HANDLER_PREFIX))
      .filter((declaration) => {
        const entry = resolveSourceFile(path.join(REPO_ROOT, declaration.handler.split('.').slice(0, -1).join('.')));
        return entry !== null && reachesPremiumToolMap(entry);
      })
      // Deliberately not pinned to `copyFiles: toolRuntimeAssets()` exactly - a Lambda that
      // later needs an extra asset should be free to spread the list.
      .filter((declaration) => !(declaration.config.includes('copyFiles:') && declaration.config.includes('toolRuntimeAssets()')))
      .map((declaration) => `${declaration.infraFile}: ${declaration.handler}`);

    expect(missing.join('\n')).toBe('');
  });

  it('still recognises the two known tool-capable Lambdas', () => {
    // Pins the detector itself: if the marker import moves and reachability silently returns
    // false everywhere, the check above would pass vacuously.
    const toolCapable = handlerDeclarations
      .filter((declaration) => !declaration.handler.startsWith(OVERLAY_HANDLER_PREFIX))
      .filter((declaration) => {
        const entry = resolveSourceFile(path.join(REPO_ROOT, declaration.handler.split('.').slice(0, -1).join('.')));
        return entry !== null && reachesPremiumToolMap(entry);
      })
      .map((declaration) => declaration.handler);

    expect(toolCapable).toContain('apps/client/server/queueHandlers/agentExecutor.handler');
    expect(toolCapable).toContain('apps/client/server/queueHandlers/slackQuestProcessor.handler');
  });
});

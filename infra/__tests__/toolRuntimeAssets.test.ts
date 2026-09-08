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
import { resolveHighsWasm } from '../../apps/client/scripts/resolve-highs-wasm.mjs';

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const INFRA_DIR = path.join(REPO_ROOT, 'infra');
const CLIENT_DIR = path.join(REPO_ROOT, 'apps/client');

/** The generated premium tool map. A handler that reaches it can execute the premium tools. */
const PREMIUM_TOOL_MAP = 'premium-generated/premiumLlmTools.generated';

/**
 * Handlers re-exported from the overlay through the stable premium-generated seam. The stub
 * files are codegen output and simply do not exist in an open-core checkout, so only the
 * "every handler resolves" check below exempts them. Anything else that fails to resolve is a
 * real break (a moved or misspelled handler) and fails the test.
 *
 * The rule itself - every tool-capable handler carries `toolRuntimeAssets()` - deliberately
 * does NOT exempt them: `overwatchAnalytics`, `optihashiRunCompletion` and `bobRunWorker` are
 * configured in this repo (infra/queues.ts) and so are this repo's to guard.
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
 * Characters that can only precede a regex literal, never a division operator. Enough to tell
 * the two `/` meanings apart without a real tokenizer, because infra/ only ever writes a regex
 * as a call argument (`.replace(/x/, y)`), after `=>`, or on the right of an assignment.
 */
const REGEX_LITERAL_PRECEDERS = new Set([
  '(',
  ',',
  '=',
  ':',
  '[',
  '!',
  '&',
  '|',
  '?',
  '{',
  '}',
  ';',
  '+',
  '-',
  '*',
  '%',
  '<',
  '>',
  '~',
  '^',
]);

/** Index just past the comment starting at `index`, or null when none starts there. */
function skipComment(source: string, index: number): number | null {
  if (source[index] !== '/') return null;
  if (source[index + 1] === '/') {
    const end = source.indexOf('\n', index);
    return end === -1 ? source.length : end;
  }
  if (source[index + 1] === '*') {
    const end = source.indexOf('*/', index + 2);
    return end === -1 ? source.length : end + 2;
  }
  return null;
}

/**
 * Index just past the string or regex literal starting at `index`, or null when none does.
 *
 * Regex literals have to be recognised as carefully as strings: an unhandled `/'/` reads as the
 * start of a string and swallows source up to the next quote, silently dropping every handler
 * declaration in between. A single `.replace(/'/g, '')` added to infra/websocket.ts takes this
 * scan from 14 handlers to 3 - passing, just guarding almost nothing.
 */
function skipQuotedOrRegex(source: string, index: number, previousCharacter: string): number | null {
  const character = source[index];

  if (character === "'" || character === '"' || character === '`') {
    let end = index + 1;
    while (end < source.length && source[end] !== character) {
      end += source[end] === '\\' ? 2 : 1;
    }
    return end + 1;
  }

  if (character !== '/' || !REGEX_LITERAL_PRECEDERS.has(previousCharacter)) return null;

  let end = index + 1;
  let inCharacterClass = false;
  while (end < source.length) {
    const current = source[end];
    // An unterminated "regex" by end of line was a division after all; leave it to the caller
    // rather than swallowing the rest of the file.
    if (current === '\n') return null;
    if (current === '\\') {
      end += 2;
      continue;
    }
    if (current === '[') inCharacterClass = true;
    else if (current === ']') inCharacterClass = false;
    else if (current === '/' && !inCharacterClass) return end + 1;
    end += 1;
  }
  return null;
}

/**
 * Every `handler: '...'` in one infra source, paired with the object literal it sits in.
 *
 * A brace-depth scan rather than a regex, because the config object holds nested objects and
 * arrays; comments, strings and regex literals are skipped so a brace or quote inside any of
 * them cannot desync the depth.
 */
function scanHandlerDeclarations(source: string, infraFile: string): HandlerDeclaration[] {
  const declarations: HandlerDeclaration[] = [];
  const openBraces: number[] = [];
  let index = 0;
  let previousCharacter = '';

  while (index < source.length) {
    const character = source[index];

    const afterComment = skipComment(source, index);
    if (afterComment !== null) {
      // Comments are transparent: `previousCharacter` must keep describing the last real code
      // so a regex on the far side of one is still recognised.
      index = afterComment;
      continue;
    }

    const afterLiteral = skipQuotedOrRegex(source, index, previousCharacter);
    if (afterLiteral !== null) {
      index = afterLiteral;
      // A completed literal cannot be followed by another regex, so record it as a value.
      previousCharacter = ')';
      continue;
    }

    if (character === '{') {
      openBraces.push(index);
      index += 1;
      previousCharacter = character;
      continue;
    }
    if (character === '}') {
      openBraces.pop();
      index += 1;
      previousCharacter = character;
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
      previousCharacter = ')';
      continue;
    }

    if (!/\s/.test(character)) previousCharacter = character;
    index += 1;
  }

  return declarations;
}

function findHandlerDeclarations(infraFile: string): HandlerDeclaration[] {
  return scanHandlerDeclarations(readFileSync(path.join(INFRA_DIR, infraFile), 'utf8'), infraFile);
}

/** Source from an opening brace through its match, skipping comments, strings and regexes. */
function sliceObjectLiteral(source: string, openBraceIndex: number): string {
  let depth = 0;
  let index = openBraceIndex;
  let previousCharacter = '';

  while (index < source.length) {
    const character = source[index];

    const afterComment = skipComment(source, index);
    if (afterComment !== null) {
      index = afterComment;
      continue;
    }

    const afterLiteral = skipQuotedOrRegex(source, index, previousCharacter);
    if (afterLiteral !== null) {
      index = afterLiteral;
      previousCharacter = ')';
      continue;
    }

    if (character === '{') depth += 1;
    if (character === '}') {
      depth -= 1;
      if (depth === 0) return source.slice(openBraceIndex, index + 1);
    }

    if (!/\s/.test(character)) previousCharacter = character;
    index += 1;
  }
  return source.slice(openBraceIndex);
}

/**
 * Independent count of handler declarations: a line-anchored regex over comment-stripped
 * source, sharing no machinery with the brace scan above. It is the oracle for the test that
 * catches the scan silently under-counting.
 */
function countDeclaredHandlerLines(source: string): number {
  const withoutComments = source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
  return (withoutComments.match(/^\s*handler:\s*'/gm) || []).length;
}

const handlerDeclarations = readdirSync(INFRA_DIR)
  .filter(file => file.endsWith('.ts'))
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

describe('the infra handler scan', () => {
  it('sees every handler declared in every infra file', () => {
    // Pinned against an independent measurement rather than a hard-coded total, so adding a
    // queue needs no test edit while a scan that desyncs - and therefore guards less than it
    // appears to - still fails loudly.
    const mismatched = readdirSync(INFRA_DIR)
      .filter(file => file.endsWith('.ts'))
      .map(file => {
        const source = readFileSync(path.join(INFRA_DIR, file), 'utf8');
        return {
          file,
          scanned: scanHandlerDeclarations(source, file).length,
          declared: countDeclaredHandlerLines(source),
        };
      })
      .filter(({ scanned, declared }) => scanned !== declared)
      .map(({ file, scanned, declared }) => `${file}: scanned ${scanned}, declared ${declared}`);

    expect(mismatched.join('\n')).toBe('');
  });

  it('does not lose declarations to a regex literal containing a quote', () => {
    const source = [
      "const sanitize = (value: string) => value.replace(/'/g, '');",
      "const worker = { handler: 'apps/client/server/queueHandlers/agentExecutor.handler' };",
    ].join('\n');

    expect(scanHandlerDeclarations(source, 'synthetic.ts').map(declaration => declaration.handler)).toEqual([
      'apps/client/server/queueHandlers/agentExecutor.handler',
    ]);
  });

  it('does not lose declarations to a regex literal containing braces', () => {
    const source = [
      'const isAccountId = (id: string) => /^\\d{12}$/.test(id);',
      "const worker = { handler: 'apps/client/server/queueHandlers/agentExecutor.handler' };",
    ].join('\n');

    expect(scanHandlerDeclarations(source, 'synthetic.ts').map(declaration => declaration.handler)).toEqual([
      'apps/client/server/queueHandlers/agentExecutor.handler',
    ]);
  });

  it('still reads a division expression as ordinary code', () => {
    const source = [
      'const share = total / count / 2;',
      "const worker = { handler: 'apps/client/server/queueHandlers/agentExecutor.handler' };",
    ].join('\n');

    expect(scanHandlerDeclarations(source, 'synthetic.ts').map(declaration => declaration.handler)).toEqual([
      'apps/client/server/queueHandlers/agentExecutor.handler',
    ]);
  });

  it('captures the whole config literal, braces inside a regex included', () => {
    const source = "const worker = { handler: 'a.handler', filter: /^x{2}$/, copyFiles: toolRuntimeAssets() };";

    expect(scanHandlerDeclarations(source, 'synthetic.ts')[0].config).toContain('toolRuntimeAssets()');
  });
});

describe('Lambdas that can execute the premium tool set', () => {
  it('finds handler declarations to check', () => {
    expect(handlerDeclarations.length).toBeGreaterThan(0);
  });

  it('declares every handler as a resolvable module, or as an overlay re-export', () => {
    const unresolvable = handlerDeclarations
      .filter(declaration => !declaration.handler.startsWith(OVERLAY_HANDLER_PREFIX))
      .filter(
        declaration =>
          resolveSourceFile(path.join(REPO_ROOT, declaration.handler.split('.').slice(0, -1).join('.'))) === null
      )
      .map(declaration => `${declaration.infraFile}: ${declaration.handler}`);
    expect(unresolvable.join('\n')).toBe('');
  });

  it('copies the tool runtime assets on every Lambda whose handler reaches the tool map', () => {
    // No overlay exemption here on purpose: a handler configured in this repo is this repo's
    // to guard. What actually bounds coverage is `resolveImport`, which stops at the package
    // edge - a generated stub is `export * from '@bike4mind/premium-<x>/...'`, so the walk
    // ends there and the handler is skipped as unreachable rather than as exempt. Overlay
    // bundles therefore still need their own guard in the overlay repo. Checked at the time
    // of writing: none of the three overlay handlers reaches the tool map.
    const missing = handlerDeclarations
      .filter(declaration => {
        const entry = resolveSourceFile(path.join(REPO_ROOT, declaration.handler.split('.').slice(0, -1).join('.')));
        return entry !== null && reachesPremiumToolMap(entry);
      })
      // Deliberately not pinned to `copyFiles: toolRuntimeAssets()` exactly - a Lambda that
      // later needs an extra asset should be free to spread the list.
      .filter(
        declaration =>
          !(declaration.config.includes('copyFiles:') && declaration.config.includes('toolRuntimeAssets()'))
      )
      .map(declaration => `${declaration.infraFile}: ${declaration.handler}`);

    expect(missing.join('\n')).toBe('');
  });

  it('still recognises the two known tool-capable Lambdas', () => {
    // Pins the detector itself: if the marker import moves and reachability silently returns
    // false everywhere, the check above would pass vacuously.
    const toolCapable = handlerDeclarations
      .filter(declaration => {
        const entry = resolveSourceFile(path.join(REPO_ROOT, declaration.handler.split('.').slice(0, -1).join('.')));
        return entry !== null && reachesPremiumToolMap(entry);
      })
      .map(declaration => declaration.handler);

    expect(toolCapable).toContain('apps/client/server/queueHandlers/agentExecutor.handler');
    expect(toolCapable).toContain('apps/client/server/queueHandlers/slackQuestProcessor.handler');
  });
});

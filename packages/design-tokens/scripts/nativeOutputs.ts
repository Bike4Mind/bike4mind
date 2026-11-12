import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { designTokens } from '../src/tokens';
import { swiftEmitter } from '../src/emitters/native/swift';
import type { TokenEmitter } from '../src/emitters/types';
import type { EmittedFiles } from '../src/emitters/native/types';

// Where each native emitter's files live in the repo. The generated files are
// committed, and nativeOutputs.test.ts fails when they drift from the tokens
// (the same reproducibility rule as apps/ios `make generate-client`). A Kotlin
// target for Android adds one entry here.

type NativeOutput = {
  readonly emitter: TokenEmitter<EmittedFiles>;
  /** Repo-relative root of the consuming app. */
  readonly root: string;
  /** Emitted file -> every app-relative path it is written to. */
  readonly destinations: Readonly<Record<string, readonly string[]>>;
};

export const NATIVE_OUTPUTS: readonly NativeOutput[] = [
  {
    emitter: swiftEmitter,
    root: 'apps/ios',
    destinations: {
      'BrandTokens.swift': ['Packages/B4MKit/Sources/B4MKit/Theme/Generated/BrandTokens.swift'],
      'AccentColor.colorset/Contents.json': [
        'Bike4Mind/Resources/Assets.xcassets/AccentColor.colorset/Contents.json',
        'Widgets/Assets.xcassets/AccentColor.colorset/Contents.json',
      ],
    },
  },
];

export const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');

export type PlannedFile = { readonly repoPath: string; readonly contents: string };

/** Every file the native emitters produce, at its repo-relative destination. */
export const planNativeFiles = (): PlannedFile[] =>
  NATIVE_OUTPUTS.flatMap(output => {
    const files = output.emitter.emit(designTokens);
    const unmapped = Object.keys(files).filter(name => !Object.hasOwn(output.destinations, name));
    if (unmapped.length > 0) {
      throw new Error(`${output.emitter.target}: no destination for ${unmapped.join(', ')}`);
    }
    return Object.entries(output.destinations).flatMap(([name, targets]) => {
      const contents = files[name];
      if (contents === undefined) throw new Error(`${output.emitter.target}: emitter did not produce ${name}`);
      return targets.map(target => ({ repoPath: path.posix.join(output.root, target), contents }));
    });
  });

/** Repo paths whose committed contents differ from what the emitters produce now. */
export const findDrift = async (): Promise<string[]> => {
  const drifted: string[] = [];
  for (const file of planNativeFiles()) {
    const committed = await readFile(path.join(REPO_ROOT, file.repoPath), 'utf8').catch((error: unknown) => {
      if (error instanceof Error && 'code' in error && error.code === 'ENOENT') return undefined;
      throw error;
    });
    if (committed !== file.contents) drifted.push(file.repoPath);
  }
  return drifted;
};

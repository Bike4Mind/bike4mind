import { lstat, open, readdir, realpath } from 'node:fs/promises';
import { extname, join, relative, resolve, sep } from 'node:path';
import type { z } from 'zod';
import {
  MOD_ID_PATTERN,
  SKIN_CONTRACT,
  SKIN_FILE_TYPES,
  SKIN_MAX_FILES,
  SKIN_MAX_TOTAL_BYTES,
  modManifestSchema,
  skinTokensSchema,
  type ModManifest,
  type SkinFileType,
  type SkinTokens,
} from '@shared/mods';

/** A file a validated skin references, as skinProtocol.ts serves it. */
export interface SkinAsset {
  absolutePath: string;
  size: number;
  type: SkinFileType;
}

export interface LoadedSkin {
  manifest: ModManifest;
  tokens: SkinTokens;
  /** Keyed by the path tokens.json uses (sprites/x.png); only referenced files are listed. */
  assets: Map<string, SkinAsset>;
}

export type SkinLoadResult = { ok: true; skin: LoadedSkin } | { ok: false; id: string; name?: string; error: string };

const MAX_DEPTH = 3;

class SkinRejected extends Error {}

/**
 * Validates every skin folder under `modsRoot` (userData/mods). A folder whose manifest is for another
 * kind of mod is skipped, not reported: it belongs to a later tier's loader. Sorted by id.
 */
export async function loadSkins(modsRoot: string): Promise<SkinLoadResult[]> {
  let names: string[];
  try {
    names = await readdir(modsRoot);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return [];
    throw error;
  }
  const results: SkinLoadResult[] = [];
  for (const name of names.filter(entry => !entry.startsWith('.')).sort()) {
    const result = await loadSkin(modsRoot, name);
    if (result !== 'not-a-skin') results.push(result);
  }
  return results;
}

/**
 * Validates one `mods/<id>/` folder. Rejects (with a reason the picker shows) on: a bad id, a symlink
 * anywhere in the folder, a file type off SKIN_FILE_TYPES, a file over its cap or a folder over the
 * whole-folder caps, an invalid mod.json or tokens.json, a skin contract this app does not read, or a
 * referenced file that is missing, resolves outside the folder or is not the type its name says.
 */
export async function loadSkin(modsRoot: string, id: string): Promise<SkinLoadResult | 'not-a-skin'> {
  let name: string | undefined;
  try {
    const folder = join(modsRoot, id);
    const stat = await lstat(folder);
    if (stat.isSymbolicLink()) throw new SkinRejected('the skin folder is a symbolic link');
    if (!stat.isDirectory()) return 'not-a-skin';
    if (!MOD_ID_PATTERN.test(id)) throw new SkinRejected('folder name is not a valid mod id');
    const root = await realpath(folder);

    // The manifest first: a folder holding another tier's mod is not this loader's to judge, files and all.
    const manifestJson = await readJson(await manifestOf(root), 'mod.json');
    if (isObject(manifestJson) && manifestJson.kind !== undefined && manifestJson.kind !== 'skin') return 'not-a-skin';

    const manifest = parse(modManifestSchema, manifestJson, 'mod.json');
    name = manifest.name;
    const files = await walk(root);
    if (manifest.id !== id) throw new SkinRejected(`mod.json id "${manifest.id}" does not match the folder name`);
    if (manifest.contract !== SKIN_CONTRACT) {
      throw new SkinRejected(
        `written for skin contract ${manifest.contract}; this app reads contract ${SKIN_CONTRACT}`
      );
    }

    const tokensFile = files.get('tokens.json');
    if (!tokensFile) throw new SkinRejected('tokens.json is missing');
    const tokens = parse(skinTokensSchema, await readJson(tokensFile, 'tokens.json'), 'tokens.json');

    const assets = new Map<string, SkinAsset>();
    for (const path of referencedPaths(tokens)) {
      const asset = files.get(path);
      if (!asset) throw new SkinRejected(`${path} is missing`);
      await assertContained(root, path);
      await assertSignature(asset, path);
      assets.set(path, asset);
    }
    return { ok: true, skin: { manifest, tokens, assets } };
  } catch (error) {
    if (error instanceof SkinRejected) return { ok: false, id, ...(name ? { name } : {}), error: error.message };
    const code = (error as NodeJS.ErrnoException).code;
    return {
      ok: false,
      id,
      ...(name ? { name } : {}),
      error: `could not read the skin folder (${code ?? String(error)})`,
    };
  }
}

async function manifestOf(root: string): Promise<SkinAsset> {
  const absolutePath = join(root, 'mod.json');
  let stat;
  try {
    stat = await lstat(absolutePath);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') throw new SkinRejected('mod.json is missing');
    throw error;
  }
  if (stat.isSymbolicLink()) throw new SkinRejected('mod.json is a symbolic link');
  if (!stat.isFile()) throw new SkinRejected('mod.json is not a regular file');
  return { absolutePath, size: stat.size, type: 'json' };
}

/** Every regular file under `root` keyed by its forward-slash relative path; dot-files are ignored. */
async function walk(root: string): Promise<Map<string, SkinAsset>> {
  const files = new Map<string, SkinAsset>();
  let total = 0;
  const visit = async (directory: string, depth: number): Promise<void> => {
    for (const entry of (await readdir(directory)).sort()) {
      if (entry.startsWith('.')) continue;
      const absolutePath = join(directory, entry);
      const relativePath = relative(root, absolutePath).split(sep).join('/');
      const stat = await lstat(absolutePath);
      if (stat.isSymbolicLink()) throw new SkinRejected(`${relativePath} is a symbolic link`);
      if (stat.isDirectory()) {
        if (depth >= MAX_DEPTH) throw new SkinRejected(`${relativePath} is nested too deep`);
        await visit(absolutePath, depth + 1);
        continue;
      }
      if (!stat.isFile()) throw new SkinRejected(`${relativePath} is not a regular file`);
      const type = fileType(relativePath);
      if (!type) throw new SkinRejected(`${relativePath}: this file type is not allowed in a skin`);
      const cap = SKIN_FILE_TYPES[type].maxBytes;
      if (stat.size > cap) throw new SkinRejected(`${relativePath} is over the ${formatBytes(cap)} limit for .${type}`);
      total += stat.size;
      if (files.size + 1 > SKIN_MAX_FILES) throw new SkinRejected(`more than ${SKIN_MAX_FILES} files`);
      if (total > SKIN_MAX_TOTAL_BYTES) throw new SkinRejected(`over ${formatBytes(SKIN_MAX_TOTAL_BYTES)} in total`);
      files.set(relativePath, { absolutePath, size: stat.size, type });
    }
  };
  await visit(root, 0);
  return files;
}

export function fileType(path: string): SkinFileType | undefined {
  const extension = extname(path).slice(1).toLowerCase();
  return Object.hasOwn(SKIN_FILE_TYPES, extension) ? (extension as SkinFileType) : undefined;
}

/**
 * The resolved path, and its real path once links are followed, must both stay inside the skin's real
 * root. The token schema already refuses dot segments and absolute paths; this is the check that does
 * not depend on it.
 */
export async function assertContained(root: string, relativePath: string): Promise<string> {
  const inside = (path: string) => path.startsWith(root + sep);
  const resolved = resolve(root, relativePath);
  if (!inside(resolved)) throw new SkinRejected(`${relativePath} leaves the skin folder`);
  const real = await realpath(resolved);
  if (!inside(real) || real !== resolved) throw new SkinRejected(`${relativePath} leaves the skin folder`);
  return real;
}

const SIGNATURES: Record<Exclude<SkinFileType, 'json'>, (head: Buffer) => boolean> = {
  png: head => head.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])),
  jpg: head => head[0] === 0xff && head[1] === 0xd8 && head[2] === 0xff,
  jpeg: head => head[0] === 0xff && head[1] === 0xd8 && head[2] === 0xff,
  webp: head => head.toString('latin1', 0, 4) === 'RIFF' && head.toString('latin1', 8, 12) === 'WEBP',
  ogg: head => head.toString('latin1', 0, 4) === 'OggS',
  // An ID3 tag, or an MPEG audio frame sync.
  mp3: head => head.toString('latin1', 0, 3) === 'ID3' || (head[0] === 0xff && (head[1] & 0xe0) === 0xe0),
};

/** A file's first bytes must match its extension, so a renamed document is never served as an image. */
export function matchesSignature(type: SkinFileType, head: Buffer): boolean {
  return type === 'json' || SIGNATURES[type](head);
}

async function assertSignature(asset: SkinAsset, path: string): Promise<void> {
  const head = await readHead(asset.absolutePath, 12);
  if (!matchesSignature(asset.type, head)) throw new SkinRejected(`${path} is not a valid .${asset.type} file`);
}

async function readHead(path: string, bytes: number): Promise<Buffer> {
  const handle = await open(path, 'r');
  try {
    const buffer = Buffer.alloc(bytes);
    const { bytesRead } = await handle.read(buffer, 0, bytes, 0);
    return buffer.subarray(0, bytesRead);
  } finally {
    await handle.close();
  }
}

async function readJson(file: SkinAsset, label: string): Promise<unknown> {
  const handle = await open(file.absolutePath, 'r');
  try {
    // Read at most the cap, whatever the file has grown to since it was listed.
    const buffer = Buffer.alloc(SKIN_FILE_TYPES.json.maxBytes + 1);
    const { bytesRead } = await handle.read(buffer, 0, buffer.length, 0);
    if (bytesRead > SKIN_FILE_TYPES.json.maxBytes) throw new SkinRejected(`${label} is too large`);
    return JSON.parse(buffer.toString('utf8', 0, bytesRead)) as unknown;
  } catch (error) {
    if (error instanceof SyntaxError) throw new SkinRejected(`${label} is not valid JSON`);
    throw error;
  } finally {
    await handle.close();
  }
}

function parse<T>(schema: z.ZodType<T>, value: unknown, label: string): T {
  const result = schema.safeParse(value);
  if (result.success) return result.data;
  const issues = result.error.issues.slice(0, 3).map(issue => {
    const where = issue.path.length > 0 ? issue.path.join('.') : '(root)';
    const keys = issue.code === 'unrecognized_keys' ? ` ${issue.keys.join(', ')}` : '';
    return `${where}: ${issue.message}${keys}`;
  });
  throw new SkinRejected(`${label}: ${issues.join('; ')}`);
}

function referencedPaths(tokens: SkinTokens): string[] {
  return [...Object.values(tokens.sprites ?? {}), ...Object.values(tokens.sounds ?? {})].filter(
    (path): path is string => typeof path === 'string'
  );
}

const isObject = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

const formatBytes = (bytes: number): string =>
  bytes >= 1024 * 1024 ? `${bytes / (1024 * 1024)} MB` : `${bytes / 1024} KB`;

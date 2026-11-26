import { lstat, open, readdir, realpath } from 'node:fs/promises';
import { extname, join, relative, resolve, sep } from 'node:path';
import type { z } from 'zod';
import {
  MOD_ID_PATTERN,
  SKIN_CONTRACTS_READ,
  SOUND_PACK_CONTRACT,
  SKIN_FILE_TYPES,
  SKIN_MAX_FILES,
  SKIN_MAX_TOTAL_BYTES,
  modManifestSchema,
  sceneSkinAssetPaths,
  skinTokensSchemaFor,
  type ModManifest,
  type SkinFileType,
  type SkinTokens,
  type SoundPackManifest,
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

export interface LoadedSoundPack {
  manifest: SoundPackManifest;
  /** Keyed by the path mod.json uses (sounds/x.ogg); only referenced files are listed. */
  assets: Map<string, SkinAsset>;
}

export type SkinLoadResult = { ok: true; skin: LoadedSkin } | { ok: false; id: string; name?: string; error: string };
export type SoundPackLoadResult =
  { ok: true; pack: LoadedSoundPack } | { ok: false; id: string; name?: string; error: string };

/** The mod kinds this loader reads; any other kind belongs to a later tier's loader. */
type DataModKind = 'skin' | 'sounds';

const CONTRACTS: Record<DataModKind, readonly number[]> = { skin: SKIN_CONTRACTS_READ, sounds: [SOUND_PACK_CONTRACT] };
const KIND_LABEL: Record<DataModKind, string> = { skin: 'skin', sounds: 'sound pack' };

const MAX_DEPTH = 3;

class SkinRejected extends Error {}

/**
 * Validates every skin folder under `modsRoot` (userData/mods). A folder whose manifest is for another
 * kind of mod is skipped, not reported: it belongs to a later tier's loader. Sorted by id.
 */
export async function loadSkins(modsRoot: string): Promise<SkinLoadResult[]> {
  const results: SkinLoadResult[] = [];
  for (const name of await modFolderNames(modsRoot)) {
    const result = await loadSkin(modsRoot, name);
    if (result !== 'not-a-skin') results.push(result);
  }
  return results;
}

/** The same scan, allow-list and caps as loadSkins, for the folders whose manifest says `kind: "sounds"`. */
export async function loadSoundPacks(modsRoot: string): Promise<SoundPackLoadResult[]> {
  const results: SoundPackLoadResult[] = [];
  for (const name of await modFolderNames(modsRoot)) {
    const result = await loadSoundPack(modsRoot, name);
    if (result !== 'not-a-sound-pack') results.push(result);
  }
  return results;
}

async function modFolderNames(modsRoot: string): Promise<string[]> {
  try {
    return (await readdir(modsRoot)).filter(entry => !entry.startsWith('.')).sort();
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return [];
    throw error;
  }
}

/** A folder that passed the checks every data mod shares: its manifest and the files it holds. */
interface OpenedMod<K extends DataModKind> {
  manifest: Extract<ModManifest, { kind: K }>;
  root: string;
  files: Map<string, SkinAsset>;
}

/**
 * Opens one `mods/<id>/` folder for `kind`. Rejects (with a reason the picker shows) on: a bad id, a
 * symlink anywhere in the folder, a file type off SKIN_FILE_TYPES, a file over its cap or a folder over
 * the whole-folder caps, an invalid mod.json, or a contract this app does not read. `'other'` is a folder
 * for another kind (or, for a non-skin kind, one whose manifest cannot be read at all: the skin pass
 * reports that, so a broken folder is listed once).
 */
async function openMod<K extends DataModKind>(
  modsRoot: string,
  id: string,
  kind: K,
  onName: (name: string) => void
): Promise<OpenedMod<K> | 'other'> {
  const label = KIND_LABEL[kind];
  const folder = join(modsRoot, id);
  const stat = await lstat(folder);
  if (stat.isSymbolicLink()) {
    if (kind !== 'skin') return 'other';
    throw new SkinRejected(`the ${label} folder is a symbolic link`);
  }
  if (!stat.isDirectory()) return 'other';
  if (!MOD_ID_PATTERN.test(id)) {
    if (kind !== 'skin') return 'other';
    throw new SkinRejected('folder name is not a valid mod id');
  }
  const root = await realpath(folder);

  // The manifest first: a folder holding another tier's mod is not this loader's to judge, files and all.
  let manifestJson: unknown;
  try {
    manifestJson = await readJson(await manifestOf(root), 'mod.json');
  } catch (error) {
    if (kind !== 'skin' && error instanceof SkinRejected) return 'other';
    throw error;
  }
  if (isObject(manifestJson) && manifestJson.kind !== undefined && manifestJson.kind !== kind) return 'other';
  if (kind !== 'skin' && !(isObject(manifestJson) && manifestJson.kind === kind)) return 'other';

  const manifest = parse(modManifestSchema, manifestJson, 'mod.json') as Extract<ModManifest, { kind: K }>;
  onName(manifest.name);
  const files = await walk(root);
  if (manifest.id !== id) throw new SkinRejected(`mod.json id "${manifest.id}" does not match the folder name`);
  if (!CONTRACTS[kind].includes(manifest.contract)) {
    throw new SkinRejected(
      `written for ${label} contract ${manifest.contract}; this app reads contract ${CONTRACTS[kind].join(' or ')}`
    );
  }
  return { manifest, root, files };
}

/** Checks each referenced file is present, contained and the type its name says; returns them by path. */
async function collectAssets(
  { root, files }: { root: string; files: Map<string, SkinAsset> },
  paths: readonly string[]
): Promise<Map<string, SkinAsset>> {
  const assets = new Map<string, SkinAsset>();
  for (const path of paths) {
    const asset = files.get(path);
    if (!asset) throw new SkinRejected(`${path} is missing`);
    await assertContained(root, path);
    await assertSignature(asset, path);
    assets.set(path, asset);
  }
  return assets;
}

function rejection(id: string, name: string | undefined, error: unknown, label: string) {
  const named = name ? { name } : {};
  if (error instanceof SkinRejected) return { ok: false as const, id, ...named, error: error.message };
  const code = (error as NodeJS.ErrnoException).code;
  return {
    ok: false as const,
    id,
    ...named,
    error: `could not read the ${label} folder (${code ?? String(error)})`,
  };
}

/** Validates one skin folder; adds a missing or invalid tokens.json and unreadable referenced files to openMod's checks. */
export async function loadSkin(modsRoot: string, id: string): Promise<SkinLoadResult | 'not-a-skin'> {
  let name: string | undefined;
  try {
    const opened = await openMod(modsRoot, id, 'skin', found => (name = found));
    if (opened === 'other') return 'not-a-skin';
    const tokensFile = opened.files.get('tokens.json');
    if (!tokensFile) throw new SkinRejected('tokens.json is missing');
    const tokens = parse(
      // A skin's manifest kind is an enum, not a literal, so Extract leaves `never` here.
      skinTokensSchemaFor((opened.manifest as ModManifest).contract),
      await readJson(tokensFile, 'tokens.json'),
      'tokens.json'
    );
    const assets = await collectAssets(opened, referencedPaths(tokens));
    return { ok: true, skin: { manifest: opened.manifest, tokens, assets } };
  } catch (error) {
    return rejection(id, name, error, 'skin');
  }
}

/** Validates one sound pack folder: the manifest's sounds map is the whole pack, so there is no tokens.json. */
export async function loadSoundPack(modsRoot: string, id: string): Promise<SoundPackLoadResult | 'not-a-sound-pack'> {
  let name: string | undefined;
  try {
    const opened = await openMod(modsRoot, id, 'sounds', found => (name = found));
    if (opened === 'other') return 'not-a-sound-pack';
    const assets = await collectAssets(opened, Object.values(opened.manifest.sounds));
    return { ok: true, pack: { manifest: opened.manifest, assets } };
  } catch (error) {
    return rejection(id, name, error, 'sound pack');
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

// The needs-you sound stays the built-in chime, so it is neither checked nor served.
function referencedPaths(tokens: SkinTokens): string[] {
  const { 'needs-you': _locked, ...sounds } = tokens.sounds ?? {};
  const images = Object.values(tokens.scenes ?? {}).flatMap(sceneSkinAssetPaths);
  return [...new Set([...images, ...Object.values(sounds)])].filter((path): path is string => typeof path === 'string');
}

const isObject = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

const formatBytes = (bytes: number): string =>
  bytes >= 1024 * 1024 ? `${bytes / (1024 * 1024)} MB` : `${bytes / 1024} KB`;

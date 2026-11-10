import { SKILL_FILE_DIRS, checkSkillFiles, type ISkillFile } from '@bike4mind/common';

/** Bounds a local file read; the server accepts 50k characters, so this is already generous. */
export const MAX_IMPORT_BYTES = 200_000;

/** Total uncompressed size a zip may expand to; guards against zip bombs. */
export const MAX_ZIP_UNCOMPRESSED_BYTES = 5_000_000;

/** Bounds how much of a dropped folder tree is walked (node_modules, .git and the like). */
const MAX_DROPPED_ENTRIES = 2_000;

export const ZIP_UNSUPPORTED_ERROR =
  'This is a zip file, not a SKILL.md. Choose or drop the .zip itself, or unzip it and choose the folder.';
export const BINARY_FILE_ERROR = 'This is not a text file. Choose the SKILL.md text file inside the skill.';
export const DROP_AMBIGUOUS_ERROR = 'Drop one SKILL.md or one skill folder.';
export const ZIP_NO_SKILL_MD_ERROR = 'The zip has no SKILL.md at its top level or in a single top-level folder.';
export const ZIP_UNREADABLE_ERROR =
  "The zip couldn't be unzipped. Unzip it yourself and choose the folder, or choose its SKILL.md.";

/** A file of a skill folder, with its path relative to the skill folder root. */
export interface SkillEntry {
  path: string;
  file: File;
}

export type SkillFolderResult =
  { ok: true; skillMd: string; files: ISkillFile[]; skipped: string[] } | { ok: false; error: string };

const isHidden = (path: string) => path.split('/').some(segment => segment.startsWith('.'));

export const isZipFile = (file: File) => /\.zip$/i.test(file.name);

export const hasZipSignature = (text: string) => text.startsWith('PK\u0003\u0004');

/** Maps a picked folder (`webkitRelativePath` is `<folder>/...`) to entries relative to the folder root. */
export function entriesFromPickedFolder(picked: File[]): SkillEntry[] {
  return picked.map(file => ({ path: file.webkitRelativePath.split('/').slice(1).join('/'), file }));
}

/**
 * A skill folder's top-level SKILL.md, the text files under scripts/ and references/, and the other
 * files it skipped. Dotfiles are skipped silently.
 */
export async function readSkillEntries(entries: SkillEntry[]): Promise<SkillFolderResult> {
  let skillMd: File | undefined;
  const files: ISkillFile[] = [];
  const skipped: string[] = [];
  for (const { path, file } of entries) {
    if (isHidden(path)) continue;
    if (path === 'SKILL.md') {
      skillMd = file;
    } else if ((SKILL_FILE_DIRS as readonly string[]).includes(path.split('/')[0])) {
      if (file.size > MAX_IMPORT_BYTES) return { ok: false, error: `${path} is too large to import.` };
      try {
        const content = new TextDecoder('utf-8', { fatal: true }).decode(await file.arrayBuffer());
        files.push({ path, content });
      } catch {
        return { ok: false, error: `${path}: only text files are supported.` };
      }
    } else {
      skipped.push(path);
    }
  }
  if (!skillMd) return { ok: false, error: 'The folder has no SKILL.md at its top level.' };
  if (skillMd.size > MAX_IMPORT_BYTES) return { ok: false, error: 'SKILL.md is too large to import (200 KB maximum).' };
  const checked = checkSkillFiles(files);
  if (!checked.ok) return { ok: false, error: checked.error };
  return { ok: true, skillMd: await skillMd.text(), files: checked.files, skipped };
}

interface ZipEntryObject {
  dir: boolean;
  async(type: 'uint8array'): Promise<Uint8Array>;
  // jszip keeps the declared size on a private field; it is the only way to size an entry before inflating it.
  _data?: { uncompressedSize?: number };
}

/** Unzips a skill client-side: SKILL.md at the zip root or in a single top-level folder. */
export async function readSkillZip(zipFile: File): Promise<SkillFolderResult> {
  let zipEntries: Array<[string, ZipEntryObject]>;
  try {
    const { default: JSZip } = await import('jszip');
    const zip = await JSZip.loadAsync(await zipFile.arrayBuffer());
    zipEntries = Object.entries(zip.files as Record<string, ZipEntryObject>);
  } catch {
    return { ok: false, error: ZIP_UNREADABLE_ERROR };
  }

  const candidates = zipEntries.filter(
    ([name, entry]) => !entry.dir && !name.startsWith('__MACOSX/') && !isHidden(name)
  );
  let declared = 0;
  for (const [, entry] of candidates) declared += entry._data?.uncompressedSize ?? 0;
  if (declared > MAX_ZIP_UNCOMPRESSED_BYTES) {
    return { ok: false, error: 'The zip is too large to import once unzipped (5 MB maximum).' };
  }

  let prefix = '';
  if (!candidates.some(([name]) => name === 'SKILL.md')) {
    const tops = new Set(candidates.map(([name]) => name.split('/')[0]));
    const top = [...tops][0];
    if (tops.size !== 1 || !candidates.some(([name]) => name === `${top}/SKILL.md`)) {
      return { ok: false, error: ZIP_NO_SKILL_MD_ERROR };
    }
    prefix = `${top}/`;
  }

  const entries: SkillEntry[] = [];
  let total = 0;
  try {
    for (const [name, entry] of candidates) {
      if (!name.startsWith(prefix)) continue;
      const path = name.slice(prefix.length);
      const inScope = path === 'SKILL.md' || (SKILL_FILE_DIRS as readonly string[]).includes(path.split('/')[0]);
      if (!inScope) {
        entries.push({ path, file: new File([], path) });
        continue;
      }
      const bytes = await entry.async('uint8array');
      total += bytes.byteLength;
      if (total > MAX_ZIP_UNCOMPRESSED_BYTES) {
        return { ok: false, error: 'The zip is too large to import once unzipped (5 MB maximum).' };
      }
      entries.push({ path, file: new File([bytes as BlobPart], path.split('/').pop() ?? path) });
    }
  } catch {
    return { ok: false, error: ZIP_UNREADABLE_ERROR };
  }
  return readSkillEntries(entries);
}

type EntryCallback<T> = (value: T) => void;

/** Structural subset of the (non-standard) FileSystem Entry API, so tests need no DOM drag support. */
export interface DroppedFsEntry {
  isFile: boolean;
  isDirectory: boolean;
  name: string;
  file?: (success: EntryCallback<File>, failure?: EntryCallback<unknown>) => void;
  createReader?: () => {
    readEntries(success: EntryCallback<DroppedFsEntry[]>, failure?: EntryCallback<unknown>): void;
  };
}

async function readDirectory(directory: DroppedFsEntry): Promise<DroppedFsEntry[]> {
  const reader = directory.createReader?.();
  if (!reader) return [];
  const all: DroppedFsEntry[] = [];
  // readEntries returns a bounded batch; an empty batch signals the end.
  for (;;) {
    const batch = await new Promise<DroppedFsEntry[]>((resolve, reject) => reader.readEntries(resolve, reject));
    if (!batch.length) return all;
    all.push(...batch);
  }
}

/** Every file under a dropped skill folder, with paths relative to it. Hidden files and folders are not walked. */
export async function readDroppedFolder(root: DroppedFsEntry): Promise<SkillEntry[]> {
  const out: SkillEntry[] = [];
  let seen = 0;
  const walk = async (directory: DroppedFsEntry, prefix: string): Promise<void> => {
    for (const child of await readDirectory(directory)) {
      if (child.name.startsWith('.')) continue;
      if (++seen > MAX_DROPPED_ENTRIES) throw new Error('too many files');
      const path = `${prefix}${child.name}`;
      if (child.isDirectory) {
        await walk(child, `${path}/`);
      } else if (child.isFile && child.file) {
        const childFile = child.file;
        const file = await new Promise<File>((resolve, reject) => childFile.call(child, resolve, reject));
        out.push({ path, file });
      }
    }
  };
  await walk(root, '');
  return out;
}

export type DropOutcome =
  | { kind: 'skillMd'; file: File }
  | { kind: 'zip'; file: File }
  | { kind: 'folder'; entries: SkillEntry[] }
  | { kind: 'error'; error: string };

/**
 * Decides what a drop contains. `entries` come from `webkitGetAsEntry()` (read synchronously during
 * the drop event) and are null where the browser gave none; `files` is `dataTransfer.files`.
 */
export async function resolveDrop(entries: Array<DroppedFsEntry | null>, files: File[]): Promise<DropOutcome> {
  const known = entries.filter((entry): entry is DroppedFsEntry => entry !== null);
  if (known.some(entry => entry.isDirectory)) {
    if (known.length !== 1 || entries.length !== 1) return { kind: 'error', error: DROP_AMBIGUOUS_ERROR };
    try {
      return { kind: 'folder', entries: await readDroppedFolder(known[0]) };
    } catch {
      return { kind: 'error', error: "The folder couldn't be read. Drop a smaller folder, or choose its SKILL.md." };
    }
  }
  if (files.length === 1)
    return isZipFile(files[0]) ? { kind: 'zip', file: files[0] } : { kind: 'skillMd', file: files[0] };
  const named = files.filter(file => file.name === 'SKILL.md');
  const markdown = files.filter(file => /\.md$/i.test(file.name));
  const pick = named.length === 1 ? named[0] : markdown.length === 1 ? markdown[0] : undefined;
  return pick ? { kind: 'skillMd', file: pick } : { kind: 'error', error: DROP_AMBIGUOUS_ERROR };
}

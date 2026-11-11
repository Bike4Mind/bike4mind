import { createHash } from 'node:crypto';
import type { Request } from 'express';
import { FabFileSourceType, KnowledgeType } from '@bike4mind/common';
import {
  adminSettingsRepository,
  dataLakeRepository,
  FabFile,
  fabFileChunkRepository,
  fabFileRepository,
  organizationRepository,
  sessionRepository,
  User,
  userRepository,
  withTransaction,
} from '@bike4mind/database';
import { fabFilesService } from '@bike4mind/services';
import { getFilesStorage } from '@bike4mind/server-utils/utils/storage/index';
import type { TutorialModule } from './types';

// Each copy the user deletes or renames uses a slot up.
const SLOT_WINDOW = 32;
const SLOT_LIMIT = 8 * SLOT_WINDOW;
const CLAIM_ATTEMPTS = 4;

type SheetModule = TutorialModule & { sheet: NonNullable<TutorialModule['sheet']> };

type SlotRow = { _id: unknown; fileName: string; deletedAt?: Date | null; tags?: { name: string }[] };

export interface SheetConfig {
  /** Names the user's copies: `<tag>:<moduleId>` marks a copy, `<tag>-csv:<digest>` the content it holds. */
  tag: string;
  /** Whether a copy issued before content tags existed counts as current for this module. Defaults to stale. */
  legacyCopyIsCurrent?: (module: TutorialModule) => boolean;
}

const contentPrefix = (tag: string) => `${tag}-csv:`;

export const sheetContentTag = (tag: string, csv: string) =>
  `${contentPrefix(tag)}${createHash('sha256').update(csv).digest('hex').slice(0, 16)}`;

/**
 * Whether a copy holds the module's CSV as it stands. A copy issued before content tags existed has none; a
 * repo module's is taken as current so its learners are not re-issued, a draft's as stale.
 */
function holdsContent(config: SheetConfig, module: SheetModule, copy: Pick<SlotRow, 'tags'>): boolean {
  const content = (copy.tags ?? []).filter(t => t.name.startsWith(contentPrefix(config.tag)));
  if (content.length === 0) return config.legacyCopyIsCurrent?.(module) ?? false;
  const want = sheetContentTag(config.tag, module.sheet.csv);
  return content.some(t => t.name === want);
}

export interface EnsureSheetOptions {
  /**
   * A fresh run: the kept copy is restamped as just made, so it is the first one the File Browser lists
   * (Recent is newest first by createdAt), above any same-named file of the user's own.
   */
  toTop?: boolean;
}

/**
 * The user's one copy of the module's sheet: the oldest live copy under the current name holding the current
 * CSV, else a new one in the first free slot. Twins and older content under the current name, and copies under
 * a retired name, go. A copy the user renamed keeps the tag but is theirs now, so it stays.
 */
export async function ensureTutorialSheet(
  config: SheetConfig,
  req: Request,
  module: SheetModule,
  options: EnsureSheetOptions = {}
): Promise<string> {
  const userId = req.user!.id;
  const tag = `${config.tag}:${module.id}`;
  const copies = await FabFile.find({ userId, 'tags.name': tag, deletedAt: null })
    .select('_id fileName tags')
    .sort({ _id: 1 })
    .lean<SlotRow[]>();

  const current = copies.find(copy => copy.fileName === module.sheet.name && holdsContent(config, module, copy));
  const keep = current ? String(current._id) : await claimSheet(config, req, module, tag);
  if (current && options.toTop) {
    // Restamped rather than reissued: one copy, no slot spent, and earlier sessions keep their attachment.
    await FabFile.updateOne({ _id: keep, userId }, { $set: { createdAt: new Date() } }, { overwriteImmutable: true })
      .exec()
      .catch(err => req.logger.warn('Could not move the tutorial sheet to the top of Recent', { fileId: keep, err }));
  }
  const retired = new Set(module.sheet.retired ?? []);
  for (const stale of copies) {
    if (String(stale._id) === keep) continue;
    if (stale.fileName !== module.sheet.name && !retired.has(stale.fileName)) continue;
    await deleteSheet(req, String(stale._id)).catch(err =>
      req.logger.warn('Could not remove a stale tutorial sheet', { fileId: String(stale._id), err })
    );
  }
  return keep;
}

/**
 * A copy's _id is fixed by user, module, name and slot, so two requests that both find no copy insert the
 * same key and the database turns one away. That one adopts the winner's copy.
 */
export function tutorialSheetSlotId(userId: string, tag: string, fileName: string, slot: number): string {
  return createHash('sha256').update(`${userId}\n${tag}\n${fileName}\n${slot}`).digest('hex').slice(0, 24);
}

async function claimSheet(config: SheetConfig, req: Request, module: SheetModule, tag: string): Promise<string> {
  const name = module.sheet.name;
  let first = 0;
  for (let attempt = 0; attempt < CLAIM_ATTEMPTS && first < SLOT_LIMIT;) {
    const slots = Array.from({ length: SLOT_WINDOW }, (_, n) =>
      tutorialSheetSlotId(req.user!.id, tag, name, first + n)
    );
    // Deleted rows still hold their key, so the look includes them.
    const taken = await FabFile.find({ _id: { $in: slots } })
      .setOptions({ includeDeleted: true })
      .select('_id fileName deletedAt tags')
      .lean<SlotRow[]>();
    const won = taken.find(
      row =>
        !row.deletedAt &&
        row.fileName === name &&
        row.tags?.some(t => t.name === tag) &&
        holdsContent(config, module, row)
    );
    if (won) return String(won._id);
    const used = new Set(taken.map(row => String(row._id)));
    const free = slots.find(id => !used.has(id));
    if (!free) {
      first += SLOT_WINDOW;
      continue;
    }
    try {
      await createSheet(config, req, module, tag, free);
      return free;
    } catch (err) {
      if (!lostTheKey(err)) throw err;
      attempt++;
    }
  }
  throw new Error(`Tutorial sheet ${name} was not created`);
}

// 11000 once the other insert committed; 112 while its transaction was still open.
function lostTheKey(err: unknown): boolean {
  const code = (err as { code?: unknown } | null)?.code;
  return code === 11000 || code === 112;
}

async function createSheet(
  config: SheetConfig,
  req: Request,
  module: SheetModule,
  tag: string,
  id: string
): Promise<void> {
  const userId = req.user!.id;
  await withTransaction(() =>
    fabFilesService.createFabFile(
      userId,
      {
        fileName: module.sheet.name,
        mimeType: 'text/csv',
        contentType: 'text/csv',
        fileSize: Buffer.byteLength(module.sheet.csv, 'utf8'),
        type: KnowledgeType.FILE,
        content: module.sheet.csv,
        tags: [
          { name: tag, strength: 1 },
          { name: sheetContentTag(config.tag, module.sheet.csv), strength: 1 },
        ],
      },
      {
        // Racers for one slot write the same object, so the one turned away leaves nothing behind.
        objectKey: `${id}.csv`,
        db: {
          adminSettings: adminSettingsRepository,
          fabFiles: { create: async data => (await FabFile.create({ ...data, _id: id })) as never },
          users: User,
          organizations: organizationRepository,
          dataLakes: dataLakeRepository,
        },
        logger: req.logger,
        storage: {
          upload: async (filepath, content, option) => {
            await getFilesStorage().upload(content, filepath, {
              ContentType: option?.ContentType || 'text/plain',
              ContentLength: option?.ContentLength || Buffer.byteLength(content, 'utf8'),
            });
            return filepath;
          },
          generateSignedUrl: (
            filepath: string,
            expireInSeconds: number,
            mode?: 'get' | 'put',
            options?: { ContentLength?: number }
          ) =>
            getFilesStorage().getSignedUrl(filepath, mode ?? 'get', {
              expiresIn: expireInSeconds,
              ContentLength: options?.ContentLength,
            }),
        },
        provenance: { sourceType: FabFileSourceType.MANUAL_UPLOAD },
      }
    )
  );
}

// Core's delete also unlinks the file from the user's sessions and removes its stored object. Project and
// system-file references are left for core's own scrub.
async function deleteSheet(req: Request, fileId: string): Promise<void> {
  await withTransaction(() =>
    fabFilesService.deleteFabFile(
      req.user!.id,
      { id: fileId },
      {
        db: {
          fabFiles: fabFileRepository,
          users: userRepository,
          sessions: sessionRepository,
          fabFileChunks: fabFileChunkRepository,
        },
        storage: getFilesStorage(),
        logger: req.logger,
      }
    )
  );
}

/** The sheet ensurer for one owner's copies. */
export function tutorialSheets(config: SheetConfig) {
  return {
    ensure: (req: Request, module: SheetModule, options?: EnsureSheetOptions) =>
      ensureTutorialSheet(config, req, module, options),
  };
}

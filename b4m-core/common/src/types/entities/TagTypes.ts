import { IBaseRepository } from './BaseTypes';

export enum TagType {
  FILE = 'file',
  SESSION = 'session',
}

export interface IBaseTag {
  /**
   * The unique identifier of the tag
   */
  id: string;

  /**
   * The user id of the tag
   */
  userId: string;

  /**
   * The name of the tag
   */
  name: string;
  /**
   * The icon of the tag
   */
  icon?: string;
  /**
   * The description of the tag
   */
  description?: string;
  /**
   * The color of the tag
   */
  color?: string;
  /**
   * The type of the tag
   */
  type: TagType;

  createdAt: Date;
  updatedAt: Date;
}

export interface IFileTag extends IBaseTag {
  /**
   * The type of the tag
   */
  type: TagType.FILE;
  /**
   * The last time this tag was used
   */
  lastActivityAt: Date;
}

/**
 * A file tag as served to a client, carrying the count of files that hold it. The count is
 * recomputed per request by tagService/listFileTags and is deliberately NOT stored on the tag
 * document: a stored counter has to be maintained by every writer that touches a file's tags, and
 * several never did, so it drifted permanently. Anything reading `fileCount` must come from
 * listFileTags - a tag fetched through any other repository method does not have one.
 */
export interface IFileTagWithFileCount extends IFileTag {
  fileCount: number;
}

export interface ISessionTag extends IBaseTag {
  type: TagType.SESSION;
}

export type ITag = IFileTag | ISessionTag;

export interface ITagRepository extends IBaseRepository<IBaseTag> {
  /**
   * Find all tags by user id
   * @param userId The user id
   */
  findAllByUserId(userId: string): Promise<IBaseTag[]>;

  /**
   * Find a tag by id and user id
   * @param id The tag id
   * @param userId The user id
   */
  findByIdAndUserId(id: string, userId: string): Promise<IBaseTag | null>;
}

export interface IFileTagRepository extends IBaseRepository<IFileTag> {
  /**
   * Find all tags by user id
   * @param userId The user id
   */
  findAllByUserId(userId: string): Promise<IFileTag[]>;

  /**
   * Find a tag by id and user id
   * @param id The tag id
   * @param userId The user id
   */
  findByIdAndUserId(id: string, userId: string): Promise<IFileTag | null>;

  /**
   * Find a tag by name and user id under the shared collision rule (trimmed, case folded - see
   * utils/tagName). Every path that mints a tag document checks this first, so one user cannot end
   * up with two tags whose names differ only by case.
   * @param name The tag name
   * @param userId The user id
   */
  findByFoldedNameAndUserId(name: string, userId: string): Promise<IFileTag | null>;

  /**
   * Find all tags by ids
   * @param ids The tag ids
   */
  findAllByIds(ids: string[]): Promise<IFileTag[]>;

  /**
   * Mark a tag as just used, refreshing `lastActivityAt`. Matched case-insensitively on the name.
   * @param name The tag name
   * @param userId The user id
   */
  touchLastActivityBy(by: { name: string; userId: string }): Promise<void>;

  /**
   * Find or create a tag by name and user id
   * @param name The tag name
   * @param userId The user id
   * @param defaultData Default data for creating the tag
   */
  findOrCreateByNameAndUserId(name: string, userId: string, defaultData: Partial<IFileTag>): Promise<IFileTag | null>;
}

export interface ISessionTagRepository extends IBaseRepository<ISessionTag> {}

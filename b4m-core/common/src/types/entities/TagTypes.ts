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
   * The number of files tagged with this tag
   */
  fileCount: number;
  /**
   * The last time this tag was used
   */
  lastActivityAt: Date;
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
   * Find a tag by name and user id
   * @param name The tag name
   * @param userId The user id
   */
  findByNameAndUserId(name: string, userId: string): Promise<IFileTag | null>;

  /**
   * Find all tags by ids
   * @param ids The tag ids
   */
  findAllByIds(ids: string[]): Promise<IFileTag[]>;

  /**
   * Increment the file count for the given tags
   * @param name The tag name
   * @param userId The user id
   * @param count The count to increment
   */
  incrementFileCountBy(by: { name: string; userId: string }, count?: number): Promise<void>;

  /**
   * Increment the file count for the given tags
   * @param ids The tag ids
   * @param count The count to increment
   */
  incrementFileCountByIds(ids: string[], count?: number): Promise<void>;

  /**
   * Find or create a tag by name and user id
   * @param name The tag name
   * @param userId The user id
   * @param defaultData Default data for creating the tag
   * @param incrementFileCount Optional file count to increment
   */
  findOrCreateByNameAndUserId(
    name: string,
    userId: string,
    defaultData: Partial<IFileTag>,
    incrementFileCount?: number
  ): Promise<IFileTag | null>;
}

export interface ISessionTagRepository extends IBaseRepository<ISessionTag> {}

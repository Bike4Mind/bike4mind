import { IBaseRepository } from './BaseTypes';
import { IShareableDocument, IShareableStaticMethods } from './ShareableDocumentTypes';

/**
 * A Skill is a reusable instruction template - markdown body authored by a user
 * (or admin/org) and invoked from the web chat via `/skill-name args`, or from
 * the LLM via the `skill` tool. Mirrors the Claude Code skill concept the B4M
 * CLI already supports locally; this model is the source of truth for skills
 * synced across the web app and the CLI.
 */
export interface ISkill {
  id: string;
  name: string;
  description: string;
  body: string;

  /** Free-form hint shown in pickers, e.g. "[file] [priority]". */
  argumentHint?: string;

  /** Optional tool whitelist used when the skill is invoked via the LLM tool. */
  allowedTools?: string[];

  /** When true, the skill is hidden from the LLM tool catalog (user-invocation only). */
  disableModelInvocation?: boolean;

  // Scope discriminator - exactly one must be set. Same shape as IAgent:
  // user-owned (personal skill), organization-shared (team skill), or
  // built-in/system. Enforced by a pre-save validator on the Mongoose schema.
  userId?: string;
  organizationId?: string;
  isSystem?: boolean;

  createdAt: Date;
  updatedAt: Date;
  deletedAt?: Date;
}

export interface ISkillDocument extends ISkill, IShareableDocument {}

export interface ISkillMethods {
  // No instance methods yet.
}

export interface ISkillRepository extends IBaseRepository<ISkillDocument> {
  shareable: IShareableStaticMethods<ISkillDocument>;

  /** Paginated search across skills the user owns or has been shared on. */
  searchAccessible(
    userId: string,
    search: string,
    filters: { query?: Record<string, unknown> },
    pagination: { page: number; limit: number },
    orderBy: { by: 'createdAt' | 'updatedAt' | 'name'; direction: 'asc' | 'desc' },
    scope?: { isAdmin?: boolean; adminOrganizationIds?: string[] }
  ): Promise<{ data: ISkill[]; hasMore: boolean; total: number }>;

  listForUser(userId: string): Promise<ISkill[]>;
  listForOrganization(organizationId: string): Promise<ISkill[]>;
  listSystem(): Promise<ISkill[]>;
  findByNameForUser(userId: string, name: string): Promise<ISkill | null>;
  findByNameForOrganization(organizationId: string, name: string): Promise<ISkill | null>;
  /** Limit-pushed-to-Mongo variant for the per-turn LLM catalog (excludes disableModelInvocation). */
  listInvocableForUser(userId: string, limit: number): Promise<ISkill[]>;
  /** Batched name lookup - single `$in` query for the chat mention resolver. */
  findByNamesForUser(userId: string, names: string[]): Promise<ISkill[]>;
  /**
   * Accessible-scope variant of `listInvocableForUser` - owned + shared +
   * global-read. Powers the per-turn LLM catalog for shared / global skills.
   */
  listAccessibleInvocableForUser(userId: string, limit: number): Promise<ISkill[]>;
  /**
   * Accessible-scope by-name resolver - owned + shared + global-read. Prefers
   * the user's own skill on a cross-scope name collision.
   */
  findAccessibleByNameForUser(userId: string, name: string): Promise<ISkill | null>;
  /**
   * Batched accessible-scope by-name resolver - single `$in` query, at most one
   * skill per name (most-specific grant wins). Accessible counterpart of
   * `findByNamesForUser` for the chat mention resolver.
   */
  findAccessibleByNamesForUser(userId: string, names: string[]): Promise<ISkill[]>;
}

import { IBaseRepository, IMongoDocument } from '.';
import type { PageWidget } from '../../schemas/customPage';

/** A user-created sidebar page. Its orchestrator chat owns `state` and places `widgets`. */
export interface ICustomPage {
  userId: string;
  name: string;
  icon?: string | null;
  description?: string | null;
  /** Free-form facts the orchestrator keeps; the source of truth the widgets are derived from. */
  state: Record<string, unknown>;
  widgets: PageWidget[];
  /** The page's chat session (surface `PAGE_SURFACE`). */
  orchestratorSessionId: string;
  /** Bumped on every state write; the optimistic-concurrency guard for `replaceStateOwned`. */
  version: number;
  deletedAt?: Date | null;
  createdAt: Date;
  updatedAt: Date;
}

export interface ICustomPageDocument extends ICustomPage, IMongoDocument {}

/** List row: a page without its `state` and `widgets`. */
export type ICustomPageSummary = Omit<ICustomPageDocument, 'state' | 'widgets'>;

export type CustomPageMetaPatch = Partial<Pick<ICustomPage, 'name' | 'icon' | 'description'>>;

/** Every method is scoped to the owner and to live (not soft-deleted) pages; a miss returns null/false. */
export interface ICustomPageRepository extends IBaseRepository<ICustomPageDocument> {
  listOwned(userId: string): Promise<ICustomPageSummary[]>;
  findOwned(id: string, userId: string): Promise<ICustomPageDocument | null>;
  findByOrchestratorSession(sessionId: string, userId: string): Promise<ICustomPageDocument | null>;
  updateMetaOwned(id: string, userId: string, patch: CustomPageMetaPatch): Promise<ICustomPageDocument | null>;
  /** Replaces `state` only while `version` still equals `expectedVersion`; null on a conflict or a miss. */
  replaceStateOwned(
    id: string,
    userId: string,
    state: Record<string, unknown>,
    expectedVersion: number
  ): Promise<ICustomPageDocument | null>;
  /**
   * Replaces the widget with the same id, or appends it while the page holds fewer than `maxWidgets`.
   * Null when the page is missing or full.
   */
  upsertWidgetOwned(
    id: string,
    userId: string,
    widget: PageWidget,
    maxWidgets: number
  ): Promise<ICustomPageDocument | null>;
  removeWidgetOwned(id: string, userId: string, widgetId: string): Promise<ICustomPageDocument | null>;
  /** Null when the page, the checklist widget or the item does not exist. */
  setChecklistItemOwned(
    id: string,
    userId: string,
    widgetId: string,
    itemId: string,
    checked: boolean
  ): Promise<ICustomPageDocument | null>;
  softDeleteOwned(id: string, userId: string): Promise<boolean>;
}

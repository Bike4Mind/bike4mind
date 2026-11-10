import { PAGE_WIDGETS_MAX, PageWidgetSchema } from '@bike4mind/common';
import { pageError, type CustomPageResult, type CustomPageServiceAdapters } from './ports';

type PageRef = { pageId: string; userId: string };

/** Validates `widget` against PageWidgetSchema, then replaces the widget with its id or appends it. */
export async function setWidget(
  params: PageRef & { widget: unknown },
  adapters: CustomPageServiceAdapters
): Promise<CustomPageResult> {
  const parsed = PageWidgetSchema.safeParse(params.widget);
  if (!parsed.success) {
    const issues = parsed.error.issues.map(issue => `${issue.path.join('.') || '(root)'}: ${issue.message}`);
    return pageError('invalid', 'Invalid widget', issues);
  }

  const { pageId, userId } = params;
  const updated = await adapters.db.customPages.upsertWidgetOwned(pageId, userId, parsed.data, PAGE_WIDGETS_MAX);
  if (updated) return { ok: true, page: updated };

  const page = await adapters.db.customPages.findOwned(pageId, userId);
  if (!page) return pageError('not_found', 'Page not found');
  return pageError(
    'too_many_widgets',
    `A page holds at most ${PAGE_WIDGETS_MAX} widgets. Remove or reuse one before adding another.`
  );
}

export async function removeWidget(
  params: PageRef & { widgetId: string },
  adapters: CustomPageServiceAdapters
): Promise<CustomPageResult> {
  const { pageId, userId, widgetId } = params;
  const page = await adapters.db.customPages.findOwned(pageId, userId);
  if (!page) return pageError('not_found', 'Page not found');
  if (!page.widgets?.some(widget => widget.id === widgetId)) {
    return pageError('not_found', `No widget with id "${widgetId}"`);
  }
  const updated = await adapters.db.customPages.removeWidgetOwned(pageId, userId, widgetId);
  return updated ? { ok: true, page: updated } : pageError('not_found', 'Page not found');
}

export async function toggleChecklistItem(
  params: PageRef & { widgetId: string; itemId: string; checked: boolean },
  adapters: CustomPageServiceAdapters
): Promise<CustomPageResult> {
  const { pageId, userId, widgetId, itemId, checked } = params;
  const updated = await adapters.db.customPages.setChecklistItemOwned(pageId, userId, widgetId, itemId, checked);
  return updated ? { ok: true, page: updated } : pageError('not_found', 'Checklist item not found');
}

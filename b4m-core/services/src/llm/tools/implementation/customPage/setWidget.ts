import type { ToolDefinition } from '../../base/types';
import { describeFailure, resolvePage } from './resolvePage';

interface SetWidgetParams {
  action?: string;
  widget?: unknown;
  widgetId?: string;
}

const WIDGET_ID = {
  type: 'string',
  description:
    'Stable lowercase id (letters, digits, "-" or "_"), e.g. "shopping-list". Reusing an id replaces that widget.',
};
const TITLE = { type: 'string', description: 'Heading shown above the widget.' };
const ORDER = { type: 'integer', description: 'Sort position; lower comes first.' };

const cardListWidget = {
  type: 'object',
  properties: {
    type: { type: 'string', enum: ['card-list'] },
    id: WIDGET_ID,
    title: TITLE,
    order: ORDER,
    items: {
      type: 'array',
      maxItems: 50,
      items: {
        type: 'object',
        properties: {
          id: { type: 'string' },
          title: { type: 'string' },
          subtitle: { type: 'string' },
          body: { type: 'string' },
        },
        required: ['id', 'title'],
      },
    },
  },
  required: ['type', 'id', 'items'],
};

const checklistWidget = {
  type: 'object',
  properties: {
    type: { type: 'string', enum: ['checklist'] },
    id: WIDGET_ID,
    title: TITLE,
    order: ORDER,
    items: {
      type: 'array',
      maxItems: 100,
      items: {
        type: 'object',
        properties: {
          id: { type: 'string' },
          label: { type: 'string' },
          checked: { type: 'boolean' },
        },
        required: ['id', 'label'],
      },
    },
  },
  required: ['type', 'id', 'items'],
};

const markdownWidget = {
  type: 'object',
  properties: {
    type: { type: 'string', enum: ['markdown'] },
    id: WIDGET_ID,
    title: TITLE,
    order: ORDER,
    markdown: { type: 'string' },
  },
  required: ['type', 'id', 'markdown'],
};

export const pageSetWidgetTool: ToolDefinition = {
  name: 'page_set_widget',
  implementation: context => ({
    toolFn: async parameters => {
      const params = (parameters ?? {}) as SetWidgetParams;
      if (params.action !== 'upsert' && params.action !== 'remove') {
        return 'Error: `action` must be "upsert" or "remove".';
      }
      if (params.action === 'remove' && (typeof params.widgetId !== 'string' || !params.widgetId)) {
        return 'Error: `widgetId` is required to remove a widget.';
      }
      if (params.action === 'upsert' && params.widget === undefined) {
        return 'Error: `widget` is required to upsert a widget.';
      }

      const resolved = await resolvePage(context);
      if ('error' in resolved) return resolved.error;
      const ref = { pageId: resolved.page.id, userId: context.userId };

      if (params.action === 'remove') {
        const removed = await resolved.port.removeWidget({ ...ref, widgetId: params.widgetId as string });
        return removed.ok ? `Widget "${params.widgetId}" removed.` : describeFailure(removed);
      }

      const result = await resolved.port.setWidget({ ...ref, widget: params.widget });
      if (!result.ok) return describeFailure(result);
      const widgetId = (params.widget as { id?: unknown } | null)?.id;
      return `Widget "${String(widgetId)}" saved. The page now has ${result.page.widgets?.length ?? 0} widget(s).`;
    },
    toolSchema: {
      name: 'page_set_widget',
      description:
        'Show or remove a display on the page. action "upsert" adds the widget, or replaces the one with the same id ' +
        '(prefer reusing an id over adding another). action "remove" deletes a widget by `widgetId`. ' +
        'Widget types: card-list (items with id, title, optional subtitle/body), checklist (items with id, label, checked), ' +
        'markdown (markdown text).',
      parameters: {
        type: 'object',
        properties: {
          action: { type: 'string', description: 'What to do with the widget.', enum: ['upsert', 'remove'] },
          widgetId: { type: 'string', description: 'Required for action "remove".' },
          widget: {
            type: 'object',
            description: 'Required for action "upsert". One of the three widget shapes.',
            oneOf: [cardListWidget, checklistWidget, markdownWidget],
          },
        },
        required: ['action'],
      },
    },
  }),
};

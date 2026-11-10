import { z } from 'zod';
import type { B4MLLMTools } from './llm';

// Custom pages: user-created sidebar pages whose orchestrator chat keeps page state and places
// typed widgets. Shared by the API routes, customPageService, the page_* LLM tools and the client.

export const PAGE_WIDGET_ID = z.string().regex(/^[a-z0-9][a-z0-9_-]{0,63}$/, 'Invalid widget id');

export const CardListItemSchema = z.object({
  id: z.string().max(64),
  title: z.string().max(200),
  subtitle: z.string().max(500).optional(),
  body: z.string().max(4000).optional(),
});
export type CardListItem = z.infer<typeof CardListItemSchema>;

export const ChecklistItemSchema = z.object({
  id: z.string().max(64),
  label: z.string().max(300),
  checked: z.boolean().default(false),
});
export type ChecklistItem = z.infer<typeof ChecklistItemSchema>;

const widgetBase = {
  id: PAGE_WIDGET_ID,
  title: z.string().max(200).optional(),
  order: z.number().int().optional(),
};

export const PageWidgetSchema = z.discriminatedUnion('type', [
  z.object({ ...widgetBase, type: z.literal('card-list'), items: z.array(CardListItemSchema).max(50) }),
  z.object({ ...widgetBase, type: z.literal('checklist'), items: z.array(ChecklistItemSchema).max(100) }),
  z.object({ ...widgetBase, type: z.literal('markdown'), markdown: z.string().max(20_000) }),
]);
export type PageWidget = z.infer<typeof PageWidgetSchema>;
export type PageWidgetType = PageWidget['type'];

/** Serialized (UTF-8 JSON) size cap for a page's `state`. */
export const PAGE_STATE_MAX_BYTES = 32_768;
export const PAGE_WIDGETS_MAX = 20;

export const CreateCustomPageInput = z.object({
  name: z.string().trim().min(1).max(120),
  description: z.string().max(1000).optional(),
  icon: z.string().max(40).optional(),
});
export type CreateCustomPageInputType = z.infer<typeof CreateCustomPageInput>;

export const UpdateCustomPageInput = CreateCustomPageInput.partial();
export type UpdateCustomPageInputType = z.infer<typeof UpdateCustomPageInput>;

/** `patch` is an RFC 7386 JSON merge patch applied to the page's `state` (see applyJsonMergePatch). */
export const PatchPageStateInput = z.object({ patch: z.record(z.string(), z.unknown()) });
export type PatchPageStateInputType = z.infer<typeof PatchPageStateInput>;

export const PatchChecklistItemInput = z.object({ checked: z.boolean() });
export type PatchChecklistItemInputType = z.infer<typeof PatchChecklistItemInput>;

export const PageIdSchema = z.string().regex(/^[a-f0-9]{24}$/, 'Invalid page id');
export const PageChecklistItemIdSchema = z.string().min(1).max(64);

export const PAGE_QUERY_KEY = (pageId: string) => ['custom-page', pageId] as const;
export const PAGES_LIST_QUERY_KEY = ['custom-pages'] as const;

export const CUSTOM_PAGE_TOOL_NAMES = [
  'page_get_state',
  'page_update_state',
  'page_set_widget',
] as const satisfies readonly B4MLLMTools[];
export type CustomPageToolName = (typeof CUSTOM_PAGE_TOOL_NAMES)[number];

// Keys that would reach Object.prototype through plain-object assignment.
const UNSAFE_KEYS = new Set(['__proto__', 'constructor', 'prototype']);

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * RFC 7386 JSON merge patch. Pure: never mutates `target` or `patch`. Objects merge recursively,
 * a `null` value deletes the key, and arrays or scalars replace whatever was there.
 */
export function applyJsonMergePatch(target: unknown, patch: unknown): unknown {
  if (!isPlainObject(patch)) return patch;
  const result: Record<string, unknown> = isPlainObject(target) ? { ...target } : {};
  for (const [key, value] of Object.entries(patch)) {
    if (UNSAFE_KEYS.has(key)) continue;
    if (value === null) {
      delete result[key];
    } else {
      result[key] = applyJsonMergePatch(result[key], value);
    }
  }
  return result;
}

import { z } from 'zod';

/** What an app-menu item asks the renderer to do; main owns the menu, the renderer owns the views. */
export const APP_MENU_ACTIONS = ['new-chat', 'open-settings'] as const;
export type AppMenuAction = (typeof APP_MENU_ACTIONS)[number];

/** Bounded so a runaway stack cannot flood main's log. */
export const RENDERER_ERROR_FIELD_MAX = 8_000;

export const rendererErrorReportSchema = z.object({
  message: z.string().max(RENDERER_ERROR_FIELD_MAX),
  stack: z.string().max(RENDERER_ERROR_FIELD_MAX).optional(),
  componentStack: z.string().max(RENDERER_ERROR_FIELD_MAX).optional(),
  route: z.string().max(500).optional(),
});

/** A render error the renderer's error boundary caught, sent to main's log. */
export type RendererErrorReport = z.infer<typeof rendererErrorReportSchema>;

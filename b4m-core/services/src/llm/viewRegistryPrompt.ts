import { getAdminViewSummaryForLLM, type IMessage } from '@bike4mind/common';

/**
 * The per-caller half of the navigate_view guidance (source `viewRegistryAdmin`): the admin-only
 * views for an admin, and a nudge when the caller is on an /admin page. The base view list ships
 * separately as `viewRegistry`, identical for every user so it can stay in the shareable cached
 * prefix (see PER_CALLER_AUTHORED_SOURCES in systemPromptSources.ts).
 *
 * The caller gates this on navigate_view having reached the model, like the base list.
 */
export function buildViewRegistryAdminMessages({
  isAdmin,
  extraContextMessages,
}: {
  isAdmin: boolean;
  extraContextMessages: ReadonlyArray<{ content?: unknown }>;
}): IMessage[] {
  const viewContext = extraContextMessages.find(
    message => typeof message.content === 'string' && message.content.includes('[Current View Context]')
  );
  const viewContextText = typeof viewContext?.content === 'string' ? viewContext.content : '';
  const currentPath = viewContextText.match(/Path:\s*(\S+)/)?.[1] ?? '';

  const parts: string[] = [];
  if (isAdmin) parts.push(getAdminViewSummaryForLLM());
  if (currentPath.startsWith('/admin')) {
    parts.push(
      'The user is currently on the Admin page. When they ask about any admin feature, you MUST call navigate_view with the matching admin.* tab.'
    );
  }
  if (parts.length === 0) return [];
  return [{ role: 'system', requiresTool: 'navigate_view', content: parts.join('\n\n') }];
}

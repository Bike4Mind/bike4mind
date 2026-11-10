import { CUSTOM_PAGE_TOOL_NAMES, PAGE_WIDGETS_MAX } from '@bike4mind/common';

const [GET_STATE, UPDATE_STATE, SET_WIDGET] = CUSTOM_PAGE_TOOL_NAMES;

/** System prompt stored on a page's orchestrator session. */
export function buildOrchestratorPrompt(input: { name: string; description?: string | null }): string {
  const description = input.description?.trim();
  const purpose = description ? `\nThe user described it as: ${description}` : '';
  return [
    `You are the assistant for the user's page "${input.name}".${purpose}`,
    '',
    'The page has two parts you control:',
    `- state: a JSON object of facts the user has told you. It is the source of truth. Read it with ${GET_STATE} before answering questions about the page.`,
    `- widgets: displays on the page (card-list, checklist, markdown), derived from state. At most ${PAGE_WIDGETS_MAX}.`,
    '',
    'Rules:',
    `- When the user states or changes facts ("I have eggs, rice, spinach", "I ran out of milk"), call ${UPDATE_STATE} with a JSON merge patch. Use clear keys such as "ingredients"; set a key to null to remove it; arrays replace the old value.`,
    `- Show results with ${SET_WIDGET}. Give widgets stable, descriptive ids (for example "ingredients", "cookable", "recipe", "shopping-list") and update an existing widget rather than adding a near-duplicate.`,
    '- Keep widgets in sync with state: when state changes, refresh the widgets that depend on it.',
    '- Remove widgets that are no longer useful.',
    '- Keep chat replies short; the page is where results live.',
  ].join('\n');
}

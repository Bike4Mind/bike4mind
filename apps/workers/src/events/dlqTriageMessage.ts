import type { AdminAiSuggestionItem } from '@bike4mind/common';

const escape = (value: string) => value.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

export function buildDlqTriageSection(
  queueLabel: string,
  suggestions: AdminAiSuggestionItem[],
  appUrl?: string
): string {
  return suggestions
    .map(suggestion => {
      const shortId = suggestion.entityId.slice(queueLabel.length + 1).slice(0, 8);
      const basis = suggestion.reasons[0]?.text ?? 'Inspect consumer logs before acting.';
      const link = appUrl
        ? ` <${appUrl}/admin?tab=dlq-replay&queue=${encodeURIComponent(queueLabel)}&message=${encodeURIComponent(suggestion.entityId.slice(queueLabel.length + 1))}|Review in console>`
        : '';
      return `Dead letter ${escape(shortId)}: ${escape(suggestion.actionClass ?? 'review-required')} - ${escape(suggestion.verdict)}. ${escape(basis)}${link}`;
    })
    .join('\n');
}

// Help Panel Components
export { default as HelpPanel } from './HelpPanel';
export { default as HelpContent } from './HelpContent';
export { default as HelpTOC } from './HelpTOC';
export { default as HelpBreadcrumbs } from './HelpBreadcrumbs';
export { default as ContextHelpButton } from './ContextHelpButton';
export { default as FieldTooltip } from './FieldTooltip';
export type { FieldTooltipProps } from './FieldTooltip';
export { default as HelpChat } from './HelpChat';
export { default as HelpSuggestionBanner } from './HelpSuggestionBanner';
export { FIELD_TOOLTIPS, type FieldTooltipKey } from './fieldTooltips';

// Re-export hooks
export { useHelpPanel, openHelpPanel, closeHelpPanel, navigateHelp } from '@client/app/hooks/useHelpPanel';
export { useHelpIndex, useHelpEntry } from '@client/app/hooks/useHelpIndex';
export { useHelpContent } from '@client/app/hooks/useHelpContent';
export { useHelpChat } from '@client/app/hooks/useHelpChat';

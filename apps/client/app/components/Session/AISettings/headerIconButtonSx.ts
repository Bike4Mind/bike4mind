// Shared style for the AI-settings dropdown header buttons (help + close) in both the
// Tools and Agents dropdowns: 28x28 frame, tertiary icon that brightens to primary on
// hover with no background change. `--Icon-color: currentColor` makes the Joy icon
// follow the button's `color` (otherwise the variant color wins).
export const HEADER_ICON_BUTTON_SX = {
  '--IconButton-size': '28px',
  '--Icon-color': 'currentColor',
  color: 'text.tertiary',
  transition: 'color 0.3s',
  '&:hover': { backgroundColor: 'transparent', color: 'text.primary' },
} as const;

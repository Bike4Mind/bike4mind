/**
 * Colour for the icons in the composer's toolbar row (SessionToolbar and the buttons in it): the
 * quieter text.tertiary in light mode, where text.primary read as muddy. Dark mode keeps
 * `darkColor`, or the button's own icon colour when none is given. A colour-scheme selector rather
 * than theme.palette.mode, so it also types for @mui/icons-material icons.
 */
export const toolbarIconSx = (darkColor?: string) => ({
  ...(darkColor && { color: darkColor }),
  '[data-joy-color-scheme="light"] &': { color: 'var(--joy-palette-text-tertiary)' },
});

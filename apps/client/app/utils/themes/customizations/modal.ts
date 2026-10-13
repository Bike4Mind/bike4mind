// ModalClose is an icon-only button; without a default every dialog's close control is unnamed.
// Lives here (not in themePrimitives) because AppTheme replaces baseConfig.components wholesale.
export const modalCustomizations = {
  JoyModalClose: {
    defaultProps: {
      'aria-label': 'Close',
    },
  },
};

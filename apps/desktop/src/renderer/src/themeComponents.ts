import type { Components, Theme } from '@mui/joy/styles';
import { avoidPageModifier } from './chat/agentBrowser';

/**
 * Every tooltip's width cap. Joy leaves a tooltip to its content's width, so one long path or
 * sentence used to draw a single line off the right edge of the window.
 */
export const TOOLTIP_MAX_WIDTH = 340;

/**
 * Every tooltip and menu slides off the agent's browser page, which is a native view drawn above
 * them; see agentBrowser.ts. A call site passing its own `modifiers` replaces this, so one that
 * needs both has to include it.
 */
const avoidPage = [avoidPageModifier];

type Size = 'sm' | 'md' | 'lg';

// Joy sizes its controls for touch (32/36/44px). A pointer-driven desktop window reads better a
// step denser, with one label size across the two sizes that carry nearly every control.
const CONTROL_HEIGHT: Record<Size, string> = { sm: '28px', md: '32px', lg: '40px' };
const CONTROL_FONT_SIZE: Record<Size, string> = { sm: '0.8125rem', md: '0.8125rem', lg: '0.875rem' };
const CONTROL_RADIUS: Record<Size, string> = { sm: '6px', md: '8px', lg: '10px' };
const CONTROL_PADDING: Record<Size, string> = { sm: '10px', md: '12px', lg: '16px' };
const FIELD_PADDING: Record<Size, string> = { sm: '8px', md: '10px', lg: '12px' };
const ICON_SIZE: Record<Size, string> = { sm: '1rem', md: '1.125rem', lg: '1.25rem' };
const TOGGLE_SIZE: Record<Size, string> = { sm: '14px', md: '16px', lg: '20px' };

const sizeOf = (ownerState: { size?: string }): Size =>
  ownerState.size === 'sm' || ownerState.size === 'lg' ? ownerState.size : 'md';

const EASE = '120ms ease-out';
const settle = (...properties: string[]) => ({
  '@media (prefers-reduced-motion: no-preference)': {
    transition: properties.map(property => `${property} ${EASE}`).join(', '),
  },
});

/** A hairline in the field's own highlight color, with a soft halo, in place of Joy's 2px inset ring. */
const fieldFocus = (name: 'Input' | 'Textarea' | 'Select', focusClass: string) => ({
  [`--${name}-focusedThickness`]: '1px',
  boxShadow: 'none',
  ...settle('box-shadow', 'border-color'),
  [`&.${focusClass}`]: {
    boxShadow: `0 0 0 3px color-mix(in srgb, var(--${name}-focusedHighlight) 24%, transparent)`,
  },
});

/** Menus, select listboxes and static menu lists: a padded panel of inset, rounded rows. */
const menuPanel = (theme: Theme) => ({
  '--List-padding': '4px',
  '--List-radius': '10px',
  '--ListItem-radius': '6px',
  '--ListItem-minHeight': CONTROL_HEIGHT.sm,
  '--ListItem-paddingX': '8px',
  '--ListItem-paddingY': '2px',
  '--ListItem-gap': '8px',
  '--ListItemDecorator-size': '1.5rem',
  '--ListDivider-gap': '4px',
  '--Icon-fontSize': ICON_SIZE.sm,
  fontSize: CONTROL_FONT_SIZE.md,
  boxShadow: theme.shadow.lg,
});

export const desktopComponents: Components<Theme> = {
  JoyButton: {
    styleOverrides: {
      root: ({ ownerState }) => {
        const size = sizeOf(ownerState);
        const raised = ownerState.variant === 'solid' && !ownerState.disabled;
        return {
          '--Icon-fontSize': ICON_SIZE[size],
          '--Button-gap': size === 'lg' ? '8px' : '6px',
          // Read through the variable so an Input or Select can still shrink a button it holds.
          minHeight: `var(--Button-minHeight, ${CONTROL_HEIGHT[size]})`,
          paddingInline: CONTROL_PADDING[size],
          borderRadius: `var(--Button-radius, ${CONTROL_RADIUS[size]})`,
          fontSize: CONTROL_FONT_SIZE[size],
          fontWeight: 500,
          ...settle('background-color', 'border-color', 'color', 'box-shadow'),
          ...(raised && {
            boxShadow: 'inset 0 1px 0 rgba(255 255 255 / 0.16), 0 1px 2px rgba(0 0 0 / 0.16)',
            '&:active': { boxShadow: 'inset 0 1px 2px rgba(0 0 0 / 0.2)' },
          }),
        };
      },
    },
  },
  JoyIconButton: {
    styleOverrides: {
      root: ({ ownerState }) => {
        const size = sizeOf(ownerState);
        const box = `var(--IconButton-size, ${CONTROL_HEIGHT[size]})`;
        return {
          // Joy sets this variable itself only when the instance names a size.
          ...((ownerState as { instanceSize?: Size }).instanceSize && { '--IconButton-size': CONTROL_HEIGHT[size] }),
          // Capped at the size step, but still shrinks with call sites that set a smaller box.
          '--Icon-fontSize': `min(${ICON_SIZE[size]}, calc(${box} / 1.5))`,
          minWidth: box,
          minHeight: box,
          borderRadius: `var(--IconButton-radius, ${CONTROL_RADIUS[size]})`,
          ...settle('background-color', 'border-color', 'color'),
        };
      },
    },
  },
  JoyInput: {
    styleOverrides: {
      root: ({ ownerState }) => {
        const size = sizeOf(ownerState);
        return {
          '--Input-minHeight': CONTROL_HEIGHT[size],
          '--Input-paddingInline': FIELD_PADDING[size],
          '--Input-radius': CONTROL_RADIUS[size],
          '--Icon-fontSize': ICON_SIZE[size],
          fontSize: CONTROL_FONT_SIZE[size],
          ...fieldFocus('Input', 'Mui-focused'),
        };
      },
    },
  },
  JoyTextarea: {
    styleOverrides: {
      root: ({ ownerState }) => {
        const size = sizeOf(ownerState);
        return {
          '--Textarea-minHeight': CONTROL_HEIGHT[size],
          '--Textarea-paddingInline': FIELD_PADDING[size],
          '--Textarea-radius': CONTROL_RADIUS[size],
          '--Icon-fontSize': ICON_SIZE[size],
          fontSize: CONTROL_FONT_SIZE[size],
          ...fieldFocus('Textarea', 'Mui-focused'),
        };
      },
    },
  },
  JoySelect: {
    styleOverrides: {
      root: ({ ownerState }) => {
        const size = sizeOf(ownerState);
        return {
          '--Select-minHeight': CONTROL_HEIGHT[size],
          '--Select-paddingInline': FIELD_PADDING[size],
          '--Select-radius': CONTROL_RADIUS[size],
          '--Icon-fontSize': ICON_SIZE[size],
          fontSize: CONTROL_FONT_SIZE[size],
          ...fieldFocus('Select', 'Mui-focusVisible'),
        };
      },
      listbox: ({ theme }) => menuPanel(theme),
    },
  },
  JoyFormLabel: {
    styleOverrides: { root: { fontSize: CONTROL_FONT_SIZE.md, fontWeight: 500 } },
  },
  JoyCheckbox: {
    styleOverrides: {
      root: ({ ownerState }) => {
        const size = sizeOf(ownerState);
        return { '--Checkbox-size': TOGGLE_SIZE[size], fontSize: CONTROL_FONT_SIZE[size] };
      },
    },
  },
  JoyRadio: {
    styleOverrides: {
      root: ({ ownerState }) => {
        const size = sizeOf(ownerState);
        return { '--Radio-size': TOGGLE_SIZE[size], fontSize: CONTROL_FONT_SIZE[size] };
      },
    },
  },
  JoySwitch: {
    styleOverrides: {
      root: ({ ownerState }) => ({
        ...(sizeOf(ownerState) === 'md' && {
          '--Switch-trackWidth': '30px',
          '--Switch-trackHeight': '18px',
          '--Switch-thumbSize': '14px',
        }),
        fontSize: CONTROL_FONT_SIZE[sizeOf(ownerState)],
      }),
    },
  },
  JoySlider: {
    styleOverrides: {
      root: ({ ownerState }) => ({
        ...(sizeOf(ownerState) === 'md' && { '--Slider-trackSize': '4px', '--Slider-thumbSize': '14px' }),
      }),
    },
  },
  JoyLinearProgress: {
    styleOverrides: {
      root: ({ ownerState }) => ({
        ...(sizeOf(ownerState) === 'md' &&
          ownerState.thickness === undefined && { '--LinearProgress-thickness': '4px' }),
      }),
    },
  },
  JoyAlert: {
    styleOverrides: {
      root: ({ ownerState }) => ({
        ...(sizeOf(ownerState) === 'md' && { '--Alert-padding': '8px 12px' }),
        '--Alert-radius': CONTROL_RADIUS.md,
        fontSize: CONTROL_FONT_SIZE.md,
        fontWeight: 400,
      }),
    },
  },
  JoyTabList: {
    styleOverrides: {
      root: { '--ListItem-minHeight': CONTROL_HEIGHT.md, fontSize: CONTROL_FONT_SIZE.md },
    },
  },
  JoyTab: {
    styleOverrides: { root: { fontWeight: 500 } },
  },
  JoyMenu: {
    defaultProps: { modifiers: avoidPage },
    styleOverrides: { root: ({ theme }) => menuPanel(theme) },
  },
  JoyMenuList: {
    styleOverrides: { root: ({ theme }) => menuPanel(theme) },
  },
  JoyModal: {
    styleOverrides: {
      // A flat dim: blurring the whole window behind a dialog costs a repaint of the transcript.
      backdrop: { backdropFilter: 'none', backgroundColor: 'rgba(0 0 0 / 0.4)' },
    },
  },
  JoyModalDialog: {
    styleOverrides: {
      root: ({ theme }) => ({ '--Card-radius': theme.vars.radius.lg, boxShadow: theme.shadow.xl }),
    },
  },
  JoyTooltip: {
    // Not interactive: a tooltip is only ever text here, and an interactive one stays up while
    // the pointer crosses it, covering - and taking the click from - whatever it was drawn over.
    defaultProps: { modifiers: avoidPage, disableInteractive: true },
    styleOverrides: {
      root: ({ theme, ownerState }) => ({
        maxWidth: `min(${TOOLTIP_MAX_WIDTH}px, calc(100vw - 32px))`,
        // A path has no spaces to wrap at.
        overflowWrap: 'anywhere',
        ...(sizeOf(ownerState) === 'md' && {
          padding: '4px 8px',
          fontSize: theme.vars.fontSize.xs,
          fontWeight: 500,
        }),
        ...(ownerState.color === 'neutral' &&
          ownerState.variant === 'soft' && {
            backgroundColor: theme.vars.palette.background.popup,
          }),
      }),
      arrow: ({ theme, ownerState }) => ({
        ...(ownerState.color === 'neutral' &&
          ownerState.variant === 'soft' && {
            '&::before': {
              borderTopColor: theme.vars.palette.background.popup,
              borderRightColor: theme.vars.palette.background.popup,
            },
          }),
      }),
    },
  },
};

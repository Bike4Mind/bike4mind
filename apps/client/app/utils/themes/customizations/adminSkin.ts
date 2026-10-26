import type { Components, Theme } from '@mui/joy/styles';

/**
 * The admin skin: Joy component overrides that only take effect under an element carrying
 * `data-admin-surface` (the admin layout root), so every admin tab inherits the design guide look
 * (`components/admin/DESIGN_GUIDE.md` sections 2 and 5) without touching the rest of the app.
 *
 * Every rule is wrapped in `:where(...)`, so it adds no specificity over the component's own class:
 * the skin replaces Joy's defaults but a tab's own `sx` still wins.
 */
export const ADMIN_SURFACE_ATTRIBUTE = 'data-admin-surface';

const surface = `[${ADMIN_SURFACE_ATTRIBUTE}]`;
const adminMounted = `body:has(${surface})`;
// Portalled popups render under <body>, outside the admin root, so they are matched while an admin
// surface is mounted instead.
const portalRoots =
  '.MuiModalDialog-root, .MuiDrawer-content, .MuiMenu-root, .MuiSelect-listbox, .MuiAutocomplete-listbox';
// The leading `*` matters: stylis reads a nested key that starts with `:` as a pseudo-class of
// the component itself and would glue the selector onto it.
export const IN_ADMIN = `*:where(${surface}, ${adminMounted} :is(${portalRoots})) &`;
export const IN_ADMIN_PORTAL = `*:where(${adminMounted}) &`;

const admin = (token: string) => `var(--joy-palette-admin-${token})`;
const tone = (name: string, part: 'foreground' | 'background') => admin(`status-${name}-${part}`);
const mix = (color: string, percent: number, base = admin('surface')) =>
  `color-mix(in srgb, ${color} ${percent}%, ${base})`;

const FONT_SANS =
  'Inter, system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Helvetica, Arial, sans-serif';
const FONT_MONO = 'var(--font-reading-mono), ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace';

/**
 * Joy reads every color, font and radius through these variables, so remapping them on the admin
 * root re-skins raw `Sheet`s, `text.secondary` copy and `divider` lines that no override reaches.
 */
const rootVariables = {
  '--joy-fontFamily-body': FONT_SANS,
  '--joy-fontFamily-display': FONT_SANS,
  '--joy-fontFamily-code': FONT_MONO,
  '--joy-palette-background-body': admin('canvas'),
  '--joy-palette-background-surface': admin('surface'),
  '--joy-palette-background-popup': admin('surface'),
  '--joy-palette-background-panel': admin('surface'),
  '--joy-palette-background-level1': admin('surfaceSubtle'),
  '--joy-palette-background-level2': admin('hover'),
  '--joy-palette-text-primary': admin('ink'),
  '--joy-palette-text-secondary': admin('inkMuted'),
  '--joy-palette-text-tertiary': admin('inkMuted'),
  '--joy-palette-text-icon': admin('inkMuted'),
  '--joy-palette-divider': admin('border'),
  '--joy-palette-neutral-outlinedBorder': admin('controlBorder'),
  '--joy-palette-focusVisible': admin('accent'),
  '--joy-focus-thickness': '2px',
  '--joy-radius-xs': '4px',
  '--joy-radius-sm': '6px',
  '--joy-radius-md': '8px',
  '--joy-radius-lg': '12px',
  '--joy-radius-xl': '16px',
};

const focusable = ':focus-visible:not(input, textarea, .MuiSelect-button)';

/** Global rules for the admin root itself and the popups it opens. Rendered once by `AppTheme`. */
export const adminSkinGlobalStyles = {
  [`${surface}${surface}`]: {
    ...rootVariables,
    backgroundColor: admin('canvas'),
    color: admin('ink'),
    fontFamily: FONT_SANS,
    WebkitFontSmoothing: 'antialiased',
  },
  [`${adminMounted} :is(${portalRoots}, .MuiTooltip-root)`]: rootVariables,
  // The app theme strips Joy's focus outline with !important; the extra specificity of the
  // attribute selector lets the 2px accent ring win back. Fields draw their own ring instead.
  [`${surface} ${focusable}, ${adminMounted} :is(${portalRoots}) ${focusable}`]: {
    outline: `2px solid ${admin('accent')} !important`,
    outlineOffset: '2px',
  },
};

const field = (prefix: string) => ({
  [IN_ADMIN]: {
    [`--${prefix}-radius`]: '8px',
    [`--${prefix}-minHeight`]: '36px',
    [`--${prefix}-focusedHighlight`]: admin('accent'),
    [`--${prefix}-focusedThickness`]: '2px',
    borderRadius: '8px',
    fontSize: '14px',
    '&.MuiInput-variantOutlined, &.MuiTextarea-variantOutlined, &.MuiSelect-variantOutlined, &.MuiAutocomplete-variantOutlined':
      {
        backgroundColor: admin('surface'),
        borderColor: admin('controlBorder'),
        boxShadow: 'none',
      },
  },
});

const popupList = {
  [IN_ADMIN_PORTAL]: {
    backgroundColor: admin('surface'),
    border: `1px solid ${admin('border')}`,
    borderRadius: '12px',
    boxShadow: '0 12px 32px rgba(0, 0, 0, 0.12)',
    padding: '6px',
    '--ListItem-radius': '8px',
    '--ListItem-minHeight': '36px',
  },
};

const chipTones = {
  Success: 'good',
  Primary: 'info',
  Warning: 'warn',
  Danger: 'bad',
  Neutral: 'neutral',
} as const;

const chipToneRules = Object.fromEntries(
  Object.entries(chipTones).map(([color, name]) => [
    `&.MuiChip-color${color}:is(.MuiChip-variantSoft, .MuiChip-variantSolid)`,
    { color: tone(name, 'foreground'), backgroundColor: tone(name, 'background'), borderColor: 'transparent' },
  ])
);

const typographyLevels: Record<string, Record<string, string | number>> = {
  h1: { fontSize: '28px', fontWeight: 600, letterSpacing: '-0.01em' },
  h2: { fontSize: '24px', fontWeight: 600, letterSpacing: '-0.01em' },
  h3: { fontSize: '20px', fontWeight: 600 },
  h4: { fontSize: '18px', fontWeight: 600 },
  'title-lg': { fontSize: '18px', fontWeight: 600 },
  'title-md': { fontSize: '15px', fontWeight: 600 },
  'title-sm': { fontSize: '14px', fontWeight: 600 },
  'body-md': { fontSize: '14px' },
  'body-sm': { fontSize: '13px' },
  'body-xs': { fontSize: '12px', fontWeight: 500 },
};

export const adminSkinComponents = {
  JoyCard: {
    styleOverrides: {
      root: {
        [IN_ADMIN]: {
          '--Card-radius': '12px',
          '--Card-padding': '16px',
          borderRadius: '12px',
          boxShadow: 'none',
          '&.MuiCard-variantOutlined': {
            backgroundColor: admin('surface'),
            borderColor: admin('border'),
          },
        },
      },
    },
  },
  JoySheet: {
    styleOverrides: {
      root: {
        [IN_ADMIN]: {
          // Plain Sheets are layout wrappers in most tabs: let the canvas, or the card they sit in, show through.
          '&.MuiSheet-variantPlain': { backgroundColor: 'transparent' },
          '&.MuiSheet-variantOutlined': {
            backgroundColor: admin('surface'),
            borderColor: admin('border'),
          },
        },
      },
    },
  },
  JoyTable: {
    styleOverrides: {
      root: {
        [IN_ADMIN]: {
          '--TableCell-height': '56px',
          '--TableCell-paddingX': '12px',
          '--TableCell-borderColor': admin('hairline'),
          '--TableCell-headBackground': admin('surfaceSubtle'),
          '--TableRow-hoverBackground': admin('surfaceSubtle'),
          '&.MuiTable-sizeSm': { '--TableCell-height': '44px' },
          color: admin('ink'),
          fontSize: '14px',
          fontVariantNumeric: 'tabular-nums',
          '& thead th': {
            height: '38px',
            fontSize: '12px',
            fontWeight: 500,
            color: admin('inkMuted'),
            textTransform: 'none',
            letterSpacing: 'normal',
            verticalAlign: 'middle',
            borderBottomColor: admin('border'),
          },
          '& tbody tr:hover > :is(td, th)': { backgroundColor: admin('surfaceSubtle') },
          '& tbody tr:last-of-type > :is(td, th)': { borderBottomColor: 'transparent' },
          '& :is(td, th):is([align="right"], [data-numeric])': { textAlign: 'right' },
        },
      },
    },
  },
  JoyButton: {
    styleOverrides: {
      root: {
        [IN_ADMIN]: {
          '--Button-radius': '8px',
          '--Button-gap': '6px',
          borderRadius: '8px',
          fontWeight: 500,
          '&.MuiButton-sizeMd': { fontSize: '13px', minHeight: '36px' },
          '&.MuiButton-sizeSm': { fontSize: '13px', minHeight: '30px' },
          '&.MuiButton-variantSolid:is(.MuiButton-colorPrimary, .MuiButton-colorNeutral)': {
            backgroundColor: admin('ink'),
            color: admin('surface'),
            '&:hover': { backgroundColor: mix(admin('ink'), 88) },
          },
          '&.MuiButton-variantSolid.MuiButton-colorDanger': {
            backgroundColor: admin('danger'),
            color: admin('surface'),
            '&:hover': { backgroundColor: mix(admin('danger'), 85, admin('ink')) },
          },
          '&.MuiButton-variantOutlined:not(.MuiButton-colorDanger)': {
            backgroundColor: admin('surface'),
            borderColor: admin('controlBorder'),
            color: admin('ink'),
            '&:hover': { backgroundColor: admin('hover') },
          },
          '&.MuiButton-variantOutlined.MuiButton-colorDanger': {
            backgroundColor: admin('surface'),
            borderColor: mix(admin('danger'), 35),
            color: admin('danger'),
            '&:hover': { backgroundColor: tone('bad', 'background') },
          },
          // Plain primary keeps Joy's link colour: tabs pair it with their own selected backgrounds.
          '&.MuiButton-variantPlain.MuiButton-colorNeutral': {
            color: admin('ink'),
            '&:hover': { backgroundColor: admin('hover') },
          },
          '&.MuiButton-variantPlain.MuiButton-colorDanger': {
            color: admin('danger'),
            '&:hover': { backgroundColor: tone('bad', 'background') },
          },
          '&.MuiButton-variantSoft.MuiButton-colorNeutral': {
            backgroundColor: admin('hover'),
            color: admin('ink'),
          },
          '&.Mui-disabled': { opacity: 0.45 },
        },
      },
    },
  },
  JoyIconButton: {
    styleOverrides: {
      root: {
        [IN_ADMIN]: {
          '--IconButton-radius': '6px',
          borderRadius: '6px',
          '&.MuiIconButton-variantPlain:not(.MuiIconButton-colorDanger)': {
            color: admin('inkMuted'),
            '&:hover': { backgroundColor: admin('hover'), color: admin('ink') },
          },
          '&.MuiIconButton-variantOutlined:not(.MuiIconButton-colorDanger)': {
            backgroundColor: admin('surface'),
            borderColor: admin('controlBorder'),
            color: admin('ink'),
            '&:hover': { backgroundColor: admin('hover') },
          },
        },
      },
    },
  },
  JoyChip: {
    styleOverrides: {
      root: {
        [IN_ADMIN]: {
          '--Chip-radius': '999px',
          borderRadius: '999px',
          fontSize: '12px',
          fontWeight: 500,
          '&.MuiChip-sizeSm, &.MuiChip-sizeMd': { minHeight: '22px', '--Chip-paddingInline': '8px' },
          ...chipToneRules,
        },
      },
    },
  },
  JoyTabs: {
    styleOverrides: {
      root: { [IN_ADMIN]: { backgroundColor: 'transparent' } },
    },
  },
  JoyTabList: {
    styleOverrides: {
      root: {
        [IN_ADMIN]: {
          '&.MuiTabList-variantPlain': { backgroundColor: 'transparent', gap: '20px' },
        },
      },
    },
  },
  JoyTab: {
    styleOverrides: {
      root: {
        [IN_ADMIN]: {
          '&.MuiTab-horizontal.MuiTab-variantPlain': {
            '--Tab-indicatorThickness': '2px',
            minHeight: '40px',
            paddingInline: '4px',
            fontSize: '14px',
            fontWeight: 500,
            color: admin('inkMuted'),
            backgroundColor: 'transparent',
            '&:hover': { color: admin('ink'), backgroundColor: 'transparent' },
            '&[aria-selected="true"]': {
              '--Tab-indicatorColor': admin('ink'),
              color: admin('ink'),
              backgroundColor: 'transparent',
            },
          },
        },
      },
    },
  },
  JoyInput: { styleOverrides: { root: field('Input') } },
  JoyTextarea: { styleOverrides: { root: field('Textarea') } },
  JoySelect: { styleOverrides: { root: field('Select'), listbox: popupList } },
  JoyAutocomplete: { styleOverrides: { root: field('Input'), listbox: popupList } },
  JoyMenu: { styleOverrides: { root: popupList } },
  JoyModal: {
    styleOverrides: {
      backdrop: {
        [IN_ADMIN_PORTAL]: { backgroundColor: 'rgba(24, 24, 27, 0.45)', backdropFilter: 'none' },
      },
    },
  },
  JoyModalDialog: {
    styleOverrides: {
      root: {
        [IN_ADMIN_PORTAL]: {
          '--ModalDialog-radius': '16px',
          '--Card-padding': '24px',
          borderRadius: '16px',
          backgroundColor: admin('surfaceSubtle'),
          borderColor: admin('border'),
          color: admin('ink'),
          boxShadow: '0 24px 64px rgba(0, 0, 0, 0.3)',
        },
      },
    },
  },
  JoyDialogTitle: {
    styleOverrides: {
      root: { [IN_ADMIN]: { fontSize: '18px', fontWeight: 600, color: admin('ink') } },
    },
  },
  JoyDivider: {
    styleOverrides: {
      root: { [IN_ADMIN]: { '--Divider-lineColor': admin('border') } },
    },
  },
  JoyTooltip: {
    styleOverrides: {
      root: {
        [IN_ADMIN_PORTAL]: {
          backgroundColor: admin('ink'),
          color: admin('surface'),
          border: 'none',
          borderRadius: '6px',
          fontSize: '12px',
          fontWeight: 500,
        },
      },
      arrow: {
        [IN_ADMIN_PORTAL]: {
          '&::before': { borderTopColor: admin('ink'), borderRightColor: admin('ink') },
        },
      },
    },
  },
  JoyTypography: {
    styleOverrides: {
      root: ({ ownerState }: { ownerState: { level?: unknown } }) => {
        const level = typeof ownerState.level === 'string' ? typographyLevels[ownerState.level] : undefined;
        return level ? { [IN_ADMIN]: level } : {};
      },
    },
  },
} satisfies Components<Theme>;

type StyleArgs = Record<string, unknown>;
type StyleSlot = StyleArgs | ((props: StyleArgs) => unknown);
type ComponentConfig = { defaultProps?: unknown; styleOverrides?: Record<string, StyleSlot> };

const resolveSlot = (slot: StyleSlot | undefined, props: StyleArgs) =>
  typeof slot === 'function' ? slot(props) : slot;

/** Joy keeps one override per slot, so a slot both sides style is merged into one function. */
const mergeSlot = (base: StyleSlot | undefined, skin: StyleSlot): StyleSlot => {
  if (!base) return skin;
  if (typeof base !== 'function' && typeof skin !== 'function') return { ...base, ...skin };
  return (props: StyleArgs) => ({
    ...(resolveSlot(base, props) as StyleArgs | undefined),
    ...(resolveSlot(skin, props) as StyleArgs | undefined),
  });
};

/**
 * Layers the admin skin onto the app's component customizations. Skin keys are scoped selectors,
 * so they never collide with the base overrides they are merged next to.
 */
export const withAdminSkin = (components: Components<Theme>): Components<Theme> => {
  const merged: Record<string, ComponentConfig> = { ...(components as Record<string, ComponentConfig>) };
  for (const [name, skin] of Object.entries(
    adminSkinComponents as Components<Theme> as Record<string, ComponentConfig>
  )) {
    const base = merged[name] ?? {};
    const styleOverrides = { ...base.styleOverrides };
    for (const [slot, style] of Object.entries(skin.styleOverrides ?? {})) {
      styleOverrides[slot] = mergeSlot(base.styleOverrides?.[slot], style);
    }
    merged[name] = { ...base, styleOverrides };
  }
  return merged as Components<Theme>;
};

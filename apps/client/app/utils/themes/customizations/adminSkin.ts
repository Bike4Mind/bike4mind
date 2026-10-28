import type { Components, Theme } from '@mui/joy/styles';
import { adminPalette, type AdminPalette } from '../admin';
import { adminScrollGutter, adminScrollbar } from './adminScrollbar';

/**
 * The admin skin: Joy component overrides that only take effect under an element carrying
 * `data-admin-surface` (the admin layout root), so every admin tab inherits the design guide look
 * (`components/admin/DESIGN_GUIDE.md` sections 2 and 5) without touching the rest of the app.
 *
 * Every rule is wrapped in `:where(...)`, so it adds no specificity over the component's own class.
 * Rules still nest under that class, so a property the skin sets directly beats a tab's flat `sx`;
 * where the skin works through a Joy CSS variable (the palette remap, `body-sm`), `sx` wins.
 */
export const ADMIN_SURFACE_ATTRIBUTE = 'data-admin-surface';
/**
 * Marks the root of app-wide chrome that renders under the admin root (the floating AI chat, the
 * help panel). The skin stops at it, so the widget looks exactly as it does on any other page.
 */
export const ADMIN_SURFACE_EXCLUDE_ATTRIBUTE = 'data-admin-surface-exclude';
/** Spread onto the root of app-wide chrome to opt it out of the admin skin. */
export const adminSurfaceExcludeProps = { [ADMIN_SURFACE_EXCLUDE_ATTRIBUTE]: '' };

const surface = `[${ADMIN_SURFACE_ATTRIBUTE}]`;
const exclude = `[${ADMIN_SURFACE_EXCLUDE_ATTRIBUTE}]`;
const notExcluded = `:where(:not(${exclude}, ${exclude} *))`;
const adminMounted = `body:has(${surface})`;
// Portalled popups render under <body>, outside the admin root, so they are matched while an admin
// surface is mounted instead. A popup opened from excluded chrome portals there too; it is told apart
// by its trigger: an expanded popup trigger (not any disclosure) inside the chrome owns the open menu
// or listbox, and a tooltip shows while the pointer is over the chrome.
const dialogRoots = '.MuiModalDialog-root, .MuiDrawer-content';
const popupRoots = '.MuiMenu-root, .MuiSelect-listbox, .MuiAutocomplete-listbox';
const adminDialogsMounted = adminMounted;
const popupTrigger = '[aria-haspopup]:not([aria-haspopup="false"]), [role="combobox"]';
const adminPopupsMounted = `${adminMounted}:not(:has(${exclude} :is(${popupTrigger})[aria-expanded="true"]))`;
const adminTooltipsMounted = `${adminMounted}:not(:has(${exclude}:hover))`;
const portalScope = `${adminDialogsMounted} :is(${dialogRoots}), ${adminPopupsMounted} :is(${popupRoots})`;
/** The portalled roots that carry the admin variables, as a list so each can take its own prefix. */
const portalSurfaces = [
  `${adminDialogsMounted} :is(${dialogRoots})${notExcluded}`,
  `${adminPopupsMounted} :is(${popupRoots})${notExcluded}`,
  `${adminTooltipsMounted} .MuiTooltip-root`,
];
// The leading `*` matters: stylis reads a nested key that starts with `:` as a pseudo-class of
// the component itself and would glue the selector onto it.
export const IN_ADMIN = `*:where(${surface}, ${portalScope}) &${notExcluded}`;
/** A portalled dialog or drawer, and its backdrop. */
export const IN_ADMIN_PORTAL = `*:where(${adminDialogsMounted}) &${notExcluded}`;
/** A portalled menu or listbox. */
export const IN_ADMIN_POPUP = `*:where(${adminPopupsMounted}) &${notExcluded}`;
export const IN_ADMIN_TOOLTIP = `*:where(${adminTooltipsMounted}) &`;
/** Inside a table body row: a Joy `Table` row or a `role="row"` grid row. */
export const IN_ADMIN_ROW = `*:where(${surface} :is(tbody tr, [role="row"])) &${notExcluded}`;

/** `selector` inside the admin root but outside any excluded chrome; a pseudo-element goes last. */
const inSurface = (selector: string, pseudoElement = '') => `${surface} ${selector}${notExcluded}${pseudoElement}`;
/** `selector` in the admin root and in the admin dialogs and popups it opens. */
const inAdminScope = (selector: string, pseudoElement = '') =>
  [
    inSurface(selector, pseudoElement),
    `${adminDialogsMounted} :is(${dialogRoots}) ${selector}${notExcluded}${pseudoElement}`,
    `${adminPopupsMounted} :is(${popupRoots}) ${selector}${pseudoElement}`,
  ].join(', ');

const admin = (token: string) => `var(--joy-palette-admin-${token})`;
const tone = (name: string, part: 'foreground' | 'background') => admin(`status-${name}-${part}`);
const mix = (color: string, percent: number, base = admin('surface')) =>
  `color-mix(in srgb, ${color} ${percent}%, ${base})`;

const FONT_SANS =
  'var(--font-admin-sans), Inter, system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Helvetica, Arial, sans-serif';
const FONT_MONO = 'var(--font-reading-mono), ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace';

type JoyColor = 'primary' | 'neutral' | 'danger' | 'success' | 'warning';
type ColorSpec = Record<string, string>;

/** Joy's numbered shades, light to dark, as `[first shade, value]` steps. */
const shades = (steps: [number, string][]) => {
  const scale = [50, 100, 200, 300, 400, 500, 600, 700, 800, 900];
  return Object.fromEntries(
    scale.map(shade => [String(shade), [...steps].reverse().find(([from]) => shade >= from)?.[1] ?? steps[0][1]])
  );
};

/** Ink on surfaces: what `primary` and `neutral` become (guide section 2, "Mapping onto Joy"). */
const inkSpec: ColorSpec = {
  plainColor: admin('ink'),
  plainHoverColor: admin('ink'),
  plainHoverBg: admin('hover'),
  plainActiveBg: admin('hover'),
  plainDisabledColor: admin('inkMuted'),
  outlinedColor: admin('ink'),
  outlinedBorder: admin('borderStrong'),
  outlinedHoverColor: admin('ink'),
  outlinedHoverBorder: admin('borderStrong'),
  outlinedHoverBg: admin('hover'),
  outlinedActiveBg: admin('hover'),
  outlinedDisabledColor: admin('inkMuted'),
  outlinedDisabledBorder: admin('border'),
  softColor: admin('ink'),
  softBg: admin('hover'),
  softHoverColor: admin('ink'),
  softHoverBg: mix(admin('ink'), 8, admin('hover')),
  softActiveColor: admin('ink'),
  softActiveBg: mix(admin('ink'), 12, admin('hover')),
  softDisabledColor: admin('inkMuted'),
  softDisabledBg: admin('surfaceSubtle'),
  solidColor: admin('surface'),
  solidBg: admin('ink'),
  solidHoverBg: mix(admin('ink'), 88),
  solidActiveBg: mix(admin('ink'), 80),
  solidDisabledColor: admin('inkMuted'),
  solidDisabledBg: admin('hover'),
  solidBorder: 'none',
  ...shades([
    [50, admin('surfaceSubtle')],
    [100, admin('hover')],
    [200, admin('border')],
    [300, admin('borderStrong')],
    [400, admin('inkMuted')],
    [600, admin('inkSecondary')],
    [800, admin('ink')],
  ]),
  500: admin('ink'),
};

/** A secondary button: `surface` fill and a `borderStrong` outline, for solid buttons that are not the primary action. */
const secondarySolid: ColorSpec = {
  solidColor: admin('ink'),
  solidBg: admin('surface'),
  solidHoverBg: admin('hover'),
  solidActiveBg: admin('hover'),
};

/** A status tone: no saturated fills, every variant is the tone's label on its tint. */
const toneSpec = (name: string): ColorSpec => {
  const [fg, bg] = [tone(name, 'foreground'), tone(name, 'background')];
  return {
    plainColor: fg,
    plainHoverColor: fg,
    plainHoverBg: bg,
    plainActiveBg: bg,
    outlinedColor: fg,
    outlinedBorder: mix(fg, 35),
    outlinedHoverBorder: mix(fg, 35),
    outlinedHoverBg: bg,
    outlinedActiveBg: bg,
    softColor: fg,
    softHoverColor: fg,
    softActiveColor: fg,
    softBg: bg,
    softHoverBg: bg,
    softActiveBg: bg,
    solidColor: fg,
    solidBg: bg,
    solidHoverBg: bg,
    solidActiveBg: bg,
    ...shades([
      [50, bg],
      [300, mix(fg, 50, bg)],
      [500, fg],
    ]),
  };
};

const dangerSpec: ColorSpec = {
  ...toneSpec('bad'),
  plainColor: admin('danger'),
  plainHoverColor: admin('danger'),
  outlinedColor: admin('danger'),
  outlinedBorder: mix(admin('danger'), 35),
  outlinedHoverBorder: mix(admin('danger'), 35),
  solidColor: admin('surface'),
  solidBg: admin('danger'),
  solidHoverBg: mix(admin('danger'), 85, admin('ink')),
  solidActiveBg: mix(admin('danger'), 85, admin('ink')),
  500: admin('danger'),
  600: admin('danger'),
};

/** Controls and data bars take the one accent: checkboxes, radios, switches, sliders, progress. */
// Labels keep the ink they inherit; only the control itself is accent.
const accentSpec: ColorSpec = {
  outlinedBorder: admin('borderStrong'),
  softColor: admin('selection-foreground'),
  softBg: admin('selection-background'),
  solidColor: admin('surface'),
  solidBg: admin('accent'),
  solidHoverBg: mix(admin('accent'), 88, admin('ink')),
  solidActiveBg: mix(admin('accent'), 88, admin('ink')),
  ...shades([
    [50, admin('selection-background')],
    [200, admin('selection-border')],
    [400, admin('accent')],
  ]),
};

const paletteVars = (colors: JoyColor[], spec: ColorSpec) =>
  Object.fromEntries(
    colors.flatMap(color => Object.entries(spec).map(([key, value]) => [`--joy-palette-${color}-${key}`, value]))
  );

const channel = (hex: string) => [1, 3, 5].map(index => parseInt(hex.slice(index, index + 2), 16)).join(' ');

/**
 * Joy colors some text through `rgba(var(--joy-palette-<color>-mainChannel) / 1)`. A channel is a
 * plain "r g b" triple that cannot reference a token, so it is computed per color scheme.
 */
const channelVars = (palette: AdminPalette) => {
  const channels = (main: string, light: string) => ({
    mainChannel: channel(main),
    lightChannel: channel(light),
    darkChannel: channel(main),
  });
  return {
    ...paletteVars(['primary', 'neutral'], channels(palette.ink, palette.inkMuted)),
    ...paletteVars(['success'], channels(palette.status.good.foreground, palette.status.good.foreground)),
    ...paletteVars(['warning'], channels(palette.status.warn.foreground, palette.status.warn.foreground)),
    ...paletteVars(['danger'], channels(palette.danger, palette.danger)),
  };
};
const DARK = '[data-joy-color-scheme="dark"]';

/**
 * Joy reads every color, font and radius through these variables, so remapping them on the admin
 * root re-skins every component, raw `Sheet`s, `text.secondary` copy and `color` props included:
 * no Joy default blue, orange or yellow can reach the admin.
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
  '--joy-palette-background-level3': admin('hover'),
  '--joy-palette-text-primary': admin('ink'),
  '--joy-palette-text-secondary': admin('inkSecondary'),
  '--joy-palette-text-tertiary': admin('inkMuted'),
  '--joy-palette-text-icon': admin('inkMuted'),
  '--joy-palette-divider': admin('border'),
  '--joy-palette-focusVisible': admin('accent'),
  ...paletteVars(['primary', 'neutral'], inkSpec),
  ...paletteVars(['success'], toneSpec('good')),
  ...paletteVars(['warning'], toneSpec('warn')),
  ...paletteVars(['danger'], dangerSpec),
  // Joy sizes labels, radios and form text from this scale; the admin has no type above 15 px
  // outside page and dialog titles, which the Typography override sets directly.
  '--joy-fontSize-xs': '12px',
  '--joy-fontSize-sm': '13px',
  '--joy-fontSize-md': '14px',
  '--joy-fontSize-lg': '15px',
  '--joy-fontSize-xl': '15px',
  '--joy-focus-thickness': '2px',
  '--joy-radius-xs': '4px',
  '--joy-radius-sm': '6px',
  '--joy-radius-md': '8px',
  '--joy-radius-lg': '12px',
  '--joy-radius-xl': '16px',
};

const fieldRoots = '.MuiInput-root, .MuiTextarea-root, .MuiSelect-root, .MuiAutocomplete-root';
/**
 * A field has one focus indicator, the ring its root draws (`field` below), so the outline ring skips
 * the root and the native control inside it. `adminFocusScope` in `admin/shared/adminStyles` reuses this.
 */
export const FIELD_FOCUS_PARTS = `input, textarea, .MuiSelect-button, ${fieldRoots}`;
const focusable = `:focus-visible:not(${FIELD_FOCUS_PARTS})`;
const helpIcons = ':is([data-testid="HelpOutlineIcon"], [data-testid="HelpIcon"], [data-testid="InfoOutlinedIcon"])';

/**
 * Every variable the skin redefines. CSS variables inherit, so excluded chrome under the admin root
 * would read the admin values; `:root` keeps a copy of each document-level value under `--app-*`
 * (a `var()` in a custom property resolves where it is declared, so the copy follows the color
 * scheme) and the excluded root puts them back.
 */
const skinnedVariables = Object.keys({ ...rootVariables, ...channelVars(adminPalette.light) });
const appCopy = (variable: string) => `--app-${variable.slice(2)}`;

/** Global rules for the admin root itself and the popups it opens. Rendered once by `AppTheme`. */
export const adminSkinGlobalStyles = (theme: Theme) => ({
  ':root': Object.fromEntries(skinnedVariables.map(variable => [appCopy(variable), `var(${variable})`])),
  [`${surface}${surface}`]: {
    ...rootVariables,
    backgroundColor: admin('canvas'),
    color: admin('ink'),
    fontFamily: FONT_SANS,
    fontSize: '14px',
    WebkitFontSmoothing: 'antialiased',
  },
  [`${surface} ${exclude}`]: Object.fromEntries(
    skinnedVariables.map(variable => [variable, `var(${appCopy(variable)})`])
  ),
  // The type the app's CssBaseline gives <body>, which excluded chrome would inherit on any other page.
  // Zero specificity, so the excluded root's own colour and type (a solid pill's label) still win.
  [`:where(${surface} ${exclude})`]: {
    color: theme.vars.palette.text.primary,
    fontFamily: theme.vars.fontFamily.body,
    ...theme.typography['body-md'],
  },
  [portalSurfaces.join(', ')]: rootVariables,
  [[`${surface}${surface}`, ...portalSurfaces].join(', ')]: channelVars(adminPalette.light),
  [[`${surface}${surface}`, ...portalSurfaces].map(selector => `${DARK} ${selector}`).join(', ')]: channelVars(
    adminPalette.dark
  ),
  // The app theme strips Joy's focus outline with !important; the extra specificity of the
  // attribute selector lets the 2px accent ring win back. Fields draw their own ring instead.
  [inAdminScope(focusable)]: {
    outline: `2px solid ${admin('accent')} !important`,
    outlineOffset: '2px',
  },
  // globals.css hides Joy's field ring through `[class*='JoyInput']`-style matches, which hit the
  // emotion labels of dev builds (and `MuiSelect-root` everywhere); the admin field's ring is its
  // only focus indicator, so it is restored here. The focus state in each selector outranks the global rule.
  [inAdminScope('.MuiInput-root:focus-within')]: {
    '--Input-focusedThickness': '2px !important',
    '--Input-focusedHighlight': `${admin('accent')} !important`,
  },
  [inAdminScope('.MuiSelect-root.Mui-focusVisible')]: { '--Select-focusedHighlight': `${admin('accent')} !important` },
  [inAdminScope(`:is(${fieldRoots})`, '::before')]: { opacity: '1 !important' },
  // Overlay scrollbars on every admin scroll area; the main frame, sidebar, tables and dialog bodies
  // also reserve the gutter (`adminScrollGutter`).
  [`${inSurface('*')}, ${adminDialogsMounted} :is(${dialogRoots})${notExcluded}, ${adminDialogsMounted} :is(${dialogRoots}) *${notExcluded}`]:
    adminScrollbar,
  // Material icons sit outside Joy's theme. Help icons are 16 px and muted, never larger than the heading they explain.
  [inSurface(`svg${helpIcons}`)]: { fontSize: '16px', color: admin('inkMuted') },
  [inSurface('a:not([class*="Mui"])')]: { color: admin('link') },
  // globals.css paints radios green with !important and outlines the whole clickable overlay; inside
  // the admin the overlay stays invisible and Joy's own radio circle carries the accent.
  [`${inSurface("[class*='MuiRadio-input']")}, ${inSurface("[class*='MuiRadio-input']:is(:checked, :hover, .Mui-checked)")}`]:
    {
      border: 'none !important',
      backgroundColor: 'transparent !important',
    },
  [inSurface("[class*='MuiRadio-input']:checked", '::after')]: { display: 'none !important' },
  [inSurface("[class*='MuiRadio-action'].Mui-checked")]: { border: 'none !important' },
  [inSurface('.MuiRadio-radio')]: { borderColor: `${admin('borderStrong')} !important` },
  [inSurface('.MuiRadio-radio.Mui-checked')]: { borderColor: `${admin('accent')} !important` },
  [inSurface("[class*='MuiRadio-icon']")]: { backgroundColor: `${admin('accent')} !important` },
  // Chart axes, ticks and legends are meta text; series colors stay with each chart.
  [inSurface(':is(.recharts-cartesian-axis-tick-value, .recharts-label, .recharts-legend-item-text)')]: {
    fontSize: '12px',
  },
  [inSurface(':is(.recharts-cartesian-axis-tick-value, .recharts-label) tspan')]: { fill: admin('inkMuted') },
  [inSurface('.recharts-cartesian-grid line')]: { stroke: admin('border') },
});

const field = (prefix: string) => ({
  [IN_ADMIN]: {
    [`--${prefix}-radius`]: '8px',
    [`--${prefix}-minHeight`]: '36px',
    // Same heights as buttons, so a `sm` field lines up with the `sm` buttons in a toolbar.
    [`&.Mui${prefix}-sizeSm`]: { [`--${prefix}-minHeight`]: '32px', fontSize: '13px' },
    [`--${prefix}-focusedHighlight`]: admin('accent'),
    [`--${prefix}-focusedThickness`]: '2px',
    '--Icon-color': admin('inkMuted'),
    borderRadius: '8px',
    fontSize: '14px',
    color: admin('ink'),
    '&.MuiInput-variantOutlined, &.MuiTextarea-variantOutlined, &.MuiSelect-variantOutlined, &.MuiAutocomplete-variantOutlined':
      {
        backgroundColor: admin('surface'),
        borderColor: admin('borderStrong'),
        boxShadow: 'none',
      },
  },
});

const popupList = {
  [IN_ADMIN_POPUP]: {
    backgroundColor: admin('surface'),
    border: `1px solid ${admin('border')}`,
    borderRadius: '12px',
    boxShadow: '0 12px 32px rgba(0, 0, 0, 0.12)',
    padding: '6px',
    '--ListItem-radius': '8px',
    '--ListItem-minHeight': '36px',
  },
};

// Chips and alerts carry the status tones; `primary` reads as "new or notable", which is info.
const toneByColor: [string, string][] = [
  ['Primary', 'info'],
  ['Neutral', 'neutral'],
];
const toneRules = (component: string) =>
  Object.fromEntries(
    toneByColor.map(([color, name]) => [
      `&.Mui${component}-color${color}`,
      paletteVars([color.toLowerCase() as JoyColor], toneSpec(name)),
    ])
  );

// Buttons are ink or danger only: a `warning` or `success` button renders as a neutral one.
const neutralButtonColors = (component: string) => ({
  [`&:is(.Mui${component}-colorWarning, .Mui${component}-colorSuccess)`]: paletteVars(['warning', 'success'], inkSpec),
  // Only `primary` keeps the ink fill; any other solid button is secondary, so a view has one primary.
  [`&.Mui${component}-variantSolid:not(.Mui${component}-colorPrimary, .Mui${component}-colorDanger)`]: {
    ...paletteVars(['neutral', 'warning', 'success'], secondarySolid),
    // The app theme gives solid buttons a currentColor border, which would draw an ink outline here.
    borderColor: admin('borderStrong'),
  },
});

// Row actions are ghost buttons (guide section 5, "Tables"), whatever variant the tab asked for.
// The doubled component class outranks the secondary-button rule above.
const rowAction = (component: string) => ({
  [IN_ADMIN_ROW]: {
    [`&.Mui${component}-root:not(.Mui${component}-colorDanger)`]: {
      ...paletteVars(['primary', 'neutral', 'warning', 'success'], {
        ...inkSpec,
        solidColor: admin('ink'),
        solidBg: 'transparent',
        solidHoverBg: admin('hover'),
        solidActiveBg: admin('hover'),
        outlinedBorder: 'transparent',
        softBg: 'transparent',
      }),
      boxShadow: 'none',
    },
    minHeight: '28px',
  },
});

/** The seven type levels (guide section 2, "Type"). Every Joy level maps onto one of them. */
const pageTitle = { fontSize: '24px', fontWeight: 600, letterSpacing: '-0.01em', lineHeight: 1.3 };
const sectionTitle = { fontSize: '15px', fontWeight: 600, letterSpacing: 'normal', lineHeight: 1.4 };
const typographyLevels: Record<string, Record<string, string | number>> = {
  h1: pageTitle,
  h2: sectionTitle,
  h3: sectionTitle,
  h4: sectionTitle,
  'title-lg': sectionTitle,
  'title-md': sectionTitle,
  'title-sm': { fontSize: '14px', fontWeight: 600, lineHeight: 1.4 },
  'body-lg': { fontSize: '14px' },
  'body-md': { fontSize: '14px' },
  // Joy colors body-sm with the tertiary (muted) text var, but tabs use it for content like table cells.
  // Redefine the var rather than set `color`: a nested rule would beat a flat sx color (the env banner's white title).
  'body-sm': { fontSize: '13px', '--joy-palette-text-tertiary': admin('inkSecondary') },
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
          '--TableCell-borderColor': admin('border'),
          '--TableCell-headBackground': admin('surfaceSubtle'),
          '--TableCell-selectedBackground': admin('selection-background'),
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
            backgroundColor: admin('surfaceSubtle'),
            textTransform: 'none',
            letterSpacing: 'normal',
            verticalAlign: 'middle',
            borderBottom: `1px solid ${admin('border')}`,
          },
          '& tbody tr:hover > :is(td, th)': { backgroundColor: admin('surfaceSubtle') },
          // A bare table is a surface card on the canvas; one already inside a Card or a framed DataTable is not.
          '&:not(:is(.MuiCard-root, [data-admin-table-frame]) *)': {
            backgroundColor: admin('surface'),
            borderRadius: '12px',
            boxShadow: `0 0 0 1px ${admin('border')}`,
            '& thead tr:first-of-type > :first-child': { borderTopLeftRadius: '12px' },
            '& thead tr:first-of-type > :last-child': { borderTopRightRadius: '12px' },
            '& tbody tr:last-of-type > :first-child': { borderBottomLeftRadius: '12px' },
            '& tbody tr:last-of-type > :last-child': { borderBottomRightRadius: '12px' },
          },
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
          '--Icon-fontSize': '16px',
          '--Icon-color': 'currentColor',
          borderRadius: '8px',
          fontWeight: 500,
          fontSize: '13px',
          '&.MuiButton-sizeLg, &.MuiButton-sizeMd': { minHeight: '36px', paddingInline: '14px' },
          '&.MuiButton-sizeSm': { minHeight: '32px', paddingBlock: 0, paddingInline: '12px', fontSize: '13px' },
          ...neutralButtonColors('Button'),
          '&.Mui-disabled': { opacity: 0.45 },
        },
        ...rowAction('Button'),
      },
    },
  },
  JoyIconButton: {
    styleOverrides: {
      root: {
        [IN_ADMIN]: {
          '--IconButton-radius': '6px',
          '--Icon-fontSize': '18px',
          '--Icon-color': 'currentColor',
          borderRadius: '6px',
          ...neutralButtonColors('IconButton'),
          '&.MuiIconButton-variantPlain:is(.MuiIconButton-colorNeutral, .MuiIconButton-colorPrimary)': {
            color: admin('inkMuted'),
            '&:hover': { color: admin('ink') },
          },
        },
        ...rowAction('IconButton'),
      },
    },
  },
  JoyChip: {
    styleOverrides: {
      root: {
        [IN_ADMIN]: {
          '--Chip-radius': '999px',
          '--Icon-fontSize': '12px',
          borderRadius: '999px',
          fontSize: '12px',
          fontWeight: 500,
          '&.MuiChip-sizeSm, &.MuiChip-sizeMd': { minHeight: '22px', '--Chip-paddingInline': '8px' },
          ...toneRules('Chip'),
        },
      },
    },
  },
  JoyAlert: {
    styleOverrides: {
      root: {
        [IN_ADMIN]: {
          borderRadius: '12px',
          fontSize: '13px',
          ...toneRules('Alert'),
        },
      },
    },
  },
  ...Object.fromEntries(
    ['JoyCheckbox', 'JoyRadio', 'JoySlider', 'JoyLinearProgress', 'JoyCircularProgress'].map(name => [
      name,
      { styleOverrides: { root: { [IN_ADMIN]: paletteVars(['primary', 'neutral', 'success'], accentSpec) } } },
    ])
  ),
  JoySwitch: {
    styleOverrides: {
      root: {
        [IN_ADMIN]: {
          ...paletteVars(['primary', 'neutral', 'success'], accentSpec),
          // Joy fills a solid switch's track with solidBg even when off; off reads as a neutral track.
          '&:not(.Mui-checked) .MuiSwitch-track': { backgroundColor: admin('borderStrong') },
        },
      },
    },
  },
  JoyLink: {
    styleOverrides: {
      root: { [IN_ADMIN]: { color: admin('link'), '&:hover': { color: admin('selection-foreground') } } },
    },
  },
  JoyAvatar: {
    styleOverrides: {
      root: {
        [IN_ADMIN]: {
          '&.MuiAvatar-variantSoft': {
            backgroundColor: admin('selection-background'),
            color: admin('selection-foreground'),
            fontWeight: 600,
          },
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
            minHeight: '40px',
            paddingInline: '4px',
            fontSize: '14px',
            fontWeight: 500,
            color: admin('inkSecondary'),
            backgroundColor: 'transparent',
            '&:hover': { color: admin('ink'), backgroundColor: 'transparent' },
            '&[aria-selected="true"]': {
              // The app theme sets `disableIndicator` on every Tab (navigation.tsx), so draw the underline here.
              boxShadow: `inset 0 -2px 0 ${admin('ink')}`,
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
          backgroundColor: admin('surface'),
          borderColor: admin('border'),
          color: admin('ink'),
          boxShadow: '0 24px 64px rgba(0, 0, 0, 0.3)',
        },
      },
    },
  },
  JoyDialogContent: {
    styleOverrides: {
      root: { [IN_ADMIN]: adminScrollGutter },
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
        [IN_ADMIN_TOOLTIP]: {
          backgroundColor: admin('ink'),
          color: admin('surface'),
          border: 'none',
          borderRadius: '6px',
          fontSize: '12px',
          fontWeight: 500,
        },
      },
      arrow: {
        [IN_ADMIN_TOOLTIP]: {
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

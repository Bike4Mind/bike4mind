import { blue, unique, greenAlpha, brand, gray, brandAlpha, green } from '../colors';

export const sidenavTheme = {
  dark: {
    // callToAction -> callToActionManager (currently unused)
    blueBack: blue[600],
    ctaSubscribe: greenAlpha[900][5],
    textColor: undefined,
    // Primary nav list (New Chat, Files Manager, Agents, ...)
    navItemText: gray[200], // #D3DFE8 — neutral light stroke
    navItemIcon: brand[100], // #D1E4F4 — brand light blue
    // Footer status chips (Serwist / WS / cloud)
    chipText: brand[100], // #D1E4F4
    chipIcon: brandAlpha[100][50], // #D1E4F4 @ 50%
    chipIconConnected: green[800], // #1FB84B — cloud icon when socket is OPEN
    filterActiveBg: brandAlpha[100][5], // #D1E4F4 @ 5% — Filters button active fill
    pinnedBackdrop: gray[850], // solid backdrop behind the sticky pinned nav
  },
  light: {
    // callToAction -> callToActionManager (currently unused)
    blueBack: unique.lightBlue,
    ctaSubscribe: unique.limeGreen,
    textColor: brand[600],
    navItemText: brand[600], // #0A3D50 — dark navy
    navItemIcon: brand[400], // #335F70 — muted brand mid-tone
    chipText: brand[600], // #0A3D50
    chipIcon: brandAlpha[400][50], // #335F70 @ 50%
    chipIconConnected: green[800], // #1FB84B — same status green in both modes
    filterActiveBg: brandAlpha[800][8], // #0B6BCB @ 8% — subtle brand tint on light surface
    pinnedBackdrop: gray[50], // solid backdrop behind the sticky pinned nav
  },
};

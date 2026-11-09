// Layout metrics. Like the typography ramps, spacing/radii/shadows pin the
// values the web app renders with today (framework defaults where the theme
// does not override them) so other platforms can match them exactly.

export const spacing = {
  unit: 8, // px
};

export const radii = {
  xs: 2, // px
  sm: 6,
  md: 8, // also the theme's root borderRadius
  lg: 12,
  xl: 16,
};

// Elevation levels as shadow layers (y-offset/blur/spread in px) over one
// shared shadow color. On web the color resolves through theme CSS variables;
// channel/opacity here are those variables' defaults.
export const shadows = {
  channel: '21 21 21',
  opacity: 0.08,
  levels: {
    xs: [{ offsetX: 0, offsetY: 1, blur: 2, spread: 0 }],
    sm: [
      { offsetX: 0, offsetY: 1, blur: 2, spread: 0 },
      { offsetX: 0, offsetY: 2, blur: 4, spread: 0 },
    ],
    md: [
      { offsetX: 0, offsetY: 2, blur: 8, spread: -2 },
      { offsetX: 0, offsetY: 6, blur: 12, spread: -2 },
    ],
    lg: [
      { offsetX: 0, offsetY: 2, blur: 8, spread: -2 },
      { offsetX: 0, offsetY: 12, blur: 16, spread: -4 },
    ],
    xl: [
      { offsetX: 0, offsetY: 2, blur: 8, spread: -2 },
      { offsetX: 0, offsetY: 20, blur: 24, spread: -4 },
    ],
  },
};

// Motion durations in ms, seeded from the durations the web app's transitions
// use most (0.15s/0.2s/0.3s/0.5s account for nearly all of them). Not yet
// consumed by the web emitters.
export const motion = {
  duration: {
    fast: 150,
    standard: 200,
    slow: 300,
    slower: 500,
  },
};

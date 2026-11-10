// Typography tokens. fontFamily is what the web theme sets explicitly; the
// size/weight/line-height ramps are the values the web app currently renders
// with (its UI framework's defaults, pinned here so other platforms can match
// them and so a framework upgrade that moves them is a visible diff).
export const typography = {
  fontFamily: {
    body: '"Libre Franklin", -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Helvetica, Arial, sans-serif',
    display: '"Libre Franklin", -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Helvetica, Arial, sans-serif',
  },
  fontSize: {
    xs: '0.75rem',
    sm: '0.875rem',
    md: '1rem',
    lg: '1.125rem',
    xl: '1.25rem',
    xl2: '1.5rem',
    xl3: '1.875rem',
    xl4: '2.25rem',
  },
  fontWeight: {
    sm: 300,
    md: 500,
    lg: 600,
    xl: 700,
  },
  lineHeight: {
    xs: '1.33334',
    sm: '1.42858',
    md: '1.5',
    lg: '1.55556',
    xl: '1.66667',
  },
};

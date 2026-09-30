/** Fixed categorical order. Dark is the same hues stepped for dark surfaces, not a flip. */
const LIGHT = ['#2a78d6', '#eb6834', '#1baf7a', '#eda100', '#e87ba4', '#008300', '#4a3aa7', '#e34948'];
const DARK = ['#3987e5', '#d95926', '#199e70', '#c98500', '#d55181', '#008300', '#9085e9', '#e66767'];
/** Status "critical"; reserved for thresholds, never a series. */
export const QA_THRESHOLD_COLOR = '#d03b3b';

/** `index` is below MAX_SERIES (chartData.ts), so the palette never wraps. */
export function seriesColor(index: number, mode: 'light' | 'dark'): string {
  const palette = mode === 'dark' ? DARK : LIGHT;
  return palette[index % palette.length];
}

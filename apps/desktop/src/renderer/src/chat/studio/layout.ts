export const STUDIO_PANE_WIDTH = 360;
export const STUDIO_DOCK_MIN_WIDTH = 400 + STUDIO_PANE_WIDTH;

export function studioPaneLayout(regionWidth: number | null): 'docked' | 'stacked' {
  return regionWidth === null || regionWidth >= STUDIO_DOCK_MIN_WIDTH ? 'docked' : 'stacked';
}

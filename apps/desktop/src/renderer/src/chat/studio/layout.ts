import { CONTENT_MAX_WIDTH } from '../layout';

export const STUDIO_PANE_WIDTH = 360;
export const STUDIO_DOCK_MIN_WIDTH = CONTENT_MAX_WIDTH + STUDIO_PANE_WIDTH;

export function studioPaneLayout(regionWidth: number | null): 'docked' | 'drawer' {
  return regionWidth !== null && regionWidth >= STUDIO_DOCK_MIN_WIDTH ? 'docked' : 'drawer';
}

import type { ColorPaletteProp } from '@mui/joy/styles';
import type { AgentState } from '@shared/agentState';

/**
 * The one place an agent state gets its colour. `joy` drives chips and tiles; `lamp` is the raw hex for
 * scene lamps, tokens and note pins, which cannot take a Joy palette name. Views import this rather than
 * keep their own map (statePalette.test.ts scans for strays), so a skin overrides the palette in one spot.
 */
export interface StateColor {
  joy: ColorPaletteProp;
  lamp: string;
}

export const STATE_PALETTE: Readonly<Record<AgentState, StateColor>> = {
  'needs-you': { joy: 'warning', lamp: '#f5c542' },
  working: { joy: 'primary', lamp: '#ff9d3c' },
  done: { joy: 'success', lamp: '#7ed07a' },
  failed: { joy: 'danger', lamp: '#e5534b' },
  stopped: { joy: 'neutral', lamp: '#a89a88' },
  idle: { joy: 'neutral', lamp: '#a89a88' },
};

export const stateJoyColor = (state: AgentState): ColorPaletteProp => STATE_PALETTE[state].joy;
export const stateLampColor = (state: AgentState): string => STATE_PALETTE[state].lamp;

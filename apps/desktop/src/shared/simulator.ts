/**
 * The live iOS Simulator view, shared by main (SimulatorLiveView) and the renderer's
 * SimulatorPane. macOS only: on any other platform main reports `available: false` and the pane
 * and its toolbar button are not drawn.
 */

export interface SimulatorViewDevice {
  udid: string;
  name: string;
  runtime: string;
  state: string;
}

export interface SimulatorViewState {
  available: boolean;
  status: 'idle' | 'starting' | 'live' | 'error';
  /** The device on screen; null when idle. */
  device: SimulatorViewDevice | null;
  /** The screen in points, which is what a tap from the pane is sent in. Portrait orientation. */
  screen: { width: number; height: number } | null;
  /** 'stream' is AXe's video stream; 'snapshots' is the slower screenshot loop used without AXe. */
  source: 'stream' | 'snapshots' | null;
  /** What went wrong, with the fix, for an 'error' status; a note (e.g. "install AXe") otherwise. */
  message: string;
}

export const IDLE_SIMULATOR_VIEW: SimulatorViewState = {
  available: false,
  status: 'idle',
  device: null,
  screen: null,
  source: null,
  message: '',
};

/** One JPEG frame of the attached device's screen. */
export interface SimulatorFrame {
  udid: string;
  // Structured clone delivers a plain ArrayBuffer-backed view, never a shared one.
  bytes: Uint8Array<ArrayBuffer>;
}

/** The user's own touches and buttons from the pane. Coordinates are points. */
export type SimulatorPaneInput =
  | { kind: 'tap'; x: number; y: number }
  | { kind: 'swipe'; from: { x: number; y: number }; to: { x: number; y: number }; duration: number }
  | { kind: 'button'; button: 'home' | 'lock' }
  | { kind: 'appearance'; mode: 'light' | 'dark' }
  | { kind: 'type'; text: string };

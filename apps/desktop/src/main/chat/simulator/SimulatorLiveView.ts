import { spawn, type ChildProcess } from 'node:child_process';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  IDLE_SIMULATOR_VIEW,
  type SimulatorPaneInput,
  type SimulatorViewDevice,
  type SimulatorViewState,
} from '@shared/simulator';
import { commandEnv } from '../tools/commandLaunch';
import type { SimulatorDriver } from '../tools/types';
import { MjpegParser } from './mjpeg';
import { AXE_INSTALL_COMMAND, runToolchain, SimulatorSetupError, type Runner } from './toolchain';

const STREAM_FPS = 10;
/** Half the device's pixels is still sharper than the pane draws it. */
const STREAM_SCALE = 0.5;
const SNAPSHOT_INTERVAL_MS = 350;

/** Starts AXe's video stream; injected so tests need no simulator. */
export type StreamSpawner = (udid: string) => Promise<ChildProcess>;

const spawnAxeStream: StreamSpawner = async udid =>
  spawn(
    'axe',
    [
      'stream-video',
      '--udid',
      udid,
      '--format',
      'mjpeg',
      '--fps',
      String(STREAM_FPS),
      '--quality',
      '70',
      '--scale',
      String(STREAM_SCALE),
    ],
    { env: await commandEnv(), stdio: ['ignore', 'pipe', 'pipe'] }
  );

export interface SimulatorLiveViewEvents {
  state(state: SimulatorViewState): void;
  frame(udid: string, jpeg: Buffer): void;
}

/**
 * The one device the user's live pane shows. The simulator is a machine-wide resource, so there
 * is one view for the app rather than one per conversation; whichever session attached last owns
 * it. Frames come from AXe's MJPEG stream, or from a screenshot loop when AXe is not installed.
 */
export class SimulatorLiveView {
  private state: SimulatorViewState;
  private stream: ChildProcess | null = null;
  private snapshotTimer: NodeJS.Timeout | null = null;
  /** Bumped on every attach and detach, so a late frame or exit from an old stream is ignored. */
  private generation = 0;

  constructor(
    private readonly driver: SimulatorDriver,
    private readonly events: SimulatorLiveViewEvents,
    private readonly options: { available: boolean; spawnStream?: StreamSpawner; run?: Runner } = { available: true }
  ) {
    this.state = { ...IDLE_SIMULATOR_VIEW, available: options.available };
  }

  current(): SimulatorViewState {
    return this.state;
  }

  attachedUdid(): string | undefined {
    return this.state.status === 'idle' ? undefined : this.state.device?.udid;
  }

  async attach(udid: string): Promise<SimulatorViewState> {
    if (!this.options.available) throw new Error('The iOS Simulator is only available on macOS.');
    if (this.attachedUdid() === udid && this.state.status !== 'error') return this.state;
    this.stop();
    const generation = ++this.generation;
    const device = await this.findDevice(udid);
    this.update({ status: 'starting', device, screen: null, source: null, message: '' });
    try {
      if (device.state !== 'Booted') await this.driver.boot(udid);
      const first = await this.driver.screenshot(udid);
      if (generation !== this.generation) return this.state;
      const { width, height } = first.screen;
      this.update({ screen: width <= height ? { width, height } : { width: height, height: width } });
      this.events.frame(udid, first.png);
    } catch (error) {
      if (generation === this.generation) this.update({ status: 'error', message: messageOf(error) });
      throw error;
    }
    await this.startStream(udid, generation);
    return this.state;
  }

  detach(): void {
    this.generation++;
    this.stop();
    this.update({ status: 'idle', device: null, screen: null, source: null, message: '' });
  }

  /** The user's own touch from the pane. Not gated: it is the user acting, not the agent. */
  async input(input: SimulatorPaneInput): Promise<void> {
    const udid = this.attachedUdid();
    if (!udid) throw new Error('No simulator is attached to the live view.');
    switch (input.kind) {
      case 'tap':
        return this.driver.tap(udid, input.x, input.y);
      case 'swipe':
        return this.driver.swipe(udid, input.from, input.to, input.duration);
      case 'button':
        return this.driver.button(udid, input.button);
      case 'appearance':
        return this.driver.setAppearance(udid, input.mode);
      case 'type':
        return this.driver.type(udid, input.text);
    }
  }

  dispose(): void {
    this.generation++;
    this.stop();
  }

  private async findDevice(udid: string): Promise<SimulatorViewDevice> {
    const { devices } = await this.driver.devices();
    const device = devices.find(candidate => candidate.udid === udid);
    if (!device) throw new Error(`No available simulator has the id ${udid}.`);
    return device;
  }

  private async startStream(udid: string, generation: number): Promise<void> {
    let child: ChildProcess;
    try {
      child = await (this.options.spawnStream ?? spawnAxeStream)(udid);
    } catch {
      return this.startSnapshots(udid, generation);
    }
    if (generation !== this.generation) {
      child.kill();
      return;
    }
    this.stream = child;
    let framed = false;
    const parser = new MjpegParser(jpeg => {
      if (generation !== this.generation) return;
      if (!framed) {
        framed = true;
        this.update({ status: 'live', source: 'stream' });
      }
      this.events.frame(udid, jpeg);
    });
    child.stdout?.on('data', (chunk: Buffer) => parser.push(chunk));
    // A missing binary arrives as an 'error' event, not a throw from spawn.
    child.on('error', () => {
      if (generation !== this.generation || this.stream !== child) return;
      this.stream = null;
      this.startSnapshots(udid, generation);
    });
    child.on('exit', () => {
      if (generation !== this.generation || this.stream !== child) return;
      this.stream = null;
      // The stream died after starting (device shut down, AXe crashed): keep the pane alive.
      this.startSnapshots(udid, generation);
    });
  }

  private startSnapshots(udid: string, generation: number): void {
    if (generation !== this.generation) return;
    this.update({
      status: 'live',
      source: 'snapshots',
      message: `Showing a few frames a second. For smooth video and to tap from here, install AXe: \`${AXE_INSTALL_COMMAND}\`.`,
    });
    const run = this.options.run ?? runToolchain;
    const tick = async () => {
      if (generation !== this.generation) return;
      const folder = await mkdtemp(join(tmpdir(), 'b4m-sim-view-'));
      try {
        const file = join(folder, 'frame.jpg');
        await run('xcrun', ['simctl', 'io', udid, 'screenshot', '--type=jpeg', file], { timeoutMs: 10_000 });
        if (generation === this.generation) this.events.frame(udid, await readFile(file));
      } catch (error) {
        if (generation === this.generation) this.update({ status: 'error', message: messageOf(error) });
        return;
      } finally {
        await rm(folder, { recursive: true, force: true });
      }
      if (generation === this.generation) this.snapshotTimer = setTimeout(() => void tick(), SNAPSHOT_INTERVAL_MS);
    };
    void tick();
  }

  private stop(): void {
    if (this.snapshotTimer) clearTimeout(this.snapshotTimer);
    this.snapshotTimer = null;
    const stream = this.stream;
    this.stream = null;
    stream?.kill('SIGINT');
  }

  private update(patch: Partial<SimulatorViewState>): void {
    this.state = { ...this.state, ...patch };
    this.events.state(this.state);
  }
}

function messageOf(error: unknown): string {
  if (error instanceof SimulatorSetupError) return `${error.problem}\nFix: ${error.fix}`;
  return error instanceof Error ? error.message : String(error);
}

function isPoint(value: unknown): value is { x: number; y: number } {
  if (typeof value !== 'object' || value === null) return false;
  const { x, y } = value as Record<string, unknown>;
  return typeof x === 'number' && Number.isFinite(x) && typeof y === 'number' && Number.isFinite(y);
}

/** The pane's input as it crossed IPC, checked field by field; null for anything else. */
export function parsePaneInput(value: unknown): SimulatorPaneInput | null {
  if (typeof value !== 'object' || value === null) return null;
  const input = value as Record<string, unknown>;
  switch (input.kind) {
    case 'tap':
      return isPoint(input) ? { kind: 'tap', x: input.x as number, y: input.y as number } : null;
    case 'swipe':
      return isPoint(input.from) && isPoint(input.to) && typeof input.duration === 'number'
        ? { kind: 'swipe', from: input.from, to: input.to, duration: Math.min(Math.max(input.duration, 0.05), 5) }
        : null;
    case 'button':
      return input.button === 'home' || input.button === 'lock' ? { kind: 'button', button: input.button } : null;
    case 'appearance':
      return input.mode === 'light' || input.mode === 'dark' ? { kind: 'appearance', mode: input.mode } : null;
    case 'type':
      return typeof input.text === 'string' && input.text.length > 0 && input.text.length <= 1000
        ? { kind: 'type', text: input.text }
        : null;
    default:
      return null;
  }
}

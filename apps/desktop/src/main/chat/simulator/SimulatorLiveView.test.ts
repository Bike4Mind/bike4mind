import { EventEmitter } from 'node:events';
import { writeFile } from 'node:fs/promises';
import type { ChildProcess } from 'node:child_process';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { SimulatorViewState } from '@shared/simulator';
import type { SimulatorDevice, SimulatorDriver } from '../tools/types';
import { SimulatorLiveView, parsePaneInput } from './SimulatorLiveView';
import type { Runner } from './toolchain';

const UDID = 'AAAA-1111';
const DEVICE: SimulatorDevice = { udid: UDID, name: 'iPhone 17', runtime: 'iOS 27.0', state: 'Booted' };
const PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 1, 2, 3]);
const JPEG = Buffer.from([0xff, 0xd8, 1, 2, 3, 0xff, 0xd9]);

function fakeDriver(device: SimulatorDevice = DEVICE) {
  return {
    devices: vi.fn(async () => ({ devices: [device], runtimes: ['iOS 27.0'] })),
    boot: vi.fn(async () => undefined),
    screenshot: vi.fn(async () => ({ png: PNG, screen: { width: 402, height: 874, scale: 3 } })),
    tap: vi.fn(async () => undefined),
    swipe: vi.fn(async () => undefined),
    type: vi.fn(async () => undefined),
    button: vi.fn(async () => undefined),
    setAppearance: vi.fn(async () => undefined),
  };
}

function fakeChild() {
  const child = new EventEmitter() as EventEmitter & { stdout: EventEmitter; kill: ReturnType<typeof vi.fn> };
  child.stdout = new EventEmitter();
  child.kill = vi.fn();
  return child;
}

const mjpegPart = (body: Buffer) =>
  Buffer.concat([
    Buffer.from(`HTTP/1.1 200 OK\r\n\r\n--b\r\nContent-Type: image/jpeg\r\nContent-Length: ${body.length}\r\n\r\n`),
    body,
    Buffer.from('\r\n'),
  ]);

function setup(
  options: {
    available?: boolean;
    device?: SimulatorDevice;
    spawnStream?: () => Promise<ChildProcess>;
    run?: Runner;
  } = {}
) {
  const driver = fakeDriver(options.device);
  const states: SimulatorViewState[] = [];
  const frames: { udid: string; jpeg: Buffer }[] = [];
  const view = new SimulatorLiveView(
    driver as unknown as SimulatorDriver,
    { state: state => states.push(state), frame: (udid, jpeg) => frames.push({ udid, jpeg }) },
    { available: options.available ?? true, spawnStream: options.spawnStream, run: options.run }
  );
  return { view, driver, states, frames };
}

describe('SimulatorLiveView', () => {
  const views: SimulatorLiveView[] = [];
  const make = (options: Parameters<typeof setup>[0] = {}) => {
    const made = setup(options);
    views.push(made.view);
    return made;
  };
  afterEach(() => {
    for (const view of views.splice(0)) view.dispose();
  });

  it('starts idle with the availability it was given', () => {
    expect(make({ available: true }).view.current()).toMatchObject({ status: 'idle', available: true });
    expect(make({ available: false }).view.current()).toMatchObject({ status: 'idle', available: false });
  });

  it('shows a first frame from a screenshot, then goes live on the stream', async () => {
    const child = fakeChild();
    const { view, driver, states, frames } = make({ spawnStream: async () => child as unknown as ChildProcess });
    await view.attach(UDID);

    expect(driver.boot).not.toHaveBeenCalled();
    expect(states[0]).toMatchObject({ status: 'starting', device: DEVICE, screen: null });
    expect(states[1]).toMatchObject({ status: 'starting', screen: { width: 402, height: 874 } });
    expect(frames).toEqual([{ udid: UDID, jpeg: PNG }]);
    expect(view.attachedUdid()).toBe(UDID);

    child.stdout.emit('data', mjpegPart(JPEG));
    expect(view.current()).toMatchObject({ status: 'live', source: 'stream' });
    expect(frames).toHaveLength(2);
    expect(frames[1]).toEqual({ udid: UDID, jpeg: JPEG });
  });

  it('boots a shut-down device first', async () => {
    const { view, driver } = make({
      device: { ...DEVICE, state: 'Shutdown' },
      spawnStream: async () => fakeChild() as unknown as ChildProcess,
    });
    await view.attach(UDID);
    expect(driver.boot).toHaveBeenCalledWith(UDID);
  });

  it('reports a landscape screenshot as a portrait screen size', async () => {
    const { view, driver } = make({ spawnStream: async () => fakeChild() as unknown as ChildProcess });
    driver.screenshot.mockResolvedValue({ png: PNG, screen: { width: 874, height: 402, scale: 3 } });
    await view.attach(UDID);
    expect(view.current().screen).toEqual({ width: 402, height: 874 });
  });

  it('falls back to snapshots when the stream cannot start', async () => {
    const run: Runner = async (_file, args) => {
      await writeFile(String(args[args.length - 1]), JPEG);
      return { stdout: '', stderr: '' };
    };
    const { view, frames } = make({
      spawnStream: async () => {
        throw new Error('spawn axe ENOENT');
      },
      run,
    });
    await view.attach(UDID);
    expect(view.current()).toMatchObject({ status: 'live', source: 'snapshots' });
    expect(view.current().message).toContain('brew install cameroncooke/axe/axe');
    await vi.waitFor(() => expect(frames.some(frame => frame.jpeg.equals(JPEG))).toBe(true));
  });

  it('falls back to snapshots when the child errors', async () => {
    const child = fakeChild();
    const run: Runner = () => new Promise(() => undefined);
    const { view } = make({ spawnStream: async () => child as unknown as ChildProcess, run });
    await view.attach(UDID);
    child.emit('error', new Error('ENOENT'));
    expect(view.current()).toMatchObject({ status: 'live', source: 'snapshots' });
  });

  it('is a no-op to attach the device already shown', async () => {
    const { view, driver } = make({ spawnStream: async () => fakeChild() as unknown as ChildProcess });
    await view.attach(UDID);
    await view.attach(UDID);
    expect(driver.screenshot).toHaveBeenCalledTimes(1);
  });

  it('detaches to idle and stops the stream', async () => {
    const child = fakeChild();
    const { view } = make({ spawnStream: async () => child as unknown as ChildProcess });
    await view.attach(UDID);
    view.detach();
    expect(child.kill).toHaveBeenCalled();
    expect(view.current()).toMatchObject({ status: 'idle', device: null, screen: null, source: null });
    expect(view.attachedUdid()).toBeUndefined();
  });

  it('ignores frames from a stream that was detached', async () => {
    const child = fakeChild();
    const { view, frames } = make({ spawnStream: async () => child as unknown as ChildProcess });
    await view.attach(UDID);
    view.detach();
    const before = frames.length;
    child.stdout.emit('data', mjpegPart(JPEG));
    expect(frames).toHaveLength(before);
    expect(view.current().status).toBe('idle');
  });

  it('refuses to attach when the simulator is not available', async () => {
    const { view } = make({ available: false });
    await expect(view.attach(UDID)).rejects.toThrow(/only available on macOS/);
  });

  it('refuses an unknown device', async () => {
    const { view } = make();
    await expect(view.attach('NOPE')).rejects.toThrow(/No available simulator has the id NOPE/);
  });

  it('goes to error when the first screenshot fails, and rethrows', async () => {
    const { view, driver } = make();
    driver.screenshot.mockRejectedValue(new Error('simctl died'));
    await expect(view.attach(UDID)).rejects.toThrow('simctl died');
    expect(view.current()).toMatchObject({ status: 'error', message: 'simctl died' });
  });

  describe('input', () => {
    it('throws without an attached device', async () => {
      const { view } = make();
      await expect(view.input({ kind: 'tap', x: 1, y: 2 })).rejects.toThrow(/No simulator is attached/);
    });

    it('drives the attached device', async () => {
      const { view, driver } = make({ spawnStream: async () => fakeChild() as unknown as ChildProcess });
      await view.attach(UDID);
      await view.input({ kind: 'tap', x: 1, y: 2 });
      await view.input({ kind: 'swipe', from: { x: 1, y: 2 }, to: { x: 3, y: 4 }, duration: 0.5 });
      await view.input({ kind: 'button', button: 'home' });
      await view.input({ kind: 'appearance', mode: 'dark' });
      await view.input({ kind: 'type', text: 'hi' });
      expect(driver.tap).toHaveBeenCalledWith(UDID, 1, 2);
      expect(driver.swipe).toHaveBeenCalledWith(UDID, { x: 1, y: 2 }, { x: 3, y: 4 }, 0.5);
      expect(driver.button).toHaveBeenCalledWith(UDID, 'home');
      expect(driver.setAppearance).toHaveBeenCalledWith(UDID, 'dark');
      expect(driver.type).toHaveBeenCalledWith(UDID, 'hi');
    });
  });
});

describe('parsePaneInput', () => {
  it('accepts every valid shape', () => {
    expect(parsePaneInput({ kind: 'tap', x: 1, y: 2 })).toEqual({ kind: 'tap', x: 1, y: 2 });
    expect(parsePaneInput({ kind: 'swipe', from: { x: 1, y: 2 }, to: { x: 3, y: 4 }, duration: 0.5 })).toEqual({
      kind: 'swipe',
      from: { x: 1, y: 2 },
      to: { x: 3, y: 4 },
      duration: 0.5,
    });
    expect(parsePaneInput({ kind: 'button', button: 'lock' })).toEqual({ kind: 'button', button: 'lock' });
    expect(parsePaneInput({ kind: 'appearance', mode: 'light' })).toEqual({ kind: 'appearance', mode: 'light' });
    expect(parsePaneInput({ kind: 'type', text: 'hello' })).toEqual({ kind: 'type', text: 'hello' });
  });

  it('clamps a swipe duration into 0.05 to 5 seconds', () => {
    const swipe = (duration: number) =>
      parsePaneInput({ kind: 'swipe', from: { x: 0, y: 0 }, to: { x: 1, y: 1 }, duration });
    expect(swipe(0)).toMatchObject({ duration: 0.05 });
    expect(swipe(60)).toMatchObject({ duration: 5 });
  });

  it('rejects junk', () => {
    expect(parsePaneInput(null)).toBeNull();
    expect(parsePaneInput('tap')).toBeNull();
    expect(parsePaneInput({})).toBeNull();
    expect(parsePaneInput({ kind: 'explode' })).toBeNull();
    expect(parsePaneInput({ kind: 'tap', x: Number.NaN, y: 2 })).toBeNull();
    expect(parsePaneInput({ kind: 'tap', x: 1, y: Infinity })).toBeNull();
    expect(parsePaneInput({ kind: 'tap', x: '1', y: 2 })).toBeNull();
    expect(parsePaneInput({ kind: 'swipe', from: { x: 1, y: 2 }, to: { x: 1 }, duration: 1 })).toBeNull();
    expect(parsePaneInput({ kind: 'swipe', from: { x: 1, y: 2 }, to: { x: 3, y: 4 } })).toBeNull();
    expect(parsePaneInput({ kind: 'button', button: 'siri' })).toBeNull();
    expect(parsePaneInput({ kind: 'appearance', mode: 'sepia' })).toBeNull();
    expect(parsePaneInput({ kind: 'type', text: '' })).toBeNull();
    expect(parsePaneInput({ kind: 'type', text: 'x'.repeat(1001) })).toBeNull();
  });
});

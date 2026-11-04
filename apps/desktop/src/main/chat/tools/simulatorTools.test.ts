import { mkdirSync, mkdtempSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ChatMedia } from '@shared/chat';
import { SimulatorSetupError } from '../simulator/toolchain';
import { PathAccessDenied } from './paths';
import {
  resolveSimulatorDevice,
  simulatorAppearance,
  simulatorBuild,
  simulatorInput,
  simulatorLaunch,
  simulatorOpenUrl,
  simulatorScreenshot,
  simulatorView,
} from './simulatorTools';
import type { SimulatorContext, SimulatorDevice, SimulatorDriver, ToolContext, ToolReporter } from './types';

const PHONE_A: SimulatorDevice = { udid: 'AAAA-1111', name: 'iPhone 17', runtime: 'iOS 27.0', state: 'Booted' };
const PHONE_B: SimulatorDevice = { udid: 'BBBB-2222', name: 'iPhone 17', runtime: 'iOS 26.0', state: 'Shutdown' };
const PAD: SimulatorDevice = { udid: 'CCCC-3333', name: 'iPad Pro', runtime: 'iOS 27.0', state: 'Shutdown' };
const PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3]);

function fakeDriver(): { [K in keyof SimulatorDriver]: ReturnType<typeof vi.fn> } {
  return {
    devices: vi.fn(async () => ({ devices: [PHONE_A, PAD], runtimes: ['iOS 27.0'] })),
    boot: vi.fn(async () => undefined),
    build: vi.fn(async () => ({ appPath: '/build/Foo.app', log: '' })),
    install: vi.fn(async () => 'com.example.foo'),
    launch: vi.fn(async () => undefined),
    screenshot: vi.fn(async () => ({ png: PNG, screen: { width: 402, height: 874, scale: 3 } })),
    tap: vi.fn(async () => undefined),
    swipe: vi.fn(async () => undefined),
    type: vi.fn(async () => undefined),
    key: vi.fn(async () => undefined),
    button: vi.fn(async () => undefined),
    openUrl: vi.fn(async () => undefined),
    appearance: vi.fn(async () => 'light'),
    setAppearance: vi.fn(async () => undefined),
    rotate: vi.fn(async () => undefined),
  };
}

function setup(options: { attached?: string; roots?: string[]; vision?: boolean } = {}) {
  const driver = fakeDriver();
  const kept: ChatMedia = { kind: 'image', url: 'media://sim.png', mimeType: 'image/png', byteLength: 3, caption: 'c' };
  const keepScreenshot = vi.fn(async () => kept);
  const attach = vi.fn(async () => undefined);
  const detach = vi.fn();
  const simulator: SimulatorContext = {
    driver: driver as unknown as SimulatorDriver,
    keepScreenshot,
    attached: () => options.attached,
    attach,
    detach,
  };
  const images: { bytes: Buffer; mimeType: string }[] = [];
  const media: ChatMedia[] = [];
  const labels: string[] = [];
  const report = {
    image: (bytes: Buffer, mimeType: string) => images.push({ bytes, mimeType }),
    media: (item: ChatMedia) => media.push(item),
    label: (text: string) => labels.push(text),
    progress: () => undefined,
  } as unknown as ToolReporter;
  const context: ToolContext = {
    roots: options.roots ?? [],
    signal: new AbortController().signal,
    simulator,
    images: {
      vision: options.vision ?? true,
      prepare: bytes => ({
        bytes,
        mediaType: 'image/png',
        width: 402,
        height: 874,
        sourceWidth: 402,
        sourceHeight: 874,
      }),
    },
    report,
  };
  return { context, driver, simulator, keepScreenshot, attach, detach, images, media, labels, kept };
}

describe('resolveSimulatorDevice', () => {
  const resolve = (
    devices: SimulatorDevice[],
    requested: string | undefined,
    attached?: string,
    runtimes = ['iOS 27.0']
  ) => {
    const { simulator, driver } = setup({ attached });
    driver.devices.mockResolvedValue({ devices, runtimes });
    return resolveSimulatorDevice(simulator, requested);
  };

  it('finds a device by UDID, ignoring case', async () => {
    await expect(resolve([PHONE_A, PAD], 'cccc-3333')).resolves.toBe(PAD);
  });

  it('finds a device by name, ignoring case', async () => {
    await expect(resolve([PHONE_A, PAD], 'IPAD pro')).resolves.toBe(PAD);
  });

  it('picks the single booted device when two share a name', async () => {
    await expect(resolve([PHONE_B, PHONE_A], 'iphone 17')).resolves.toBe(PHONE_A);
  });

  it('lists the UDIDs of every device sharing a name when none or several are booted', async () => {
    const error = await resolve([PHONE_B, { ...PHONE_A, state: 'Shutdown' }], 'iPhone 17').catch((e: unknown) => e);
    expect(error).toBeInstanceOf(Error);
    expect((error as Error).message).toMatch(/2 simulators are named "iPhone 17"/);
    expect((error as Error).message).toContain('AAAA-1111');
    expect((error as Error).message).toContain('BBBB-2222');
  });

  it('lists what is available when nothing matches', async () => {
    await expect(resolve([PHONE_A, PAD], 'Watch')).rejects.toThrow(/No simulator matches "Watch"[\s\S]*iPad Pro/);
  });

  it('defaults to the device in the live view', async () => {
    await expect(resolve([PHONE_A, PAD], undefined, 'CCCC-3333')).resolves.toBe(PAD);
  });

  it('defaults to the only booted device', async () => {
    await expect(resolve([PHONE_A, PAD], undefined)).resolves.toBe(PHONE_A);
  });

  it('points at simulator_boot when none is booted', async () => {
    await expect(resolve([PHONE_B, PAD], undefined)).rejects.toThrow(/simulator_boot[\s\S]*BBBB-2222/);
  });

  it('refuses to guess among several booted devices', async () => {
    const booted = { ...PAD, state: 'Booted' };
    await expect(resolve([PHONE_A, booted], undefined)).rejects.toThrow(/2 simulators are booted[\s\S]*CCCC-3333/);
  });

  it('is a setup error when there are no devices and no runtime', async () => {
    await expect(resolve([], undefined, undefined, [])).rejects.toBeInstanceOf(SimulatorSetupError);
  });

  it('says to add a device when a runtime exists but no devices do', async () => {
    const error = await resolve([], undefined).catch((e: unknown) => e);
    expect(error).not.toBeInstanceOf(SimulatorSetupError);
    expect((error as Error).message).toMatch(/No iOS simulator devices exist/);
  });
});

describe('device approval', () => {
  it('keys every device action on the same per-device key, asking in auto mode too', async () => {
    const { context } = setup();
    const prompts = await Promise.all([
      simulatorScreenshot.approval?.({}, context),
      simulatorInput.approval?.({ action: 'tap', x: 1, y: 2 }, context),
      simulatorLaunch.approval?.({ bundle_id: 'com.example.foo' }, context),
    ]);
    for (const prompt of prompts) {
      expect(prompt).toMatchObject({ key: 'simulator\x00AAAA-1111', askInAuto: true });
    }
  });

  it('uses a different key for another device', async () => {
    const { context } = setup();
    const prompt = await simulatorScreenshot.approval?.({ device: 'iPad Pro' }, context);
    expect(prompt).toMatchObject({ key: 'simulator\x00CCCC-3333', askInAuto: true });
    expect(prompt?.detail).toContain('iPad Pro');
  });

  it('refuses to run when the approved key names a different device', async () => {
    const { context, driver } = setup();
    const approved: ToolContext = { ...context, approvedKey: 'simulator\x00CCCC-3333' };
    await expect(simulatorScreenshot.run({}, approved)).rejects.toThrow(/changed after the user approved/);
    expect(driver.screenshot).not.toHaveBeenCalled();
    const same: ToolContext = { ...context, approvedKey: 'simulator\x00AAAA-1111' };
    await expect(simulatorScreenshot.run({}, same)).resolves.toMatch(/Captured/);
  });

  it('refuses when the simulator context is absent', async () => {
    const { context } = setup();
    const bare: ToolContext = { ...context, simulator: undefined };
    await expect(simulatorScreenshot.run({}, bare)).rejects.toThrow(/only available in the macOS app/);
  });
});

describe('simulator_screenshot', () => {
  it('keeps the shot for the user, shows it to the model and states the size in points', async () => {
    const { context, keepScreenshot, media, images, kept } = setup();
    const result = await simulatorScreenshot.run({ caption: 'Home screen' }, context);
    expect(keepScreenshot).toHaveBeenCalledWith(PNG, 'Home screen');
    expect(media).toEqual([kept]);
    expect(images).toEqual([{ bytes: PNG, mimeType: 'image/png' }]);
    expect(result).toContain('402x874 points');
  });

  it('defaults the caption to the device and says so when the model cannot see images', async () => {
    const { context, keepScreenshot, images, media } = setup({ vision: false });
    const result = await simulatorScreenshot.run({}, context);
    expect(keepScreenshot).toHaveBeenCalledWith(PNG, 'iPhone 17 (iOS 27.0)');
    expect(images).toEqual([]);
    expect(media).toHaveLength(1);
    expect(result).toMatch(/402x874 points\) and showed it to the user, but not to you/);
  });
});

describe('simulator_input', () => {
  it('taps with the optional duration', async () => {
    const { context, driver } = setup();
    await simulatorInput.run({ action: 'tap', x: 10, y: 20, duration: 1 }, context);
    expect(driver.tap).toHaveBeenCalledWith('AAAA-1111', 10, 20, 1);
  });

  it('swipes from one point to another', async () => {
    const { context, driver } = setup();
    await simulatorInput.run({ action: 'swipe', x: 1, y: 2, x2: 3, y2: 4 }, context);
    expect(driver.swipe).toHaveBeenCalledWith('AAAA-1111', { x: 1, y: 2 }, { x: 3, y: 4 }, undefined);
  });

  it('types text', async () => {
    const { context, driver } = setup();
    const result = await simulatorInput.run({ action: 'type', text: 'hello' }, context);
    expect(driver.type).toHaveBeenCalledWith('AAAA-1111', 'hello');
    expect(result).toContain('5 character(s)');
  });

  it('presses a key and a button', async () => {
    const { context, driver } = setup();
    await simulatorInput.run({ action: 'key', key: 'return' }, context);
    await simulatorInput.run({ action: 'button', button: 'home', duration: 2 }, context);
    expect(driver.key).toHaveBeenCalledWith('AAAA-1111', 'return');
    expect(driver.button).toHaveBeenCalledWith('AAAA-1111', 'home', 2);
  });

  it('rejects an unknown action, key and button without touching the device', async () => {
    const { context, driver } = setup();
    await expect(simulatorInput.run({ action: 'pinch' }, context)).rejects.toThrow(/"action" must be one of/);
    await expect(simulatorInput.run({ action: 'key', key: 'f13' }, context)).rejects.toThrow(/"key" must be one of/);
    await expect(simulatorInput.run({ action: 'button', button: 'power' }, context)).rejects.toThrow(
      /"button" must be one of/
    );
    expect(driver.key).not.toHaveBeenCalled();
    expect(driver.button).not.toHaveBeenCalled();
  });

  it('requires numeric coordinates', async () => {
    const { context, driver } = setup();
    await expect(simulatorInput.run({ action: 'tap', x: 1 }, context)).rejects.toThrow(/"y" argument is required/);
    expect(driver.tap).not.toHaveBeenCalled();
  });
});

describe('simulator_appearance', () => {
  it('needs approval only when it switches the mode', async () => {
    const { context } = setup();
    expect(await simulatorAppearance.needsApproval?.({}, context)).toBe(false);
    expect(await simulatorAppearance.needsApproval?.({ mode: 'dark' }, context)).toBe(true);
  });

  it('reads and sets the mode', async () => {
    const { context, driver } = setup();
    await expect(simulatorAppearance.run({}, context)).resolves.toMatch(/is in light mode/);
    await expect(simulatorAppearance.run({ mode: 'dark' }, context)).resolves.toMatch(/now in dark mode/);
    expect(driver.setAppearance).toHaveBeenCalledWith('AAAA-1111', 'dark');
    await expect(simulatorAppearance.run({ mode: 'sepia' }, context)).rejects.toThrow(/"mode" must be one of/);
  });
});

describe('simulator_open_url', () => {
  it('opens a URL with a scheme', async () => {
    const { context, driver } = setup();
    await simulatorOpenUrl.run({ url: 'myapp://home' }, context);
    expect(driver.openUrl).toHaveBeenCalledWith('AAAA-1111', 'myapp://home');
  });

  it('rejects a URL with no scheme', async () => {
    const { context, driver } = setup();
    await expect(simulatorOpenUrl.run({ url: 'example.com/path' }, context)).rejects.toThrow(/needs a scheme/);
    expect(driver.openUrl).not.toHaveBeenCalled();
  });
});

describe('simulator_build', () => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'b4m-sim-tools-')));
  const outside = realpathSync(mkdtempSync(join(tmpdir(), 'b4m-sim-outside-')));
  const project = join(root, 'Foo.xcodeproj');
  mkdirSync(project);
  mkdirSync(join(outside, 'Bar.xcodeproj'));
  afterAll(() => {
    rmSync(root, { recursive: true, force: true });
    rmSync(outside, { recursive: true, force: true });
  });

  it('refuses a project outside the shared roots', async () => {
    const { context, driver } = setup({ roots: [root] });
    const input = { project: join(outside, 'Bar.xcodeproj'), scheme: 'Bar' };
    await expect(simulatorBuild.run(input, context)).rejects.toBeInstanceOf(PathAccessDenied);
    await expect(Promise.resolve(simulatorBuild.approval?.(input, context))).rejects.toBeInstanceOf(PathAccessDenied);
    expect(driver.build).not.toHaveBeenCalled();
  });

  it('refuses a path that is not an Xcode project or workspace', async () => {
    const { context } = setup({ roots: [root] });
    await expect(simulatorBuild.run({ project: join(root, 'src'), scheme: 'Foo' }, context)).rejects.toThrow(
      /must be a \.xcodeproj or \.xcworkspace/
    );
  });

  it('builds a project inside the root for the resolved device', async () => {
    const { context, driver } = setup({ roots: [root] });
    const result = await simulatorBuild.run({ project, scheme: 'Foo', configuration: 'Release' }, context);
    expect(driver.build).toHaveBeenCalledWith(
      { container: project, scheme: 'Foo', udid: 'AAAA-1111', configuration: 'Release' },
      context.signal
    );
    expect(result).toContain('/build/Foo.app');
  });

  it('omits the configuration when none is given, and keys approval per project and scheme', async () => {
    const { context, driver } = setup({ roots: [root] });
    await simulatorBuild.run({ project: `${project}/`, scheme: 'Foo' }, context);
    expect(driver.build.mock.calls[0][0]).toEqual({ container: project, scheme: 'Foo', udid: 'AAAA-1111' });
    const prompt = await simulatorBuild.approval?.({ project, scheme: 'Foo' }, context);
    expect(prompt).toMatchObject({ key: `simulator_build\x00${project}\x00Foo`, askInAuto: true });
  });
});

describe('simulator_view', () => {
  let state: ReturnType<typeof setup>;
  beforeEach(() => {
    state = setup();
  });

  it('attaches the live view to the resolved device', async () => {
    await simulatorView.run({ action: 'attach', device: 'iPad Pro' }, state.context);
    expect(state.attach).toHaveBeenCalledWith('CCCC-3333');
  });

  it('detaches', async () => {
    await simulatorView.run({ action: 'detach' }, state.context);
    expect(state.detach).toHaveBeenCalledTimes(1);
    expect(state.attach).not.toHaveBeenCalled();
  });

  it('rejects an unknown action', async () => {
    await expect(simulatorView.run({ action: 'peek' }, state.context)).rejects.toThrow(/"action" must be one of/);
  });
});

describe('simulator_launch', () => {
  it('installs the app, then launches the bundle id the install returned', async () => {
    const { context, driver } = setup();
    const result = await simulatorLaunch.run({ app_path: '/build/Foo.app' }, context);
    expect(driver.install).toHaveBeenCalledWith('AAAA-1111', '/build/Foo.app');
    expect(driver.launch).toHaveBeenCalledWith('AAAA-1111', 'com.example.foo');
    expect(driver.install.mock.invocationCallOrder[0]).toBeLessThan(driver.launch.mock.invocationCallOrder[0]);
    expect(result).toContain('Launched com.example.foo');
  });

  it('launches an installed app by bundle id without installing', async () => {
    const { context, driver } = setup();
    await simulatorLaunch.run({ bundle_id: 'com.example.other' }, context);
    expect(driver.install).not.toHaveBeenCalled();
    expect(driver.launch).toHaveBeenCalledWith('AAAA-1111', 'com.example.other');
  });

  it('needs one of app_path or bundle_id', async () => {
    const { context } = setup();
    await expect(simulatorLaunch.run({}, context)).rejects.toThrow(/Pass app_path/);
  });

  it('tells the model the user sees it when the device is in the live view', async () => {
    const { context } = setup({ attached: 'AAAA-1111' });
    await expect(simulatorLaunch.run({ bundle_id: 'x.y' }, context)).resolves.toMatch(/live view/);
  });
});

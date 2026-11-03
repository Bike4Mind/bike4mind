import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import type {
  SimulatorBuildRequest,
  SimulatorButton,
  SimulatorDevice,
  SimulatorDriver,
  SimulatorKey,
  SimulatorScreen,
} from '../tools/types';
import {
  explainToolchainFailure,
  runToolchain,
  SimulatorSetupError,
  ToolchainCommandError,
  type RunOptions,
  type Runner,
} from './toolchain';

const BOOT_TIMEOUT_MS = 180_000;
const BUILD_TIMEOUT_MS = 20 * 60_000;
const BUILD_LOG_TAIL_CHARS = 4_000;

/** USB HID usage ids, which is what `axe key` takes. */
const HID_KEYCODES: Record<SimulatorKey, number> = {
  return: 40,
  escape: 41,
  delete: 42,
  tab: 43,
  space: 44,
  right: 79,
  left: 80,
  down: 81,
  up: 82,
};

/** "com.apple.CoreSimulator.SimRuntime.iOS-27-0" -> "iOS 27.0". */
export function runtimeName(identifier: string): string {
  const match = /SimRuntime\.([A-Za-z]+)-(\d+(?:-\d+)*)$/.exec(identifier);
  return match ? `${match[1]} ${match[2].replace(/-/g, '.')}` : identifier;
}

/** Devices on iOS runtimes, from `simctl list devices available -j`. */
export function parseDevices(json: string): SimulatorDevice[] {
  const parsed: unknown = JSON.parse(json);
  if (!isRecord(parsed) || !isRecord(parsed.devices)) return [];
  const devices: SimulatorDevice[] = [];
  for (const [runtime, list] of Object.entries(parsed.devices)) {
    if (!/SimRuntime\.iOS-/.test(runtime) || !Array.isArray(list)) continue;
    for (const entry of list) {
      if (!isRecord(entry) || typeof entry.udid !== 'string' || typeof entry.name !== 'string') continue;
      if (entry.isAvailable === false) continue;
      devices.push({
        udid: entry.udid,
        name: entry.name,
        runtime: runtimeName(runtime),
        state: typeof entry.state === 'string' ? entry.state : 'Unknown',
      });
    }
  }
  return devices;
}

export function parseRuntimes(json: string): string[] {
  const parsed: unknown = JSON.parse(json);
  if (!isRecord(parsed) || !Array.isArray(parsed.runtimes)) return [];
  return parsed.runtimes
    .filter(isRecord)
    .filter(runtime => runtime.platform === 'iOS' || /SimRuntime\.iOS-/.test(String(runtime.identifier)))
    .filter(runtime => runtime.isAvailable !== false)
    .map(runtime => String(runtime.name));
}

/** Width and height from a PNG's IHDR chunk. */
export function pngSize(png: Buffer): { width: number; height: number } {
  if (png.length < 24 || png.readUInt32BE(12) !== 0x49484452)
    throw new Error('simctl wrote a screenshot that is not a PNG.');
  return { width: png.readUInt32BE(16), height: png.readUInt32BE(20) };
}

/**
 * Points from pixels. Every phone a current iOS runtime supports with a tall (>= 2:1) screen is
 * 3x, and the iPhone SE and every iPad are 2x; simctl reports no scale, and asking AXe for the
 * accessibility frame takes seconds.
 */
export function screenFromPixels(width: number, height: number): SimulatorScreen {
  const aspect = Math.max(width, height) / Math.min(width, height);
  const scale = aspect >= 2 ? 3 : 2;
  return { width: Math.round(width / scale), height: Math.round(height / scale), scale };
}

/** The script for Simulator.app's Device > Rotate menu, on the window showing this device. */
export function rotateScript(device: SimulatorDevice, direction: 'left' | 'right'): string {
  const quote = (text: string) => `"${text.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`;
  const version = device.runtime.replace(/^iOS /, '');
  return [
    'tell application "Simulator" to activate',
    'delay 0.5',
    'tell application "System Events" to tell process "Simulator"',
    '  set target to missing value',
    '  repeat with candidate in windows',
    `    if name of candidate contains ${quote(device.name)} and name of candidate contains ${quote(version)} then set target to candidate`,
    '  end repeat',
    `  if target is missing value then set target to first window whose name contains ${quote(device.name)}`,
    '  perform action "AXRaise" of target',
    `  click menu item ${quote(direction === 'left' ? 'Rotate Left' : 'Rotate Right')} of menu "Device" of menu bar 1`,
    'end tell',
  ].join('\n');
}

export class XcodeSimulatorDriver implements SimulatorDriver {
  constructor(private readonly run: Runner = runToolchain) {}

  async devices(): Promise<{ devices: SimulatorDevice[]; runtimes: string[] }> {
    const [devices, runtimes] = await Promise.all([
      this.xcrun(['simctl', 'list', 'devices', 'available', '-j']),
      this.xcrun(['simctl', 'list', 'runtimes', 'available', '-j']),
    ]);
    return { devices: parseDevices(devices.stdout), runtimes: parseRuntimes(runtimes.stdout) };
  }

  async boot(udid: string): Promise<void> {
    try {
      await this.xcrun(['simctl', 'boot', udid]);
    } catch (error) {
      // Booting a booted device is the state we want, not a failure.
      if (!(error instanceof ToolchainCommandError && /current state: Booted/i.test(error.stderr))) throw error;
    }
    await this.xcrun(['simctl', 'bootstatus', udid, '-b'], { timeoutMs: BOOT_TIMEOUT_MS });
  }

  async build(request: SimulatorBuildRequest, signal: AbortSignal): Promise<{ appPath: string; log: string }> {
    const containerFlag = request.container.endsWith('.xcworkspace') ? '-workspace' : '-project';
    const args = [
      containerFlag,
      request.container,
      '-scheme',
      request.scheme,
      '-configuration',
      request.configuration ?? 'Debug',
      '-destination',
      `id=${request.udid}`,
    ];
    const options: RunOptions = {
      cwd: dirname(request.container),
      signal,
      timeoutMs: BUILD_TIMEOUT_MS,
      maxBuffer: 64 * 1024 * 1024,
    };
    let log: string;
    try {
      log = (await this.xcrun(['xcodebuild', ...args, 'build'], options)).stdout;
    } catch (error) {
      if (error instanceof ToolchainCommandError) {
        const errors = error.stdout
          .split('\n')
          .filter(line => /\berror:/.test(line))
          .slice(0, 30);
        throw new Error(
          ['xcodebuild failed.', ...(errors.length ? errors : [error.stdout.slice(-BUILD_LOG_TAIL_CHARS)])].join('\n')
        );
      }
      throw error;
    }
    const settings = await this.xcrun(['xcodebuild', ...args, '-showBuildSettings', '-json'], options);
    return { appPath: builtAppPath(settings.stdout), log: log.slice(-BUILD_LOG_TAIL_CHARS) };
  }

  async install(udid: string, appPath: string): Promise<string> {
    const info = await this.run('plutil', [
      '-extract',
      'CFBundleIdentifier',
      'raw',
      '-o',
      '-',
      join(appPath, 'Info.plist'),
    ]);
    const bundleId = info.stdout.trim();
    if (!bundleId) throw new Error(`${appPath} has no CFBundleIdentifier; is it an .app bundle?`);
    await this.xcrun(['simctl', 'install', udid, appPath], { timeoutMs: 120_000 });
    return bundleId;
  }

  async launch(udid: string, bundleId: string): Promise<void> {
    await this.xcrun(['simctl', 'launch', '--terminate-running-process', udid, bundleId]);
  }

  async screenshot(udid: string): Promise<{ png: Buffer; screen: SimulatorScreen }> {
    const folder = await mkdtemp(join(tmpdir(), 'b4m-sim-'));
    try {
      const raw = join(folder, 'raw.png');
      await this.xcrun(['simctl', 'io', udid, 'screenshot', '--type=png', raw]);
      const pixels = pngSize(await readFile(raw));
      const screen = screenFromPixels(pixels.width, pixels.height);
      const scaled = join(folder, 'points.png');
      await this.run('sips', [
        '--resampleHeightWidth',
        String(screen.height),
        String(screen.width),
        raw,
        '--out',
        scaled,
      ]);
      return { png: await readFile(scaled), screen };
    } finally {
      await rm(folder, { recursive: true, force: true });
    }
  }

  async tap(udid: string, x: number, y: number, duration?: number): Promise<void> {
    if (duration && duration > 0) {
      await this.axe([
        'touch',
        '-x',
        coordinate(x),
        '-y',
        coordinate(y),
        '--down',
        '--up',
        '--delay',
        String(duration),
        '--udid',
        udid,
      ]);
      return;
    }
    await this.axe(['tap', '-x', coordinate(x), '-y', coordinate(y), '--udid', udid]);
  }

  async swipe(
    udid: string,
    from: { x: number; y: number },
    to: { x: number; y: number },
    duration?: number
  ): Promise<void> {
    await this.axe([
      'swipe',
      '--start-x',
      coordinate(from.x),
      '--start-y',
      coordinate(from.y),
      '--end-x',
      coordinate(to.x),
      '--end-y',
      coordinate(to.y),
      ...(duration ? ['--duration', String(duration)] : []),
      '--udid',
      udid,
    ]);
  }

  async type(udid: string, text: string): Promise<void> {
    // `--` so text that starts with a dash is typed rather than read as a flag.
    await this.axe(['type', '--udid', udid, '--', text]);
  }

  async key(udid: string, key: SimulatorKey): Promise<void> {
    await this.axe(['key', String(HID_KEYCODES[key]), '--udid', udid]);
  }

  async button(udid: string, button: SimulatorButton, duration?: number): Promise<void> {
    await this.axe(['button', button, ...(duration ? ['--duration', String(duration)] : []), '--udid', udid]);
  }

  async openUrl(udid: string, url: string): Promise<void> {
    await this.xcrun(['simctl', 'openurl', udid, url]);
  }

  async appearance(udid: string): Promise<string> {
    return (await this.xcrun(['simctl', 'ui', udid, 'appearance'])).stdout.trim();
  }

  async setAppearance(udid: string, mode: 'light' | 'dark'): Promise<void> {
    await this.xcrun(['simctl', 'ui', udid, 'appearance', mode]);
  }

  async rotate(udid: string, direction: 'left' | 'right'): Promise<void> {
    const device = (await this.devices()).devices.find(candidate => candidate.udid === udid);
    if (!device) throw new Error(`No simulator has the id ${udid}.`);
    // simctl and AXe have no rotation, so this drives Simulator.app's menu, which needs it open on the device.
    await this.run('open', ['-a', 'Simulator', '--args', '-CurrentDeviceUDID', udid]);
    try {
      await this.run('osascript', ['-e', rotateScript(device, direction)], { timeoutMs: 15_000 });
    } catch (error) {
      if (error instanceof ToolchainCommandError && /assistive access|-1719|-25211/i.test(error.stderr)) {
        throw new SimulatorSetupError(
          'Rotating drives Simulator.app through its menu, and macOS has not allowed this app to control other apps.',
          'turn on Bike4Mind in System Settings > Privacy & Security > Accessibility, then try again.'
        );
      }
      if (error instanceof ToolchainCommandError && /-1743|not authorized to send apple events/i.test(error.stderr)) {
        throw new SimulatorSetupError(
          'macOS has not allowed this app to send events to System Events, which rotating needs.',
          'turn on System Events under Bike4Mind in System Settings > Privacy & Security > Automation, then try again.'
        );
      }
      throw error;
    }
  }

  private async xcrun(args: readonly string[], options?: RunOptions) {
    try {
      return await this.run('xcrun', args, options);
    } catch (error) {
      return explainToolchainFailure(error);
    }
  }

  private async axe(args: readonly string[]) {
    try {
      return await this.run('axe', args, { timeoutMs: 30_000 });
    } catch (error) {
      return explainToolchainFailure(error);
    }
  }
}

/** The application product among a scheme's targets, from `-showBuildSettings -json`. */
export function builtAppPath(json: string): string {
  const parsed: unknown = JSON.parse(json);
  const entries = Array.isArray(parsed) ? parsed.filter(isRecord) : [];
  for (const entry of entries) {
    const settings = entry.buildSettings;
    if (!isRecord(settings)) continue;
    if (settings.WRAPPER_EXTENSION !== 'app') continue;
    if (typeof settings.TARGET_BUILD_DIR === 'string' && typeof settings.WRAPPER_NAME === 'string') {
      return join(settings.TARGET_BUILD_DIR, settings.WRAPPER_NAME);
    }
  }
  throw new Error('The build succeeded but the scheme builds no .app. Pick the scheme of an iOS app target.');
}

function coordinate(value: number): string {
  return String(Math.round(value * 10) / 10);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

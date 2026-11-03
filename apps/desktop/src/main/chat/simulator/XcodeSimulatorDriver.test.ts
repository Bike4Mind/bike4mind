import { describe, expect, it, vi } from 'vitest';
import type { SimulatorDevice } from '../tools/types';
import {
  XcodeSimulatorDriver,
  builtAppPath,
  parseDevices,
  parseRuntimes,
  pngSize,
  rotateScript,
  runtimeName,
  screenFromPixels,
} from './XcodeSimulatorDriver';
import { SimulatorSetupError, ToolchainCommandError, type Runner } from './toolchain';

const UDID = 'AAAA-1111';

function fakeRunner(impl?: Runner) {
  const run = vi.fn<Runner>(impl ?? (async () => ({ stdout: '', stderr: '' })));
  return { run, driver: new XcodeSimulatorDriver(run) };
}

const callsOf = (run: ReturnType<typeof fakeRunner>['run']) => run.mock.calls.map(([file, args]) => [file, [...args]]);

describe('parseDevices', () => {
  it('keeps only available devices on iOS runtimes', () => {
    const json = JSON.stringify({
      devices: {
        'com.apple.CoreSimulator.SimRuntime.iOS-27-0': [
          { udid: 'U1', name: 'iPhone 17', state: 'Booted', isAvailable: true },
          { udid: 'U2', name: 'iPhone Old', state: 'Shutdown', isAvailable: false },
          { udid: 'U3', name: 'No State' },
          { name: 'no udid' },
        ],
        'com.apple.CoreSimulator.SimRuntime.watchOS-12-0': [{ udid: 'W1', name: 'Watch', state: 'Shutdown' }],
      },
    });
    expect(parseDevices(json)).toEqual([
      { udid: 'U1', name: 'iPhone 17', runtime: 'iOS 27.0', state: 'Booted' },
      { udid: 'U3', name: 'No State', runtime: 'iOS 27.0', state: 'Unknown' },
    ]);
  });

  it('returns nothing for an unexpected shape', () => {
    expect(parseDevices('{}')).toEqual([]);
    expect(parseDevices('[]')).toEqual([]);
  });
});

describe('parseRuntimes', () => {
  it('keeps available iOS runtimes by name', () => {
    const json = JSON.stringify({
      runtimes: [
        { name: 'iOS 27.0', platform: 'iOS', isAvailable: true },
        { name: 'iOS 25.0', identifier: 'com.apple.CoreSimulator.SimRuntime.iOS-25-0', isAvailable: false },
        { name: 'watchOS 12.0', platform: 'watchOS' },
      ],
    });
    expect(parseRuntimes(json)).toEqual(['iOS 27.0']);
  });
});

describe('runtimeName', () => {
  it('turns a runtime identifier into a version name', () => {
    expect(runtimeName('com.apple.CoreSimulator.SimRuntime.iOS-27-0')).toBe('iOS 27.0');
    expect(runtimeName('com.apple.CoreSimulator.SimRuntime.iOS-17-5-1')).toBe('iOS 17.5.1');
    expect(runtimeName('something-else')).toBe('something-else');
  });
});

describe('screenFromPixels', () => {
  it('is 3x for a tall phone', () => {
    expect(screenFromPixels(1206, 2622)).toEqual({ width: 402, height: 874, scale: 3 });
  });

  it('is 2x for an SE or iPad-shaped screen', () => {
    expect(screenFromPixels(750, 1334)).toEqual({ width: 375, height: 667, scale: 2 });
  });

  it('keeps the orientation of a landscape frame', () => {
    expect(screenFromPixels(2622, 1206)).toEqual({ width: 874, height: 402, scale: 3 });
  });
});

describe('pngSize', () => {
  const png = (width: number, height: number) => {
    const buffer = Buffer.alloc(33);
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]).copy(buffer);
    buffer.writeUInt32BE(13, 8);
    buffer.write('IHDR', 12, 'latin1');
    buffer.writeUInt32BE(width, 16);
    buffer.writeUInt32BE(height, 20);
    return buffer;
  };

  it('reads the IHDR dimensions', () => {
    expect(pngSize(png(1206, 2622))).toEqual({ width: 1206, height: 2622 });
  });

  it('throws on something that is not a PNG', () => {
    expect(() => pngSize(Buffer.from('not a png at all, just some text bytes'))).toThrow(/not a PNG/);
    expect(() => pngSize(Buffer.alloc(10))).toThrow(/not a PNG/);
  });
});

describe('builtAppPath', () => {
  it('picks the application target, skipping frameworks', () => {
    const json = JSON.stringify([
      {
        target: 'Kit',
        buildSettings: { WRAPPER_EXTENSION: 'framework', TARGET_BUILD_DIR: '/b', WRAPPER_NAME: 'Kit.framework' },
      },
      {
        target: 'App',
        buildSettings: {
          WRAPPER_EXTENSION: 'app',
          TARGET_BUILD_DIR: '/b/Debug-iphonesimulator',
          WRAPPER_NAME: 'App.app',
        },
      },
    ]);
    expect(builtAppPath(json)).toBe('/b/Debug-iphonesimulator/App.app');
  });

  it('throws when the scheme builds no app', () => {
    const json = JSON.stringify([{ buildSettings: { WRAPPER_EXTENSION: 'framework' } }]);
    expect(() => builtAppPath(json)).toThrow(/builds no \.app/);
    expect(() => builtAppPath('{}')).toThrow(/builds no \.app/);
  });
});

describe('rotateScript', () => {
  const device: SimulatorDevice = { udid: UDID, name: 'Nao "Test" Phone', runtime: 'iOS 27.0', state: 'Booted' };

  it('escapes double quotes in the device name', () => {
    const script = rotateScript(device, 'left');
    expect(script).toContain('"Nao \\"Test\\" Phone"');
    expect(script).not.toContain('"Nao "Test"');
  });

  it('clicks the menu item for the direction', () => {
    expect(rotateScript(device, 'left')).toContain('click menu item "Rotate Left"');
    expect(rotateScript(device, 'right')).toContain('click menu item "Rotate Right"');
  });

  it('matches the window on the runtime version', () => {
    expect(rotateScript(device, 'left')).toContain('"27.0"');
  });
});

describe('XcodeSimulatorDriver', () => {
  it('taps with axe', async () => {
    const { run, driver } = fakeRunner();
    await driver.tap(UDID, 100.04, 200, undefined);
    expect(callsOf(run)).toEqual([['axe', ['tap', '-x', '100', '-y', '200', '--udid', UDID]]]);
  });

  it('holds the HID connection open so Xcode 27 does not drop the tap', async () => {
    const { run, driver } = fakeRunner();
    await driver.tap(UDID, 100, 200, undefined);
    expect(run.mock.calls[0][2]?.env).toEqual({ AXE_HID_STABILIZATION_MS: '250' });
  });

  it('turns a long tap into a held touch', async () => {
    const { run, driver } = fakeRunner();
    await driver.tap(UDID, 1, 2, 1.5);
    expect(callsOf(run)[0][1]).toEqual([
      'touch',
      '-x',
      '1',
      '-y',
      '2',
      '--down',
      '--up',
      '--delay',
      '1.5',
      '--udid',
      UDID,
    ]);
  });

  it('types after a -- so text starting with a dash is not a flag', async () => {
    const { run, driver } = fakeRunner();
    await driver.type(UDID, '-hello');
    expect(callsOf(run)).toEqual([['axe', ['type', '--udid', UDID, '--', '-hello']]]);
  });

  it('sends the HID keycode for a key', async () => {
    const { run, driver } = fakeRunner();
    await driver.key(UDID, 'return');
    expect(callsOf(run)).toEqual([['axe', ['key', '40', '--udid', UDID]]]);
  });

  it('boots, then waits for bootstatus', async () => {
    const { run, driver } = fakeRunner();
    await driver.boot(UDID);
    expect(callsOf(run)).toEqual([
      ['xcrun', ['simctl', 'boot', UDID]],
      ['xcrun', ['simctl', 'bootstatus', UDID, '-b']],
    ]);
  });

  it('treats booting a booted device as success and still waits for bootstatus', async () => {
    const { run, driver } = fakeRunner(async (_file, args) => {
      if (args[1] === 'boot') {
        throw new ToolchainCommandError('xcrun', 149, '', 'Unable to boot device in current state: Booted');
      }
      return { stdout: '', stderr: '' };
    });
    await expect(driver.boot(UDID)).resolves.toBeUndefined();
    expect(callsOf(run).map(([, args]) => (args as string[])[1])).toEqual(['boot', 'bootstatus']);
  });

  it('rethrows any other boot failure without waiting', async () => {
    const { run, driver } = fakeRunner(async () => {
      throw new ToolchainCommandError('xcrun', 1, '', 'Invalid device: nope');
    });
    await expect(driver.boot(UDID)).rejects.toBeInstanceOf(ToolchainCommandError);
    expect(run).toHaveBeenCalledTimes(1);
  });

  it('turns a missing axe into a setup error', async () => {
    const { driver } = fakeRunner(async file => {
      throw new ToolchainCommandError(file, 'ENOENT', '', '');
    });
    const error = await driver.tap(UDID, 1, 2).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(SimulatorSetupError);
    expect((error as SimulatorSetupError).fix).toContain('brew install cameroncooke/axe/axe');
  });

  it('lists devices and runtimes through simctl', async () => {
    const { driver } = fakeRunner(async (_file, args) => ({
      stdout:
        args[2] === 'devices'
          ? JSON.stringify({
              devices: {
                'com.apple.CoreSimulator.SimRuntime.iOS-27-0': [{ udid: 'U1', name: 'P', state: 'Shutdown' }],
              },
            })
          : JSON.stringify({ runtimes: [{ name: 'iOS 27.0', platform: 'iOS' }] }),
      stderr: '',
    }));
    await expect(driver.devices()).resolves.toEqual({
      devices: [{ udid: 'U1', name: 'P', runtime: 'iOS 27.0', state: 'Shutdown' }],
      runtimes: ['iOS 27.0'],
    });
  });

  it('launches terminating a running copy', async () => {
    const { run, driver } = fakeRunner();
    await driver.launch(UDID, 'com.example.foo');
    expect(callsOf(run)).toEqual([
      ['xcrun', ['simctl', 'launch', '--terminate-running-process', UDID, 'com.example.foo']],
    ]);
  });
});

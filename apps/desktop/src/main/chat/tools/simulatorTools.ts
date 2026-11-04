import { SimulatorSetupError } from '../simulator/toolchain';
import { resolveWithinRoots } from './paths';
import { showImage } from './toolImages';
import {
  optionalNumber,
  requireString,
  type ApprovalPrompt,
  type SimulatorButton,
  type SimulatorContext,
  type SimulatorDevice,
  type SimulatorKey,
  type ToolContext,
  type ToolDefinition,
} from './types';

/**
 * The iOS Simulator tools, macOS only. Every tool that acts on a device shares one approval key
 * per device, so a user asked once about "iPhone 17 (iOS 27.0)" has answered for every tap,
 * screenshot and launch on it - and for nothing on any other device. Building is gated apart,
 * per project and scheme, because a build runs the project's own scripts.
 */

const DEVICE_KEY_PREFIX = 'simulator\x00';
const BUTTONS: readonly SimulatorButton[] = ['home', 'lock', 'side-button', 'siri', 'apple-pay'];
const KEYS: readonly SimulatorKey[] = ['return', 'delete', 'tab', 'escape', 'space', 'up', 'down', 'left', 'right'];
const DEVICE_PROPERTY = {
  device: {
    type: 'string',
    description:
      'A simulator UDID or name from simulator_devices. Omit it to use the device in the live view, or the only booted one.',
  },
};

function requireSimulator(context: ToolContext): SimulatorContext {
  if (!context.simulator) throw new Error('The iOS Simulator is only available in the macOS app.');
  return context.simulator;
}

function describeDevice(device: SimulatorDevice): string {
  return `${device.name} (${device.runtime})`;
}

function listDevices(devices: readonly SimulatorDevice[], attached?: string): string[] {
  return devices.map(
    device =>
      `  ${device.udid}  ${describeDevice(device)}  ${device.state}${device.udid === attached ? '  [live view]' : ''}`
  );
}

/**
 * The device `requested` names - a UDID, or a name matched case-insensitively, preferring a booted
 * one when several devices share it - or, without one, the live view's device and then the only
 * booted device. Ambiguity is refused with the list rather than guessed.
 */
export async function resolveSimulatorDevice(
  simulator: SimulatorContext,
  requested: string | undefined
): Promise<SimulatorDevice> {
  const { devices, runtimes } = await simulator.driver.devices();
  if (devices.length === 0) {
    throw runtimes.length === 0
      ? new SimulatorSetupError(
          'No iOS simulator runtime is installed.',
          'run `xcodebuild -downloadPlatform iOS` in a terminal, or add one in Xcode > Settings > Components.'
        )
      : new Error(
          'No iOS simulator devices exist. Ask the user to add one in Xcode > Window > Devices and Simulators.'
        );
  }
  const attached = simulator.attached();
  if (requested) {
    const byUdid = devices.find(device => device.udid.toLowerCase() === requested.toLowerCase());
    if (byUdid) return byUdid;
    const named = devices.filter(device => device.name.toLowerCase() === requested.toLowerCase());
    const booted = named.filter(device => device.state === 'Booted');
    const pick = named.length === 1 ? named : booted.length === 1 ? booted : [];
    if (pick.length === 1) return pick[0];
    throw new Error(
      [
        named.length > 1
          ? `${named.length} simulators are named "${requested}". Pass the UDID of the one you mean:`
          : `No simulator matches "${requested}". Available:`,
        ...listDevices(named.length > 1 ? named : devices, attached),
      ].join('\n')
    );
  }
  const live = attached ? devices.find(device => device.udid === attached) : undefined;
  if (live) return live;
  const booted = devices.filter(device => device.state === 'Booted');
  if (booted.length === 1) return booted[0];
  if (booted.length === 0) {
    throw new Error(
      [
        'No simulator is booted. Call simulator_boot with one of these, or pass `device`:',
        ...listDevices(devices, attached),
      ].join('\n')
    );
  }
  throw new Error(
    [
      `${booted.length} simulators are booted. Pass \`device\` with the one you mean:`,
      ...listDevices(booted, attached),
    ].join('\n')
  );
}

function deviceArgument(input: Record<string, unknown>): string | undefined {
  return typeof input.device === 'string' && input.device.trim() ? input.device.trim() : undefined;
}

function deviceApproval(action: (input: Record<string, unknown>) => string) {
  return async (input: Record<string, unknown>, context: ToolContext): Promise<ApprovalPrompt> => {
    const device = await resolveSimulatorDevice(requireSimulator(context), deviceArgument(input));
    return {
      detail: `${action(input)} on the iOS Simulator ${describeDevice(device)}`,
      key: `${DEVICE_KEY_PREFIX}${device.udid}`,
      askInAuto: true,
      alwaysCovers: `every simulator action on ${describeDevice(device)}`,
    };
  };
}

/**
 * The device this call acts on, re-resolved at run time and held to the one the user approved:
 * the booted set or the live view can change between the card and the answer.
 */
async function approvedDevice(input: Record<string, unknown>, context: ToolContext): Promise<SimulatorDevice> {
  const device = await resolveSimulatorDevice(requireSimulator(context), deviceArgument(input));
  const approved = context.approvedKey?.startsWith(DEVICE_KEY_PREFIX)
    ? context.approvedKey.slice(DEVICE_KEY_PREFIX.length)
    : undefined;
  if (approved && approved !== device.udid) {
    throw new Error(
      `The simulators changed after the user approved this: it now targets ${describeDevice(device)}, which was not approved. Pass \`device\` and call again.`
    );
  }
  return device;
}

function requireNumber(input: Record<string, unknown>, key: string): number {
  const value = optionalNumber(input, key);
  if (value === undefined) throw new Error(`The "${key}" argument is required and must be a number (points).`);
  return value;
}

function oneOf<T extends string>(input: Record<string, unknown>, key: string, allowed: readonly T[]): T {
  const value = input[key];
  if (typeof value === 'string' && (allowed as readonly string[]).includes(value)) return value as T;
  throw new Error(`"${key}" must be one of: ${allowed.join(', ')}.`);
}

export const simulatorDevices: ToolDefinition = {
  schema: {
    name: 'simulator_devices',
    description:
      'List the iOS simulators on this Mac with their UDIDs, runtimes and whether each is booted, plus the installed iOS runtimes. Start here before building or launching an app.',
    parameters: { type: 'object', properties: {} },
  },
  async run(_input, context) {
    const simulator = requireSimulator(context);
    const { devices, runtimes } = await simulator.driver.devices();
    context.report?.label('Listed iOS simulators');
    if (runtimes.length === 0) {
      throw new SimulatorSetupError(
        'No iOS simulator runtime is installed.',
        'run `xcodebuild -downloadPlatform iOS` in a terminal, or add one in Xcode > Settings > Components.'
      );
    }
    return [
      `Runtimes: ${runtimes.join(', ')}`,
      devices.length ? `${devices.length} device(s):` : 'No devices exist yet.',
      ...listDevices(devices, simulator.attached()),
    ].join('\n');
  },
};

export const simulatorBoot: ToolDefinition = {
  schema: {
    name: 'simulator_boot',
    description: 'Boot an iOS simulator and wait until it has finished starting. Booting a booted device is a no-op.',
    parameters: {
      type: 'object',
      properties: DEVICE_PROPERTY,
      required: ['device'],
    },
  },
  approval: deviceApproval(() => 'Boot'),
  async run(input, context) {
    const device = await approvedDevice(input, context);
    context.report?.progress(`Booting ${describeDevice(device)}...`);
    await requireSimulator(context).driver.boot(device.udid);
    context.report?.label(`Booted ${describeDevice(device)}`);
    return `${describeDevice(device)} is booted (${device.udid}).`;
  },
};

export const simulatorBuild: ToolDefinition = {
  schema: {
    name: 'simulator_build',
    description:
      'Build an Xcode project or workspace scheme for an iOS simulator with xcodebuild and return the path of the built .app, for simulator_launch. Takes minutes on a first build. Build errors come back as the compiler wrote them.',
    parameters: {
      type: 'object',
      properties: {
        project: {
          type: 'string',
          description:
            'Path to the .xcodeproj or .xcworkspace, inside a shared folder. Prefer the workspace when there is one.',
        },
        scheme: { type: 'string', description: 'The scheme to build, as `xcodebuild -list` shows it.' },
        configuration: { type: 'string', description: 'Build configuration. Defaults to Debug.' },
        ...DEVICE_PROPERTY,
      },
      required: ['project', 'scheme'],
    },
  },
  async approval(input, context): Promise<ApprovalPrompt> {
    const container = await containerPath(input, context);
    const scheme = requireString(input, 'scheme');
    return {
      detail: `Build the scheme "${scheme}" of ${container} with xcodebuild\n\nA build runs the project's own build scripts.`,
      key: `simulator_build\x00${container}\x00${scheme}`,
      askInAuto: true,
    };
  },
  async run(input, context) {
    const simulator = requireSimulator(context);
    const container = await containerPath(input, context);
    const scheme = requireString(input, 'scheme');
    const device = await resolveSimulatorDevice(simulator, deviceArgument(input));
    const configuration =
      typeof input.configuration === 'string' && input.configuration ? input.configuration : undefined;
    context.report?.progress(`Building ${scheme} for ${describeDevice(device)}...`);
    const built = await simulator.driver.build(
      { container, scheme, udid: device.udid, ...(configuration ? { configuration } : {}) },
      context.signal
    );
    context.report?.label(`Built ${scheme}`);
    return [`Build succeeded. App: ${built.appPath}`, 'Install and start it with simulator_launch.'].join('\n');
  },
};

async function containerPath(input: Record<string, unknown>, context: ToolContext): Promise<string> {
  const requested = requireString(input, 'project');
  if (!/\.(xcodeproj|xcworkspace)\/?$/.test(requested)) {
    throw new Error('"project" must be a .xcodeproj or .xcworkspace path.');
  }
  return resolveWithinRoots(requested.replace(/\/$/, ''), context.roots, context.workingDirectory);
}

export const simulatorLaunch: ToolDefinition = {
  schema: {
    name: 'simulator_launch',
    description:
      'Install a built .app on a booted simulator and launch it, or relaunch an installed app by bundle id. A running copy is terminated first.',
    parameters: {
      type: 'object',
      properties: {
        app_path: { type: 'string', description: 'Path to the built .app bundle, e.g. from simulator_build.' },
        bundle_id: { type: 'string', description: 'Launch an already-installed app by its bundle identifier instead.' },
        ...DEVICE_PROPERTY,
      },
    },
  },
  approval: deviceApproval(input =>
    typeof input.app_path === 'string' ? `Install and launch ${input.app_path}` : `Launch ${String(input.bundle_id)}`
  ),
  async run(input, context) {
    const simulator = requireSimulator(context);
    const device = await approvedDevice(input, context);
    const appPath = typeof input.app_path === 'string' && input.app_path ? input.app_path : undefined;
    let bundleId = typeof input.bundle_id === 'string' && input.bundle_id ? input.bundle_id : undefined;
    if (!appPath && !bundleId) throw new Error('Pass app_path to install and launch, or bundle_id to launch.');
    if (appPath) {
      context.report?.progress(`Installing on ${describeDevice(device)}...`);
      bundleId = await simulator.driver.install(device.udid, appPath);
    }
    await simulator.driver.launch(device.udid, bundleId as string);
    context.report?.label(`Launched ${bundleId}`);
    const live = simulator.attached() === device.udid;
    return `Launched ${bundleId} on ${describeDevice(device)}.${live ? ' The user sees it in the live view.' : ''} Take a simulator_screenshot to check what it shows.`;
  },
};

export const simulatorScreenshot: ToolDefinition = {
  schema: {
    name: 'simulator_screenshot',
    description:
      "Capture a simulator's screen as an image you see and the user sees in the conversation. The image is scaled to the screen's size in points, so a pixel position in it is the coordinate simulator_input takes.",
    parameters: {
      type: 'object',
      properties: {
        caption: { type: 'string', description: 'What this screenshot shows, for the user.' },
        ...DEVICE_PROPERTY,
      },
    },
  },
  approval: deviceApproval(() => 'Take a screenshot'),
  async run(input, context) {
    const simulator = requireSimulator(context);
    const device = await approvedDevice(input, context);
    const { png, screen } = await simulator.driver.screenshot(device.udid);
    const caption =
      typeof input.caption === 'string' && input.caption.trim() ? input.caption.trim() : describeDevice(device);
    const kept = await simulator.keepScreenshot(png, caption);
    if (kept) context.report?.media(kept);
    context.report?.label(`Screenshot of ${describeDevice(device)}`);
    const size = `${screen.width}x${screen.height} points`;
    const shown = showImage(context, png, 'image/png');
    if (!shown.ok)
      return `Captured ${describeDevice(device)} (${size}) and showed it to the user, but not to you: ${shown.reason}.`;
    return `Captured ${describeDevice(device)}: ${size}, and the image is at that size, so its pixel coordinates are tap coordinates. You see it below this result in this reply only.`;
  },
};

const INPUT_ACTIONS = ['tap', 'swipe', 'type', 'key', 'button'] as const;

export const simulatorInput: ToolDefinition = {
  schema: {
    name: 'simulator_input',
    description:
      'Touch or type on a simulator, the way a user would. Coordinates are points, read off a simulator_screenshot. tap: x, y (duration > 0.5 s is a long press). swipe: x, y to x2, y2. type: text into the focused field (US keyboard characters). key: a hardware key. button: a hardware button. Take a screenshot afterwards to see the result.',
    parameters: {
      type: 'object',
      properties: {
        action: { type: 'string', enum: [...INPUT_ACTIONS] },
        x: { type: 'number' },
        y: { type: 'number' },
        x2: { type: 'number', description: 'swipe end x.' },
        y2: { type: 'number', description: 'swipe end y.' },
        duration: { type: 'number', description: 'Seconds: a long press for tap, the gesture length for swipe.' },
        text: { type: 'string', description: 'For type.' },
        key: { type: 'string', enum: [...KEYS] },
        button: { type: 'string', enum: [...BUTTONS] },
        ...DEVICE_PROPERTY,
      },
      required: ['action'],
    },
  },
  approval: deviceApproval(input => {
    switch (input.action) {
      case 'tap':
        return `Tap at (${String(input.x)}, ${String(input.y)})`;
      case 'swipe':
        return `Swipe from (${String(input.x)}, ${String(input.y)}) to (${String(input.x2)}, ${String(input.y2)})`;
      case 'type':
        return `Type "${String(input.text)}"`;
      case 'key':
        return `Press the ${String(input.key)} key`;
      case 'button':
        return `Press the ${String(input.button)} button`;
      default:
        return 'Send input';
    }
  }),
  async run(input, context) {
    const driver = requireSimulator(context).driver;
    const action = oneOf(input, 'action', INPUT_ACTIONS);
    const device = await approvedDevice(input, context);
    const duration = optionalNumber(input, 'duration');
    const where = describeDevice(device);
    switch (action) {
      case 'tap': {
        const x = requireNumber(input, 'x');
        const y = requireNumber(input, 'y');
        await driver.tap(device.udid, x, y, duration);
        context.report?.label(`Tapped (${x}, ${y})`);
        return `Tapped (${x}, ${y}) on ${where}.`;
      }
      case 'swipe': {
        const from = { x: requireNumber(input, 'x'), y: requireNumber(input, 'y') };
        const to = { x: requireNumber(input, 'x2'), y: requireNumber(input, 'y2') };
        await driver.swipe(device.udid, from, to, duration);
        context.report?.label(`Swiped (${from.x}, ${from.y}) to (${to.x}, ${to.y})`);
        return `Swiped from (${from.x}, ${from.y}) to (${to.x}, ${to.y}) on ${where}.`;
      }
      case 'type': {
        const text = requireString(input, 'text');
        await driver.type(device.udid, text);
        context.report?.label('Typed text');
        return `Typed ${text.length} character(s) on ${where}.`;
      }
      case 'key': {
        const key = oneOf(input, 'key', KEYS);
        await driver.key(device.udid, key);
        context.report?.label(`Pressed ${key}`);
        return `Pressed ${key} on ${where}.`;
      }
      case 'button': {
        const button = oneOf(input, 'button', BUTTONS);
        await driver.button(device.udid, button, duration);
        context.report?.label(`Pressed ${button}`);
        return `Pressed the ${button} button on ${where}.`;
      }
    }
  },
};

export const simulatorOpenUrl: ToolDefinition = {
  schema: {
    name: 'simulator_open_url',
    description:
      'Open a URL on a simulator: a deep link into an app (myapp://path), a universal link, or a web page in Safari.',
    parameters: {
      type: 'object',
      properties: { url: { type: 'string' }, ...DEVICE_PROPERTY },
      required: ['url'],
    },
  },
  approval: deviceApproval(input => `Open ${String(input.url)}`),
  async run(input, context) {
    const url = requireString(input, 'url');
    if (!/^[a-z][a-z0-9+.-]*:/i.test(url))
      throw new Error('"url" needs a scheme, e.g. myapp://home or https://example.com.');
    const device = await approvedDevice(input, context);
    await requireSimulator(context).driver.openUrl(device.udid, url);
    context.report?.label(`Opened ${url}`);
    return `Opened ${url} on ${describeDevice(device)}.`;
  },
};

export const simulatorAppearance: ToolDefinition = {
  schema: {
    name: 'simulator_appearance',
    description: "Read a simulator's light/dark appearance, or switch it by passing mode.",
    parameters: {
      type: 'object',
      properties: { mode: { type: 'string', enum: ['light', 'dark'] }, ...DEVICE_PROPERTY },
    },
  },
  needsApproval: input => input.mode !== undefined,
  approval: deviceApproval(input => `Switch to ${String(input.mode)} mode`),
  async run(input, context) {
    const driver = requireSimulator(context).driver;
    const device = await approvedDevice(input, context);
    if (input.mode === undefined) {
      const current = await driver.appearance(device.udid);
      return `${describeDevice(device)} is in ${current} mode.`;
    }
    const mode = oneOf(input, 'mode', ['light', 'dark'] as const);
    await driver.setAppearance(device.udid, mode);
    context.report?.label(`Switched to ${mode} mode`);
    return `${describeDevice(device)} is now in ${mode} mode.`;
  },
};

export const simulatorRotate: ToolDefinition = {
  schema: {
    name: 'simulator_rotate',
    description:
      "Turn a simulator a quarter turn left or right. This drives Simulator.app's Device menu, so it opens Simulator.app and needs macOS Accessibility permission for this app. Take a screenshot afterwards: coordinates follow the new orientation.",
    parameters: {
      type: 'object',
      properties: { direction: { type: 'string', enum: ['left', 'right'] }, ...DEVICE_PROPERTY },
      required: ['direction'],
    },
  },
  approval: deviceApproval(input => `Rotate ${String(input.direction)}`),
  async run(input, context) {
    const direction = oneOf(input, 'direction', ['left', 'right'] as const);
    const device = await approvedDevice(input, context);
    await requireSimulator(context).driver.rotate(device.udid, direction);
    context.report?.label(`Rotated ${direction}`);
    return `Rotated ${describeDevice(device)} ${direction}.`;
  },
};

export const simulatorView: ToolDefinition = {
  schema: {
    name: 'simulator_view',
    description:
      "Open (attach) or close (detach) the user's live simulator panel beside the chat, which streams the device's screen and lets the user tap it. Attach as soon as the user wants to watch the app, before building or launching. It shows the screen to the user only; use simulator_screenshot to see it yourself.",
    parameters: {
      type: 'object',
      properties: { action: { type: 'string', enum: ['attach', 'detach'] }, ...DEVICE_PROPERTY },
      required: ['action'],
    },
  },
  async run(input, context) {
    const simulator = requireSimulator(context);
    const action = oneOf(input, 'action', ['attach', 'detach'] as const);
    if (action === 'detach') {
      simulator.detach();
      context.report?.label('Closed the simulator view');
      return 'Closed the live simulator view.';
    }
    const device = await resolveSimulatorDevice(simulator, deviceArgument(input));
    await simulator.attach(device.udid);
    context.report?.label(`Showing ${describeDevice(device)}`);
    return `The user now sees ${describeDevice(device)} live beside the chat.`;
  },
};

export const SIMULATOR_TOOLS: readonly ToolDefinition[] = [
  simulatorDevices,
  simulatorBoot,
  simulatorBuild,
  simulatorLaunch,
  simulatorScreenshot,
  simulatorInput,
  simulatorOpenUrl,
  simulatorAppearance,
  simulatorRotate,
  simulatorView,
];

/**
 * Terminal setup utility for configuring Shift+Enter keybindings.
 *
 * Most terminal emulators send the same byte (\r) for both Enter and Shift+Enter,
 * making them indistinguishable. This utility detects the user's terminal and provides
 * instructions or automatic configuration to make Shift+Enter emit a distinct sequence.
 *
 * Terminals with native Shift+Enter support (no setup needed):
 *   - iTerm2, WezTerm, Ghostty, Kitty
 *
 * Terminals that need configuration:
 *   - VS Code integrated terminal
 *   - Alacritty
 *   - Zed
 *   - macOS Terminal.app
 */

import { existsSync, promises as fs } from 'fs';
import path from 'path';
import { homedir } from 'os';

type TerminalId =
  | 'iterm2'
  | 'wezterm'
  | 'ghostty'
  | 'kitty'
  | 'vscode'
  | 'alacritty'
  | 'zed'
  | 'terminal_app'
  | 'warp'
  | 'unknown';

type SetupStatus = 'native' | 'configurable' | 'manual' | 'unknown';

interface TerminalInfo {
  id: TerminalId;
  name: string;
  status: SetupStatus;
}

const TERMINAL_INFO: Record<TerminalId, { name: string; status: SetupStatus }> = {
  iterm2: { name: 'iTerm2', status: 'native' },
  wezterm: { name: 'WezTerm', status: 'native' },
  ghostty: { name: 'Ghostty', status: 'native' },
  kitty: { name: 'Kitty', status: 'native' },
  vscode: { name: 'VS Code', status: 'configurable' },
  alacritty: { name: 'Alacritty', status: 'configurable' },
  zed: { name: 'Zed', status: 'manual' },
  terminal_app: { name: 'Terminal.app', status: 'manual' },
  warp: { name: 'Warp', status: 'manual' },
  unknown: { name: 'Unknown', status: 'unknown' },
};

/**
 * Detect the current terminal emulator from environment variables.
 */
export function detectTerminal(): TerminalInfo {
  const termProgram = process.env['TERM_PROGRAM'] ?? '';
  const term = process.env['TERM'] ?? '';

  // VS Code integrated terminal
  if (termProgram === 'vscode' || process.env['VSCODE_PID']) {
    return { id: 'vscode', ...TERMINAL_INFO.vscode };
  }

  // iTerm2
  if (termProgram === 'iTerm.app' || process.env['ITERM_SESSION_ID']) {
    return { id: 'iterm2', ...TERMINAL_INFO.iterm2 };
  }

  // WezTerm
  if (termProgram === 'WezTerm' || process.env['WEZTERM_PANE']) {
    return { id: 'wezterm', ...TERMINAL_INFO.wezterm };
  }

  // Ghostty
  if (termProgram === 'ghostty' || term === 'xterm-ghostty') {
    return { id: 'ghostty', ...TERMINAL_INFO.ghostty };
  }

  // Kitty
  if (term === 'xterm-kitty' || process.env['KITTY_PID']) {
    return { id: 'kitty', ...TERMINAL_INFO.kitty };
  }

  // Alacritty
  if (termProgram === 'Alacritty' || term === 'alacritty') {
    return { id: 'alacritty', ...TERMINAL_INFO.alacritty };
  }

  // Warp
  if (termProgram === 'WarpTerminal' || process.env['WARP_IS_LOCAL_SHELL_SESSION']) {
    return { id: 'warp', ...TERMINAL_INFO.warp };
  }

  // Zed
  if (termProgram === 'zed') {
    return { id: 'zed', ...TERMINAL_INFO.zed };
  }

  // macOS Terminal.app
  if (termProgram === 'Apple_Terminal') {
    return { id: 'terminal_app', ...TERMINAL_INFO.terminal_app };
  }

  return { id: 'unknown', ...TERMINAL_INFO.unknown };
}

/**
 * VS Code keybindings.json entry for Shift+Enter -> \x1b[13;2u (Kitty protocol)
 */
const VSCODE_KEYBINDING = {
  key: 'shift+enter',
  command: 'workbench.action.terminal.sendSequence',
  args: { text: '\u001b[13;2u' },
  when: 'terminalFocus',
};

/**
 * Configure VS Code to send a Kitty-protocol escape sequence for Shift+Enter.
 */
async function setupVSCode(): Promise<{ success: boolean; message: string }> {
  const vscodeDirs = [
    path.join(homedir(), 'Library', 'Application Support', 'Code', 'User'), // macOS
    path.join(homedir(), '.config', 'Code', 'User'), // Linux
    path.join(homedir(), 'AppData', 'Roaming', 'Code', 'User'), // Windows
  ];

  const vscodeDir = vscodeDirs.find(dir => existsSync(dir));
  if (!vscodeDir) {
    return {
      success: false,
      message:
        'Could not find VS Code settings directory.\n' +
        'Manually add this to your keybindings.json (Cmd+K Cmd+S → Open Keyboard Shortcuts JSON):\n\n' +
        JSON.stringify(VSCODE_KEYBINDING, null, 2),
    };
  }

  const keybindingsPath = path.join(vscodeDir, 'keybindings.json');

  let keybindings: unknown[] = [];
  if (existsSync(keybindingsPath)) {
    const content = await fs.readFile(keybindingsPath, 'utf-8');
    // Strip comments (VS Code allows JSONC)
    const stripped = content.replace(/\/\/.*$/gm, '').replace(/\/\*[\s\S]*?\*\//g, '');
    try {
      keybindings = JSON.parse(stripped) as unknown[];
    } catch {
      return {
        success: false,
        message:
          'Could not parse keybindings.json. Manually add this entry:\n\n' + JSON.stringify(VSCODE_KEYBINDING, null, 2),
      };
    }
  }

  // Check if already configured
  const alreadyConfigured = (keybindings as Array<Record<string, unknown>>).some(
    binding =>
      binding['key'] === 'shift+enter' &&
      binding['command'] === 'workbench.action.terminal.sendSequence' &&
      binding['when'] === 'terminalFocus'
  );

  if (alreadyConfigured) {
    return {
      success: true,
      message: 'VS Code is already configured for Shift+Enter newlines.',
    };
  }

  keybindings.push(VSCODE_KEYBINDING);
  await fs.writeFile(keybindingsPath, JSON.stringify(keybindings, null, 2) + '\n', 'utf-8');

  return {
    success: true,
    message:
      `Updated ${keybindingsPath}\n` +
      'Shift+Enter will now insert a newline in the B4M CLI.\n' +
      'Restart your VS Code terminal for the change to take effect.',
  };
}

/**
 * Alacritty config entry for Shift+Enter -> Kitty protocol sequence.
 */
const ALACRITTY_TOML_SNIPPET = `
# B4M CLI: Shift+Enter sends Kitty-protocol sequence for newline
[[keyboard.bindings]]
key = "Return"
mods = "Shift"
chars = "\\u001b[13;2u"
`.trim();

/**
 * Configure Alacritty to send a distinct escape sequence for Shift+Enter.
 */
async function setupAlacritty(): Promise<{ success: boolean; message: string }> {
  const configPaths = [
    path.join(homedir(), '.config', 'alacritty', 'alacritty.toml'),
    path.join(homedir(), '.alacritty.toml'),
  ];

  const existingConfig = configPaths.find(p => existsSync(p));
  const configPath = existingConfig ?? configPaths[0];

  let content = '';
  if (existingConfig) {
    content = await fs.readFile(configPath, 'utf-8');

    // Check if already configured
    if (content.includes('[13;2u') || content.includes('\\u001b[13;2u')) {
      return {
        success: true,
        message: 'Alacritty is already configured for Shift+Enter newlines.',
      };
    }
  }

  const newContent = content
    ? content.trimEnd() + '\n\n' + ALACRITTY_TOML_SNIPPET + '\n'
    : ALACRITTY_TOML_SNIPPET + '\n';

  // Ensure directory exists
  const configDir = path.dirname(configPath);
  if (!existsSync(configDir)) {
    await fs.mkdir(configDir, { recursive: true });
  }

  await fs.writeFile(configPath, newContent, 'utf-8');

  return {
    success: true,
    message:
      `Updated ${configPath}\n` +
      'Shift+Enter will now insert a newline in the B4M CLI.\n' +
      'Restart Alacritty for the change to take effect.',
  };
}

/**
 * Get manual instructions for terminals that can't be auto-configured.
 */
function getManualInstructions(terminal: TerminalInfo): string {
  switch (terminal.id) {
    case 'zed':
      return (
        'Add this to your Zed keymap.json (Zed → Settings → Open Key Bindings):\n\n' +
        JSON.stringify(
          [
            {
              context: 'Terminal',
              bindings: {
                'shift-enter': ['terminal::SendText', '\\u001b[13;2u'],
              },
            },
          ],
          null,
          2
        )
      );

    case 'terminal_app':
      return (
        'macOS Terminal.app cannot send distinct Shift+Enter sequences.\n\n' +
        'Alternatives:\n' +
        '  • Use Option+Enter (⌥+Enter) to insert newlines\n' +
        '  • Type \\ then Enter to insert newlines\n' +
        '  • Switch to iTerm2, WezTerm, or Ghostty for native Shift+Enter support'
      );

    case 'warp':
      return (
        'Warp terminal has limited keybinding customization.\n\n' +
        'Alternatives:\n' +
        '  • Use Option+Enter (⌥+Enter) to insert newlines\n' +
        '  • Type \\ then Enter to insert newlines'
      );

    default:
      return (
        'Your terminal needs to be configured to send a distinct escape sequence for Shift+Enter.\n' +
        'Configure Shift+Enter to send: \\x1b[13;2u (Kitty keyboard protocol)\n\n' +
        'Alternatives that work in all terminals:\n' +
        '  • Option/Alt+Enter to insert newlines\n' +
        '  • Type \\ then Enter to insert newlines'
      );
  }
}

/**
 * Run the terminal setup flow.
 */
export async function runTerminalSetup(): Promise<void> {
  const terminal = detectTerminal();

  console.log(`\nDetected terminal: ${terminal.name}\n`);

  switch (terminal.status) {
    case 'native':
      console.log(`✅ ${terminal.name} natively supports Shift+Enter for newlines.\n` + 'No configuration needed!\n');
      break;

    case 'configurable': {
      console.log(`Configuring ${terminal.name} for Shift+Enter support...\n`);

      let result: { success: boolean; message: string };
      switch (terminal.id) {
        case 'vscode':
          result = await setupVSCode();
          break;
        case 'alacritty':
          result = await setupAlacritty();
          break;
        default:
          result = { success: false, message: 'No auto-configuration available.' };
      }

      console.log(result.success ? `✅ ${result.message}` : `⚠️  ${result.message}`);
      console.log();
      break;
    }

    case 'manual':
      console.log(`⚠️  ${terminal.name} requires manual configuration.\n`);
      console.log(getManualInstructions(terminal));
      console.log();
      break;

    case 'unknown':
      console.log(getManualInstructions(terminal));
      console.log();
      break;
  }

  // Always show the universal alternatives
  console.log('Universal newline methods (work in all terminals):');
  console.log('  • Option/Alt + Enter — insert newline');
  console.log('  • \\ + Enter          — insert newline (backslash-escape)');
  console.log('  • Shift + Enter      — insert newline (if terminal supports Kitty protocol)');
  console.log();
}

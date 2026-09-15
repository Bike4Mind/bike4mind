import { describe, it, expect } from 'vitest';
import yargs from 'yargs';
import { matchesAnyPattern } from '../agents/toolFilter';

/**
 * Exact-argv parse guard for the claude-compat flags.
 *
 * Mirrors the yargs option declarations + the `--allowedTools` flatten and
 * positional-capture logic in bin/bike4mind-cli.mjs (which, being an executable
 * script, can't be imported without running). The vectors below are the LITERAL
 * argv a host builds when launching the CLI under the name `claude`:
 *   - stage  (--mcp-config + --allowedTools glob + brief + settings + positional task)
 *   - board  (board YAML pane: --strict-mcp-config + explicit tool list + session id)
 *
 * The risk this locks down: `--allowedTools` is a greedy yargs array. It must
 * stop at the next `--flag` and NOT swallow the positional task; the task must
 * land in `argv._[0]`.
 */
function buildParser() {
  return yargs()
    .option('prompt', { alias: 'p', type: 'string' })
    .option('mcp-config', { type: 'string' })
    .option('strict-mcp-config', { type: 'boolean', default: false })
    .option('append-system-prompt', { type: 'string' })
    .option('allowedTools', { type: 'array', string: true })
    .option('settings', { type: 'string' })
    .option('session-id', { type: 'string' })
    .option('resume', { type: 'string' })
    .command('mcp', 'mcp')
    .command('update', 'update')
    .command('doctor', 'doctor')
    .help(false)
    .version(false);
}

/** Mirrors bin's --allowedTools -> B4M_ALLOWED_TOOLS flatten (split on whitespace). */
function flattenAllowedTools(allowedTools: unknown): string[] {
  const arr = (allowedTools as unknown[] | undefined) ?? [];
  return arr.flatMap(s => String(s).split(/\s+/)).filter(Boolean);
}

/** Mirrors bin's positional-task capture. */
const KNOWN_SUBCOMMANDS = new Set(['mcp', 'update', 'doctor']);
function captureTask(argv: { _: (string | number)[]; prompt?: string }): string | undefined {
  if (argv.prompt !== undefined) return undefined;
  if (argv._.length > 0 && !KNOWN_SUBCOMMANDS.has(String(argv._[0]))) return String(argv._[0]);
  return undefined;
}

describe('claude-compat arg parsing (exact host launch vectors)', () => {
  it('STAGE vector: --allowedTools is bounded; positional task lands in _[0]', () => {
    const sys = 'You are operating inside the host...';
    const settings = JSON.stringify({ hooks: { Stop: [{ matcher: '*', hooks: [] }] } });
    const task = 'Implement the spec. update the config and tools.'; // deliberately contains "update"
    const argv = buildParser().parseSync([
      '--mcp-config',
      '/tmp/per-launch.json',
      '--allowedTools',
      'mcp__manifold__*',
      '--append-system-prompt',
      sys,
      '--settings',
      settings,
      task,
    ]);

    expect(argv['mcp-config']).toBe('/tmp/per-launch.json');
    expect(flattenAllowedTools(argv.allowedTools)).toEqual(['mcp__manifold__*']);
    expect(argv['append-system-prompt']).toBe(sys);
    expect(argv.settings).toBe(settings);
    // The greedy array did NOT swallow the task.
    expect(captureTask(argv)).toBe(task);
    expect(argv['strict-mcp-config']).toBe(false);
  });

  it('BOARD vector: single space-separated --allowedTools token flattens to 3 patterns; --strict set', () => {
    const argv = buildParser().parseSync([
      '--mcp-config',
      '/tmp/board.json',
      '--strict-mcp-config',
      '--allowedTools',
      'mcp__manifold__read_board_yaml mcp__manifold__write_board_yaml mcp__manifold__list_tickets',
      '--append-system-prompt',
      'BOARD_YAML_BRIEF',
      '--session-id',
      'abc-123',
    ]);

    expect(argv['strict-mcp-config']).toBe(true);
    expect(flattenAllowedTools(argv.allowedTools)).toEqual([
      'mcp__manifold__read_board_yaml',
      'mcp__manifold__write_board_yaml',
      'mcp__manifold__list_tickets',
    ]);
    expect(argv['session-id']).toBe('abc-123');
    expect(captureTask(argv)).toBeUndefined(); // board pane has no positional
  });

  it('BOARD reopen vector: --resume carries the uuid', () => {
    const argv = buildParser().parseSync([
      '--mcp-config',
      '/tmp/board.json',
      '--strict-mcp-config',
      '--allowedTools',
      'mcp__manifold__read_board_yaml',
      '--append-system-prompt',
      'BOARD_YAML_BRIEF',
      '--resume',
      'uuid-xyz',
    ]);
    expect(argv.resume).toBe('uuid-xyz');
  });

  it('a real subcommand still dispatches (not captured as a task)', () => {
    const argv = buildParser().parseSync(['mcp', 'list']);
    expect(captureTask(argv)).toBeUndefined();
    expect(argv._[0]).toBe('mcp');
  });
});

describe('allowlist auto-approve matching (toolsAdapter uses matchesAnyPattern)', () => {
  it('stage glob mcp__manifold__* auto-approves every manifold tool but nothing else', () => {
    const patterns = ['mcp__manifold__*'];
    expect(matchesAnyPattern('mcp__manifold__mark_ready', patterns)).toBe(true);
    expect(matchesAnyPattern('mcp__manifold__read_board', patterns)).toBe(true);
    expect(matchesAnyPattern('bash_execute', patterns)).toBe(false);
    expect(matchesAnyPattern('mcp__playwright__click', patterns)).toBe(false);
  });

  it('board explicit list auto-approves only the three named tools', () => {
    const patterns = [
      'mcp__manifold__read_board_yaml',
      'mcp__manifold__write_board_yaml',
      'mcp__manifold__list_tickets',
    ];
    expect(matchesAnyPattern('mcp__manifold__read_board_yaml', patterns)).toBe(true);
    expect(matchesAnyPattern('mcp__manifold__list_tickets', patterns)).toBe(true);
    // A host tool NOT in the list still requires a prompt.
    expect(matchesAnyPattern('mcp__manifold__spawn_subticket', patterns)).toBe(false);
  });
});

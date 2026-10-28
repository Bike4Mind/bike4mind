import { describe, it, expect } from 'vitest';
import yargs from 'yargs';
import { splitEnvFlags } from '../../bin/envFlags.mjs';

// Mirrors the `mcp serve` declaration in bin/bike4mind-cli.mjs; nothing declares `local` at the top level.
function parse(args: string[]) {
  return yargs()
    .option('prompt', { alias: 'p', type: 'string' })
    .command('mcp', 'mcp', mcp =>
      mcp.command('serve', 'serve', serve =>
        serve.option('http', { type: 'boolean', default: false }).option('local', { type: 'boolean', default: false })
      )
    )
    .parseSync(args);
}

describe('splitEnvFlags', () => {
  it.each([['--local'], ['-local']])('keeps mcp serve %s as the serve flag', flag => {
    const split = splitEnvFlags(['mcp', 'serve', flag]);
    expect(split).toMatchObject({ cleaned: ['mcp', 'serve', '--local'], envTarget: null, serveLocal: true });
    const argv = parse(split.cleaned);
    expect(argv._).toEqual(['mcp', 'serve']);
    expect(argv.local).toBe(true);
  });

  it('treats --local before mcp serve as the --dev alias', () => {
    const split = splitEnvFlags(['--local', 'mcp', 'serve']);
    expect(split).toMatchObject({ cleaned: ['mcp', 'serve'], envTarget: 'dev', serveLocal: false, mcpServe: true });
    const argv = parse(split.cleaned);
    expect(argv._).toEqual(['mcp', 'serve']);
    expect(argv.local).toBe(false);
  });

  it('treats --local with a prompt as the --dev alias', () => {
    expect(splitEnvFlags(['--local', '-p', 'hi'])).toMatchObject({
      cleaned: ['-p', 'hi'],
      envTarget: 'dev',
      mcpServe: false,
    });
  });

  it('treats --local between mcp and serve as the --dev alias', () => {
    const split = splitEnvFlags(['mcp', '--local', 'serve']);
    expect(split).toMatchObject({ cleaned: ['mcp', 'serve'], envTarget: 'dev', serveLocal: false });
    expect(parse(split.cleaned).local).toBe(false);
  });

  it('keeps serve --local alongside a leading env flag', () => {
    const split = splitEnvFlags(['--dev', 'mcp', 'serve', '--local']);
    expect(split).toMatchObject({
      cleaned: ['mcp', 'serve', '--local'],
      envTarget: 'dev',
      envFlags: ['--dev'],
      serveLocal: true,
    });
    const argv = parse(split.cleaned);
    expect(argv._).toEqual(['mcp', 'serve']);
    expect(argv.local).toBe(true);
  });

  it('treats --local as the --dev alias when mcp serve is not the command', () => {
    expect(splitEnvFlags(['explain', 'mcp', 'serve', '--local'])).toMatchObject({
      cleaned: ['explain', 'mcp', 'serve'],
      envTarget: 'dev',
      mcpServe: false,
      serveLocal: false,
    });
  });

  it('reports the env flags it removed, last one winning', () => {
    expect(splitEnvFlags(['mcp', 'serve', '--local', '--prod', '-dev'])).toMatchObject({
      cleaned: ['mcp', 'serve', '--local'],
      envTarget: 'dev',
      envFlags: ['--prod', '-dev'],
      serveLocal: true,
    });
  });
});

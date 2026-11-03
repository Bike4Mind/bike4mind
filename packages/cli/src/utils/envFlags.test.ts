import { readFileSync } from 'node:fs';
import { describe, it, expect } from 'vitest';
import yargs from 'yargs';
import { ARRAY_OPTIONS, splitEnvFlags, VALUE_OPTIONS } from '../../bin/envFlags.mjs';

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

  it.each([
    [['--ollama-host', 'http://gpu:11434', 'mcp', 'serve', '--local']],
    [['-p', 'hi', 'mcp', 'serve', '--local']],
    [['--resume', 'abc', '--dev', 'mcp', 'serve', '--local']],
  ])('finds mcp serve after a global option value in %j', args => {
    expect(splitEnvFlags(args)).toMatchObject({ mcpServe: true, serveLocal: true });
  });

  it('treats tokens after an array option as its values, as yargs does', () => {
    expect(splitEnvFlags(['--add-dir', 'a', '--dev', 'mcp', 'serve', '--local'])).toMatchObject({
      mcpServe: false,
      serveLocal: false,
      envTarget: 'dev',
    });
  });

  it('knows every top-level option that takes a value', () => {
    const source = readFileSync(new URL('../../bin/bike4mind-cli.mjs', import.meta.url), 'utf8');
    const topLevel = source.slice(source.indexOf('yargs(hideBin'), source.indexOf(".command('mcp'"));
    const declared = [...topLevel.matchAll(/\.option\('([^']+)',\s*\{([^}]*)\}/g)];
    expect(declared.length).toBeGreaterThan(10);
    for (const [, name, body] of declared) {
      const type = /type: '(\w+)'/.exec(body)?.[1];
      if (type === 'string') expect(VALUE_OPTIONS, name).toContain(`--${name}`);
      if (type === 'array') expect(ARRAY_OPTIONS, name).toContain(`--${name}`);
    }
  });

  it.each([
    ['--local=true', true],
    ['-local=true', true],
    ['--local=false', false],
  ])('reads mcp serve %s as the serve flag', (flag, local) => {
    const split = splitEnvFlags(['--dev', 'mcp', 'serve', flag]);
    expect(split).toMatchObject({ envTarget: 'dev', serveLocal: local });
    expect(parse(split.cleaned).local).toBe(local);
  });
});

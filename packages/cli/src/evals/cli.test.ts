/**
 * Tests for the CLI argument parser and surrounding orchestration logic.
 * The full main() path is not tested end-to-end because it requires a
 * live B4M auth token - that's covered by manual smoke runs.
 */
import { describe, it, expect } from 'vitest';
import { parseArgs } from './cli';

describe('parseArgs', () => {
  it('returns sensible defaults when given no flags (model deferred to config)', () => {
    const args = parseArgs([]);
    // Model defaults are resolved at runtime from ConfigStore, not parse-time.
    expect(args.model).toBe('__from_config__');
    expect(args.label).toBe('');
    expect(args.taskIds).toBeUndefined();
    expect(args.dryRun).toBe(false);
    expect(args.help).toBe(false);
  });

  it('parses an explicit --model', () => {
    const args = parseArgs(['--model', 'gpt-5']);
    expect(args.model).toBe('gpt-5');
    expect(args.label).toBe(''); // label derivation also deferred to runtime
  });

  it('respects an explicit --label', () => {
    const args = parseArgs(['--model', 'gpt-5', '--label', 'gpt5:minimal']);
    expect(args.model).toBe('gpt-5');
    expect(args.label).toBe('gpt5:minimal');
  });

  it('collects multiple --task flags into a Set', () => {
    const args = parseArgs(['--task', 'read-file', '--task', 'create-file']);
    expect(args.taskIds).toEqual(new Set(['read-file', 'create-file']));
  });

  it('parses --max-cost-tokens as a positive number', () => {
    const args = parseArgs(['--max-cost-tokens', '500000']);
    expect(args.maxCostTokens).toBe(500_000);
  });

  it('rejects --max-cost-tokens that is non-positive or non-numeric', () => {
    expect(() => parseArgs(['--max-cost-tokens', '0'])).toThrow(/positive number/);
    expect(() => parseArgs(['--max-cost-tokens', 'abc'])).toThrow(/positive number/);
    expect(() => parseArgs(['--max-cost-tokens', '-5'])).toThrow(/positive number/);
  });

  it('sets dryRun for --dry-run and help for --help / -h', () => {
    expect(parseArgs(['--dry-run']).dryRun).toBe(true);
    expect(parseArgs(['--help']).help).toBe(true);
    expect(parseArgs(['-h']).help).toBe(true);
  });

  it('throws on unknown flags', () => {
    expect(() => parseArgs(['--mystery'])).toThrow(/Unknown flag/);
  });

  it('throws when a flag is missing its value', () => {
    expect(() => parseArgs(['--model'])).toThrow(/Missing value/);
  });

  it('resolves --out to an absolute path', () => {
    const args = parseArgs(['--out', './my-runs']);
    expect(args.outDir.startsWith('/')).toBe(true);
    expect(args.outDir.endsWith('my-runs')).toBe(true);
  });

  it('defaults --prompt-variant to "current"', () => {
    const args = parseArgs([]);
    expect(args.promptVariant).toBe('current');
  });

  it('parses --prompt-variant minimal', () => {
    const args = parseArgs(['--prompt-variant', 'minimal']);
    expect(args.promptVariant).toBe('minimal');
  });

  it('rejects unknown --prompt-variant values', () => {
    expect(() => parseArgs(['--prompt-variant', 'mystery'])).toThrow(/must be one of/);
  });
});

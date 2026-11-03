import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { arityPrefix, directoryOptionValues } from './bashArity';
import { scanShell } from './shellScan';

const home = '/Users/tester';
vi.mock('node:os', async importOriginal => ({
  ...(await importOriginal<typeof import('node:os')>()),
  homedir: () => home,
}));

const PROTOTYPE_NAMES = ['constructor', 'toString', '__proto__', 'valueOf', 'hasOwnProperty'];

describe('lookup tables keyed by a command word', () => {
  const root = join(home, 'proj');
  const scan = (command: string) => scanShell(command, root, [root]);

  describe.each(PROTOTYPE_NAMES)('a command named %s', name => {
    it.each([
      ['a short option', `${name} -x`],
      ['a short option with a value', `${name} -x value file`],
      ['a long option', `${name} --flag`],
      ['a long option with a value', `${name} --flag value file`],
      ['an inline script flag', `${name} -c 'echo hi'`],
      ['a plus option', `${name} +x`],
      ['an output option', `${name} -o out.txt https://example.com`],
      ['a long output option', `${name} --output out.txt https://example.com`],
      ['an operand only', `${name} file`],
      ['a directory option', `${name} -C dir status`],
      ['a decompress flag', `${name} -d file.gz`],
    ])('is scanned like any unknown program: %s', async (_label, command) => {
      const result = await scan(command);
      expect(result).not.toBeNull();
      expect(result?.commands[0]?.words.split(' ')[0]).toBe(name);
      expect(result?.writes).toEqual([]);
      expect(result?.readOnly).toBe(false);
    });

    it('is not taken for a gh subcommand with reads', async () => {
      const result = await scan(`gh ${name} list`);
      expect(result?.readOnly).toBe(false);
    });

    it('has no arity of its own and drops no leading options', () => {
      expect(arityPrefix([name, 'sub', 'x'])).toEqual([name]);
      expect(arityPrefix(['git', name, 'x']).slice(0, 2)).toEqual(['git', name]);
      expect(directoryOptionValues([name, '-C', 'dir'])).toEqual([]);
    });
  });
});

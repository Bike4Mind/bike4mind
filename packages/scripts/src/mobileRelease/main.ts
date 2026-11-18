import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { runCli } from './cli';

process.exitCode = runCli(
  process.argv.slice(2),
  {
    stdout: line => process.stdout.write(`${line}\n`),
    stderr: line => process.stderr.write(`${line}\n`),
    readFile: path => readFileSync(path, 'utf8'),
    now: () => new Date(),
  },
  fileURLToPath(new URL('./parityMatrix.json', import.meta.url))
);

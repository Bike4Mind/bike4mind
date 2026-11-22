// A stand-in for apps/workers/src/callableFunctions/child.ts. The request's `code` is JSON naming what to do.
import { createInterface } from 'node:readline';

const stayAlive = () => setInterval(() => {}, 1000);

createInterface({ input: process.stdin }).once('line', line => {
  const request = JSON.parse(line);
  const spec = JSON.parse(request.code);
  switch (spec.mode) {
    case 'reply':
      process.stdout.write(`${JSON.stringify(spec.reply)}\n`);
      stayAlive();
      break;
    case 'report': {
      const report = {
        env: process.env,
        execArgv: process.execArgv,
        args: process.argv.slice(2),
        pid: process.pid,
        glueBytes: request.glue.length,
        pyodideVersion: request.pyodideVersion,
      };
      process.stdout.write(`${JSON.stringify({ ok: true, initMs: 1, printed: JSON.stringify(report) })}\n`);
      stayAlive();
      break;
    }
    case 'memory': {
      const held = [];
      setInterval(() => held.push(Buffer.alloc(32 * 1024 * 1024, 1)), 20);
      break;
    }
    case 'flood':
      process.stdout.write('x'.repeat(3 * 1024 * 1024));
      stayAlive();
      break;
    case 'exit':
      process.exit(0);
      break;
    default:
      stayAlive();
  }
});

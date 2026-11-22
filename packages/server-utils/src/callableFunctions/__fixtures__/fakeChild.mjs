// A stand-in for apps/workers/src/callableFunctions/child.ts. The request's `code` is JSON naming what to do:
// `startDelayMs` delays the run-start line, `skipStart` leaves it out, then `mode` runs.
import { createInterface } from 'node:readline';

const stayAlive = () => setInterval(() => {}, 1000);
const write = message => process.stdout.write(`${JSON.stringify(message)}\n`);
const runStarted = () => write({ started: true });

function runMode(request, spec) {
  switch (spec.mode) {
    case 'reply':
      write(spec.reply);
      stayAlive();
      break;
    case 'report': {
      const report = {
        env: process.env,
        execArgv: process.execArgv,
        args: process.argv.slice(2),
        pid: process.pid,
        glueBytes: request.glue.length,
        glueResultCap: Number(/^_MAX_RESULT_BYTES = (\d+)$/m.exec(request.glue)?.[1]),
        pyodideVersion: request.pyodideVersion,
      };
      write({ ok: true, initMs: 1, printed: JSON.stringify(report) });
      stayAlive();
      break;
    }
    case 'series': {
      const outputsJson = `{"values": [${new Array(spec.count).fill('0.5').join(', ')}]}`;
      write({ ok: true, initMs: 1, printed: '', contractJson: spec.contractJson, outputsJson });
      stayAlive();
      break;
    }
    case 'sleep':
      setTimeout(() => write(spec.reply), spec.ms);
      stayAlive();
      break;
    case 'restart':
      setTimeout(runStarted, spec.afterMs);
      stayAlive();
      break;
    case 'memory': {
      const held = [];
      setInterval(() => held.push(Buffer.alloc(32 * 1024 * 1024, 1)), 20);
      break;
    }
    case 'flood':
      process.stdout.write('x'.repeat(spec.bytes));
      stayAlive();
      break;
    case 'line':
      process.stdout.write(`${spec.text}\n`);
      stayAlive();
      break;
    case 'exit':
      process.exit(0);
      break;
    default:
      stayAlive();
  }
}

createInterface({ input: process.stdin }).once('line', line => {
  const request = JSON.parse(line);
  const spec = JSON.parse(request.code);
  setTimeout(() => {
    if (!spec.skipStart) runStarted();
    runMode(request, spec);
  }, spec.startDelayMs ?? 0);
});

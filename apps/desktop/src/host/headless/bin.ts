import { main, parseCommand } from './cli';

// The bundle's entry (vite.host.config.ts). A daemon exits explicitly once it has shut down;
// every other command lets Node exit on its own so stdout is flushed first.
const argv = process.argv.slice(2);
main(argv).then(
  code => {
    process.exitCode = code;
    if (parseCommand(argv) === 'daemon') process.exit(code);
  },
  (error: unknown) => {
    process.stderr.write(`b4m-host: ${error instanceof Error ? error.message : String(error)}\n`);
    process.exit(1);
  }
);

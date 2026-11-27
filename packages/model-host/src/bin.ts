import { runHost } from './cli';

process.exit(await runHost(process.argv.slice(2)));

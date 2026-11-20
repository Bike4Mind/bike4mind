import type { ProcessRunner, RunOptions, RunResult } from './runProcess';

export interface RunCall {
  file: string;
  args: string[];
  input?: string;
}

const ADD_LINE = /^add-generic-password -a "([^"]+)" -s "([^"]+)" -w (\S+)\n$/;

/** Stands in for /usr/bin/security over an in-memory keychain; no test touches the real one. */
export function fakeKeychain(
  options: {
    findStatus?: number;
    addStatus?: number;
    codesign?: RunResult;
  } = {}
) {
  const items = new Map<string, string>();
  const calls: RunCall[] = [];
  const done = (status: number | null, stdout = ''): RunResult => ({ status, stdout, stderr: '' });

  const run: ProcessRunner = (file: string, args: readonly string[], runOptions: RunOptions = {}) => {
    calls.push({ file, args: [...args], ...(runOptions.input === undefined ? {} : { input: runOptions.input }) });
    if (file === '/usr/bin/codesign') return options.codesign ?? done(null);
    if (file !== '/usr/bin/security') return done(null);
    if (args[0] === 'find-generic-password') {
      if (options.findStatus !== undefined) return done(options.findStatus);
      const value = items.get(`${args[args.indexOf('-s') + 1]}|${args[args.indexOf('-a') + 1]}`);
      return value === undefined ? done(44) : done(0, `${value}\n`);
    }
    if (args.length === 1 && args[0] === '-i') {
      if (options.addStatus !== undefined) return done(options.addStatus);
      const match = ADD_LINE.exec(runOptions.input ?? '');
      if (!match) return done(1);
      const [, account, service, password] = match;
      if (items.has(`${service}|${account}`)) return done(45);
      items.set(`${service}|${account}`, password);
      return done(0);
    }
    return done(1);
  };

  return { run, calls, items };
}

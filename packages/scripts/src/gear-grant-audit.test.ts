import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { resolve } from 'node:path';
import { HELP_TEXT } from './gearGrantAudit';

const mocks = vi.hoisted(() => ({
  connectDB: vi.fn(),
  runGearGrantAudit: vi.fn(),
  writeFileSync: vi.fn(),
}));

vi.mock('@bike4mind/db-core', () => ({ connectDB: mocks.connectDB }));
vi.mock('sst', () => ({ Resource: { App: { stage: 'dev' } } }));
vi.mock('../utils/config', () => ({ Config: { MONGODB_URI: 'mongodb://config/%STAGE%' } }));
vi.mock('./gearGrantAuditData', () => ({ runGearGrantAudit: mocks.runGearGrantAudit }));
vi.mock('node:fs', () => ({ writeFileSync: mocks.writeFileSync }));

const env = { ...process.env };
const argv = process.argv;
let exit: ReturnType<typeof vi.spyOn>;
let log: ReturnType<typeof vi.spyOn>;
let error: ReturnType<typeof vi.spyOn>;

const runCli = async (...args: string[]) => {
  process.argv = ['node', 'gear-grant-audit.ts', ...args];
  vi.resetModules();
  await import('./gear-grant-audit');
};

beforeEach(() => {
  vi.clearAllMocks();
  mocks.runGearGrantAudit.mockResolvedValue({ markdown: '## report' });
  exit = vi.spyOn(process, 'exit').mockImplementation((() => undefined) as never);
  log = vi.spyOn(console, 'log').mockImplementation(() => undefined);
  error = vi.spyOn(console, 'error').mockImplementation(() => undefined);
  delete process.env.MONGODB_URI;
  delete process.env.INIT_CWD;
});

afterEach(() => {
  process.argv = argv;
  process.env = { ...env };
  vi.restoreAllMocks();
});

describe('gear-grant-audit entry point', () => {
  it('prints help without connecting', async () => {
    await runCli('--help');
    await vi.waitFor(() => expect(log).toHaveBeenCalledWith(HELP_TEXT));
    expect(mocks.connectDB).not.toHaveBeenCalled();
    expect(exit).not.toHaveBeenCalled();
  });

  it('connects read-only with the env URI and prints the report', async () => {
    process.env.MONGODB_URI = 'mongodb://env/%STAGE%';
    await runCli('--days', '7');
    await vi.waitFor(() => expect(exit).toHaveBeenCalledWith(0));
    expect(mocks.connectDB).toHaveBeenCalledWith('mongodb://env/dev', undefined, {
      autoIndex: false,
      autoCreate: false,
    });
    expect(mocks.runGearGrantAudit).toHaveBeenCalledWith(
      expect.objectContaining({ days: 7, withinMinutes: 60, top: 10 })
    );
    expect(log).toHaveBeenCalledWith('## report');
  });

  it('writes the report next to the operator when --out is given', async () => {
    process.env.INIT_CWD = '/operator';
    await runCli('--out', 'gears.md');
    await vi.waitFor(() => expect(exit).toHaveBeenCalledWith(0));
    expect(mocks.connectDB).toHaveBeenCalledWith('mongodb://config/dev', undefined, expect.anything());
    expect(mocks.writeFileSync).toHaveBeenCalledWith('/operator/gears.md', '## report\n');
  });

  it('resolves --out against the working directory outside pnpm', async () => {
    await runCli('--out', 'gears.md');
    await vi.waitFor(() => expect(exit).toHaveBeenCalledWith(0));
    expect(mocks.writeFileSync).toHaveBeenCalledWith(resolve(process.cwd(), 'gears.md'), '## report\n');
  });

  it('exits non-zero on a failure', async () => {
    await runCli('--days', 'zero');
    await vi.waitFor(() => expect(exit).toHaveBeenCalledWith(1));
    expect(error).toHaveBeenCalledWith('[gear-grant-audit] failed:', expect.any(Error));
  });
});

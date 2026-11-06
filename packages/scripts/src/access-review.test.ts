import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { resolve } from 'node:path';
import {
  ACCESS_REVIEW_COUNT_LABELS,
  type AccessReviewSnapshot,
} from '@bike4mind/server-utils/security/accessReview/accessReview';
import { HELP_TEXT, parseAccessReviewArgs } from './accessReviewArgs';

const mocks = vi.hoisted(() => ({
  connectDB: vi.fn(),
  collectAccessReview: vi.fn(),
  readFileSync: vi.fn(),
  writeFileSync: vi.fn(),
}));

vi.mock('@bike4mind/db-core', () => ({ connectDB: mocks.connectDB }));
vi.mock('sst', () => ({ Resource: { App: { stage: 'production' } } }));
vi.mock('../utils/config', () => ({ Config: { MONGODB_URI: 'mongodb://config/%STAGE%' } }));
vi.mock('@bike4mind/server-utils/security/accessReview/accessReviewData', () => ({
  collectAccessReview: mocks.collectAccessReview,
}));
vi.mock('node:fs', () => ({ readFileSync: mocks.readFileSync, writeFileSync: mocks.writeFileSync }));

const counts = Object.fromEntries(
  Object.keys(ACCESS_REVIEW_COUNT_LABELS).map(key => [key, 1])
) as AccessReviewSnapshot['counts'];
const snapshot: AccessReviewSnapshot = {
  quarter: '2027-Q1',
  generatedAt: '2027-01-04T09:00:00.000Z',
  allApiKeysListed: false,
  counts,
  admins: [],
  apiKeys: [],
  supportAccess: [],
  impersonation: [],
};

const env = { ...process.env };
const argv = process.argv;
let exit: ReturnType<typeof vi.spyOn>;
let log: ReturnType<typeof vi.spyOn>;
let error: ReturnType<typeof vi.spyOn>;

const runCli = async (...args: string[]) => {
  process.argv = ['node', 'access-review.ts', ...args];
  vi.resetModules();
  await import('./access-review');
};

beforeEach(() => {
  vi.clearAllMocks();
  mocks.collectAccessReview.mockResolvedValue(snapshot);
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

describe('parseAccessReviewArgs', () => {
  it('defaults to stdout, privileged keys only', () => {
    expect(parseAccessReviewArgs([])).toEqual({
      help: false,
      out: undefined,
      json: undefined,
      baseline: undefined,
      allKeys: false,
    });
  });

  it('reads every option', () => {
    expect(
      parseAccessReviewArgs(['--out', 'r.md', '--json', 's.json', '--baseline', 'b.json', '--all-keys', '-h'])
    ).toEqual({ help: true, out: 'r.md', json: 's.json', baseline: 'b.json', allKeys: true });
  });

  it('rejects an unknown flag', () => {
    expect(() => parseAccessReviewArgs(['--days', '7'])).toThrow();
  });
});

describe('access-review entry point', () => {
  it('prints help without connecting', async () => {
    await runCli('--help');
    await vi.waitFor(() => expect(log).toHaveBeenCalledWith(HELP_TEXT));
    expect(mocks.connectDB).not.toHaveBeenCalled();
    expect(exit).not.toHaveBeenCalled();
  });

  it('connects read-only with the env URI and prints the report', async () => {
    process.env.MONGODB_URI = 'mongodb://env/%STAGE%';
    await runCli();
    await vi.waitFor(() => expect(exit).toHaveBeenCalledWith(0));
    expect(mocks.connectDB).toHaveBeenCalledWith('mongodb://env/production', undefined, {
      autoIndex: false,
      autoCreate: false,
    });
    expect(mocks.collectAccessReview).toHaveBeenCalledWith({ allApiKeys: false });
    expect(log).toHaveBeenCalledWith(expect.stringContaining('# Access review 2027-Q1'));
    expect(mocks.writeFileSync).not.toHaveBeenCalled();
  });

  it('writes the report and snapshot next to the operator, comparing against a baseline', async () => {
    process.env.INIT_CWD = '/operator';
    mocks.readFileSync.mockReturnValue(
      JSON.stringify({ quarter: '2027-Q1', generatedAt: '2027-01-04T08:00:00.000Z', counts: { fullAdmins: 3 } })
    );
    await runCli('--out', 'after.md', '--json', 'after.json', '--baseline', 'before.json', '--all-keys');
    await vi.waitFor(() => expect(exit).toHaveBeenCalledWith(0));
    expect(mocks.connectDB).toHaveBeenCalledWith('mongodb://config/production', undefined, expect.anything());
    expect(mocks.readFileSync).toHaveBeenCalledWith('/operator/before.json', 'utf8');
    expect(mocks.collectAccessReview).toHaveBeenCalledWith({ allApiKeys: true });
    expect(mocks.writeFileSync).toHaveBeenCalledWith('/operator/after.json', `${JSON.stringify(snapshot, null, 2)}\n`, {
      mode: 0o600,
    });
    const [path, markdown, options] = mocks.writeFileSync.mock.calls[1];
    expect(path).toBe('/operator/after.md');
    expect(options).toEqual({ mode: 0o600 });
    expect(markdown).toContain('| Full admin accounts | 3 | 1 | -2 |');
    expect(log).toHaveBeenCalledWith('Report written to /operator/after.md');
  });

  it('resolves paths against the working directory outside pnpm', async () => {
    await runCli('--out', 'review.md');
    await vi.waitFor(() => expect(exit).toHaveBeenCalledWith(0));
    expect(mocks.writeFileSync).toHaveBeenCalledWith(resolve(process.cwd(), 'review.md'), expect.any(String), {
      mode: 0o600,
    });
  });

  it('fails on a bad baseline before connecting', async () => {
    mocks.readFileSync.mockReturnValue('{"not":"a snapshot"}');
    await runCli('--baseline', 'nope.json');
    await vi.waitFor(() => expect(exit).toHaveBeenCalledWith(1));
    expect(error).toHaveBeenCalledWith('[access-review] failed:', expect.any(Error));
    expect(mocks.connectDB).not.toHaveBeenCalled();
  });
});

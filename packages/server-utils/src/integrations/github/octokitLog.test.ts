import { describe, expect, it, vi } from 'vitest';
import { Octokit } from '@octokit/rest';
import { createOctokitLog, isGitHubAccessLossStatus, requestLogFailureStatus } from './octokitLog';

const makeLogger = () => ({ debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() });

describe('requestLogFailureStatus', () => {
  it.each([
    ['GET /repos/acme/widgets/labels?per_page=100 - 404 with id ABCD:1234 in 323ms', 404],
    ['POST /app/installations/1/access_tokens - 404 with id ABCD:1234 in 99ms', 404],
    ['GET /rate_limit - 503 with id UNKNOWN in 12ms', 503],
  ])('reads the status from %s', (line, status) => {
    expect(requestLogFailureStatus(line)).toBe(status);
  });

  it.each(['GET /rate_limit - undefined with id UNKNOWN in 5ms', 'Some other warning that mentions 404', ''])(
    'returns null for a line that is not a request failure: %s',
    line => {
      expect(requestLogFailureStatus(line)).toBeNull();
    }
  );
});

describe('isGitHubAccessLossStatus', () => {
  it.each([403, 404, 410])('treats %i as access loss', status => {
    expect(isGitHubAccessLossStatus(status)).toBe(true);
  });

  it.each([400, 401, 422, 429, 500, 502, 503, null])('does not treat %s as access loss', status => {
    expect(isGitHubAccessLossStatus(status)).toBe(false);
  });
});

describe('createOctokitLog', () => {
  it('logs an access-loss request failure at warn, with its status', () => {
    const logger = makeLogger();
    const line = 'POST /app/installations/1/access_tokens - 404 with id ABCD:1234 in 99ms';

    createOctokitLog(logger).error(line);

    expect(logger.error).not.toHaveBeenCalled();
    expect(logger.warn).toHaveBeenCalledWith(expect.stringContaining('access lost'), { status: 404, request: line });
  });

  it.each([
    'GET /rate_limit - 401 with id ABCD:1234 in 50ms',
    'GET /rate_limit - 500 with id ABCD:1234 in 50ms',
    'GET /rate_limit - undefined with id UNKNOWN in 50ms',
    'Unexpected failure',
  ])('keeps %s at error', line => {
    const logger = makeLogger();

    createOctokitLog(logger).error(line);

    expect(logger.warn).not.toHaveBeenCalled();
    expect(logger.error).toHaveBeenCalledWith(`[Octokit] ${line}`);
  });

  it('drops the per-request debug and info lines', () => {
    const logger = makeLogger();
    const log = createOctokitLog(logger);

    log.debug('request', {});
    log.info('GET /rate_limit - 200 with id ABCD:1234 in 50ms');

    expect(logger.debug).not.toHaveBeenCalled();
    expect(logger.info).not.toHaveBeenCalled();
  });

  it('forwards Octokit warnings at warn', () => {
    const logger = makeLogger();

    createOctokitLog(logger).warn('deprecated endpoint');

    expect(logger.warn).toHaveBeenCalledWith('[Octokit] deprecated endpoint');
  });
});

describe('createOctokitLog wired into a real Octokit', () => {
  const octokitAnswering = (status: number, logger: ReturnType<typeof makeLogger>) =>
    new Octokit({
      log: createOctokitLog(logger),
      request: {
        fetch: async () =>
          new Response(JSON.stringify({ message: 'stubbed' }), {
            status,
            headers: { 'content-type': 'application/json', 'x-github-request-id': 'STUB:1' },
          }),
      },
    });

  it('reports a 404 from the request-log plugin at warn, not error', async () => {
    const logger = makeLogger();

    await expect(
      octokitAnswering(404, logger).issues.listLabelsForRepo({ owner: 'o', repo: 'r', per_page: 100 })
    ).rejects.toMatchObject({ status: 404 });

    expect(logger.error).not.toHaveBeenCalled();
    expect(logger.warn).toHaveBeenCalledWith(expect.stringContaining('access lost'), {
      status: 404,
      request: expect.stringMatching(/^GET \/repos\/o\/r\/labels\?per_page=100 - 404 with id STUB:1 in \d+ms$/),
    });
  });

  it('keeps a 500 from the request-log plugin at error', async () => {
    const logger = makeLogger();

    await expect(octokitAnswering(500, logger).rateLimit.get()).rejects.toMatchObject({ status: 500 });

    expect(logger.warn).not.toHaveBeenCalled();
    expect(logger.error).toHaveBeenCalledWith(
      expect.stringMatching(/^\[Octokit\] GET \/rate_limit - 500 with id STUB:1/)
    );
  });
});

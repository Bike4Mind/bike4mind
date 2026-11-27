/**
 * @vitest-environment node
 */
import { describe, it, expect, vi, afterEach } from 'vitest';
import { applyPersonalMailDefaults, isPersonalMailStage } from '../personalMailDefaults';

const SET_PARAM = '/app/shared/mail/ses-configuration-set';
const IDENTITY_PARAM = '/app/shared/mail/ses-identity';

const lookupFrom = (values: Record<string, string | undefined>) => vi.fn(async (name: string) => values[name]);

const run = (
  stage: string,
  env: NodeJS.ProcessEnv,
  lookup = lookupFrom({ [SET_PARAM]: 'set-a', [IDENTITY_PARAM]: 'example.com' })
) => applyPersonalMailDefaults({ stage, env, lookup, appName: 'app' }).then(result => ({ result, lookup }));

describe('applyPersonalMailDefaults', () => {
  afterEach(() => vi.restoreAllMocks());

  it.each([
    ['production', {}],
    ['dev', {}],
    ['shared-dev', {}],
    ['pr123', {}],
    ['alice', { IS_PREVIEW: 'true' }],
  ])('leaves stage %s (%o) alone without reading SSM', async (stage, extra) => {
    const env: NodeJS.ProcessEnv = { ...extra };
    const { result, lookup } = await run(stage, env);
    expect(result).toBe('skipped-stage');
    expect(lookup).not.toHaveBeenCalled();
    expect(env.MAIL_TRANSPORT).toBeUndefined();
    expect(env.SES_CONFIGURATION_SET).toBeUndefined();
    expect(env.SES_IDENTITY).toBeUndefined();
  });

  it('defaults a personal stage from a clean env to ses with both names from the app-scoped params', async () => {
    const log = vi.spyOn(console, 'log').mockImplementation(() => {});
    const env: NodeJS.ProcessEnv = {};
    const { result, lookup } = await run('alice', env);
    expect(result).toBe('applied');
    expect(lookup).toHaveBeenCalledWith(SET_PARAM);
    expect(lookup).toHaveBeenCalledWith(IDENTITY_PARAM);
    expect(env).toEqual({ MAIL_TRANSPORT: 'ses', SES_CONFIGURATION_SET: 'set-a', SES_IDENTITY: 'example.com' });
    expect(log).toHaveBeenCalledTimes(1);
    expect(log.mock.calls[0][0]).toBe(
      '[mail] personal stage alice: defaulting to SES (identity example.com); export MAIL_TRANSPORT=smtp to opt out'
    );
  });

  it.each([
    [{ MAIL_TRANSPORT: 'smtp' }],
    [{ MAIL_TRANSPORT: 'ses' }],
    [{ SES_IDENTITY: 'other.example' }],
    [{ SES_CONFIGURATION_SET: 'other-set' }],
  ])('keeps an explicit %o untouched', async explicit => {
    const env: NodeJS.ProcessEnv = { ...explicit };
    const { result, lookup } = await run('alice', env);
    expect(result).toBe('skipped-explicit');
    expect(lookup).not.toHaveBeenCalled();
    expect(env).toEqual(explicit);
  });

  it('treats empty-string values as unset', async () => {
    const env: NodeJS.ProcessEnv = { MAIL_TRANSPORT: '', SES_IDENTITY: '', SES_CONFIGURATION_SET: '' };
    const { result } = await run('alice', env);
    expect(result).toBe('applied');
    expect(env.MAIL_TRANSPORT).toBe('ses');
  });

  it.each([
    ['the set param is missing', lookupFrom({ [IDENTITY_PARAM]: 'example.com' })],
    ['the identity param is missing', lookupFrom({ [SET_PARAM]: 'set-a' })],
    ['a param is whitespace only', lookupFrom({ [SET_PARAM]: '  ', [IDENTITY_PARAM]: 'example.com' })],
    [
      'a lookup rejects',
      vi.fn(async (name: string) => {
        if (name === IDENTITY_PARAM) throw new Error('ParameterNotFound');
        return 'set-a';
      }),
    ],
    ['the set param is a wildcard', lookupFrom({ [SET_PARAM]: '*', [IDENTITY_PARAM]: 'example.com' })],
    ['the identity param is a wildcard', lookupFrom({ [SET_PARAM]: 'set-a', [IDENTITY_PARAM]: '*' })],
    ['the identity param carries a path', lookupFrom({ [SET_PARAM]: 'set-a', [IDENTITY_PARAM]: 'example.com/*' })],
    ['the set param carries inner whitespace', lookupFrom({ [SET_PARAM]: 'set a', [IDENTITY_PARAM]: 'example.com' })],
  ])('stays on SMTP and sets nothing when %s', async (_case, lookup) => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const env: NodeJS.ProcessEnv = {};
    const { result } = await run('alice', env, lookup);
    expect(result).toBe('skipped-missing');
    expect(env).toEqual({});
    expect(warn).toHaveBeenCalledTimes(1);
  });

  it('accepts an email-address identity', async () => {
    const env: NodeJS.ProcessEnv = {};
    const { result } = await run(
      'alice',
      env,
      lookupFrom({ [SET_PARAM]: 'set_a-1', [IDENTITY_PARAM]: 'noreply@mail.example.com' })
    );
    expect(result).toBe('applied');
    expect(env.SES_IDENTITY).toBe('noreply@mail.example.com');
  });

  it('names a lookup failure other than ParameterNotFound in the warning instead of calling it missing', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const env: NodeJS.ProcessEnv = {};
    const lookup = vi.fn(async () => {
      throw new Error('ExpiredTokenException: the SSO session has expired');
    });
    const { result } = await run('alice', env, lookup);
    expect(result).toBe('skipped-missing');
    expect(env).toEqual({});
    expect(warn.mock.calls[0][0]).toContain('unreadable (ExpiredTokenException');
    expect(warn.mock.calls[0][0]).not.toContain('not found');
  });

  it('reports a ParameterNotFound rejection as not found', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const lookup = vi.fn(async () => {
      throw new Error('ParameterNotFound: no such parameter');
    });
    await run('alice', {}, lookup);
    expect(warn.mock.calls[0][0]).toContain(`${SET_PARAM} not found`);
    expect(warn.mock.calls[0][0]).not.toContain('unreadable');
  });

  it('reports the Pulumi getParameter invoke error for a missing parameter as not found', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const lookup = vi.fn(async (name: string) => {
      throw new Error(
        'invocation of aws:ssm/getParameter:getParameter returned an error: invoking ' +
          'aws:ssm/getParameter:getParameter: 1 error occurred:\n' +
          `\t* reading SSM Parameter (${name}): couldn't find resource\n\n`
      );
    });
    const { result } = await run('alice', {}, lookup);
    expect(result).toBe('skipped-missing');
    expect(warn.mock.calls[0][0]).toBe(
      `[mail] personal stage alice: no SES defaults (${SET_PARAM} not found; ${IDENTITY_PARAM} not found), staying on SMTP`
    );
  });

  it('reports an SDK error named ParameterNotFound as not found', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const lookup = vi.fn(async () => {
      throw Object.assign(new Error('Parameter does not exist'), { name: 'ParameterNotFound' });
    });
    await run('alice', {}, lookup);
    expect(warn.mock.calls[0][0]).toContain(`${SET_PARAM} not found`);
    expect(warn.mock.calls[0][0]).not.toContain('unreadable');
  });

  it.each([
    ['AccessDeniedException: User is not authorized to perform: ssm:GetParameter'],
    ['ThrottlingException: Rate exceeded'],
  ])('keeps %s unreadable and stays on SMTP', async message => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const env: NodeJS.ProcessEnv = {};
    const lookup = vi.fn(async () => {
      throw new Error(message);
    });
    const { result } = await run('alice', env, lookup);
    expect(result).toBe('skipped-missing');
    expect(env).toEqual({});
    expect(warn.mock.calls[0][0]).toContain(`${SET_PARAM} unreadable (${message})`);
    expect(warn.mock.calls[0][0]).not.toContain('not found');
  });

  it('collapses a multi-line lookup error to one capped line in the warning', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const lookup = vi.fn(async () => {
      throw new Error(`ExpiredTokenException: token expired\n\tat request\r\n  retry hint ${'x'.repeat(500)}`);
    });
    await run('alice', {}, lookup);
    const line: string = warn.mock.calls[0][0];
    expect(line).not.toMatch(/[\r\n\t]/);
    expect(line).toContain('unreadable (ExpiredTokenException: token expired at request retry hint x');
    expect(line).not.toContain('x'.repeat(250));
    expect(line).toContain('...)');
  });
});

describe('isPersonalMailStage', () => {
  it('matches only non-production, non-shared, non-preview stages', () => {
    expect(isPersonalMailStage('alice', {})).toBe(true);
    expect(isPersonalMailStage('pr42-alice', {})).toBe(true);
    expect(isPersonalMailStage('production', {})).toBe(false);
    expect(isPersonalMailStage('dev', {})).toBe(false);
    expect(isPersonalMailStage('shared-dev', {})).toBe(false);
    expect(isPersonalMailStage('pr42', {})).toBe(false);
    expect(isPersonalMailStage('alice', { IS_PREVIEW: 'true' })).toBe(false);
  });
});

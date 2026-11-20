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
    ['pr123', {}],
    ['alice', { IS_PREVIEW: 'true' }],
    ['alice', { B4M_SELF_HOST: 'true' }],
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
    const env: NodeJS.ProcessEnv = {};
    const { result, lookup } = await run('alice', env);
    expect(result).toBe('applied');
    expect(lookup).toHaveBeenCalledWith(SET_PARAM);
    expect(lookup).toHaveBeenCalledWith(IDENTITY_PARAM);
    expect(env).toEqual({ MAIL_TRANSPORT: 'ses', SES_CONFIGURATION_SET: 'set-a', SES_IDENTITY: 'example.com' });
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
  ])('stays on SMTP and sets nothing when %s', async (_case, lookup) => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const env: NodeJS.ProcessEnv = {};
    const { result } = await run('alice', env, lookup);
    expect(result).toBe('skipped-missing');
    expect(env).toEqual({});
    expect(warn).toHaveBeenCalledTimes(1);
  });
});

describe('isPersonalMailStage', () => {
  it('matches only non-production, non-preview, non-self-host stages', () => {
    expect(isPersonalMailStage('alice', {})).toBe(true);
    expect(isPersonalMailStage('pr42-alice', {})).toBe(true);
    expect(isPersonalMailStage('production', {})).toBe(false);
    expect(isPersonalMailStage('dev', {})).toBe(false);
    expect(isPersonalMailStage('pr42', {})).toBe(false);
    expect(isPersonalMailStage('alice', { IS_PREVIEW: 'true' })).toBe(false);
    expect(isPersonalMailStage('alice', { B4M_SELF_HOST: 'true' })).toBe(false);
  });
});

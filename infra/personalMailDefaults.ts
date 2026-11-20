/**
 * SES defaults for personal (per-developer) stages, applied in sst.config.ts before infra/ loads.
 *
 * A personal stage deployed from a clean shell would otherwise fall back to SMTP. When the deploy
 * account holds the two shared SSM parameters below, their values become SES_CONFIGURATION_SET and
 * SES_IDENTITY and MAIL_TRANSPORT becomes `ses`; infra/mailTransport.ts then reads the filled env as
 * it would an exported one. The names are read from SSM rather than written into this repo.
 *
 * Production, dev, shared-dev and previews keep whatever the deployer exports. Any explicit
 * MAIL_TRANSPORT / SES_* value wins, so MAIL_TRANSPORT=smtp is the opt-out.
 */
import { PRODUCTION_STAGES } from '@bike4mind/infra';

export type PersonalMailDefaultsResult = 'applied' | 'skipped-stage' | 'skipped-explicit' | 'skipped-missing';

const EXPLICIT_KEYS = ['MAIL_TRANSPORT', 'SES_IDENTITY', 'SES_CONFIGURATION_SET'] as const;

// shared-dev is a permanent team stage (sst.config.ts), so it opts in explicitly like dev.
const NON_PERSONAL_STAGES = ['shared-dev'];

// Preview test must stay in sync with isPreviewStage in infra/constants.ts, which reads $app and so
// cannot load here.
export const isPersonalMailStage = (stage: string, env: NodeJS.ProcessEnv): boolean =>
  !PRODUCTION_STAGES.includes(stage) &&
  !NON_PERSONAL_STAGES.includes(stage) &&
  !(env.IS_PREVIEW === 'true' || /^pr\d+$/.test(stage));

export const personalMailParameterNames = (appName: string) => ({
  configurationSet: `/${appName}/shared/mail/ses-configuration-set`,
  identity: `/${appName}/shared/mail/ses-identity`,
});

// The values land in the SES grant's resource ARNs (infra/mailTransport.ts), so anything that is not a
// plain name (a wildcard, a slash, whitespace) is rejected rather than widening the grant.
const CONFIGURATION_SET_SHAPE = /^[A-Za-z0-9_-]{1,64}$/;
const IDENTITY_SHAPE = /^([A-Za-z0-9._%+-]+@)?[A-Za-z0-9-]+(\.[A-Za-z0-9-]+)+$/;

type ParameterRead = { value: string } | { problem: string };

const MAX_ERROR_DETAIL = 200;

// The AWS SDK names the error ParameterNotFound; the Pulumi getParameter invoke surfaces the
// provider's "couldn't find resource" text instead, with no ParameterNotFound token.
const isParameterMissing = (error: unknown, message: string): boolean => {
  const { name, code } = (error ?? {}) as { name?: unknown; code?: unknown };
  return (
    name === 'ParameterNotFound' ||
    code === 'ParameterNotFound' ||
    message.includes('ParameterNotFound') ||
    message.includes("couldn't find resource")
  );
};

const errorDetail = (message: string): string => {
  const line = message.replace(/\s+/g, ' ').trim();
  return line.length > MAX_ERROR_DETAIL ? `${line.slice(0, MAX_ERROR_DETAIL)}...` : line;
};

const readParameter = async (
  lookup: (name: string) => Promise<string | undefined>,
  name: string,
  shape: RegExp
): Promise<ParameterRead> => {
  let value: string | undefined;
  try {
    value = (await lookup(name))?.trim();
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return {
      problem: isParameterMissing(error, message)
        ? `${name} not found`
        : `${name} unreadable (${errorDetail(message)})`,
    };
  }
  if (!value) return { problem: `${name} not found` };
  if (!shape.test(value)) return { problem: `${name} is not a valid SES name` };
  return { value };
};

export async function applyPersonalMailDefaults({
  stage,
  env,
  lookup,
  appName,
}: {
  stage: string;
  env: NodeJS.ProcessEnv;
  lookup: (name: string) => Promise<string | undefined>;
  appName: string;
}): Promise<PersonalMailDefaultsResult> {
  if (!isPersonalMailStage(stage, env)) return 'skipped-stage';
  if (EXPLICIT_KEYS.some(key => env[key])) return 'skipped-explicit';

  const names = personalMailParameterNames(appName);
  const [configurationSet, identity] = await Promise.all([
    readParameter(lookup, names.configurationSet, CONFIGURATION_SET_SHAPE),
    readParameter(lookup, names.identity, IDENTITY_SHAPE),
  ]);
  if (!('value' in configurationSet) || !('value' in identity)) {
    const problems = [configurationSet, identity].flatMap(read => ('problem' in read ? [read.problem] : []));
    console.warn(`[mail] personal stage ${stage}: no SES defaults (${problems.join('; ')}), staying on SMTP`);
    return 'skipped-missing';
  }

  env.MAIL_TRANSPORT = 'ses';
  env.SES_CONFIGURATION_SET = configurationSet.value;
  env.SES_IDENTITY = identity.value;
  console.log(
    `[mail] personal stage ${stage}: defaulting to SES (identity ${identity.value}); export MAIL_TRANSPORT=smtp to opt out`
  );
  return 'applied';
}

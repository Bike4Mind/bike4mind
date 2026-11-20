/**
 * SES defaults for personal (per-developer) stages, applied in sst.config.ts before infra/ loads.
 *
 * A personal stage deployed from a clean shell would otherwise fall back to SMTP. When the deploy
 * account holds the two shared SSM parameters below, their values become SES_CONFIGURATION_SET and
 * SES_IDENTITY and MAIL_TRANSPORT becomes `ses`; infra/mailTransport.ts then reads the filled env as
 * it would an exported one. The names are read from SSM rather than written into this repo.
 *
 * Production, dev, previews and self-host keep whatever the deployer exports. Any explicit
 * MAIL_TRANSPORT / SES_* value wins, so MAIL_TRANSPORT=smtp is the opt-out.
 */
import { PRODUCTION_STAGES } from '@bike4mind/infra';

export type PersonalMailDefaultsResult = 'applied' | 'skipped-stage' | 'skipped-explicit' | 'skipped-missing';

const EXPLICIT_KEYS = ['MAIL_TRANSPORT', 'SES_IDENTITY', 'SES_CONFIGURATION_SET'] as const;

// Preview test mirrors isPreviewStage in infra/constants.ts, which reads $app and so cannot load here.
export const isPersonalMailStage = (stage: string, env: NodeJS.ProcessEnv): boolean =>
  !PRODUCTION_STAGES.includes(stage) &&
  !(env.IS_PREVIEW === 'true' || /^pr\d+$/.test(stage)) &&
  env.B4M_SELF_HOST !== 'true';

export const personalMailParameterNames = (appName: string) => ({
  configurationSet: `/${appName}/shared/mail/ses-configuration-set`,
  identity: `/${appName}/shared/mail/ses-identity`,
});

const readParameter = async (lookup: (name: string) => Promise<string | undefined>, name: string) => {
  try {
    return (await lookup(name))?.trim() || undefined;
  } catch {
    return undefined;
  }
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
    readParameter(lookup, names.configurationSet),
    readParameter(lookup, names.identity),
  ]);
  if (!configurationSet || !identity) {
    console.warn(
      `[mail] personal stage ${stage}: SES defaults not found under /${appName}/shared/mail/, staying on SMTP`
    );
    return 'skipped-missing';
  }

  env.MAIL_TRANSPORT = 'ses';
  env.SES_CONFIGURATION_SET = configurationSet;
  env.SES_IDENTITY = identity;
  return 'applied';
}

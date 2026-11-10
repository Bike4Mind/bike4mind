/**
 * Outbound mail transport for the email-send worker (apps/workers/src/events/sendEmail.ts).
 *
 * MAIL_TRANSPORT selects the transport the worker uses at runtime: `smtp` (the default, nodemailer
 * against the MAIL_* secrets) or `ses` (the SESv2 SDK under the worker's execution role). The SES
 * grant is scoped to the verified sending identity and the configuration set the deployer names,
 * so it is built here from the account and region the stage deploys into rather than written down.
 * The grant exists whenever both names are set, so a tier can carry it while still on SMTP and flip
 * the transport in a later deploy without an IAM change in the same step.
 *
 * Scope: only the email-send worker receives the flag and the grant. Processes that call
 * MailService in-process (the web server function, the email batch and spend-notifier workers,
 * moderation incidents) keep sending over SMTP, so the MAIL_* secrets stay required until those
 * paths are routed through the email.send event or given the same environment and grant.
 */
import { otcEmailConfigurationSet } from './otcEmailMetrics';

export type MailTransportKind = 'smtp' | 'ses';

// Same normalisation as resolveMailTransportKind in packages/server-utils, so `SES` or ` ses ` cannot
// build no grant here while the runtime would have picked the SDK.
export const mailTransport: MailTransportKind =
  process.env.MAIL_TRANSPORT?.trim().toLowerCase() === 'ses' ? 'ses' : 'smtp';
export const sesConfigurationSet = process.env.SES_CONFIGURATION_SET || '';
export const sesIdentity = process.env.SES_IDENTITY || '';

if (mailTransport === 'ses' && (!sesConfigurationSet || !sesIdentity)) {
  throw new Error('MAIL_TRANSPORT=ses requires SES_CONFIGURATION_SET and SES_IDENTITY');
}

const partition = aws.getPartitionOutput().partition;
const region = aws.getRegionOutput().name;
const accountId = aws.getCallerIdentityOutput().accountId;

const sesArn = (suffix: string) => $interpolate`arn:${partition}:ses:${region}:${accountId}:${suffix}`;

export const sesSendPermissions =
  sesConfigurationSet && sesIdentity
    ? [
        {
          actions: ['ses:SendEmail', 'ses:SendRawEmail'],
          resources: [
            sesArn(`identity/${sesIdentity}`),
            sesArn(`configuration-set/${sesConfigurationSet}`),
            ...(otcEmailConfigurationSet ? [otcEmailConfigurationSet.arn] : []),
          ],
        },
      ]
    : [];

export const mailTransportEnvironment = {
  MAIL_TRANSPORT: mailTransport,
  SES_CONFIGURATION_SET: sesConfigurationSet,
};

import { isPlaceholderValue } from '@bike4mind/common';
import { Config } from '../config';
import { resolveMailTransportKind, type MailTransportEnv, type MailTransportKind } from './transport';

export type MailSecretName = 'MAIL_HOST' | 'MAIL_PORT' | 'MAIL_USERNAME' | 'MAIL_PASSWORD' | 'MAIL_FROM';

/** Where the sender comes from: the mailFrom admin setting, or the MAIL_FROM secret. */
export type MailSenderSource = 'setting' | 'secret';

export interface EmailConfigStatus {
  configured: boolean;
  transport: MailTransportKind;
  missingSecrets: MailSecretName[];
  /** Settings that may stay unset: on self-host, the SMTP credentials when neither is set, for a relay without auth. */
  optionalSecrets: MailSecretName[];
  /** Only the secrets this transport needs, so an SES stage never lists the SMTP credentials. */
  secrets: Partial<Record<MailSecretName, boolean>>;
  /** Absent when neither the setting nor the secret holds a sender. */
  senderSource?: MailSenderSource;
}

const SMTP_SECRETS: readonly MailSecretName[] = [
  'MAIL_HOST',
  'MAIL_PORT',
  'MAIL_USERNAME',
  'MAIL_PASSWORD',
  'MAIL_FROM',
];

const SMTP_CREDENTIALS: readonly MailSecretName[] = ['MAIL_USERNAME', 'MAIL_PASSWORD'];

/** SES authenticates with the execution role, so it needs only the sender. */
export function requiredMailSecrets(kind: MailTransportKind): MailSecretName[] {
  return kind === 'ses' ? ['MAIL_FROM'] : [...SMTP_SECRETS];
}

/** Mail settings the transport never reads, so secret lists can leave them out. */
export function unusedMailSecrets(kind: MailTransportKind = statusTransportKind()): MailSecretName[] {
  const required = requiredMailSecrets(kind);
  return SMTP_SECRETS.filter(name => !required.includes(name));
}

export function isUnsetMailValue(value: string | undefined | null): boolean {
  return isPlaceholderValue(value) || !value?.trim();
}

/**
 * A self-host SMTP relay that takes no auth: both credentials unset. Hosted stages always need the
 * credentials, and one set without the other is a mistake, so neither counts.
 */
export function isUnauthenticatedSmtpRelay(env: MailTransportEnv = process.env): boolean {
  return env.B4M_SELF_HOST === 'true' && SMTP_CREDENTIALS.every(name => isUnsetMailValue(Config[name]));
}

/**
 * The transport a process that only reports mail status should describe. Such a process never sends,
 * so infra/mailTransport.ts gives it MAIL_STATUS_TRANSPORT instead of MAIL_TRANSPORT and the SES grant.
 */
export function statusTransportKind(env: MailTransportEnv = process.env): MailTransportKind {
  return resolveMailTransportKind({
    B4M_SELF_HOST: env.B4M_SELF_HOST,
    MAIL_TRANSPORT: env.MAIL_STATUS_TRANSPORT !== undefined ? env.MAIL_STATUS_TRANSPORT : env.MAIL_TRANSPORT,
  });
}

/** `senderFromSetting`: the mailFrom admin setting holds a valid sender, so MAIL_FROM counts as set (sender.ts reads it). */
export function getMailConfigStatus(
  kind: MailTransportKind = statusTransportKind(),
  senderFromSetting = false
): EmailConfigStatus {
  const required = requiredMailSecrets(kind);
  const secrets: Partial<Record<MailSecretName, boolean>> = {};
  for (const name of required) secrets[name] = !isUnsetMailValue(Config[name]);
  if (senderFromSetting) secrets.MAIL_FROM = true;
  const optionalSecrets = kind === 'smtp' && isUnauthenticatedSmtpRelay() ? [...SMTP_CREDENTIALS] : [];
  const missingSecrets = required.filter(name => !secrets[name] && !optionalSecrets.includes(name));
  const senderSource: MailSenderSource | undefined = senderFromSetting
    ? 'setting'
    : secrets.MAIL_FROM
      ? 'secret'
      : undefined;
  return {
    configured: missingSecrets.length === 0,
    transport: kind,
    missingSecrets,
    optionalSecrets,
    secrets,
    ...(senderSource && { senderSource }),
  };
}

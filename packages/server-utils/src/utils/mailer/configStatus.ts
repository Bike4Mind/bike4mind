import { isPlaceholderValue } from '@bike4mind/common';
import { Config } from '../config';
import { resolveMailTransportKind, type MailTransportEnv, type MailTransportKind } from './transport';

export type MailSecretName = 'MAIL_HOST' | 'MAIL_PORT' | 'MAIL_USERNAME' | 'MAIL_PASSWORD' | 'MAIL_FROM';

export interface EmailConfigStatus {
  configured: boolean;
  transport: MailTransportKind;
  missingSecrets: MailSecretName[];
  /** Settings that may stay unset: the SMTP credentials when neither is set, for a relay without auth. */
  optionalSecrets: MailSecretName[];
  /** Only the secrets this transport needs, so an SES stage never lists the SMTP credentials. */
  secrets: Partial<Record<MailSecretName, boolean>>;
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

export function isUnsetMailValue(value: string | undefined | null): boolean {
  return isPlaceholderValue(value) || !value?.trim();
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

export function getMailConfigStatus(kind: MailTransportKind = statusTransportKind()): EmailConfigStatus {
  const required = requiredMailSecrets(kind);
  const secrets: Partial<Record<MailSecretName, boolean>> = {};
  for (const name of required) secrets[name] = !isUnsetMailValue(Config[name]);
  // The SMTP credentials are a pair: both unset is a relay without auth, one alone is a mistake.
  const credentialsUnset = kind === 'smtp' && SMTP_CREDENTIALS.every(name => !secrets[name]);
  const optionalSecrets = credentialsUnset ? [...SMTP_CREDENTIALS] : [];
  const missingSecrets = required.filter(name => !secrets[name] && !optionalSecrets.includes(name));
  return { configured: missingSecrets.length === 0, transport: kind, missingSecrets, optionalSecrets, secrets };
}

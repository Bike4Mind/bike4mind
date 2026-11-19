import { isPlaceholderValue } from '@bike4mind/common';
import { Config } from '../config';
import { resolveMailTransportKind, type MailTransportEnv, type MailTransportKind } from './transport';

export type MailSecretName = 'MAIL_HOST' | 'MAIL_PORT' | 'MAIL_USERNAME' | 'MAIL_PASSWORD' | 'MAIL_FROM';

export interface EmailConfigStatus {
  configured: boolean;
  transport: MailTransportKind;
  missingSecrets: MailSecretName[];
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

/** SES authenticates with the execution role, so it needs only the sender. */
export function requiredMailSecrets(kind: MailTransportKind): MailSecretName[] {
  return kind === 'ses' ? ['MAIL_FROM'] : [...SMTP_SECRETS];
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
  for (const name of required) secrets[name] = !isPlaceholderValue(Config[name]);
  const missingSecrets = required.filter(name => !secrets[name]);
  return { configured: missingSecrets.length === 0, transport: kind, missingSecrets, secrets };
}

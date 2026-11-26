import addressparser from 'nodemailer/lib/addressparser';
import { MAIL_FROM_SETTING_MAX_LENGTH } from '@bike4mind/common';
import { adminSettingsRepository } from '@bike4mind/database';
import { Logger } from '@bike4mind/observability';
import { Config } from '../config';
import {
  getMailConfigStatus,
  isUnsetMailValue,
  statusTransportKind,
  type EmailConfigStatus,
  type MailSenderSource,
} from './configStatus';
import type { MailTransportKind } from './transport';

export interface MailSender {
  from: string;
  source: MailSenderSource;
}

const ADDRESS = /^[^\s@<>]+@[^\s@<>]+$/;

/** The address of `value` when it is exactly one mailbox, with or without a display name. */
export function parseMailSender(value: string): string | undefined {
  if (value.length > MAIL_FROM_SETTING_MAX_LENGTH || /[\r\n]/.test(value)) return undefined;
  const entries = addressparser(value);
  if (entries.length !== 1) return undefined;
  const [entry] = entries;
  if ('group' in entry || !ADDRESS.test(entry.address) || entry.name.includes('@')) return undefined;
  return entry.address;
}

const domainOf = (address: string) => address.slice(address.lastIndexOf('@') + 1).toLowerCase();

/**
 * Why `value` cannot be saved as the mailFrom setting, or undefined when it can; blank clears it.
 * The web function does not know the stage's SES identity, so SES holds the address to the MAIL_FROM secret's domain.
 */
export function mailSenderSettingProblem(
  value: string,
  { transport, secretFrom }: { transport: MailTransportKind; secretFrom: string | undefined }
): string | undefined {
  if (value.trim() === '') return undefined;
  if (/[\r\n]/.test(value)) return 'The sender must be on one line.';
  if (value.length > MAIL_FROM_SETTING_MAX_LENGTH) {
    return `The sender must be at most ${MAIL_FROM_SETTING_MAX_LENGTH} characters.`;
  }
  const address = parseMailSender(value);
  if (!address) {
    return 'Enter one sender, such as noreply@example.com or Example <noreply@example.com>.';
  }
  const secretAddress = transport === 'ses' && !isUnsetMailValue(secretFrom) ? parseMailSender(secretFrom!) : undefined;
  if (secretAddress && domainOf(address) !== domainOf(secretAddress)) {
    return `On Amazon SES the sender must use the domain of the MAIL_FROM secret (${domainOf(secretAddress)}).`;
  }
  return undefined;
}

/** The sender for the next email: the mailFrom admin setting when it holds a valid mailbox, else the MAIL_FROM secret. */
export async function resolveMailSender(): Promise<MailSender> {
  let setting = '';
  try {
    const row = await adminSettingsRepository.findOne({ settingName: 'mailFrom' });
    if (typeof row?.settingValue === 'string') setting = row.settingValue.trim();
  } catch (error) {
    Logger.warn(
      `Could not read the mailFrom admin setting, sending from the MAIL_FROM secret: ${error instanceof Error ? error.message : String(error)}`
    );
  }
  if (setting) {
    if (parseMailSender(setting)) return { from: setting, source: 'setting' };
    Logger.warn('The mailFrom admin setting is not a single valid sender; sending from the MAIL_FROM secret instead.');
  }
  return { from: Config.MAIL_FROM, source: 'secret' };
}

/** getMailConfigStatus with the mailFrom admin setting counted as a sender. */
export async function loadMailConfigStatus(
  kind: MailTransportKind = statusTransportKind()
): Promise<EmailConfigStatus> {
  const { source } = await resolveMailSender();
  return getMailConfigStatus(kind, source === 'setting');
}

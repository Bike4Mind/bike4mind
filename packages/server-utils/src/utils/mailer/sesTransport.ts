import {
  SESv2Client,
  SendEmailCommand,
  type EmailContent,
  type MessageHeader,
  type SendEmailCommandInput,
} from '@aws-sdk/client-sesv2';
import MailComposer from 'nodemailer/lib/mail-composer';
import addressparser from 'nodemailer/lib/addressparser';
import type Mail from 'nodemailer/lib/mailer';
import type { MailSendContext, MailSendResult, MailTransport } from './transport';

export interface SesTransportOptions {
  /** The stage's configuration set; applied to every send unless the category names its own. */
  configurationSet?: string;
  /** Configuration set for `otc` mail. Wins over `configurationSet` for that category. */
  otcConfigurationSet?: string;
  client?: SESv2Client;
}

/**
 * Sends through the SESv2 API under the process's AWS credentials (the Lambda execution role on a
 * hosted stage), so no SMTP credential is involved. Plain mail goes as Simple content; anything
 * Simple cannot carry is composed into MIME by nodemailer and sent Raw.
 */
export class SesTransport implements MailTransport {
  readonly kind = 'ses' as const;
  private readonly client: SESv2Client;

  constructor(private readonly options: SesTransportOptions = {}) {
    this.client = options.client ?? new SESv2Client({});
  }

  // Probing the account would need its own IAM grant; a role that cannot send fails on the first
  // send with a typed SES error, which the caller already logs.
  async verify(): Promise<void> {}

  configurationSetFor(category: MailSendContext['category']): string | undefined {
    if (category === 'otc' && this.options.otcConfigurationSet) return this.options.otcConfigurationSet;
    return this.options.configurationSet;
  }

  async send(mail: Mail.Options, context: MailSendContext = {}): Promise<MailSendResult> {
    const configurationSet = this.configurationSetFor(context.category);
    const input: SendEmailCommandInput = {
      FromEmailAddress: addressList(mail.from)[0],
      Destination: {
        ToAddresses: addressList(mail.to),
        ...nonEmpty('CcAddresses', addressList(mail.cc)),
        ...nonEmpty('BccAddresses', addressList(mail.bcc)),
      },
      ...nonEmpty('ReplyToAddresses', addressList(mail.replyTo)),
      Content: await buildContent(mail),
      ...(configurationSet ? { ConfigurationSetName: configurationSet } : {}),
    };
    const result = await this.client.send(new SendEmailCommand(input));
    return { messageId: result.MessageId ?? '' };
  }

  describe(): string {
    return `SES configurationSet=${this.options.configurationSet ?? 'none'}`;
  }
}

/** Simple content carries only string bodies and headers; everything else needs a MIME message. */
export function needsRawMime(mail: Mail.Options): boolean {
  const stringOrAbsent = (value: unknown) => value === undefined || value === null || typeof value === 'string';
  const hasBody = typeof mail.text === 'string' || typeof mail.html === 'string';
  return (
    !hasBody ||
    !stringOrAbsent(mail.text) ||
    !stringOrAbsent(mail.html) ||
    Boolean(mail.attachments?.length) ||
    Boolean(mail.alternatives?.length) ||
    mail.icalEvent !== undefined ||
    mail.raw !== undefined
  );
}

async function buildContent(mail: Mail.Options): Promise<EmailContent> {
  if (needsRawMime(mail)) {
    // nodemailer only strips Bcc when its SMTP sender runs; MailComposer alone would write the
    // header into the bytes. Bcc recipients travel in Destination.BccAddresses instead.
    const { bcc: _bcc, ...visible } = mail;
    const data = await new MailComposer(visible).compile().build();
    return { Raw: { Data: data } };
  }
  const headers = toMessageHeaders(mail.headers);
  return {
    Simple: {
      Subject: { Data: mail.subject ?? '', Charset: 'UTF-8' },
      Body: {
        ...(typeof mail.text === 'string' ? { Text: { Data: mail.text, Charset: 'UTF-8' } } : {}),
        ...(typeof mail.html === 'string' ? { Html: { Data: mail.html, Charset: 'UTF-8' } } : {}),
      },
      ...(headers.length ? { Headers: headers } : {}),
    },
  };
}

// Header and address values are typed loosely on purpose: nodemailer's own declarations and
// @types/nodemailer disagree on the shapes, and both accept nested arrays, address objects and
// prepared header values. Walking unknown input keeps this correct under either set.
function toMessageHeaders(headers: Mail.Options['headers']): MessageHeader[] {
  if (!headers) return [];
  if (Array.isArray(headers)) {
    return headers.flatMap(({ key, value }) => headerValues(value).map(Value => ({ Name: key, Value })));
  }
  return Object.entries(headers).flatMap(([name, value]) => headerValues(value).map(Value => ({ Name: name, Value })));
}

function headerValues(value: unknown): string[] {
  if (value === null || value === undefined) return [];
  if (typeof value === 'string') return [value];
  if (typeof value === 'number' || typeof value === 'boolean') return [String(value)];
  if (value instanceof Date) return [value.toUTCString()];
  if (Array.isArray(value)) return value.flatMap(headerValues);
  if (typeof value === 'object') {
    const record = value as { value?: unknown; address?: unknown };
    if (typeof record.value === 'string') return [record.value];
    if (typeof record.address === 'string') return addressList(record);
  }
  return [];
}

/** Flattens any nodemailer address field into the `Name <address>` strings SES accepts. */
export function addressList(field: unknown): string[] {
  if (!field) return [];
  if (typeof field === 'string') return addressparser(field, { flatten: true }).flatMap(formatAddress);
  if (Array.isArray(field)) return field.flatMap(addressList);
  if (typeof field === 'object') {
    const record = field as { name?: unknown; address?: unknown; group?: unknown };
    if (Array.isArray(record.group)) return addressList(record.group);
    return formatAddress({ name: typeof record.name === 'string' ? record.name : '', address: record.address });
  }
  return [];
}

function formatAddress({ name, address }: { name: string; address: unknown }): string[] {
  if (typeof address !== 'string' || !address) return [];
  return [name ? `"${name.replace(/"/g, '\\"')}" <${address}>` : address];
}

function nonEmpty<K extends string>(key: K, values: string[]): Partial<Record<K, string[]>> {
  return values.length ? ({ [key]: values } as Record<K, string[]>) : {};
}

import { describe, it, expect, beforeEach } from 'vitest';
import { mockClient } from 'aws-sdk-client-mock';
import { SESv2Client, SendEmailCommand, type SendEmailCommandInput } from '@aws-sdk/client-sesv2';
import { SesTransport, addressList, needsRawMime } from './sesTransport';

const sesMock = mockClient(SESv2Client);

function lastInput(): SendEmailCommandInput {
  const calls = sesMock.commandCalls(SendEmailCommand);
  expect(calls).toHaveLength(1);
  return calls[0].args[0].input;
}

function rawText(input: SendEmailCommandInput): string {
  const data = input.Content?.Raw?.Data;
  expect(data).toBeInstanceOf(Uint8Array);
  return Buffer.from(data as Uint8Array).toString('utf8');
}

describe('SesTransport', () => {
  beforeEach(() => {
    sesMock.reset();
    sesMock.on(SendEmailCommand).resolves({ MessageId: 'ses-message-id' });
  });

  it('sends plain mail as Simple content with the subject and both bodies', async () => {
    const transport = new SesTransport({ client: new SESv2Client({}) });
    const result = await transport.send({
      from: 'noreply@example.com',
      to: 'user@test.com',
      subject: 'Welcome',
      text: 'Hello',
      html: '<h1>Hello</h1>',
    });

    expect(result).toEqual({ messageId: 'ses-message-id' });
    const input = lastInput();
    expect(input.FromEmailAddress).toBe('noreply@example.com');
    expect(input.Destination).toEqual({ ToAddresses: ['user@test.com'] });
    expect(input.ConfigurationSetName).toBeUndefined();
    expect(input.Content).toEqual({
      Simple: {
        Subject: { Data: 'Welcome', Charset: 'UTF-8' },
        Body: {
          Text: { Data: 'Hello', Charset: 'UTF-8' },
          Html: { Data: '<h1>Hello</h1>', Charset: 'UTF-8' },
        },
      },
    });
  });

  it('carries cc, bcc, reply-to and custom headers on Simple content', async () => {
    const transport = new SesTransport({ client: new SESv2Client({}) });
    await transport.send({
      from: { name: 'Ops Team', address: 'ops@example.com' },
      to: 'a@test.com, "Doe, Jane" <jane@test.com>',
      cc: ['cc@test.com'],
      bcc: { name: 'Audit', address: 'audit@test.com' },
      replyTo: 'support@example.com',
      subject: 'Headers',
      html: '<p>Hi</p>',
      headers: { 'X-Campaign': 'spring', 'X-Multi': ['one', 'two'] },
    });

    const input = lastInput();
    expect(input.FromEmailAddress).toBe('"Ops Team" <ops@example.com>');
    expect(input.Destination).toEqual({
      ToAddresses: ['a@test.com', '"Doe, Jane" <jane@test.com>'],
      CcAddresses: ['cc@test.com'],
      BccAddresses: ['"Audit" <audit@test.com>'],
    });
    expect(input.ReplyToAddresses).toEqual(['support@example.com']);
    expect(input.Content?.Simple?.Headers).toEqual([
      { Name: 'X-Campaign', Value: 'spring' },
      { Name: 'X-Multi', Value: 'one' },
      { Name: 'X-Multi', Value: 'two' },
    ]);
    expect(input.Content?.Simple?.Body).toEqual({ Html: { Data: '<p>Hi</p>', Charset: 'UTF-8' } });
  });

  it('sends Raw MIME when attachments are present, built by nodemailer', async () => {
    const transport = new SesTransport({ client: new SESv2Client({}), configurationSet: 'stage-set' });
    await transport.send({
      from: 'noreply@example.com',
      to: 'user@test.com',
      subject: 'Your report',
      html: '<p>Attached</p>',
      attachments: [{ filename: 'report.txt', content: Buffer.from('line one\nline two'), contentType: 'text/plain' }],
    });

    const input = lastInput();
    expect(input.Content?.Simple).toBeUndefined();
    expect(input.ConfigurationSetName).toBe('stage-set');
    expect(input.Destination).toEqual({ ToAddresses: ['user@test.com'] });
    const mime = rawText(input);
    expect(mime).toContain('From: noreply@example.com');
    expect(mime).toContain('To: user@test.com');
    expect(mime).toContain('Subject: Your report');
    expect(mime).toMatch(/Content-Type: multipart\/mixed/);
    expect(mime).toContain('Content-Disposition: attachment; filename=report.txt');
    expect(mime).toContain(Buffer.from('line one\nline two').toString('base64'));
    expect(mime).toContain('<p>Attached</p>');
  });

  it('keeps bcc recipients out of the Raw MIME bytes while still addressing them', async () => {
    const transport = new SesTransport({ client: new SESv2Client({}) });
    await transport.send({
      from: 'noreply@example.com',
      to: 'user@test.com',
      bcc: 'hidden@test.com',
      messageId: '<contains-bcc@example.com>',
      subject: 'Report',
      html: '<p>Attached</p>',
      attachments: [{ filename: 'a.txt', content: 'x', contentType: 'text/plain' }],
    });

    const input = lastInput();
    expect(input.Destination?.BccAddresses).toEqual(['hidden@test.com']);
    const mime = rawText(input);
    expect(mime).toContain('To: user@test.com');
    expect(mime).not.toMatch(/^bcc:/im);
    expect(mime).not.toContain('hidden@test.com');
  });

  describe('configuration set selection', () => {
    it('applies the stage set to uncategorized mail', async () => {
      const transport = new SesTransport({
        client: new SESv2Client({}),
        configurationSet: 'stage-set',
        otcConfigurationSet: 'otc-set',
      });
      await transport.send({ from: 'a@example.com', to: 'b@test.com', subject: 's', text: 't' });
      expect(lastInput().ConfigurationSetName).toBe('stage-set');
    });

    it('prefers the OTC set for otc mail', async () => {
      const transport = new SesTransport({
        client: new SESv2Client({}),
        configurationSet: 'stage-set',
        otcConfigurationSet: 'otc-set',
      });
      await transport.send({ from: 'a@example.com', to: 'b@test.com', subject: 's', text: 't' }, { category: 'otc' });
      expect(lastInput().ConfigurationSetName).toBe('otc-set');
    });

    it('falls back to the stage set for otc mail when no OTC set exists', async () => {
      const transport = new SesTransport({ client: new SESv2Client({}), configurationSet: 'stage-set' });
      await transport.send({ from: 'a@example.com', to: 'b@test.com', subject: 's', text: 't' }, { category: 'otc' });
      expect(lastInput().ConfigurationSetName).toBe('stage-set');
    });

    it('omits the parameter entirely when no set is configured', async () => {
      const transport = new SesTransport({ client: new SESv2Client({}) });
      await transport.send({ from: 'a@example.com', to: 'b@test.com', subject: 's', text: 't' }, { category: 'otc' });
      expect('ConfigurationSetName' in lastInput()).toBe(false);
    });
  });

  it('surfaces SES rejections to the caller', async () => {
    sesMock
      .on(SendEmailCommand)
      .rejects(Object.assign(new Error('Email address is not verified.'), { name: 'MessageRejected' }));
    const transport = new SesTransport({ client: new SESv2Client({}) });
    await expect(transport.send({ from: 'a@example.com', to: 'b@test.com', subject: 's', text: 't' })).rejects.toThrow(
      'Email address is not verified.'
    );
  });

  it('describes itself without credentials', () => {
    expect(new SesTransport({ configurationSet: 'stage-set' }).describe()).toBe('SES configurationSet=stage-set');
    expect(new SesTransport().describe()).toBe('SES configurationSet=none');
  });
});

describe('needsRawMime', () => {
  it.each([
    ['text only', { text: 'hi' }, false],
    ['html only', { html: '<p>hi</p>' }, false],
    ['string bodies with headers', { html: '<p>hi</p>', headers: { 'X-A': 'b' } }, false],
    ['attachments', { html: '<p>hi</p>', attachments: [{ filename: 'a.txt', content: 'x' }] }, true],
    ['empty attachments array', { html: '<p>hi</p>', attachments: [] }, false],
    ['alternatives', { text: 'hi', alternatives: [{ contentType: 'text/x-web-markdown', content: '# hi' }] }, true],
    ['calendar invite', { text: 'hi', icalEvent: 'BEGIN:VCALENDAR' }, true],
    ['prebuilt raw message', { raw: 'From: a@b\r\n\r\nhi' }, true],
    ['buffer body', { html: Buffer.from('<p>hi</p>') }, true],
    ['no body at all', { subject: 'only a subject' }, true],
  ])('%s -> raw=%s', (_label, mail, expected) => {
    expect(needsRawMime(mail)).toBe(expected);
  });
});

describe('addressList', () => {
  it('flattens strings, arrays and address objects into SES address strings', () => {
    expect(addressList(undefined)).toEqual([]);
    expect(addressList('a@test.com, b@test.com')).toEqual(['a@test.com', 'b@test.com']);
    expect(addressList(['a@test.com', { name: 'Bee', address: 'b@test.com' }])).toEqual([
      'a@test.com',
      '"Bee" <b@test.com>',
    ]);
    expect(addressList({ name: 'Quote "Q" Name', address: 'q@test.com' })).toEqual([
      '"Quote \\"Q\\" Name" <q@test.com>',
    ]);
  });
});

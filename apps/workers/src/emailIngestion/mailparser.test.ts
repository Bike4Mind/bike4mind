import { simpleParser } from 'mailparser';
import { describe, expect, it } from 'vitest';

function createMessage(headers: string[]): string {
  return [...headers, 'Subject: Parser regression', '', 'Hello parser', ''].join('\r\n');
}

describe('mailparser dependency regressions', () => {
  it('preserves ordinary message headers, body, and attachment bytes', async () => {
    const attachmentContent = Buffer.from('attachment bytes\n');
    const rawEmail = [
      'From: Sender <sender@example.com>',
      'To: Recipient <recipient@example.com>',
      'Subject: Ordinary message',
      'Message-ID: <ordinary@example.com>',
      'MIME-Version: 1.0',
      'Content-Type: multipart/mixed; boundary="probe-boundary"',
      '',
      '--probe-boundary',
      'Content-Type: text/plain; charset=utf-8',
      '',
      'Hello parser',
      '--probe-boundary',
      'Content-Type: application/octet-stream; name="hello.txt"',
      'Content-Disposition: attachment; filename="hello.txt"',
      'Content-Transfer-Encoding: base64',
      '',
      attachmentContent.toString('base64'),
      '--probe-boundary--',
      '',
    ].join('\r\n');

    const parsed = await simpleParser(Buffer.from(rawEmail));

    expect(parsed.from?.value).toEqual([{ name: 'Sender', address: 'sender@example.com' }]);
    expect(parsed.to).toMatchObject({ value: [{ name: 'Recipient', address: 'recipient@example.com' }] });
    expect(parsed.subject).toBe('Ordinary message');
    expect(parsed.messageId).toBe('<ordinary@example.com>');
    expect(parsed.text?.trim()).toBe('Hello parser');
    expect(parsed.attachments).toHaveLength(1);
    expect(parsed.attachments[0].filename).toBe('hello.txt');
    expect(parsed.attachments[0].content).toEqual(attachmentContent);
  });

  it('does not extract sender or recipient addresses from nested comments', async () => {
    const parsed = await simpleParser(
      createMessage([
        'From: sender@example.com (note (nested) evil@attacker.example)',
        'To: recipient@example.com (note (nested) evil@attacker.example)',
      ])
    );

    expect(parsed.from?.value).toEqual([expect.objectContaining({ address: 'sender@example.com' })]);
    expect(parsed.to).toMatchObject({ value: [expect.objectContaining({ address: 'recipient@example.com' })] });
  });

  it('keeps a quoted semicolon inside its address group', async () => {
    const parsed = await simpleParser(
      createMessage([
        'From: sender@example.com',
        'To: Team: "a;evil@attacker.example" <ok@corp.example>; other@corp.example',
      ])
    );

    expect(parsed.to).toMatchObject({
      value: [{ name: 'Team', group: [{ address: 'ok@corp.example' }] }, { address: 'other@corp.example' }],
    });
  });

  it('finishes parsing deeply nested groups and preserves the mailbox', async () => {
    const parsed = await simpleParser(
      createMessage([
        'From: sender@example.com',
        `To: ${'Group: '.repeat(1000)}recipient@example.com${';'.repeat(1000)}`,
      ])
    );

    expect(parsed.to).toMatchObject({
      value: [{ name: 'Group', group: [{ address: 'recipient@example.com' }] }],
    });
  });
});

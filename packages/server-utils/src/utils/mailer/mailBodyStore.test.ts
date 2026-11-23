import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mockClient } from 'aws-sdk-client-mock';
import { GetObjectCommand, type GetObjectCommandOutput, S3Client } from '@aws-sdk/client-s3';
import { getMailBody } from './mailBodyStore';

const s3 = mockClient(S3Client);
const key = 'queued-mail/0b5f3c3e-0d6a-4c55-9f0e-2a4b8c1d7e90.json';

const bodyOf = (raw: string | undefined): Partial<GetObjectCommandOutput> =>
  raw === undefined ? {} : { Body: { transformToString: async () => raw } as GetObjectCommandOutput['Body'] };

beforeEach(() => {
  s3.reset();
  process.env.MAIL_BODY_BUCKET = 'mail-bodies';
});

afterEach(() => {
  delete process.env.MAIL_BODY_BUCKET;
});

describe('getMailBody', () => {
  it('reads the key from the configured bucket and returns html and text', async () => {
    s3.on(GetObjectCommand).resolves(bodyOf(JSON.stringify({ html: '<p>Hi</p>', text: 'Hi' })));
    await expect(getMailBody(key)).resolves.toEqual({ html: '<p>Hi</p>', text: 'Hi' });
    expect(s3.commandCalls(GetObjectCommand)[0].args[0].input).toEqual({ Bucket: 'mail-bodies', Key: key });
  });

  it('returns html alone when no text was stored, without a text key', async () => {
    s3.on(GetObjectCommand).resolves(bodyOf(JSON.stringify({ html: '<p>Hi</p>' })));
    const body = await getMailBody(key);
    expect(body).toEqual({ html: '<p>Hi</p>' });
    expect(Object.keys(body)).toEqual(['html']);
  });

  it('keeps an empty html and drops fields that are not part of a stored body', async () => {
    s3.on(GetObjectCommand).resolves(bodyOf(JSON.stringify({ html: '', text: '', extra: 1 })));
    await expect(getMailBody(key)).resolves.toEqual({ html: '', text: '' });
  });

  it('throws when the object has no body', async () => {
    s3.on(GetObjectCommand).resolves(bodyOf(undefined));
    await expect(getMailBody(key)).rejects.toThrow(`mail body ${key} has no content`);
  });

  it.each([
    ['null', 'null'],
    ['a string', '"html"'],
    ['a missing html', JSON.stringify({ text: 'Hi' })],
    ['a non-string html', JSON.stringify({ html: 1 })],
    ['a non-string text', JSON.stringify({ html: '<p>Hi</p>', text: 2 })],
    ['a null text', JSON.stringify({ html: '<p>Hi</p>', text: null })],
  ])('rejects %s as not a stored mail body', async (_label, raw) => {
    s3.on(GetObjectCommand).resolves(bodyOf(raw));
    await expect(getMailBody(key)).rejects.toThrow(`mail body ${key} is not a stored mail body`);
  });

  it('lets an S3 error through for the caller to classify', async () => {
    s3.on(GetObjectCommand).rejects(Object.assign(new Error('gone'), { name: 'NoSuchKey' }));
    await expect(getMailBody(key)).rejects.toMatchObject({ name: 'NoSuchKey' });
  });

  it('throws before calling S3 when the bucket is not configured', async () => {
    delete process.env.MAIL_BODY_BUCKET;
    await expect(getMailBody(key)).rejects.toThrow('MAIL_BODY_BUCKET is not set');
    expect(s3.commandCalls(GetObjectCommand)).toHaveLength(0);
  });
});

import { S3Client, GetObjectCommand, PutObjectCommand, HeadObjectCommand } from '@aws-sdk/client-s3';
import type { APIGatewayProxyEventV2, APIGatewayProxyStructuredResultV2 } from 'aws-lambda';
import { Resource } from 'sst';

const s3 = new S3Client({});

function bucketName(): string {
  return (Resource as Record<string, { name: string }>).turboCacheBucket.name;
}

function artifactKey(hash: string, team?: string): string {
  const prefix = team ? `${team}/` : '';
  return `${prefix}${hash}`;
}

function unauthorized(): APIGatewayProxyStructuredResultV2 {
  return { statusCode: 401, body: JSON.stringify({ error: 'Unauthorized' }) };
}

function verifyToken(event: APIGatewayProxyEventV2): boolean {
  const auth = event.headers.authorization ?? event.headers.Authorization;
  if (!auth) return false;
  const token = auth.replace(/^Bearer\s+/i, '');
  const expected = (Resource as Record<string, { value: string }>).TURBO_CACHE_TOKEN.value;
  if (!expected || expected === 'not-configured') return false;
  // Constant-time comparison to prevent timing attacks
  if (token.length !== expected.length) return false;
  let mismatch = 0;
  for (let i = 0; i < token.length; i++) {
    mismatch |= token.charCodeAt(i) ^ expected.charCodeAt(i);
  }
  return mismatch === 0;
}

async function handleGet(hash: string, team?: string): Promise<APIGatewayProxyStructuredResultV2> {
  try {
    const result = await s3.send(new GetObjectCommand({ Bucket: bucketName(), Key: artifactKey(hash, team) }));
    const body = await result.Body?.transformToByteArray();
    if (!body) return { statusCode: 404, body: JSON.stringify({ error: 'Not found' }) };
    return {
      statusCode: 200,
      headers: {
        'content-type': 'application/octet-stream',
        ...(result.ContentLength != null && { 'content-length': String(result.ContentLength) }),
      },
      body: Buffer.from(body).toString('base64'),
      isBase64Encoded: true,
    };
  } catch (err: unknown) {
    if ((err as { name?: string }).name === 'NoSuchKey') {
      return { statusCode: 404, body: JSON.stringify({ error: 'Not found' }) };
    }
    throw err;
  }
}

async function handleHead(hash: string, team?: string): Promise<APIGatewayProxyStructuredResultV2> {
  try {
    const result = await s3.send(new HeadObjectCommand({ Bucket: bucketName(), Key: artifactKey(hash, team) }));
    return {
      statusCode: 200,
      headers: {
        'content-type': 'application/octet-stream',
        ...(result.ContentLength != null && { 'content-length': String(result.ContentLength) }),
      },
    };
  } catch (err: unknown) {
    if ((err as { name?: string }).name === 'NotFound') {
      return { statusCode: 404, body: JSON.stringify({ error: 'Not found' }) };
    }
    throw err;
  }
}

async function handlePut(
  hash: string,
  body: string | undefined,
  isBase64: boolean,
  team?: string
): Promise<APIGatewayProxyStructuredResultV2> {
  const content = body ? (isBase64 ? Buffer.from(body, 'base64') : Buffer.from(body)) : Buffer.alloc(0);
  await s3.send(
    new PutObjectCommand({
      Bucket: bucketName(),
      Key: artifactKey(hash, team),
      Body: content,
      ContentType: 'application/octet-stream',
    })
  );
  return { statusCode: 202, body: JSON.stringify({ urls: [`${hash}`] }) };
}

// Turborepo remote cache API handler
// Protocol: https://turbo.build/repo/docs/core-concepts/remote-caching
export async function handler(event: APIGatewayProxyEventV2): Promise<APIGatewayProxyStructuredResultV2> {
  if (!verifyToken(event)) return unauthorized();

  const method = event.requestContext.http.method;
  const path = event.rawPath;
  const team = event.queryStringParameters?.slug ?? event.queryStringParameters?.teamId;

  // POST /v8/artifacts/events -- Turborepo analytics events (accepted but not stored)
  if (method === 'POST' && path.endsWith('/artifacts/events')) {
    return { statusCode: 200, body: '{}' };
  }

  // Extract hash from /v8/artifacts/:hash
  const hashMatch = path.match(/\/v8\/artifacts\/([a-f0-9]+)$/);
  if (!hashMatch) {
    return { statusCode: 404, body: JSON.stringify({ error: 'Not found' }) };
  }
  const hash = hashMatch[1];

  switch (method) {
    case 'GET':
      return handleGet(hash, team);
    case 'HEAD':
      return handleHead(hash, team);
    case 'PUT':
      return handlePut(hash, event.body, event.isBase64Encoded, team);
    default:
      return { statusCode: 405, body: JSON.stringify({ error: 'Method not allowed' }) };
  }
}

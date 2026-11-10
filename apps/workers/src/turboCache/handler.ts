import { S3Client, GetObjectCommand, PutObjectCommand, HeadObjectCommand } from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';
import type { APIGatewayProxyEventV2, APIGatewayProxyStructuredResultV2 } from 'aws-lambda';
import { timingSafeEqual } from 'node:crypto';
import { Resource } from 'sst';

const s3 = new S3Client({});
const PRESIGNED_URL_EXPIRY = 900; // 15 minutes

function bucketName(): string {
  return (Resource as unknown as Record<string, { name: string }>).turboCacheBucket.name;
}

function artifactKey(hash: string, team?: string): string {
  const prefix = team ? `${team}/` : '';
  return `${prefix}${hash}`;
}

function unauthorized(): APIGatewayProxyStructuredResultV2 {
  return { statusCode: 401, body: JSON.stringify({ error: 'Unauthorized' }) };
}

function verifyToken(event: APIGatewayProxyEventV2): boolean {
  const auth = event.headers.authorization;
  if (!auth) return false;
  const token = auth.replace(/^Bearer\s+/i, '');
  const expected = (Resource as unknown as Record<string, { value: string }>).TURBO_CACHE_TOKEN.value;
  if (!expected || expected === 'not-configured') return false;
  if (token.length !== expected.length) return false;
  return timingSafeEqual(Buffer.from(token), Buffer.from(expected));
}

async function handleGet(hash: string, team?: string): Promise<APIGatewayProxyStructuredResultV2> {
  try {
    await s3.send(new HeadObjectCommand({ Bucket: bucketName(), Key: artifactKey(hash, team) }));
    const url = await getSignedUrl(s3, new GetObjectCommand({ Bucket: bucketName(), Key: artifactKey(hash, team) }), {
      expiresIn: PRESIGNED_URL_EXPIRY,
    });
    return { statusCode: 302, headers: { location: url } };
  } catch (err: unknown) {
    if ((err as { name?: string }).name === 'NotFound') {
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

async function handlePut(hash: string, team?: string): Promise<APIGatewayProxyStructuredResultV2> {
  const url = await getSignedUrl(
    s3,
    new PutObjectCommand({
      Bucket: bucketName(),
      Key: artifactKey(hash, team),
      ContentType: 'application/octet-stream',
    }),
    { expiresIn: PRESIGNED_URL_EXPIRY }
  );
  return { statusCode: 307, headers: { location: url } };
}

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
      return handlePut(hash, team);
    default:
      return { statusCode: 405, body: JSON.stringify({ error: 'Method not allowed' }) };
  }
}

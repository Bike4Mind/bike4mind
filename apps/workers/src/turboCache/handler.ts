import { GetObjectCommand, PutObjectCommand, HeadObjectCommand } from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';
import { createS3Client } from '@bike4mind/fab-pipeline';
import type { APIGatewayProxyEventV2, APIGatewayProxyStructuredResultV2 } from 'aws-lambda';
import { timingSafeEqual } from 'node:crypto';
import { Resource } from 'sst';
import { z } from 'zod';

// The body is uploaded later by Turbo; createS3Client keeps an empty-body checksum out of the signature.
const s3 = createS3Client();
const PRESIGNED_URL_EXPIRY = 900; // 15 minutes
const TEAM_PATTERN = /^[A-Za-z0-9_-]{1,64}$/;

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

type CachePermission = 'read' | 'write';
const requestMethodSchema = z.enum(['GET', 'HEAD', 'PUT', 'POST']);

function matchesToken(token: string, expected: string): boolean {
  if (!expected || expected === 'not-configured') return false;
  const suppliedBytes = Buffer.from(token);
  const expectedBytes = Buffer.from(expected);
  return suppliedBytes.length === expectedBytes.length && timingSafeEqual(suppliedBytes, expectedBytes);
}

function verifyToken(event: APIGatewayProxyEventV2): CachePermission | undefined {
  const token = event.headers.authorization?.match(/^Bearer ([^\s]+)$/i)?.[1];
  if (!token) return undefined;
  const secrets = Resource as unknown as Record<string, { value: string }>;
  // Fail closed if both secrets were accidentally configured with the same value.
  if (matchesToken(token, secrets.TURBO_CACHE_READ_TOKEN.value)) return 'read';
  if (matchesToken(token, secrets.TURBO_CACHE_TOKEN.value)) return 'write';
  return undefined;
}

async function handleGet(hash: string, team?: string): Promise<APIGatewayProxyStructuredResultV2> {
  try {
    await s3.send(new HeadObjectCommand({ Bucket: bucketName(), Key: artifactKey(hash, team) }));
    const url = await getSignedUrl(s3, new GetObjectCommand({ Bucket: bucketName(), Key: artifactKey(hash, team) }), {
      expiresIn: PRESIGNED_URL_EXPIRY,
    });
    return { statusCode: 302, headers: { location: url } };
  } catch (err: unknown) {
    if (err instanceof Error && err.name === 'NotFound') {
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
    if (err instanceof Error && err.name === 'NotFound') {
      return { statusCode: 404, body: JSON.stringify({ error: 'Not found' }) };
    }
    throw err;
  }
}

async function createUploadPreflight(hash: string, team?: string): Promise<APIGatewayProxyStructuredResultV2> {
  const url = await getSignedUrl(
    s3,
    new PutObjectCommand({
      Bucket: bucketName(),
      Key: artifactKey(hash, team),
      ContentType: 'application/octet-stream',
    }),
    { expiresIn: PRESIGNED_URL_EXPIRY }
  );
  // Turbo sends the body directly to this URL after its authenticated OPTIONS request.
  // Deliberately omit Authorization from allowed headers: S3 uses the URL signature.
  return {
    statusCode: 200,
    headers: { location: url, 'access-control-allow-headers': 'Content-Type, x-artifact-duration, User-Agent' },
  };
}

// Protocol: https://turbo.build/repo/docs/core-concepts/remote-caching
export async function handler(event: APIGatewayProxyEventV2): Promise<APIGatewayProxyStructuredResultV2> {
  const permission = verifyToken(event);
  if (!permission) return unauthorized();

  const method = event.requestContext.http.method;
  const preflightMethod = requestMethodSchema.safeParse(event.headers['access-control-request-method']);
  if (method === 'OPTIONS' && !preflightMethod.success) {
    return { statusCode: 405, body: JSON.stringify({ error: 'Method not allowed' }) };
  }
  const requestedMethod = method === 'OPTIONS' && preflightMethod.success ? preflightMethod.data : method;
  const preflightResponse: APIGatewayProxyStructuredResultV2 = {
    statusCode: 200,
    headers: { 'access-control-allow-headers': 'Authorization, User-Agent' },
  };
  const path = event.rawPath;
  const team = event.queryStringParameters?.slug ?? event.queryStringParameters?.teamId;
  // The team becomes the S3 key prefix; keep every key in the `<team>/<hash>` shape.
  if (team !== undefined && !TEAM_PATTERN.test(team)) {
    return { statusCode: 400, body: JSON.stringify({ error: 'Invalid team' }) };
  }

  // POST /v8/artifacts/events -- Turborepo analytics events (accepted but not stored)
  if (requestedMethod === 'POST' && path === '/v8/artifacts/events') {
    if (method === 'OPTIONS') return preflightResponse;
    return { statusCode: 200, body: '{}' };
  }

  const hashMatch = path.match(/^\/v8\/artifacts\/([a-f0-9]+)$/);
  if (!hashMatch) {
    return { statusCode: 404, body: JSON.stringify({ error: 'Not found' }) };
  }
  const hash = hashMatch[1];

  if (requestedMethod === 'PUT' && permission !== 'write') {
    return { statusCode: 403, body: JSON.stringify({ error: 'Read-only cache token' }) };
  }
  if (method === 'OPTIONS') {
    if (requestedMethod === 'PUT') return createUploadPreflight(hash, team);
    // Turbo preflights HEAD using GET too; keep both at Lambda for correct metadata.
    if (requestedMethod === 'GET' || requestedMethod === 'HEAD') return preflightResponse;
    return { statusCode: 405, body: JSON.stringify({ error: 'Method not allowed' }) };
  }

  switch (method) {
    case 'GET':
      return handleGet(hash, team);
    case 'HEAD':
      return handleHead(hash, team);
    case 'PUT':
      return { statusCode: 400, body: JSON.stringify({ error: 'Enable remoteCache.preflight in turbo.json' }) };
    default:
      return { statusCode: 405, body: JSON.stringify({ error: 'Method not allowed' }) };
  }
}

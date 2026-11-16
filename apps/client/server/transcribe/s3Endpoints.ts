import type { S3ClientConfig } from '@aws-sdk/client-s3';

/** `process.env`, or a literal in tests. */
type EndpointEnv = Record<string, string | undefined>;

/**
 * A custom S3 endpoint (self-host MinIO) is addressed path-style: the default virtual-hosted
 * style puts the bucket in the host name, which has no DNS there. Hosted sets no endpoint and
 * keeps the SDK defaults. Same rule as S3Storage in b4m-core/fab-pipeline.
 */
export function storageClientConfig(env: EndpointEnv): S3ClientConfig {
  const endpoint = env.AWS_ENDPOINT_URL_S3?.trim();
  return endpoint ? { endpoint, forcePathStyle: true } : {};
}

/**
 * The endpoint an upload form is signed against when it differs from the server's own: the form
 * goes to a browser, which cannot reach an address only the server resolves. Null when the
 * server's client already signs a reachable URL.
 */
export function browserPresignConfig(env: EndpointEnv): S3ClientConfig | null {
  const endpoint = env.S3_PRESIGN_ENDPOINT?.trim();
  return endpoint ? { endpoint, forcePathStyle: true } : null;
}

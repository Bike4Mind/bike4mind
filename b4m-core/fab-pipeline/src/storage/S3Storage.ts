import { Logger } from '@bike4mind/observability';
import {
  S3Client,
  PutObjectCommand,
  DeleteObjectCommand,
  GetObjectCommand,
  GetObjectCommandOutput,
  HeadObjectCommand,
  ListObjectsV2Command,
  PutObjectCommandInput,
  ObjectCannedACL,
} from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';
import { BaseStorage } from './BaseStorage';
import fs from 'fs';
import { Readable } from 'stream';
import mime from 'mime-types';
import { fileTypeFromBuffer } from 'file-type';
import { NodeHttpHandler } from '@smithy/node-http-handler';
import { Agent } from 'https';
import { createS3Client } from './createS3Client';

const isInvalidRangeError = (error: unknown): boolean => {
  const e = error as { name?: string; $metadata?: { httpStatusCode?: number } } | null;
  return e?.name === 'InvalidRange' || e?.$metadata?.httpStatusCode === 416;
};

// Headroom for clock skew between this host and S3 when clamping a link to its credentials.
const CREDENTIAL_EXPIRY_MARGIN_MS = 60 * 1000;

export class S3Storage extends BaseStorage {
  private s3: S3Client;
  private presignS3: S3Client;
  /** True when signed links can be handed to a browser (see `browserSigningOrigin`). */
  private browserPresignable: boolean;
  private hasPresignEndpoint: boolean;
  private browserOrigin?: Promise<string>;

  constructor(
    private bucketName: string,
    private region = process.env.AWS_REGION || 'us-east-2'
  ) {
    super();

    // A custom S3 endpoint (self-host MinIO, localstack) is addressed path-style
    // (endpoint/bucket/key). The default virtual-hosted style (bucket.endpoint-host) has no
    // DNS there, so downloads/uploads fail with ENOTFOUND bucket.host. Real S3 sets no custom
    // endpoint and keeps the default virtual-hosted addressing, so hosted is unchanged.
    const endpoint = process.env.AWS_ENDPOINT_URL_S3;

    this.s3 = createS3Client({
      region: this.region,
      ...(endpoint ? { endpoint, forcePathStyle: true } : {}),
      maxAttempts: 3,
      retryMode: 'standard',
      requestHandler: new NodeHttpHandler({
        httpsAgent: new Agent({
          keepAlive: true,
          maxSockets: 50, // Default connection pool size
        }),
        connectionTimeout: 5000, // 5 seconds
        requestTimeout: 60000, // 1 minute
      }),
    });

    const presignEndpoint = process.env.S3_PRESIGN_ENDPOINT?.trim();
    if (presignEndpoint) {
      try {
        const url = new URL(presignEndpoint);
        if (url.protocol !== 'http:' && url.protocol !== 'https:') throw new Error('Unsupported protocol');
      } catch {
        throw new Error('S3_PRESIGN_ENDPOINT must be an absolute HTTP or HTTPS URL');
      }
    }
    // A custom server endpoint (self-host MinIO at `http://minio:9000`) is an address only the
    // server can resolve. Without a browser-facing S3_PRESIGN_ENDPOINT, a "browser" link
    // signed against it is useless to the browser it is handed to.
    this.browserPresignable = !endpoint || !!presignEndpoint;
    this.hasPresignEndpoint = !!presignEndpoint;
    // Browser signing is opt-in; server consumers keep the private endpoint.
    this.presignS3 = presignEndpoint
      ? createS3Client({
          region: this.region,
          credentials: this.s3.config.credentials,
          endpoint: presignEndpoint,
          forcePathStyle: true,
        })
      : this.s3;
  }

  /**
   * @param input A string (stored as literal content) or a buffer. Never interpreted as a path;
   * use `uploadFile` for local files.
   * @param destination Destination path with filename
   *
   * @returns The path where the file is uploaded
   */
  async upload(
    input: string | Buffer,
    destination: string,
    options?: Omit<PutObjectCommandInput, 'Bucket' | 'Key' | 'Body'>,
    abortSignal?: AbortSignal
  ): Promise<string> {
    let contentType = mime.lookup(destination);

    if (Buffer.isBuffer(input)) {
      const fileType = await fileTypeFromBuffer(input);
      if (fileType) contentType = fileType.mime;
    }

    return this.put(input, destination, contentType, options, abortSignal);
  }

  /**
   * Streams a local file to storage.
   * @param localPath Path of a file on the local filesystem
   * @param destination Destination path with filename
   *
   * @returns The path where the file is uploaded
   */
  async uploadFile(
    localPath: string,
    destination: string,
    options?: Omit<PutObjectCommandInput, 'Bucket' | 'Key' | 'Body'>,
    abortSignal?: AbortSignal
  ): Promise<string> {
    return this.put(fs.createReadStream(localPath), destination, mime.lookup(destination), options, abortSignal);
  }

  private async put(
    content: Buffer | Readable | string,
    destination: string,
    contentType: string | false,
    options?: Omit<PutObjectCommandInput, 'Bucket' | 'Key' | 'Body'>,
    abortSignal?: AbortSignal
  ): Promise<string> {
    await this.s3.send(
      new PutObjectCommand({
        Bucket: this.bucketName,
        Key: destination,
        Body: content,
        ...(contentType && { ContentType: contentType }),
        ...options,
      }),
      {
        requestTimeout: 300000, // 5 minute timeout
        abortSignal,
      }
    );

    return destination;
  }

  async download(path: string): Promise<Buffer> {
    const { Body } = await this.s3.send(
      new GetObjectCommand({
        Bucket: this.bucketName,
        Key: path,
      })
    );

    if (!Body) throw new Error('File content is empty or not available');
    return await this.streamToBuffer(Body as Readable);
  }

  /**
   * Ranged read of the first `length` bytes of an object - lets a caller
   * byte-sniff a file's real type from magic numbers without downloading the whole object.
   * S3 clamps a range that starts inside the object to its actual size, so objects smaller
   * than `length` are fine. A 0-byte object has no byte 0 to start from, so S3 answers 416
   * InvalidRange; that is returned as an empty `Buffer`. Mirrors `getPreview`'s Range-header
   * pattern but returns the raw `Buffer` instead of a UTF-8 string (binary-safe).
   */
  async downloadRange(path: string, length: number): Promise<Buffer> {
    try {
      const { Body } = await this.s3.send(
        new GetObjectCommand({
          Bucket: this.bucketName,
          Key: path,
          Range: `bytes=0-${length - 1}`,
        })
      );

      if (!Body) throw new Error('File content is empty or not available');
      return await this.streamToBuffer(Body as Readable);
    } catch (error) {
      if (isInvalidRangeError(error)) return Buffer.alloc(0);
      throw error;
    }
  }

  async delete(path: string): Promise<void> {
    await this.s3.send(
      new DeleteObjectCommand({
        Bucket: this.bucketName,
        Key: path,
      })
    );
  }

  /**
   * Delete every object whose key starts with `prefix` and return how many there were. Meant for
   * small per-entity prefixes: lists page by page and deletes one key at a time. The prefix must
   * name a folder at least two levels deep (`a/b/`), so a bad caller cannot sweep a bucket, a
   * top-level folder, or the siblings that share a name's leading characters.
   */
  async deletePrefix(prefix: string): Promise<number> {
    if (!prefix.endsWith('/') || prefix.split('/').filter(Boolean).length < 2) {
      throw new Error(`deletePrefix refuses the unscoped prefix "${prefix}"`);
    }
    let deleted = 0;
    let ContinuationToken: string | undefined;
    do {
      const page = await this.s3.send(
        new ListObjectsV2Command({ Bucket: this.bucketName, Prefix: prefix, ContinuationToken })
      );
      for (const { Key } of page.Contents ?? []) {
        if (!Key?.startsWith(prefix)) continue;
        await this.delete(Key);
        deleted += 1;
      }
      ContinuationToken = page.IsTruncated ? page.NextContinuationToken : undefined;
    } while (ContinuationToken);
    return deleted;
  }

  /**
   * Get a signed URL for a file in the storage bucket that expires after the specified time
   */
  async getSignedUrl(
    path: string,
    method: 'get' | 'put' = 'get',
    {
      expiresIn = 3600,
      audience,
      ACL,
      ContentType,
      ContentLength,
      ResponseContentType,
      ResponseContentDisposition,
      signingDate,
    }: {
      expiresIn?: number;
      audience?: 'browser';
      ACL?: ObjectCannedACL;
      ContentType?: string;
      /**
       * PUT only: signs the exact byte length, so S3 refuses (403) an upload of any other size.
       * This is what makes a declared upload size, and the size and quota checks run on it, binding.
       */
      ContentLength?: number;
      /**
       * GET only: the Content-Type S3 answers with, regardless of the type stored on the object.
       * Lets a caller pin what a browser may render from a signed link.
       */
      ResponseContentType?: string;
      ResponseContentDisposition?: string;
      /**
       * Sign as of this instant instead of now; the link is valid from it for `expiresIn` seconds.
       * Repeated calls with the same value (and credentials) return the identical URL, so a browser
       * can cache what it points at.
       */
      signingDate?: Date;
    } = {}
  ): Promise<string> {
    const bindLength = method !== 'get' && ContentLength !== undefined;
    const client = audience === 'browser' ? this.presignS3 : this.s3;
    return await getSignedUrl(
      client,
      method !== 'get'
        ? new PutObjectCommand({
            Bucket: this.bucketName,
            Key: path,
            ACL,
            ContentType,
            ContentLength,
          })
        : new GetObjectCommand({
            Bucket: this.bucketName,
            Key: path,
            ResponseContentType,
            ResponseContentDisposition,
          }),
      {
        expiresIn: await this.clampToCredentialLifetime(client, expiresIn, signingDate),
        ...(signingDate && { signingDate }),
        ...(bindLength && { signableHeaders: new Set(['content-length']) }),
      }
    );
  }

  /**
   * A SigV4 link stops working when the temporary credentials that signed it expire, whatever
   * X-Amz-Expires says, so never sign one that claims to outlive them. Callers that cache a link
   * read its real lifetime back from X-Amz-Date + X-Amz-Expires (see fabFileService/get.ts).
   */
  private async clampToCredentialLifetime(client: S3Client, expiresIn: number, signingDate?: Date) {
    const { expiration } = await client.config.credentials();
    if (!expiration) return expiresIn;
    const signedAt = (signingDate ?? new Date()).getTime();
    const credentialSeconds = Math.floor((expiration.getTime() - CREDENTIAL_EXPIRY_MARGIN_MS - signedAt) / 1000);
    return Math.max(1, Math.min(expiresIn, credentialSeconds));
  }

  /**
   * Origin of this bucket's browser-audience signed GET links, or '' when they are not
   * browser-usable: a custom server endpoint with no S3_PRESIGN_ENDPOINT, or a link that is
   * not on the bucket's OWN virtual host on AWS. The last case matters to callers that admit
   * this origin in a CSP: a path-style link lives on the shared regional endpoint, which
   * would admit every bucket in the region. Computed once per instance (signing is local).
   */
  browserSigningOrigin(): Promise<string> {
    this.browserOrigin ??= (async () => {
      if (!this.browserPresignable) return '';
      try {
        const url = new URL(await this.getSignedUrl('__origin__', 'get', { audience: 'browser', expiresIn: 60 }));
        // Any AWS host must be this bucket's own virtual host - including a browser endpoint
        // configured as a bare regional `s3.<region>.amazonaws.com`, which path-style signing
        // would turn into an origin shared by every bucket in the region.
        const onAws = url.hostname.toLowerCase().endsWith('.amazonaws.com');
        if (this.hasPresignEndpoint && !onAws) return url.origin;
        return url.hostname.startsWith(`${this.bucketName}.`) ? url.origin : '';
      } catch {
        return '';
      }
    })();
    return this.browserOrigin;
  }

  getPublicUrl(path: string): string {
    return `https://${this.bucketName}.s3.${this.region}.amazonaws.com/${path}`;
  }

  private streamToBuffer(stream: Readable): Promise<Buffer> {
    return new Promise((resolve, reject) => {
      const chunks: Uint8Array[] = [];
      stream.on('data', chunk => chunks.push(chunk));
      stream.on('end', () => resolve(Buffer.concat(chunks)));
      stream.on('error', reject);
    });
  }

  async getContent(path: string): Promise<NonNullable<GetObjectCommandOutput['Body']>> {
    const { Body } = await this.s3.send(
      new GetObjectCommand({
        Bucket: this.bucketName,
        Key: path,
      })
    );

    if (!Body) throw new Error('File content is empty or not available');
    Logger.globalInstance.log('download complete!');

    return Body;
  }

  async getContentAsBuffer(path: string): Promise<Buffer> {
    const content = await this.getContent(path);
    return await this.streamToBuffer(content as Readable);
  }

  async getContentAsString(path: string): Promise<string> {
    const content = await this.getContent(path);
    Logger.globalInstance.log('got content');
    return await content.transformToString('utf-8');
  }

  async getPreview(path: string): Promise<string> {
    try {
      const response = await this.s3.send(
        new GetObjectCommand({
          Bucket: this.bucketName,
          Key: path,
          Range: 'bytes=0-5120', // First 5KB
        })
      );
      return await response.Body!.transformToString('utf-8');
    } catch (error) {
      if (isInvalidRangeError(error)) return '';
      throw error;
    }
  }

  async getMetadata(path: string) {
    const response = await this.s3.send(
      new HeadObjectCommand({
        Bucket: this.bucketName,
        Key: path,
      })
    );
    return {
      size: response.ContentLength,
      contentType: response.ContentType,
      lastModified: response.LastModified,
      etag: response.ETag,
    };
  }
}

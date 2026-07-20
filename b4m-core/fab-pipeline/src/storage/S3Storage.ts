import { Logger } from '@bike4mind/observability';
import {
  S3Client,
  PutObjectCommand,
  DeleteObjectCommand,
  GetObjectCommand,
  GetObjectCommandOutput,
  HeadObjectCommand,
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

export class S3Storage extends BaseStorage {
  private s3: S3Client;

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

    this.s3 = new S3Client({
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
  }

  /**
   * @param input Input can be a string, a buffer or a path to a file(but not external URL)
   * @param destination Destination path with filename
   *
   * @returns The path where the file is uploaded
   */
  async upload(
    input: string | Buffer,
    destination: string,
    options?: Omit<PutObjectCommandInput, 'Bucket' | 'Key' | 'Body'>
  ): Promise<string> {
    let content: Buffer | Readable | string;

    let contentType = mime.lookup(destination);

    if (Buffer.isBuffer(input)) {
      const fileType = await fileTypeFromBuffer(input);
      if (fileType) contentType = fileType.mime;
      content = input;
    } else if (fs.existsSync(input)) {
      content = fs.createReadStream(input);
    } else if (typeof input === 'string') {
      content = input;
    } else {
      content = Readable.from(input);
    }

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
   * S3 clamps an out-of-range `Range` header to the object's actual size, so this is safe
   * to call on objects smaller than `length` too. Mirrors `getPreview`'s Range-header
   * pattern but returns the raw `Buffer` instead of a UTF-8 string (binary-safe).
   */
  async downloadRange(path: string, length: number): Promise<Buffer> {
    const { Body } = await this.s3.send(
      new GetObjectCommand({
        Bucket: this.bucketName,
        Key: path,
        Range: `bytes=0-${length - 1}`,
      })
    );

    if (!Body) throw new Error('File content is empty or not available');
    return await this.streamToBuffer(Body as Readable);
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
   * Get a signed URL for a file in the storage bucket that expires after the specified time
   */
  async getSignedUrl(
    path: string,
    method: 'get' | 'put' = 'get',
    {
      expiresIn = 3600,
      ACL,
      ContentType,
      ResponseContentDisposition,
    }: {
      expiresIn?: number;
      ACL?: ObjectCannedACL;
      ContentType?: string;
      ResponseContentDisposition?: string;
    } = {}
  ): Promise<string> {
    return await getSignedUrl(
      this.s3,
      method !== 'get'
        ? new PutObjectCommand({
            Bucket: this.bucketName,
            Key: path,
            ACL,
            ContentType,
          })
        : new GetObjectCommand({
            Bucket: this.bucketName,
            Key: path,
            ResponseContentDisposition,
          }),
      {
        expiresIn,
      }
    );
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
    const response = await this.s3.send(
      new GetObjectCommand({
        Bucket: this.bucketName,
        Key: path,
        Range: 'bytes=0-5120', // First 5KB
      })
    );
    return await response.Body!.transformToString('utf-8');
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

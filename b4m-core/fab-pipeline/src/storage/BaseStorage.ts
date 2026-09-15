export abstract class BaseStorage {
  abstract upload(input: string | Buffer, destination: string, options: any): Promise<string>;
  abstract download(path: string): Promise<Buffer>;
  abstract delete(path: string): Promise<void>;
  abstract getSignedUrl(
    path: string,
    method?: 'get' | 'put',
    options?: {
      expiresIn?: number;
      ACL?: any;
    }
  ): Promise<string>;
  abstract getPublicUrl(path: string): string;
  abstract getPreview(path: string): Promise<string>;
  abstract getMetadata(path: string): Promise<{
    size?: number;
    contentType?: string;
    lastModified?: Date;
    etag?: string;
  }>;
}

export default BaseStorage;

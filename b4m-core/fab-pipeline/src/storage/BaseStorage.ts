export abstract class BaseStorage {
  abstract upload(input: string | Buffer, destination: string, options: any): Promise<string>;
  abstract uploadFile(localPath: string, destination: string, options?: Record<string, unknown>): Promise<string>;
  abstract download(path: string): Promise<Buffer>;
  abstract delete(path: string): Promise<void>;
  abstract getSignedUrl(
    path: string,
    method?: 'get' | 'put',
    options?: {
      expiresIn?: number;
      ACL?: any;
      /** PUT only: the exact byte length the upload must have (see S3Storage.getSignedUrl). */
      ContentLength?: number;
      audience?: 'browser';
      /** GET only: overrides the stored object's Content-Type on the signed response. */
      ResponseContentType?: string;
      /** GET only: overrides the stored object's Content-Disposition on the signed response. */
      ResponseContentDisposition?: string;
      /** Sign as of this instant instead of now, so repeated calls can return the identical URL. */
      signingDate?: Date;
    }
  ): Promise<string>;
  abstract getPublicUrl(path: string): string;
  /**
   * Origin a browser fetches this storage's signed GET links from, or '' when signed links
   * are not usable by a browser here. Storages that cannot presign for browsers keep the
   * default.
   */
  async browserSigningOrigin(): Promise<string> {
    return '';
  }
  abstract getPreview(path: string): Promise<string>;
  abstract getMetadata(path: string): Promise<{
    size?: number;
    contentType?: string;
    lastModified?: Date;
    etag?: string;
  }>;
}

export default BaseStorage;

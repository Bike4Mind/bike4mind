import { GetObjectCommand, S3Client } from '@aws-sdk/client-s3';
import { asyncHandler } from '@server/middlewares/asyncHandler';
import { baseApi } from '@server/middlewares/baseApi';
import { LOCAL_FILE_PROXY_BASE, resolveProxyTarget } from '@server/utils/appFileProxy';
import { Resource } from 'sst';
import { Readable } from 'stream';

const s3 = new S3Client({});

// DEV-ONLY proxy. In personal `sst dev` stages NEXT_PUBLIC_CDN_URL is set to
// `/api/app-files/serve` (infra/web.ts), so all file URLs resolve here instead
// of through the shared CloudFront router. auth:false matches today's
// unauthenticated CloudFront serving and permits the pre-auth public-settings
// fetch. Deployed stages never hit this route (their CDN URL is the real
// distribution).
const handler = baseApi({ auth: false }).get(
  asyncHandler(async (req, res) => {
    // Deployed stages set NEXT_PUBLIC_CDN_URL to the real distribution URL, not
    // this path - so this route only serves requests on personal `sst dev` stages.
    if (process.env.NEXT_PUBLIC_CDN_URL !== LOCAL_FILE_PROXY_BASE) {
      res.status(404).end();
      return;
    }

    const raw = (req.query as Record<string, string | string[] | undefined>).key;
    const cdnPath = Array.isArray(raw) ? raw.join('/') : String(raw ?? '');
    if (!cdnPath) {
      res.status(400).end();
      return;
    }

    const target = resolveProxyTarget(cdnPath);
    if (!target) {
      res.status(404).end();
      return;
    }
    const { bucket, key } = target;
    const bucketName = bucket === 'generated' ? Resource.generatedImagesBucket.name : Resource.appFilesBucket.name;

    const rangeHeader = typeof req.headers.range === 'string' ? req.headers.range : undefined;

    try {
      const out = await s3.send(
        new GetObjectCommand({
          Bucket: bucketName,
          Key: key,
          ...(rangeHeader && { Range: rangeHeader }),
        })
      );
      // defensive backstop: GetObject resolves with Body or throws; this branch handles unexpected SDK changes
      if (!out.Body) {
        res.status(502).end();
        return;
      }
      res.setHeader('Accept-Ranges', 'bytes');
      if (out.ContentRange) {
        res.setHeader('Content-Range', out.ContentRange);
        res.status(206);
      }
      if (out.ContentType) res.setHeader('Content-Type', out.ContentType);
      if (out.ContentLength != null) res.setHeader('Content-Length', String(out.ContentLength));
      res.setHeader('Cache-Control', out.CacheControl ?? 'private, max-age=300');
      // Once piping starts the response is already committed, so a mid-transfer
      // S3 error can't be turned into an HTTP status. Destroy the socket instead
      // of letting an unhandled 'error' event surface on the stream.
      (out.Body as Readable).on('error', e => res.destroy(e)).pipe(res);
    } catch (err: unknown) {
      const name = (err as { name?: string })?.name;
      if (name === 'NoSuchKey' || name === 'NotFound') {
        res.status(404).end();
        return;
      }
      throw err;
    }
  })
);

export const config = {
  api: {
    responseLimit: false, // streaming arbitrary-size objects
    externalResolver: true,
  },
};

export default handler;

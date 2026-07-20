import { GetObjectCommand, S3Client } from '@aws-sdk/client-s3';
import { asyncHandler } from '@server/middlewares/asyncHandler';
import { baseApi } from '@server/middlewares/baseApi';
import { LOCAL_FILE_PROXY_BASE, resolveProxyTarget } from '@server/utils/appFileProxy';
import { Resource } from 'sst';
import { Readable } from 'stream';

// A custom S3 endpoint (self-host MinIO) must be addressed path-style: the default
// virtual-hosted style (bucket.endpoint-host) has no DNS there and fails with
// ENOTFOUND bucket.host. The SDK auto-reads AWS_ENDPOINT_URL_S3 for the endpoint; we
// set it explicitly and force path-style. Hosted sets no custom endpoint, so the
// client stays on default virtual-hosted addressing.
const s3Endpoint = process.env.AWS_ENDPOINT_URL_S3;
const s3 = new S3Client(s3Endpoint ? { endpoint: s3Endpoint, forcePathStyle: true } : {});

// Local file proxy for stages with no CloudFront distribution. Personal `sst dev`
// stages (infra/web.ts) AND self-host both point NEXT_PUBLIC_CDN_URL at
// `/api/app-files/serve`, so file URLs resolve here instead of the shared CloudFront
// router. auth:false matches the unauthenticated CloudFront serving it replaces and
// permits the pre-auth public-settings fetch. Hosted deploys set NEXT_PUBLIC_CDN_URL
// to the real distribution and never reach this route.
const handler = baseApi({ auth: false }).get(
  asyncHandler(async (req, res) => {
    // Hosted deploys set NEXT_PUBLIC_CDN_URL to the real distribution URL, not this
    // path, so this route serves only on `sst dev` and self-host stages.
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
      // Served objects are static user assets, never executable. On self-host this
      // proxy serves them same-origin (hosted uses an isolated CDN origin), so an asset
      // stored as active content (e.g. an SVG or HTML uploaded as a "profile photo")
      // could otherwise run in the app origin on direct navigation. Deny all
      // script/subresource capability so served assets are inert as documents;
      // <img>/<link> embedding by the app is unaffected.
      res.setHeader('Content-Security-Policy', "default-src 'none'; sandbox");
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

import { NotFoundError } from '@bike4mind/common';
import { curatedJsonSchemaText } from '@bike4mind/common/modelHub';
import { curatedCatalogVersionRepository } from '@bike4mind/database';
import {
  CURATED_CHANNEL,
  CURATED_IMMUTABLE_CACHE_CONTROL,
  CURATED_LATEST_CACHE_CONTROL,
  CURATED_SCHEMA_CACHE_CONTROL,
  parseCuratedFileName,
} from '@bike4mind/server-utils/modelHub/curatedCatalog';
import { rateLimit } from '@bike4mind/server-utils/middlewares/rateLimit';
import { baseApi } from '@server/middlewares/baseApi';

/**
 * The signed curated Model Hub list for Desktop and the CLI: `latest.json`, `<sequence>.json`, their `.sig`, and
 * `schema.json`. Bytes are sent exactly as stored, since clients verify signatures over them.
 */
const handler = baseApi({ auth: false, allowedMethods: ['GET'] })
  // No user on a public route, so the limiter keys on the client IP.
  .use(rateLimit({ limit: 60, windowMs: 60_000, bucket: 'GET /api/model-hub/curated/v2' }))
  .get(async (req, res) => {
    const name = typeof req.query.file === 'string' ? req.query.file : '';
    const file = parseCuratedFileName(name);
    if (!file) throw new NotFoundError(`No curated list file ${name}`);

    let body: string | null;
    let cacheControl: string;
    if (file.kind === 'schema') {
      body = curatedJsonSchemaText();
      cacheControl = CURATED_SCHEMA_CACHE_CONTROL;
    } else {
      const selector = file.kind === 'latest' ? 'latest' : file.sequence;
      const field = file.signature ? 'signatureBytes' : 'manifestBytes';
      body = await curatedCatalogVersionRepository.readServed(CURATED_CHANNEL, selector, field);
      cacheControl = file.kind === 'latest' ? CURATED_LATEST_CACHE_CONTROL : CURATED_IMMUTABLE_CACHE_CONTROL;
    }
    if (body === null) throw new NotFoundError(`No curated list file ${name}`);
    res.setHeader('Content-Type', 'application/json');
    res.setHeader('Cache-Control', cacheControl);
    // A string, not a Buffer: Next would JSON-stringify a Buffer to compute the ETag.
    return res.status(200).send(body);
  });

export default handler;

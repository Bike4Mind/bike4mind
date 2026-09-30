import path from 'node:path';
import { isSafeQaPath } from '@bike4mind/common';
import { QaRun } from '@bike4mind/database';
import { baseApi } from '@server/middlewares/baseApi';
import { NotFoundError, UnauthorizedError } from '@server/utils/errors';
import { getQaArtifactsStorage } from '@server/utils/storage';
import { verifyQaReportToken } from '@server/qa/reportToken';

const RUN_ID = /^[a-f0-9]{24}$/;

const CONTENT_TYPES: Record<string, string> = {
  '.html': 'text/html',
  '.css': 'text/css',
  '.js': 'application/javascript',
  '.json': 'application/json',
  '.zip': 'application/zip',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.svg': 'image/svg+xml',
  '.webm': 'video/webm',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
  '.txt': 'text/plain',
};

/**
 * GET /api/admin/qa/report/<runId>/<token>/<path>. Serves one run's Playwright
 * HTML report from qaArtifactsBucket. Unauthenticated at the JWT layer: access is
 * the run-scoped token in the path (server/qa/reportToken.ts), so the report's
 * relative asset URLs carry it with no cookie. CSP sandbox gives the report an
 * opaque origin, so its scripts cannot reach the app's storage or cookies. Never
 * relax the sandbox: the run page's trace download is the fallback if the
 * embedded viewer fails.
 */
const handler = baseApi({ auth: false }).get(async (req, res) => {
  const runId = typeof req.query.runId === 'string' ? req.query.runId : '';
  const token = typeof req.query.token === 'string' ? req.query.token : '';
  const rawPath = req.query.path;
  const segments = Array.isArray(rawPath) ? rawPath : typeof rawPath === 'string' ? [rawPath] : [];
  const filePath = segments.join('/');
  if (!RUN_ID.test(runId) || !isSafeQaPath(filePath)) throw new NotFoundError('Not found');

  const claims = token ? verifyQaReportToken(token) : null;
  if (!claims || claims.runId !== runId) throw new UnauthorizedError('Report link expired. Reopen it from /status.');

  const run = await QaRun.findById(runId).select('reportPrefix').lean<{ reportPrefix?: string }>();
  if (!run?.reportPrefix) throw new NotFoundError('Report not found');

  let body: Buffer;
  try {
    body = await getQaArtifactsStorage().getContentAsBuffer(`${run.reportPrefix}${filePath}`);
  } catch {
    throw new NotFoundError('Report file not found');
  }

  res.setHeader('Content-Security-Policy', 'sandbox allow-scripts allow-popups allow-downloads');
  res.setHeader('X-Content-Type-Options', 'nosniff');
  // The URL carries the token; keep it out of Referer on outbound links.
  res.setHeader('Referrer-Policy', 'no-referrer');
  res.setHeader('Cache-Control', 'private, max-age=300');
  res.setHeader('Content-Type', CONTENT_TYPES[path.extname(filePath).toLowerCase()] ?? 'application/octet-stream');
  return res.status(200).send(body);
});

export const config = { api: { responseLimit: false } };

export default handler;

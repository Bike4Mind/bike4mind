import { ccBridgePairingTokenRepository } from '@bike4mind/database';
import { BadRequestError } from '@bike4mind/utils';
import { S3Storage } from '@bike4mind/fab-pipeline';
import { asyncHandler } from '@server/middlewares/asyncHandler';
import { baseApi } from '@server/middlewares/baseApi';
import { csrfProtection } from '@server/middlewares/csrfProtection';
import { ensureTavernAccess } from '@server/utils/errors';
import { rateLimit } from '@server/middlewares/rateLimit';
import archiver from 'archiver';
import bcrypt from 'bcryptjs';
import { randomBytes, randomUUID } from 'crypto';
import { Resource } from 'sst';
import { z } from 'zod';

const PAIRING_TOKEN_TTL_MS = 5 * 60 * 1000;

/** Prefix under appFilesBucket where we store published bridge binaries.
 *  Binaries are uploaded manually via `pnpm --filter @bike4mind/cc-bridge upload-binaries`
 *  for the PoC; a CI job will automate this once the build stabilises. */
const BINARY_PREFIX = 'cc-bridge/artifacts/';
const BINARY_VERSION = 'latest';

/** Prefix for per-user download zips. Lifecycle rule on appFilesBucket
 *  (see infra/buckets.ts) expires these after 1 day. */
const DOWNLOAD_PREFIX = 'cc-bridge-downloads/';

const DownloadRequestSchema = z.object({
  os: z.enum(['linux', 'darwin', 'win32']),
  arch: z.enum(['x64', 'arm64']),
});

type Os = z.infer<typeof DownloadRequestSchema>['os'];

function binaryFilename(os: Os, arch: 'x64' | 'arm64'): string {
  const ext = os === 'win32' ? '.exe' : '';
  return `cc-bridge-${os}-${arch}${ext}`;
}

function readmeContent(baseUrl: string, binaryName: string, os: Os): string {
  const launchCmd = os === 'win32' ? binaryName : `./${binaryName}`;
  return [
    'Claude Code Bridge',
    '==================',
    '',
    `Downloaded from ${baseUrl}`,
    '',
    'Quick start',
    '-----------',
    '',
    '1. Unzip this archive. You should see:',
    `     ${binaryName}   (the bridge binary)`,
    '     pair.json       (one-time pairing token; expires 5 min after download)',
    '     README.txt      (this file)',
    '',
    '2. From the directory that contains pair.json, run:',
    `     ${launchCmd}`,
    '',
    os === 'win32'
      ? '   Windows SmartScreen may warn on first launch; click "More info" → "Run anyway".'
      : `   If the binary is not executable: chmod +x ${binaryName}`,
    os === 'darwin'
      ? '   macOS Gatekeeper blocks unsigned binaries on first launch. Right-click → Open to override.'
      : '',
    '',
    '3. On first run the bridge:',
    '   - Redeems the pairing token in pair.json (one-time use).',
    '   - Writes its durable config to ~/.b4m/cc-bridge.json.',
    '   - Installs Claude Code hooks into ~/.claude/settings.json.',
    '   - Opens a persistent WebSocket to the B4M tavern.',
    '',
    '4. Launch `claude` in any folder on this machine — a sprite will appear',
    '   in the tavern within a second. `/exit` makes it disappear.',
    '',
    'Stopping and removing',
    '---------------------',
    '',
    '  Ctrl+C cleanly stops the bridge. The shutdown handler removes the',
    '  hooks it installed so Claude Code does not error when offline.',
    '',
    '  To un-pair this device: delete ~/.b4m/cc-bridge.json. The bridge',
    '  will not reconnect. A server-side revoke UI is not shipped yet; if',
    '  you need a device revoked, email support and an operator can',
    '  invalidate the key server-side.',
    '',
    'Troubleshooting',
    '---------------',
    '',
    '  "Invalid or expired pairing token": re-download from the tavern',
    '    (tokens expire 5 minutes after issue).',
    '  "Port 48732 already in use": stop any other cc-bridge, or set',
    '    CC_BRIDGE_PORT to a free port before launching.',
    '',
  ]
    .filter(Boolean)
    .join('\n');
}

async function buildZip(params: {
  binary: Buffer;
  binaryName: string;
  pairJson: Record<string, unknown>;
  os: Os;
  baseUrl: string;
}): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    const archive = archiver('zip', { zlib: { level: 6 } });
    archive.on('data', chunk => chunks.push(chunk as Buffer));
    archive.on('end', () => resolve(Buffer.concat(chunks)));
    archive.on('error', reject);

    // Executable permission for POSIX platforms so the user doesn't have
    // to chmod before double-clicking. Zip mode is irrelevant on Windows.
    archive.append(params.binary, {
      name: params.binaryName,
      mode: params.os === 'win32' ? undefined : 0o755,
    });
    archive.append(JSON.stringify(params.pairJson, null, 2), { name: 'pair.json' });
    archive.append(readmeContent(params.baseUrl, params.binaryName, params.os), {
      name: 'README.txt',
    });

    archive.finalize();
  });
}

/**
 * POST /api/cc-bridge/download
 *
 * Auth'd + CSRF-protected + rate-limited. Mints a fresh pair token, wraps
 * the binary + pair.json + README in a zip, uploads to S3, and returns a
 * presigned URL the browser fetches. The bridge binary must already be
 * published to
 * `appFilesBucket/cc-bridge/artifacts/<version>/cc-bridge-<os>-<arch>[.exe]`.
 *
 * MUST be POST: the endpoint mints a pair token + uploads to S3, which
 * makes it unsafe under GET semantics (CSRF via `<img src=...>` would
 * spam the user's account with zips and Lambda invocations).
 *
 * Returns `Referrer-Policy: no-referrer` so the presigned URL the client
 * navigates to does not leak the tavern origin to S3 access logs.
 */
const handler = baseApi({ auth: true })
  .use(csrfProtection())
  .use(rateLimit({ limit: 10, windowMs: 60_000 }))
  .post(
    asyncHandler(async (req, res) => {
      req.logger.updateMetadata({ endpoint: 'cc-bridge/download' });

      const userId = req.user?.id;
      if (!userId) throw new BadRequestError('Missing authenticated user');
      ensureTavernAccess(req.user);

      const parsed = DownloadRequestSchema.safeParse(req.body ?? {});
      if (!parsed.success) {
        return res.status(400).json({
          error: 'Invalid os or arch',
          details: parsed.error.flatten(),
          allowed: { os: ['linux', 'darwin', 'win32'], arch: ['x64', 'arm64'] },
        });
      }

      const { os, arch } = parsed.data;
      if (os === 'win32' && arch === 'arm64') {
        return res.status(400).json({
          error: 'unsupported_platform',
          message: 'Windows on arm64 is not supported yet.',
        });
      }

      const binaryName = binaryFilename(os, arch);
      const binaryKey = `${BINARY_PREFIX}${BINARY_VERSION}/${binaryName}`;
      const appFiles = new S3Storage(Resource.appFilesBucket.name);

      let binary: Buffer;
      try {
        binary = await appFiles.download(binaryKey);
      } catch (err) {
        req.logger.error(`[CC_BRIDGE] binary missing at s3://${Resource.appFilesBucket.name}/${binaryKey}`, err);
        return res.status(503).json({
          error: 'binary_not_available',
          platform: `${os}-${arch}`,
          message:
            'The bridge binary for this platform has not been published yet. ' +
            'Copy the pair.json from the tavern modal and run the bridge from source instead.',
        });
      }

      const deviceLabel = `cc-bridge-${randomBytes(3).toString('hex')}`;
      const platform = `${os}-${arch}`;
      const randomPart = randomBytes(16).toString('hex');
      const token = `b4mpair_${randomPart}`;
      const tokenPrefix = token.substring(0, 16);
      // Async hash - don't block the Lambda event loop for ~300ms per call.
      const tokenHash = await bcrypt.hash(token, 12);
      const expiresAt = new Date(Date.now() + PAIRING_TOKEN_TTL_MS);

      await ccBridgePairingTokenRepository.create({
        userId,
        tokenHash,
        tokenPrefix,
        deviceLabel,
        platform,
        expiresAt,
      });

      // Pin baseUrl to a trusted env var - never derive from request headers.
      // A CSRF + alternate-hostname attacker could otherwise ship a zip whose
      // pair.json points at their own domain; the bridge would redeem there
      // and hand over the freshly-minted CC_BRIDGE API key.
      const baseUrl = process.env.CC_BRIDGE_PUBLIC_URL ?? process.env.APP_URL;
      if (!baseUrl) {
        req.logger.error('[CC_BRIDGE] Neither CC_BRIDGE_PUBLIC_URL nor APP_URL is set; cannot build download zip');
        return res.status(500).json({ error: 'Server misconfigured: public URL not set' });
      }

      const pairJson = {
        baseUrl,
        pairingToken: token,
        deviceLabel,
      };

      const zipBuffer = await buildZip({
        binary,
        binaryName,
        pairJson,
        os,
        baseUrl,
      });

      const downloadKey = `${DOWNLOAD_PREFIX}${userId}/${randomUUID()}.zip`;
      await appFiles.upload(zipBuffer, downloadKey, { ContentType: 'application/zip' });

      const filename = `cc-bridge-${platform}.zip`;
      const downloadUrl = await appFiles.getSignedUrl(downloadKey, 'get', {
        expiresIn: 3600,
        ResponseContentDisposition: `attachment; filename="${filename}"`,
      });

      req.logger.info(`[CC_BRIDGE] Download ready for user ${userId}, platform ${platform}, token ${tokenPrefix}…`);

      // Don't leak the tavern origin to S3 access logs when the client
      // navigates to the presigned URL. Belt-and-braces alongside the
      // client's anchor-rel="noreferrer" trigger.
      res.setHeader('Referrer-Policy', 'no-referrer');

      return res.status(200).json({
        url: downloadUrl,
        filename,
        platform,
        pairingTokenExpiresAt: expiresAt.toISOString(),
        deviceLabel,
      });
    })
  );

export const config = {
  api: {
    externalResolver: true,
  },
};

export default handler;

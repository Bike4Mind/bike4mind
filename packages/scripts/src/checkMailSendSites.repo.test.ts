import { describe, it, expect } from 'vitest';
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

/**
 * One process sends mail: the email-send worker. Everything else hands its mail to queuedMailer
 * (packages/server-utils/src/utils/mailer/queuedMailer.ts) or publishes EmailEvents.Send, so the
 * mail transport, its configuration and its grant stay in one place. This fails when a file
 * outside the allowlist loads the mailer, a transport, or a mail client library.
 */
const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');

const MAILER_DIR = 'packages/server-utils/src/utils/mailer';

/** Modules that can put a message on the wire, as repo paths without an extension. */
const SENDING_MODULES = new Set([
  MAILER_DIR,
  `${MAILER_DIR}/index`,
  `${MAILER_DIR}/smtpTransport`,
  `${MAILER_DIR}/sesTransport`,
]);

const MAIL_CLIENT_PACKAGES = ['nodemailer', '@aws-sdk/client-sesv2', '@aws-sdk/client-ses'];

/** May load the mailer. Every entry has to keep doing so, or the test fails on the stale entry. */
const ALLOWLIST: Record<string, string> = {
  'apps/workers/src/events/sendEmail.ts': 'the email-send worker',
  'packages/server-utils/src/utils/eventBus.ts': 'self-host has no event bus; email.send goes to the SMTP mailer',
  [`${MAILER_DIR}/index.ts`]: 'MailService picks the transport',
  [`${MAILER_DIR}/smtpTransport.ts`]: 'the SMTP transport',
  [`${MAILER_DIR}/sesTransport.ts`]: 'the SES transport',
  [`${MAILER_DIR}/queuedMailer.ts`]: 'self-host has no event bus; mail goes to the SMTP mailer',
  [`${MAILER_DIR}/testEmail.ts`]: 'self-host test email runs in-process through the SMTP mailer',
  [`${MAILER_DIR}/sender.ts`]: "parses the sender with nodemailer's address parser; sends nothing",
};

const SCAN_ROOTS = ['apps', 'b4m-core', 'packages', 'infra', 'scripts'];
const SOURCE_FILE = /\.(ts|tsx|mts|cts|js|mjs|cjs)$/;
const NOT_SHIPPED = /(\.test\.|\.d\.ts$|\/__tests__\/|\/__test__\/|\/__mocks__\/|vitest\.setup\.)/;

const STATIC_IMPORT = /\b(?:import|export)\s+(type\s+)?[^;'"]*?\bfrom\s*['"]([^'"]+)['"]/g;
const OTHER_IMPORT = /\b(?:import|require)\s*\(\s*['"]([^'"]+)['"]|\bimport\s*['"]([^'"]+)['"]/g;

/** Every module specifier a file loads at runtime; `import type` statements are erased and skipped. */
export function runtimeSpecifiers(source: string): string[] {
  const specifiers: string[] = [];
  for (const match of source.matchAll(STATIC_IMPORT)) {
    if (!match[1]) specifiers.push(match[2]);
  }
  for (const match of source.matchAll(OTHER_IMPORT)) {
    specifiers.push(match[1] ?? match[2]);
  }
  return specifiers;
}

const stripExtension = (specifier: string) => specifier.replace(/\.(ts|tsx|mts|cts|js|mjs|cjs)$/, '');

/** The reason a specifier counts as loading the mail transport from `file`, or undefined. */
export function mailSendReason(file: string, specifier: string): string | undefined {
  if (MAIL_CLIENT_PACKAGES.some(pkg => specifier === pkg || specifier.startsWith(`${pkg}/`))) {
    return `loads the mail client library ${specifier}`;
  }
  const target = specifier.startsWith('.')
    ? path.posix.normalize(path.posix.join(path.posix.dirname(file), specifier))
    : specifier.replace(/^@bike4mind\/server-utils\//, 'packages/server-utils/src/');
  return SENDING_MODULES.has(stripExtension(target)) ? `loads ${specifier}` : undefined;
}

function scannedFiles(): string[] {
  const out = execFileSync('git', ['ls-files', '--cached', '--others', '--exclude-standard', '--', ...SCAN_ROOTS], {
    cwd: REPO_ROOT,
    encoding: 'utf8',
    maxBuffer: 64 * 1024 * 1024,
  });
  return out.split('\n').filter(file => SOURCE_FILE.test(file) && !NOT_SHIPPED.test(file));
}

function findSendSites(): Map<string, string[]> {
  const sites = new Map<string, string[]>();
  for (const file of scannedFiles()) {
    let source: string;
    try {
      source = readFileSync(path.join(REPO_ROOT, file), 'utf8');
    } catch {
      continue; // listed by git but deleted in the working tree
    }
    if (!source.includes('mailer') && !source.includes('nodemailer') && !source.includes('client-ses')) continue;
    const reasons = runtimeSpecifiers(source)
      .map(specifier => mailSendReason(file, specifier))
      .filter((reason): reason is string => reason !== undefined);
    if (reasons.length > 0) sites.set(file, reasons);
  }
  return sites;
}

describe('mail is sent from one place', () => {
  const sites = findSendSites();

  it('finds no file outside the allowlist that loads the mailer or a mail client', () => {
    const unexpected = [...sites].filter(([file]) => !(file in ALLOWLIST)).map(([file, why]) => `${file}: ${why[0]}`);
    expect(
      unexpected,
      'Send through queuedMailer (packages/server-utils/src/utils/mailer/queuedMailer.ts) or publish EmailEvents.Send; ' +
        'only the email-send worker holds the mail transport.'
    ).toEqual([]);
  });

  it('has no allowlist entry that stopped loading the mailer', () => {
    // Also proves the scan sees real files: an empty scan would report every entry as stale.
    expect(Object.keys(ALLOWLIST).filter(file => !sites.has(file))).toEqual([]);
  });

  it.each([
    ["import mailer from '@bike4mind/server-utils/utils/mailer/index';", 'apps/client/pages/api/x.ts'],
    ["import { MailService } from '@bike4mind/server-utils/utils/mailer';", 'apps/client/pages/api/x.ts'],
    [
      "import {\n  type TestEmailResult,\n  MailService,\n} from '../utils/mailer/index';",
      'packages/server-utils/src/moderation/x.ts',
    ],
    ["const { default: mailer } = await import('./mailer/index');", 'packages/server-utils/src/utils/x.ts'],
    ["const { SesTransport } = require('./mailer/sesTransport.js');", 'packages/server-utils/src/utils/x.ts'],
    ["export { SmtpTransport } from './mailer/smtpTransport';", 'packages/server-utils/src/utils/x.ts'],
    ["import nodemailer from 'nodemailer';", 'apps/workers/src/x.ts'],
    ["import MailComposer from 'nodemailer/lib/mail-composer';", 'apps/workers/src/x.ts'],
    ["import { SESv2Client } from '@aws-sdk/client-sesv2';", 'apps/workers/src/x.ts'],
  ])('flags %s', (source, file) => {
    expect(runtimeSpecifiers(source).some(specifier => mailSendReason(file, specifier))).toBe(true);
  });

  it.each([
    ["import type { EmailConfigStatus } from '@bike4mind/server-utils/utils/mailer/index';", 'apps/client/server/x.ts'],
    ["import type Mail from 'nodemailer/lib/mailer';", 'apps/workers/src/x.ts'],
    [
      "import { getMailConfigStatus } from '@bike4mind/server-utils/utils/mailer/configStatus';",
      'apps/client/server/x.ts',
    ],
    ["import { queuedMailer } from '@bike4mind/server-utils/utils/mailer/queuedMailer';", 'apps/client/server/x.ts'],
    ["import { escapeHtml } from '../utils/mailer/emailHelpers';", 'packages/server-utils/src/moderation/x.ts'],
    ["import { sendEmailWithAttachments } from '@server/utils/mailer/emailAttachments';", 'apps/client/pages/api/x.ts'],
  ])('allows %s', (source, file) => {
    expect(runtimeSpecifiers(source).some(specifier => mailSendReason(file, specifier))).toBe(false);
  });
});

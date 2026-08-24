import { describe, expect, it } from 'vitest';
import { execFileSync } from 'child_process';
import { join } from 'path';

/**
 * No browser code may PUT bytes straight at storage without going through uploadFileToUrl.
 *
 * On self-host the object store is not browser-reachable: a presigned URL targets the internal
 * MinIO host, which the browser cannot resolve and the CSP connect-src allow-list blocks. So the
 * server hands back a same-origin proxy path instead, and only uploadFileToUrl knows to send the
 * app's Bearer to a same-origin path while withholding it from a presign.
 *
 * A raw `axios.put` / `fetch(..., {method:'PUT'})` bypasses that decision, which is why the same
 * bug has now shipped three times: fab-file uploads (#855), the data-lake batch path (#1062), and
 * the LLM history import (#1365). Each looked fine hosted and failed identically on self-host.
 *
 * Exemptions are per-file and must say why. "It is not an upload" is a fine reason; "not got
 * round to it" is the bug this test exists to catch.
 */

const REPO_ROOT = join(__dirname, '../../../..');
const SCAN_ROOTS = ['apps/client/app'];

/**
 * Files allowed to issue a raw PUT, each with the reason it is not a bypass.
 * Keyed by repo-relative path so a moved file loses its exemption and has to re-earn it.
 */
const ALLOWED_RAW_PUT: Record<string, string> = {
  'apps/client/app/utils/uploadFileToUrl.ts':
    'the sanctioned helper itself - this IS the branch every other call site must route through',
  'apps/client/app/utils/publishApi.ts':
    'draft bundle upload; the server already returns a same-origin proxy URL on self-host (mintDraftUploadUrl) and that route authorizes by signed capability token, not by Bearer, so the raw PUT is correct',
  'apps/client/app/utils/blogImageUpload.ts':
    'PUTs to a third-party blog host presign, not B4M storage - no B4M proxy to route through (#1365 decision: out of scope, a CSP/blog-integration concern)',
};

const rawPutCallSites = (): string[] => {
  let out = '';
  try {
    out = execFileSync('grep', ['-rlE', "axios\\.put\\(|method:\\s*'PUT'", ...SCAN_ROOTS], {
      cwd: REPO_ROOT,
      encoding: 'utf8',
    });
  } catch (e) {
    // grep exits 1 for no matches and 2 for a real failure; only the former is tolerable here.
    if ((e as { status?: number }).status !== 1) throw e;
  }
  return out
    .split('\n')
    .filter(Boolean)
    .filter(f => !/\.test\.|__tests__/.test(f));
};

describe('browser upload call sites', () => {
  it('finds the sanctioned helper, proving the scan is not vacuous', () => {
    // Without this, a regex that silently matched nothing would make the assertion below pass
    // while covering no files at all.
    expect(rawPutCallSites()).toContain('apps/client/app/utils/uploadFileToUrl.ts');
  });

  it('routes every browser upload through uploadFileToUrl, or documents why not', () => {
    const bypasses = rawPutCallSites().filter(f => !(f in ALLOWED_RAW_PUT));

    expect(
      bypasses,
      `raw PUT to storage outside uploadFileToUrl, with no documented exemption:\n  ${bypasses.join('\n  ')}`
    ).toEqual([]);
  });

  it('does not carry an exemption for a file that no longer raw-PUTs', () => {
    // A stale exemption is dead weight that would silently cover the next real bypass.
    const found = new Set(rawPutCallSites());
    const stale = Object.keys(ALLOWED_RAW_PUT).filter(f => !found.has(f));

    expect(stale, `exempted but no longer issues a raw PUT: ${stale.join(', ')}`).toEqual([]);
  });
});

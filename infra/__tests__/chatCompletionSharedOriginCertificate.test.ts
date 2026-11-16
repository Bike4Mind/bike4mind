/**
 * @vitest-environment node
 */
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

// infra/chatCompletion.ts only loads inside `sst`, so wiring is asserted against its source text.
const source = readFileSync(new URL('../chatCompletion.ts', import.meta.url), 'utf8');
const contract = JSON.parse(readFileSync(new URL('../deploy-contract.json', import.meta.url), 'utf8')) as {
  deployEnv: string[];
};

describe('shared preview certificate for the ChatCompletion load balancer', () => {
  it('reads the ARN only on preview stages', () => {
    expect(source).toMatch(
      /const sharedOriginCertificateArn =\s*isPreviewStage && !\$dev \? process\.env\.PREVIEW_CHAT_ORIGIN_CERT_ARN \|\| undefined : undefined/
    );
  });

  it('uses a host name one label under the parent of the stage domain when the ARN is set', () => {
    expect(source).toMatch(
      /return sharedOriginCertificateArn \? `chat-origin-\$\{domain\}` : `chat-origin\.\$\{appDomain\}`/
    );
  });

  it('requests a certificate only when no shared one is supplied', () => {
    expect(source).toMatch(/sharedOriginCertificateArn \?\? issueOriginCertificate\(originDomain\)/);
  });

  it('declares the deploy-time variable in the contract', () => {
    expect(contract.deployEnv).toContain('PREVIEW_CHAT_ORIGIN_CERT_ARN');
  });
});

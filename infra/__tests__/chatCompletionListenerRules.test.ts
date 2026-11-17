/**
 * @vitest-environment node
 */
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

// infra/chatCompletion.ts only loads inside `sst`, so wiring is asserted against its source text.
const source = readFileSync(new URL('../chatCompletion.ts', import.meta.url), 'utf8');
const squashed = source.replace(/\s+/g, ' ');

describe('ChatCompletion load balancer listener rules', () => {
  it('forwards on 443 and redirects port 80 when the stage has an origin domain', () => {
    expect(squashed).toContain(
      "rules: originDomain ? [ { listen: '443/https', forward: '8080/http' }, { listen: '80/http', redirect: '443/https' }, ]"
    );
  });

  it('forwards on port 80 only when the stage has no origin domain', () => {
    expect(squashed).toContain(": [{ listen: '80/http', forward: '8080/http' }],");
    expect(source.match(/listen: '80\/http', forward:/g)).toHaveLength(1);
  });

  it('admits each source on the forwarding port only', () => {
    expect(source).toContain('const forwardingPort = originDomain ? 443 : 80;');
    expect(source.match(/fromPort: forwardingPort,\s+toPort: forwardingPort,/g)).toHaveLength(2);
    expect(source).not.toMatch(/fromPort: 80,/);
  });
});

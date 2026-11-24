/**
 * @vitest-environment node
 */
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

// infra/chatCompletion.ts only loads inside `sst`, so wiring is asserted against its source text.
const source = readFileSync(new URL('../chatCompletion.ts', import.meta.url), 'utf8');
const squashed = source.replace(/\s+/g, ' ');

describe('ChatCompletion load balancer listener rules', () => {
  it('adds a dormant HTTP redirect beside the forwarding rules when the stage has an origin domain', () => {
    expect(squashed).toContain(
      "rules: originDomain ? [...forwardRules, { listen: '80/http', redirect: '443/https' }] : forwardRules,"
    );
    expect(source).toContain("const forwardListen = originDomain ? ('443/https' as const) : ('80/http' as const);");
  });

  it('forwards on port 80 only when the stage has no origin domain', () => {
    expect(source).not.toMatch(/listen: '80\/http', forward:/);
  });

  it('forwards only on the origin header or a direct path when origin verification is on', () => {
    expect(squashed).toContain('const forwardRules = originVerifyEnabled ? [');
    expect(squashed).toContain(
      'header: { name: ORIGIN_VERIFY_HEADER, values: [$util.unsecret(originVerifySecret.result)] }'
    );
    expect(squashed).toContain(
      "...DIRECT_PATHS.map(path => ({ listen: forwardListen, forward: '8080/http' as const, conditions: { path } }))"
    );
    expect(source).toContain("const DIRECT_PATHS = ['/process', '/health'] as const;");
    // An unconditional forward rule would become the listener's default action and admit everything.
    expect(squashed).toContain(": [{ listen: forwardListen, forward: '8080/http' as const }];");
    expect(source.match(/listen: forwardListen, forward: '8080\/http' as const \}/g)).toHaveLength(1);
  });

  it('keeps the rule conditions secret and limits the direct paths to the NAT egress IPs', () => {
    expect(squashed).toContain(
      "if (originVerifyEnabled) { $transform(aws.lb.ListenerRule, (args, _opts, name) => { if (!name.startsWith('ChatCompletionListener')) return; args.conditions = $util.secret("
    );
    expect(squashed).toContain(
      'conditions.some(condition => condition.pathPattern) ? [...conditions, { sourceIp: { values: cidrs } }] : conditions'
    );
  });

  it('admits each source on the forwarding port only', () => {
    expect(source).toContain('const forwardingPort = originDomain ? 443 : 80;');
    expect(source.match(/fromPort: forwardingPort,\s+toPort: forwardingPort,/g)).toHaveLength(2);
    expect(source).not.toMatch(/fromPort: 80,/);
    expect(source).toContain('const natCidrs = natEgressCidrs();');
  });
});

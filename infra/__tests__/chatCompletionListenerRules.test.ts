/**
 * @vitest-environment node
 */
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { withDirectPathSourceIp } from '../listenerRuleConditions';

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
    expect(source).toContain("const forwardListen = originDomain ? ('443/https' as const) : ('80/http' as const);");
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

  it('wraps the rule conditions as secret through the listener-rule transform', () => {
    expect(squashed).toContain(
      "if (originVerifyEnabled) { $transform(aws.lb.ListenerRule, (args, _opts, name) => { if (!name.startsWith('ChatCompletionListener')) return; args.conditions = $util.secret("
    );
    expect(squashed).toContain('.apply(([conditions, cidrs]) => withDirectPathSourceIp(conditions, cidrs))');
  });

  it('admits each source on the forwarding port only', () => {
    expect(source).toContain('const forwardingPort = originDomain ? 443 : 80;');
    expect(source.match(/fromPort: forwardingPort,\s+toPort: forwardingPort,/g)).toHaveLength(2);
    expect(source).not.toMatch(/fromPort: 80,/);
    expect(source).toContain('const natCidrs = natEgressCidrs();');
  });
});

describe('withDirectPathSourceIp', () => {
  const cidrs = ['203.0.113.1/32', '203.0.113.2/32'];

  it('leaves a header rule unchanged', () => {
    const conditions = [{ httpHeader: { httpHeaderName: 'x-b4m-origin-verify', values: ['secret'] } }];
    expect(withDirectPathSourceIp(conditions, cidrs)).toEqual(conditions);
  });

  it('adds the source IPs as a separate block on a path rule', () => {
    const conditions = [{ pathPattern: { values: ['/process'] } }];
    expect(withDirectPathSourceIp(conditions, cidrs)).toEqual([
      { pathPattern: { values: ['/process'] } },
      { sourceIp: { values: cidrs } },
    ]);
  });
});

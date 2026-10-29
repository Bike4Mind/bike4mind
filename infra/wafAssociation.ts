/**
 * External WAF association settings.
 *
 * When WAF_WEB_ACL_NAME is set, the ACL resources are owned by the infrastructure repo; this
 * stack only looks the ACL up by name and attaches it to the CDN.
 */

export type ExternalWafAssociation = { webAclName: string };

export function resolveWafLogDestination(destinations: readonly string[]): { arn: string; name: string } {
  const destination = destinations[0];
  const match = destination?.match(/^arn:[^:]+:logs:us-east-1:[^:]+:log-group:(aws-waf-logs-[^:]+)(?::\*)?$/);
  if (destinations.length !== 1 || !match) {
    throw new Error('The external WAF ACL must log to one aws-waf-logs- CloudWatch log group in us-east-1.');
  }
  return { arn: destination.replace(/:\*$/, ''), name: match[1] };
}

/**
 * Resolves the externally managed ACL name, or undefined when the stage owns its ACL.
 * Any stage with ENABLE_WAF=true and WAF_WEB_ACL_NAME set attaches the external ACL. Production
 * throws instead of returning undefined: a missing name would silently detach the ACL from the CDN.
 */
export function resolveExternalWafAssociation(args: {
  stage: string;
  enableWaf: string | undefined;
  webAclName: string | undefined;
}): ExternalWafAssociation | undefined {
  const webAclName = args.webAclName?.trim();

  if (args.stage === 'production') {
    if (args.enableWaf !== 'true') {
      throw new Error(
        "ENABLE_WAF must be 'true' on the production stage: deploying without it would detach the web ACL from the CDN."
      );
    }
    if (!webAclName) {
      throw new Error(
        'WAF_WEB_ACL_NAME must be set on the production stage: it names the externally managed web ACL to attach to the CDN.'
      );
    }
  }

  return args.enableWaf === 'true' && webAclName ? { webAclName } : undefined;
}

/**
 * Whether the attached ACL inserts the WAF label headers that apps/client/server/auth/networkMeta.ts
 * reads. The stage-owned ACL is built from infra/waf/bike4mind-api-protection-dev.json, which carries
 * the label-forward rules. An external ACL is managed outside this stack, so its deployer vouches for
 * them with WAF_LABEL_FORWARDING=true; without it the signup WAF fields stay null. The flag also
 * vouches for the forged-header block: networkMeta.ts trusts the headers at face value.
 */
export function resolveWafLabelForwarding(args: {
  attachedAcl: 'none' | 'stage' | 'external';
  labelForwarding: string | undefined;
}): boolean {
  if (args.attachedAcl === 'stage') return true;
  return args.attachedAcl === 'external' && args.labelForwarding === 'true';
}

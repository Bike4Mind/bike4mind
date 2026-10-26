/**
 * Production WAF association settings.
 *
 * Production ACL resources are owned by the infrastructure repo; this stack only looks the ACL up
 * by name and attaches it to the CDN.
 */

export type ExternalWafAssociation = { webAclName: string };

/**
 * Resolves the externally managed ACL name for production, or undefined for stages that own
 * their ACL. Throws instead of returning undefined for production: a missing name would
 * silently detach the ACL from the CDN on the next deploy.
 */
export function resolveExternalWafAssociation(args: {
  stage: string;
  enableWaf: string | undefined;
  webAclName: string | undefined;
}): ExternalWafAssociation | undefined {
  if (args.stage !== 'production') return undefined;

  if (args.enableWaf !== 'true') {
    throw new Error(
      "ENABLE_WAF must be 'true' on the production stage: deploying without it would detach the web ACL from the CDN."
    );
  }
  const webAclName = args.webAclName?.trim();
  if (!webAclName) {
    throw new Error(
      'WAF_WEB_ACL_NAME must be set on the production stage: it names the externally managed web ACL to attach to the CDN.'
    );
  }
  return { webAclName };
}

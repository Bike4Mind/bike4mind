/**
 * External WAF association settings.
 *
 * Externally managed ACL resources are owned by the infrastructure repo; this stack only looks the
 * ACL up by name and attaches it to the CDN.
 */

export type ExternalWafAssociation = { webAclName: string };

/** Stage that serves the staging environment. */
const STAGING_STAGE = 'dev';

/**
 * Resolves the externally managed ACL name, or undefined for stages that own their ACL.
 * Production throws instead of returning undefined: a missing name would silently detach the ACL
 * from the CDN on the next deploy. Staging and preview stages attach externally only when
 * ENABLE_WAF is true and a name is set, and otherwise keep their stage-owned ACL. All other stages
 * own their ACL. `isPreview` is the preview-stage flag from constants.ts, passed in so this module
 * stays free of SST globals.
 */
export function resolveExternalWafAssociation(args: {
  stage: string;
  isPreview: boolean;
  enableWaf: string | undefined;
  webAclName: string | undefined;
}): ExternalWafAssociation | undefined {
  if (args.stage !== 'production' && (args.stage === STAGING_STAGE || args.isPreview)) {
    const name = args.webAclName?.trim();
    return args.enableWaf === 'true' && name ? { webAclName: name } : undefined;
  }
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

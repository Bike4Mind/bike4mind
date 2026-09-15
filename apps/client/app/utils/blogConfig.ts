/**
 * Operator blog host for the optional blog-integration feature.
 *
 * Sourced from NEXT_PUBLIC_BLOG_HOST (inlined into the client bundle at build time) with NO
 * brand fallback - empty when the operator hasn't configured one. An unbranded fork therefore
 * never ships a hardcoded personal blog host; the blog-integration UI requires the user to
 * supply a URL and the CSP omits the entry. The hosted deployment sets BLOG_HOST per deploy.
 *
 * @returns The configured blog host (e.g. "https://blog.example.com"), or "" when unset.
 */
export const getBlogHost = (): string => process.env.NEXT_PUBLIC_BLOG_HOST || '';

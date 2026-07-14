/**
 * Blessed, self-hosted artifact library script paths (root-relative).
 *
 * Single source of truth shared across the artifact pipeline:
 *  - publish validation + viewer CSP (server: validateBundle.ts, viewerSecurity.ts)
 *  - publish srcdoc absolutization (server: renderSandboxedBundle.ts)
 *  - in-app sandbox sanitizer absolutization (client: htmlSanitizer.ts)
 *  - /api/artifact-sandbox CSP (server)
 *
 * Keeping the list here (rather than in a server-only module) lets the client
 * sanitizer absolutize EXACTLY these paths without pulling server-only deps
 * (cheerio) into the client bundle - so the client and publish paths can never
 * drift apart on what counts as "blessed".
 *
 * These are paths only; the deployment-specific host allowlist (PUBLISH_HOST,
 * derived from SERVER_DOMAIN) stays in validateBundle.ts.
 */
/**
 * React runtime libs self-hosted for PUBLISHABLE React artifacts (issue #21). Pinned,
 * self-hosted UMD builds under `/static/lib/` (mirrors `chart.js@4.x.js`). The publish-time
 * transpiler references these to assemble a React artifact's inert HTML bundle; kept as a
 * named subset so the assembler and the validator share one list.
 */
export const REACT_BLESSED_SCRIPT_PATHS: readonly string[] = [
  '/static/lib/react@18.x.js',
  '/static/lib/react-dom@18.x.js',
  '/static/lib/prop-types@15.x.js',
];

export const BLESSED_SCRIPT_PATHS: readonly string[] = [
  '/static/lib/chart.js@4.x.js',
  '/static/b4m-client.js@1.x.js',
  ...REACT_BLESSED_SCRIPT_PATHS,
];

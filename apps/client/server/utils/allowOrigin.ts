/**
 * On the Next server Lambda the function URL adds `Access-Control-Allow-Origin: *` to every
 * request that carries an Origin (SST's default URL CORS, see the `server` function in
 * infra/web.ts), and a second value makes browsers reject the response. A request without
 * Origin gets nothing from it, so the handler still sets the header there: a CDN copy filled by
 * that request is then readable cross-origin too. Fargate, self-host and local dev get no
 * platform header at all.
 */
export function setAllowOrigin(
  req: { headers: { origin?: string } },
  res: { setHeader(name: string, value: string): unknown },
  value: string
): void {
  if (process.env.AWS_LAMBDA_FUNCTION_NAME && req.headers.origin) return;
  res.setHeader('Access-Control-Allow-Origin', value);
}

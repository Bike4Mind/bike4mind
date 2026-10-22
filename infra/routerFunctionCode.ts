import { transformSync } from 'esbuild';

const CLOUDFRONT_FUNCTION_MAX_BYTES = 10_240;

export function minifyRouterFunction(code: string): string {
  // Preserve CloudFront's handler name and SST's identifiers; remove formatting and comments.
  const minified = transformSync(code, {
    minifyWhitespace: true,
    minifySyntax: true,
    minifyIdentifiers: false,
    legalComments: 'none',
    // Match SST's compiler target so minification cannot introduce unsupported edge syntax.
    target: 'es2018',
  }).code;
  const size = Buffer.byteLength(minified, 'utf8');
  if (size > CLOUDFRONT_FUNCTION_MAX_BYTES) {
    throw new Error(`Router CloudFront function is ${size} bytes; maximum is ${CLOUDFRONT_FUNCTION_MAX_BYTES}`);
  }
  return minified;
}

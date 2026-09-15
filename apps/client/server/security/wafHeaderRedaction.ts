/**
 * Header exposure policy for the admin blocked-requests view.
 *
 * WAF-side redaction (infra/wafRedaction.ts) is the write-time gate, and it only covers the headers
 * that were known when the WebACL was last deployed. This is the read-time gate: only the headers
 * listed here keep their value on the way to the browser, so a header introduced after that deploy,
 * or one already sitting in a log record written before redaction was configured, is withheld by
 * default rather than passed through.
 *
 * Membership test: does an admin triaging a blocked request need this to tell a bot from a customer,
 * or to correlate the block with an application log line? Anything that carries a secret, or that
 * might, does not belong here.
 */
const WAF_DIAGNOSTIC_HEADERS: readonly string[] = [
  'host',
  'user-agent',
  'referer',
  'origin',
  'accept',
  'accept-encoding',
  'accept-language',
  'content-type',
  'content-length',
  'cache-control',
  'connection',
  'via',
  'upgrade-insecure-requests',
  // Client hints and fetch metadata: the signals that separate a real browser from a scripted client.
  'sec-ch-ua',
  'sec-ch-ua-mobile',
  'sec-ch-ua-platform',
  'sec-fetch-dest',
  'sec-fetch-mode',
  'sec-fetch-site',
  'sec-fetch-user',
  // Forwarding chain and trace identifiers, for correlating a block with the application logs.
  'x-forwarded-for',
  'x-forwarded-host',
  'x-forwarded-proto',
  'x-real-ip',
  'x-amzn-trace-id',
  'x-request-id',
  'x-b4m-client',
  // Webhook delivery metadata. Identifies which integration got blocked; neither value is a secret,
  // unlike the signature headers that accompany them.
  'x-github-event',
  'x-github-delivery',
];

const diagnosticHeaderSet = new Set(WAF_DIAGNOSTIC_HEADERS);

/**
 * Placeholder for a header this API withheld. Deliberately not WAF's own "REDACTED", so the
 * dashboard distinguishes a value the log never held from one the log holds but we do not serve.
 */
export const WAF_MASKED_HEADER_VALUE = 'MASKED';

export function isWafDiagnosticHeader(name: string): boolean {
  return diagnosticHeaderSet.has(name.toLowerCase());
}

/**
 * Replace the value of every non-diagnostic header with a mask, keeping the name. Names survive so
 * an admin can still see which headers a blocked request carried.
 *
 * WAF logs header names in the casing the client sent, so matching is case-insensitive.
 */
export function maskWafRequestHeaders(
  headers: ReadonlyArray<{ name: string; value: string }>
): Array<{ name: string; value: string }> {
  return headers.map(header =>
    isWafDiagnosticHeader(header.name)
      ? { name: header.name, value: header.value }
      : { name: header.name, value: WAF_MASKED_HEADER_VALUE }
  );
}

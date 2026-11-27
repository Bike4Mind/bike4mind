/**
 * Error type extraction and message normalization helpers
 */

/**
 * Regex patterns for extracting and normalizing error data
 */
const PATTERNS = {
  // Error type extraction (e.g., "TypeError:", "MongoServerError:", "ValidationException:")
  errorType: /^(?:(?:Runtime\.)?UnhandledPromiseRejection:\s*)?(\w+(?:Error|Exception)?)\s*:/m,

  // Normalization patterns
  uuid: /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gi,
  mongoObjectId: /\b[0-9a-f]{24}\b/gi,
  isoTimestamp: /\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?(?:Z|[+-]\d{2}:?\d{2})?/g,
  unixTimestamp: /\b\d{10,13}\b/g,
  slackTimestamp: /\d{10}\.\d{6}/g,
  portNumber: /:(\d{4,5})\b/g,
  requestId: /(?:request[_-]?id|correlation[_-]?id|trace[_-]?id|req_id|x-request-id)[:\s=]+['"]?[\w-]+['"]?/gi,
  email: /[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}/g,
  ipv4: /\b(?:\d{1,3}\.){3}\d{1,3}\b/g,
  ipv6: /\b(?:[0-9a-fA-F]{1,4}:){7}[0-9a-fA-F]{1,4}\b|\b(?:[0-9a-fA-F]{1,4}:){1,7}:|\b(?:[0-9a-fA-F]{1,4}:){1,6}:[0-9a-fA-F]{1,4}\b/g,

  // AWS/CloudWatch patterns (for LiveOps alert deduplication)
  // CloudWatch console URLs - entire URL is variable (handles log streams, function suffixes, etc.)
  cloudwatchUrl: /https:\/\/console\.aws\.amazon\.com\/cloudwatch\/[^\s)]+/gi,
  // 32-character hex IDs (AWS log stream IDs, X-Ray segments - not matched by 24-char ObjectId)
  hexId32: /\b[0-9a-f]{32}\b/gi,
  // Count/duration metadata that appears in aggregated alerts
  countDuration: /count:\s*\d+\s+duration:\s*[\dhms\s]+/gi,
  // Lambda log stream format: YYYY/MM/DD/[$LATEST]hexstring or YYYY/MM/DD/[version]hexstring
  lambdaLogStream: /\d{4}\/\d{2}\/\d{2}\/\[\$?\w+\][a-f0-9]{32}/gi,
};

/**
 * Extract the error type/class from error text
 *
 * @example
 * extractErrorType("TypeError: Cannot read property 'foo'") => "TypeError"
 * extractErrorType("MongoServerError: E11000 duplicate key") => "MongoServerError"
 */
export function extractErrorType(text: string): string {
  const match = text.match(PATTERNS.errorType);
  if (match?.[1]) {
    return match[1];
  }

  // Fallback: look for common error patterns
  const errorPatterns = [
    /\b(TypeError|ReferenceError|SyntaxError|RangeError|URIError|EvalError)\b/,
    /\b(MongoServerError|MongoNetworkError|MongoError)\b/,
    /\b(ValidationException|ServiceException|AccessDeniedException)\b/,
    /\b(\w+Error|\w+Exception)\b/,
  ];

  for (const pattern of errorPatterns) {
    const fallbackMatch = text.match(pattern);
    if (fallbackMatch?.[1]) {
      return fallbackMatch[1];
    }
  }

  return 'UnknownError';
}

/**
 * Normalize error message by replacing variable parts with placeholders
 *
 * Conservative normalization to avoid false positives:
 * - Replaces: UUIDs, ObjectIds, timestamps, ports, request IDs, emails, IPs
 * - Preserves: file paths, HTTP status codes, error codes, model names
 */
export function normalizeErrorMessage(text: string): string {
  let normalized = text;

  // Order matters: more specific patterns first

  // Remove Runtime.UnhandledPromiseRejection wrapper (common Lambda prefix)
  normalized = normalized.replace(/^Runtime\.UnhandledPromiseRejection:\s*/i, '');

  // AWS/CloudWatch patterns (replace FIRST to handle embedded IDs and suffixes)
  normalized = normalized.replace(PATTERNS.cloudwatchUrl, '<CLOUDWATCH_URL>');
  normalized = normalized.replace(PATTERNS.lambdaLogStream, '<LOG_STREAM>');
  // Replace 32-char hex IDs (after URLs to avoid partial matches)
  normalized = normalized.replace(PATTERNS.hexId32, '<HEX_ID>');
  normalized = normalized.replace(PATTERNS.countDuration, '<COUNT_DURATION>');

  // Replace ISO timestamps (YYYY-MM-DDTHH:MM:SS format)
  normalized = normalized.replace(PATTERNS.isoTimestamp, '<TIMESTAMP>');

  // Replace Slack timestamps (before general numbers) - format: 10digits.6digits
  normalized = normalized.replace(PATTERNS.slackTimestamp, '<SLACK_TS>');

  // Replace UUIDs (also covers AWS request IDs)
  normalized = normalized.replace(PATTERNS.uuid, '<UUID>');

  // Replace MongoDB ObjectIds (24 hex chars)
  normalized = normalized.replace(PATTERNS.mongoObjectId, '<ID>');

  // Replace Unix timestamps (10-13 digits standalone)
  // But avoid matching things like port numbers or small integers
  normalized = normalized.replace(/\b[12]\d{9,12}\b/g, '<TS>');

  normalized = normalized.replace(PATTERNS.portNumber, ':<PORT>');
  normalized = normalized.replace(PATTERNS.requestId, '<REQ_ID>');
  normalized = normalized.replace(PATTERNS.email, '<EMAIL>');
  normalized = normalized.replace(PATTERNS.ipv4, '<IP>');
  normalized = normalized.replace(PATTERNS.ipv6, '<IP>');

  normalized = normalized.replace(/\s+/g, ' ').trim();

  return normalized;
}

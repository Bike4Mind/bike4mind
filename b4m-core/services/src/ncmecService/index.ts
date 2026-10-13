/**
 * NCMEC CyberTipline reporting service (18 U.S.C. section 2258A).
 *
 * Submits a CyberTip to NCMEC when a human admin confirms a detected incident is CSAM.
 * Only the admin verdict route calls this; the detection/block path does not.
 *
 * Credentials (espId, apiKey) and the sandbox flag are resolved by the caller from SST
 * Resource (Resource.NCMEC_ESP_ID.value, etc.) and passed in as arguments. This keeps the
 * service free of SST imports and allows the test suite to supply config directly.
 *
 * Sandbox vs. production: anything other than an explicit useSandbox=false uses the test
 * host, so a misconfigured or missing value cannot post to production.
 *
 * Self-host installs skip reporting (same pattern as imageModerationGate.ts) because
 * self-host operators are not registered ESPs and have no NCMEC credentials.
 *
 * IMPORTANT: The XML schema and field values below are based on the publicly documented
 * CyberTipline ESP API at report.cybertip.org/ispws/documentation/. Validate the exact
 * schema, element names, and required fields with your NCMEC ESP representative before
 * go-live. In particular, confirm the /finish endpoint path and the reporter vs.
 * personOrUserReported element placement, as these affect who NCMEC treats as the suspect.
 */

// NCMEC CyberTipline ESP API (report.cybertip.org/ispws/documentation/).
const NCMEC_PRODUCTION_URL = 'https://report.cybertip.org/ispws';
const NCMEC_TEST_URL = 'https://exttest.cybertip.org/ispws';

// NCMEC incident type string for CSAM (possession, manufacture, and distribution).
const NCMEC_CSAM_INCIDENT_TYPE = 'Child Pornography (possession, manufacture, and distribution)';

export interface NcmecCredentials {
  /** ESP ID issued by NCMEC to the registered Electronic Service Provider. */
  espId: string;
  /** API key (password component of HTTP Basic auth). */
  apiKey: string;
  /**
   * When false (explicit), use the production host. Any other value (true, missing) uses
   * the test host, so misconfigured deployments cannot post to production.
   */
  useSandbox: boolean;
}

export interface NcmecReportInput {
  /** Internal incident ID (imageModerationIncident._id) for audit correlation. */
  incidentId: string;
  /** The platform user ID whose content was blocked. NCMEC treats this as the suspect. */
  userId: string;
  /** ISO timestamp of when the incident was detected. */
  detectedAt: Date;
  /** Rekognition labels that triggered the block. */
  labels: Array<{ name: string; confidence: number }>;
  /** The FabFile ID, when the incident originated from an uploaded file. */
  fabFileId?: string;
}

export interface NcmecReportResult {
  /** The CyberTipline report identifier returned by NCMEC. Persist on the incident record. */
  reportId: string;
}

/** Escapes a string value for safe inclusion in XML character data. */
function xmlEscape(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
}

function buildSubmitXml(espId: string, input: NcmecReportInput): string {
  // Rekognition stores confidence in the 0-100 range (not 0-1); format directly.
  const labelsSummary = input.labels
    .map(l => `${xmlEscape(l.name)} (${l.confidence.toFixed(1)}%)`)
    .join(', ');

  // XML per NCMEC CyberTipline ESP API (report.cybertip.org/ispws/documentation/).
  // <reporter> identifies the reporting ESP; <personOrUserReported> is the suspect.
  // Verify this schema with your NCMEC ESP representative before production use.
  return `<?xml version="1.0" encoding="UTF-8"?>
<report>
  <incidentSummary>
    <incidentType>${xmlEscape(NCMEC_CSAM_INCIDENT_TYPE)}</incidentType>
    <incidentDateTime>${input.detectedAt.toISOString()}</incidentDateTime>
  </incidentSummary>
  <reporter>
    <reportingEsp>
      <espId>${xmlEscape(espId)}</espId>
    </reportingEsp>
  </reporter>
  <personOrUserReported>
    <espUserId>${xmlEscape(input.userId)}</espUserId>
  </personOrUserReported>
  <additionalInfo>
    <text>Internal incident ID: ${xmlEscape(input.incidentId)}. Detected labels: ${labelsSummary}.${input.fabFileId ? ` File ID: ${xmlEscape(input.fabFileId)}.` : ''}</text>
  </additionalInfo>
</report>`;
}

function buildFinishXml(reportId: string): string {
  return `<?xml version="1.0" encoding="UTF-8"?>
<finishReport>
  <reportId>${xmlEscape(reportId)}</reportId>
</finishReport>`;
}

/**
 * NCMEC explicitly rejected the report (HTTP non-2xx on /submit).
 * A rejection means NCMEC did not accept the submission, so rolling back to
 * 'pending_review' is safe -- no CyberTip was filed.
 *
 * Callers distinguish this from a plain Error, which indicates an unknown outcome
 * (timeout, network error, missing reportId in a 2xx body): in that case the incident
 * must remain in 'confirmed_csam' until a human can verify with NCMEC.
 */
export class NcmecRejectedError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'NcmecRejectedError';
  }
}

/**
 * Submit a confirmed CSAM incident to the NCMEC CyberTipline.
 *
 * Flow: POST /submit (get reportId) -> POST /finish (finalize).
 * NCMEC deletes unfinished reports 24 hours after /submit; /finish must succeed before
 * the incident is marked 'reported'.
 *
 * Throws NcmecRejectedError when NCMEC explicitly rejects /submit (non-2xx): the caller
 * may safely roll back the incident to 'pending_review'.
 *
 * Throws plain Error for unknown outcomes (timeout, network error, missing reportId):
 * the caller must NOT roll back -- NCMEC may have already received the submission.
 */
export async function submitNcmecReport(
  credentials: NcmecCredentials,
  input: NcmecReportInput
): Promise<NcmecReportResult> {
  if (process.env.B4M_SELF_HOST === 'true') {
    throw new Error('NCMEC reporting is not available on self-host installs');
  }

  const { espId, apiKey, useSandbox } = credentials;

  if (!espId || espId === 'not-configured' || !apiKey || apiKey === 'not-configured') {
    throw new Error('NCMEC credentials not configured (NCMEC_ESP_ID, NCMEC_API_KEY must be set via SST secrets)');
  }

  const baseUrl = useSandbox !== false ? NCMEC_TEST_URL : NCMEC_PRODUCTION_URL;
  const credential = Buffer.from(`${espId}:${apiKey}`).toString('base64');
  const authHeader = `Basic ${credential}`;

  // 25 seconds: safely below the typical 30-second Lambda timeout while still giving NCMEC
  // time to respond. A timeout throws AbortError (unknown outcome -- do not rollback).
  const fetchTimeout = AbortSignal.timeout(25_000);

  // Step 1: Submit the report and receive a reportId.
  const submitXml = buildSubmitXml(espId, input);
  const submitResponse = await fetch(`${baseUrl}/submit`, {
    method: 'POST',
    headers: { Authorization: authHeader, 'Content-Type': 'text/xml; charset=utf-8' },
    body: submitXml,
    signal: fetchTimeout,
  });

  if (!submitResponse.ok) {
    const text = await submitResponse.text();
    // Non-2xx: NCMEC explicitly rejected the submission -- no report was filed. The caller
    // can safely roll back the incident to 'pending_review'.
    throw new NcmecRejectedError(`NCMEC /submit error ${submitResponse.status}: ${text.slice(0, 300)}`);
  }

  const submitText = await submitResponse.text();
  const match = /<reportId>([^<]+)<\/reportId>/.exec(submitText);
  if (!match) {
    // 2xx but no parseable reportId -- ambiguous outcome. The caller must NOT roll back.
    throw new Error(`NCMEC /submit response missing reportId: ${submitText.slice(0, 300)}`);
  }
  const reportId = match[1].trim();

  // Step 2: Finalize the report. Without /finish, NCMEC deletes it after 24 hours.
  // We have the reportId at this point. A /finish failure is logged with the reportId so
  // an operator can manually finalize; the caller should NOT roll back.
  const finishXml = buildFinishXml(reportId);
  const finishResponse = await fetch(`${baseUrl}/finish`, {
    method: 'POST',
    headers: { Authorization: authHeader, 'Content-Type': 'text/xml; charset=utf-8' },
    body: finishXml,
    signal: fetchTimeout,
  });

  if (!finishResponse.ok) {
    const text = await finishResponse.text();
    throw new Error(`NCMEC /finish error ${finishResponse.status} for reportId ${reportId}: ${text.slice(0, 300)}`);
  }

  return { reportId };
}

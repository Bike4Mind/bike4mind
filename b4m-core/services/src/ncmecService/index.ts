/**
 * NCMEC CyberTipline reporting service (18 U.S.C. §2258A).
 *
 * Submits a CyberTip to NCMEC when a human admin confirms a detected incident is CSAM.
 * Only the admin verdict route calls this; the detection/block path does not.
 *
 * Credentials come from SST secrets (NCMEC_ESP_ID, NCMEC_API_KEY). A missing or
 * 'not-configured' credential throws immediately so the caller can surface the gap
 * without a silent no-op.
 *
 * Sandbox vs. production is controlled by NCMEC_USE_SANDBOX:
 *   - 'true'  -> extapipre.cybertipline.org (sandbox; safe for testing)
 *   - unset or anything else -> extapi.cybertipline.org (production)
 *
 * Self-host installs skip reporting (same pattern as imageModerationGate.ts) because
 * self-host operators are not registered ESPs and have no NCMEC credentials.
 *
 * IMPORTANT: Before going live, verify the exact endpoint path and XML schema with your
 * NCMEC ESP representative. The XML format below follows the publicly documented
 * CyberTipline ESP API v3 structure but must be validated against the schema NCMEC
 * provides to registered ESPs.
 */

// Publicly documented NCMEC CyberTipline ESP API endpoints.
const NCMEC_SANDBOX_URL = 'https://extapipre.cybertipline.org';
const NCMEC_PRODUCTION_URL = 'https://extapi.cybertipline.org';

export interface NcmecReportInput {
  /** Internal incident ID (imageModerationIncident._id) for audit correlation. */
  incidentId: string;
  /** The platform user ID whose content was blocked. */
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

function buildReportXml(espId: string, input: NcmecReportInput): string {
  const labelsSummary = input.labels
    .map(l => `${xmlEscape(l.name)} (${(l.confidence * 100).toFixed(1)}%)`)
    .join(', ');

  // XML per NCMEC CyberTipline ESP API v3 specification.
  // Verify this schema with your NCMEC ESP representative before production use.
  return `<?xml version="1.0" encoding="UTF-8"?>
<cybertiplineReport>
  <reportingEsp>
    <espId>${xmlEscape(espId)}</espId>
  </reportingEsp>
  <incidentSummary>
    <incidentType>74</incidentType>
    <incidentDateTime>${input.detectedAt.toISOString()}</incidentDateTime>
  </incidentSummary>
  <reporter>
    <reportingPerson>
      <espUserId>${xmlEscape(input.userId)}</espUserId>
    </reportingPerson>
  </reporter>
  <additionalInfo>
    <text>Internal incident ID: ${xmlEscape(input.incidentId)}. Detected labels: ${labelsSummary}.${input.fabFileId ? ` File ID: ${xmlEscape(input.fabFileId)}.` : ''}</text>
  </additionalInfo>
</cybertiplineReport>`;
}

/**
 * Submit a confirmed CSAM incident to the NCMEC CyberTipline.
 *
 * Returns the `reportId` that NCMEC assigns; the caller must persist this on the
 * incident and flip `reviewStatus` to 'reported'. Throws on any API or credential error.
 */
export async function submitNcmecReport(input: NcmecReportInput): Promise<NcmecReportResult> {
  if (process.env.B4M_SELF_HOST === 'true') {
    throw new Error('NCMEC reporting is not available on self-host installs');
  }

  const espId = process.env.NCMEC_ESP_ID;
  const apiKey = process.env.NCMEC_API_KEY;

  if (!espId || espId === 'not-configured' || !apiKey || apiKey === 'not-configured') {
    throw new Error('NCMEC credentials not configured (NCMEC_ESP_ID, NCMEC_API_KEY must be set via SST secrets)');
  }

  const useSandbox = process.env.NCMEC_USE_SANDBOX === 'true';
  const baseUrl = useSandbox ? NCMEC_SANDBOX_URL : NCMEC_PRODUCTION_URL;

  const xml = buildReportXml(espId, input);
  const credential = Buffer.from(`${espId}:${apiKey}`).toString('base64');

  const formData = new FormData();
  formData.append('report', new Blob([xml], { type: 'text/xml' }), 'report.xml');

  const response = await fetch(`${baseUrl}/cybertiplinewebservices/v3/report`, {
    method: 'POST',
    headers: { Authorization: `Basic ${credential}` },
    body: formData,
  });

  if (!response.ok) {
    const text = await response.text();
    throw new Error(`NCMEC API error ${response.status}: ${text.slice(0, 300)}`);
  }

  const responseText = await response.text();
  const match = /<reportId>([^<]+)<\/reportId>/.exec(responseText);
  if (!match) {
    throw new Error(`NCMEC response missing reportId: ${responseText.slice(0, 300)}`);
  }

  return { reportId: match[1].trim() };
}

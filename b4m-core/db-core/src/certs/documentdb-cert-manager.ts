import { writeFileSync, existsSync, mkdirSync } from 'fs';
import { join } from 'path';
import { awsGlobalBundle } from './aws-global-bundle';

// DocumentDB root certificate content (base64 encoded for compactness)
// This is the global-bundle.pem from AWS: https://docs.aws.amazon.com/documentdb/latest/developerguide/ca_cert_rotation.html
// To update this certificate:
// 1. Download: curl -sS "https://truststore.pki.rds.amazonaws.com/global/global-bundle.pem" -o global-bundle.pem
// 2. Convert to base64: base64 -b 76 -i global-bundle.pem -o aws-global-bundle.ts (on macOS) or base64 -w 0 global-bundle.pem > aws-global-bundle.ts (on Linux)
// 3. Add an `export const awsGlobalBundle = ` preamble at the top of the file, and a `;` at the end
// 4. We import above, so we don't need to update this file, and it's not a massive wall of text right here.
//
const DOCUMENTDB_CA_BUNDLE_BASE64 = process.env.DOCUMENTDB_CA_BUNDLE_BASE64 || awsGlobalBundle;

export interface CertificateConfig {
  certPath: string;
  certExists: boolean;
}

/**
 * Get the certificate configuration for DocumentDB
 * This function ensures the certificate file exists in the Lambda environment
 */
export function getDocumentDBCertificate(): CertificateConfig {
  // Use /tmp in Lambda environment
  const certDir = '/tmp/certs';
  const certPath = join(certDir, 'rds-ca-bundle.pem');

  if (existsSync(certPath)) {
    return { certPath, certExists: true };
  }

  if (!existsSync(certDir)) {
    mkdirSync(certDir, { recursive: true });
  }

  const certContent = Buffer.from(DOCUMENTDB_CA_BUNDLE_BASE64, 'base64').toString('utf-8');
  writeFileSync(certPath, certContent, { mode: 0o644 });

  return { certPath, certExists: false };
}

/**
 * Check if we're using DocumentDB based on the connection string
 * DocumentDB URLs typically contain "docdb" or "documentdb" in the hostname
 */
export function isDocumentDBConnection(mongoUri: string): boolean {
  const dbType = process.env.MAIN_DB_TYPE || 'MongoAtlas';
  if (dbType === 'DocumentDB') {
    return true;
  }

  // Auto-detection based on URI (fallback)
  try {
    const url = new URL(mongoUri);
    const hostname = url.hostname.toLowerCase();
    return hostname.includes('docdb') || hostname.includes('documentdb') || hostname.includes('.rds.amazonaws.com');
  } catch {
    return false;
  }
}

/**
 * Modify the MongoDB URI to include the TLS CA file path
 */
export function addCertificateToUri(mongoUri: string, certPath: string): string {
  if (mongoUri.includes('tlsCAFile=')) {
    return mongoUri;
  }

  const hasQueryParams = mongoUri.includes('?');
  const separator = hasQueryParams ? '&' : '?';

  const documentDBParams = [`tls=true`, `tlsCAFile=${certPath}`];

  if (!mongoUri.includes('authMechanism=')) {
    documentDBParams.push('authMechanism=SCRAM-SHA-1');
  }

  if (!mongoUri.includes('authSource=')) {
    documentDBParams.push('authSource=admin');
  }

  // DocumentDB doesn't support retryable writes
  if (!mongoUri.includes('retryWrites=')) {
    documentDBParams.push('retryWrites=false');
  }

  return `${mongoUri}${separator}${documentDBParams.join('&')}`;
}

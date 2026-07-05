import { IMongoDocument } from '@bike4mind/common';
import mongoose, { Model } from 'mongoose';
import BaseRepository from '@bike4mind/db-core';

export type SecurityDashboardScanType =
  | 'web'
  | 'web-owasp'
  | 'code'
  | 'code-semgrep'
  | 'packages'
  | 'secrets'
  | 'cloud'
  | 'cloud-prowler'
  | 'waf';

export type SecurityDashboardStatus = 'pass' | 'warning' | 'fail';

export interface ISecurityDashboardFinding {
  id: string;
  title: string;
  severity: 'low' | 'medium' | 'high' | 'critical';
  description: string;
  recommendation?: string;
  documentationUrl?: string;
  // Optional bag for scan-specific structured data (eg. file path, line, package info).
  // This is intentionally flexible so individual scan types can evolve without schema churn.
  metadata?: Record<string, unknown>;
}

export interface ISecurityDashboardSnapshotDocument extends IMongoDocument {
  stage: string;
  scanType: SecurityDashboardScanType;
  targetUrl: string;
  status: SecurityDashboardStatus;
  score: number; // 0-100
  summary: string;
  findings: ISecurityDashboardFinding[];
  checkedAt: Date;
  createdAt: Date;
  updatedAt: Date;
}

const SecurityDashboardSnapshotSchema = new mongoose.Schema<ISecurityDashboardSnapshotDocument>(
  {
    stage: { type: String, required: true },
    scanType: {
      type: String,
      required: true,
      enum: ['web', 'web-owasp', 'code', 'code-semgrep', 'packages', 'secrets', 'cloud', 'cloud-prowler', 'waf'],
    },
    targetUrl: { type: String, required: true },
    status: { type: String, enum: ['pass', 'warning', 'fail'], required: true },
    score: { type: Number, required: true, min: 0, max: 100 },
    summary: { type: String, required: true },
    findings: [
      {
        id: { type: String, required: true },
        title: { type: String, required: true },
        severity: {
          type: String,
          enum: ['low', 'medium', 'high', 'critical'],
          required: true,
        },
        description: { type: String, required: true },
        recommendation: { type: String },
        documentationUrl: { type: String },
        metadata: { type: Object },
      },
    ],
    checkedAt: { type: Date, required: true },
  },
  { timestamps: true }
);

// All performance indexes declared together for auditability.
// The compound index covers the most common query (latest snapshot per stage+scanType).
// { stage: 1 } alone is omitted - it's a leftmost-prefix subset of the compound index.
SecurityDashboardSnapshotSchema.index({ stage: 1, scanType: 1, checkedAt: -1 });
SecurityDashboardSnapshotSchema.index({ scanType: 1 });
SecurityDashboardSnapshotSchema.index({ status: 1 });
SecurityDashboardSnapshotSchema.index({ checkedAt: -1 });

export const SecurityDashboardSnapshot: Model<ISecurityDashboardSnapshotDocument> =
  mongoose.models.SecurityDashboardSnapshot ||
  mongoose.model<ISecurityDashboardSnapshotDocument>('SecurityDashboardSnapshot', SecurityDashboardSnapshotSchema);

export class SecurityDashboardSnapshotRepository extends BaseRepository<ISecurityDashboardSnapshotDocument> {
  constructor(model: Model<ISecurityDashboardSnapshotDocument>) {
    super(model);
  }

  async findLatestByStageAndScanType(
    stage: string,
    scanType: SecurityDashboardScanType
  ): Promise<ISecurityDashboardSnapshotDocument | null> {
    const doc = await this.model.findOne({ stage, scanType }).sort({ checkedAt: -1 }).limit(1).exec();
    return doc ? (doc.toJSON() as ISecurityDashboardSnapshotDocument) : null;
  }
}

export const securityDashboardSnapshotRepository = new SecurityDashboardSnapshotRepository(SecurityDashboardSnapshot);

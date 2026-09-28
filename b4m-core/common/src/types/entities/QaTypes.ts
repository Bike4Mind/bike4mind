import type { IMongoDocument } from './common';
import type {
  QaArtifact,
  QaCounts,
  QaMetric,
  QaRunSource,
  QaRunStatus,
  QaSuiteSummary,
  QaTestStatus,
} from '../../schemas/qa';

export interface IQaRun {
  product: string;
  tenant?: string;
  suite: string;
  env: string;
  branch: string;
  trigger: string;
  source: QaRunSource;
  ciRunUrl: string;
  sha: string;
  startedAt: Date;
  durationMs: number;
  status: QaRunStatus;
  counts: QaCounts;
  suiteSummary: QaSuiteSummary[];
  metrics: QaMetric[];
  reportPrefix?: string;
  externalRunId: string;
}

export interface IQaRunDocument extends IQaRun, IMongoDocument {}

export interface IQaTestResult {
  /** QaRun _id as a hex string. */
  runId: string;
  testKey: string;
  title: string;
  status: QaTestStatus;
  durationMs: number;
  retries: number;
  error?: string;
  artifacts: QaArtifact[];
}

export interface IQaTestResultDocument extends IQaTestResult, IMongoDocument {}

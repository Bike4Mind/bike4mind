import {
  IAuthFailLogDocument,
  type ISecurityFindingDocument,
  type ISecurityFindingRunDocument,
} from '@bike4mind/database';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { api } from '@client/app/contexts/ApiContext';
import { IInternalTeamMemberDocument } from '@bike4mind/common';

export interface SuspiciousPatternSummary {
  ip?: string;
  attempts: number;
  usernames: string[];
  lastAttempt: string;
  firstAttempt: string;
  riskLevel: string;
}

export type UserSecurityEvent =
  | {
      type: 'failed_login';
      data: IAuthFailLogDocument;
      timestamp: string;
    }
  | {
      type: 'suspicious_pattern';
      data: SuspiciousPatternSummary;
      timestamp: string;
    };

// Shared query keys - user-facing hooks use ['security', 'user', ...] prefix
const USER_SUMMARY_KEY = ['security', 'user', 'summary'] as const;
const USER_RECENT_24H_KEY = ['security', 'user', 'recent', '24h'] as const;
const USER_RECENT_7D_KEY = ['security', 'user', 'recent', '7d'] as const;
const BLOCKED_IPS_KEY = ['security', 'blocked-ips'] as const;

type UserSecuritySummaryData = {
  userFailures: { total: number; items: IAuthFailLogDocument[] };
  suspiciousPatterns: { total: number; items: SuspiciousPatternSummary[] };
  since: string;
  user: { email: string; username: string };
};

type UserRecentEventsData = {
  items: UserSecurityEvent[];
  since: string;
  user: { email: string; username: string };
};

// Shared fetchers - a single queryFn per endpoint so React Query deduplicates the HTTP request
const fetchUserSecuritySummary = async (): Promise<UserSecuritySummaryData> => {
  const response = await api.get<UserSecuritySummaryData>('/api/security/user-summary?hours=24');
  return response.data;
};

const fetchUserRecentEvents24h = async (): Promise<UserRecentEventsData> => {
  const response = await api.get<UserRecentEventsData>('/api/security/user-recent?limit=5&hours=24');
  return response.data;
};

export const useGetFailedLoginCount = () => {
  return useQuery({
    queryKey: USER_SUMMARY_KEY,
    queryFn: fetchUserSecuritySummary,
    select: data => ({ total: data.userFailures.total, since: data.since }),
  });
};

export const useGetRecentFailedLogins = () => {
  return useQuery({
    queryKey: USER_RECENT_24H_KEY,
    queryFn: fetchUserRecentEvents24h,
    select: data => ({
      items: data.items
        .filter((e): e is Extract<UserSecurityEvent, { type: 'failed_login' }> => e.type === 'failed_login')
        .map(e => e.data),
      since: data.since,
    }),
  });
};

export const useGetSuspiciousSummary = () => {
  return useQuery({
    queryKey: USER_SUMMARY_KEY,
    queryFn: fetchUserSecuritySummary,
    select: data => ({ total: data.suspiciousPatterns.total, since: data.since }),
  });
};

export const useGetRecentSuspiciousLogins = () => {
  return useQuery({
    queryKey: USER_RECENT_24H_KEY,
    queryFn: fetchUserRecentEvents24h,
    select: data => ({
      items: data.items
        .filter((e): e is Extract<UserSecurityEvent, { type: 'suspicious_pattern' }> => e.type === 'suspicious_pattern')
        .map(e => e.data),
      since: data.since,
    }),
  });
};

export const useGetRecentSecurityEvents = () => {
  return useQuery({
    queryKey: USER_RECENT_24H_KEY,
    queryFn: fetchUserRecentEvents24h,
    select: data => ({ items: data.items, since: data.since }),
  });
};

export const useGetAllRecentSecurityEvents = () => {
  return useQuery({
    queryKey: USER_RECENT_7D_KEY,
    queryFn: async (): Promise<UserRecentEventsData> => {
      const response = await api.get<UserRecentEventsData>('/api/security/user-recent?limit=50&hours=168');
      return response.data;
    },
    select: data => ({ items: data.items, since: data.since }),
  });
};

// Blocked IPs
export const useGetBlockedIPs = () => {
  return useQuery({
    queryKey: BLOCKED_IPS_KEY,
    queryFn: async () => {
      const res = await api.get<{ items: Array<{ ip: string; reason?: string; blockedAt: string }> }>(
        '/api/security/blocked-ips?limit=10'
      );
      return res.data.items;
    },
  });
};

// API Usage Monitoring
export interface ApiKeyUsageItem {
  id: string;
  name: string;
  status: string;
  createdAt: Date;
  lastUsedAt?: Date;
  expiresAt?: Date;
  rateLimit: {
    requestsPerMinute: number;
    requestsPerDay: number;
  };
  usage: {
    totalRequests: number;
    totalTokens?: number;
    lastRequest?: Date;
    requestsToday: number;
    requestsThisMinute: number;
  };
  metadata?: {
    baseline?: {
      avgRequestsPerHour: number;
      avgRequestsPerDay: number;
      commonIPs: string[];
      commonEndpoints: string[];
      avgResponseTime: number;
      peakHours: number[];
      lastCalculatedAt: Date;
    };
  };
  alerts: Array<{
    id: string;
    alertType: 'high_rate' | 'new_ip' | 'unusual_pattern';
    message: string;
    detectedAt: Date;
    metadata?: {
      currentRate?: number;
      baselineRate?: number;
      ipAddress?: string;
      endpoint?: string;
    };
  }>;
}

export const useGetApiUsage = () => {
  return useQuery<ApiKeyUsageItem[]>({
    queryKey: ['admin', 'security', 'api-usage'],
    queryFn: async () => {
      const res = await api.get<{ items: ApiKeyUsageItem[] }>('/api/security/api-usage');
      return res.data.items;
    },
  });
};

// AI Behavioral Summary (user-level)
export interface SecurityBehavioralSummary {
  /** Short natural-language overview of the user's security posture. */
  summary: string;
  /** 0-100 numeric risk score (0 = no risk, 100 = critical). */
  riskScore: number;
  /** Categorical risk level derived from the score. */
  riskLevel: 'low' | 'medium' | 'high';
  /** 2-5 short, actionable recommendations for the user. */
  recommendations: string[];
}

export const useGetSecurityBehavioralSummary = () => {
  return useQuery<SecurityBehavioralSummary>({
    queryKey: ['admin', 'security', 'behavioral-summary'],
    queryFn: async () => {
      const res = await api.get<SecurityBehavioralSummary>('/api/security/behavioral-summary');
      return res.data;
    },
    // Keep the AI summary reasonably fresh without hammering the model
    staleTime: 5 * 60 * 1000, // 5 minutes
    refetchOnWindowFocus: true,
    refetchOnReconnect: true,
    refetchOnMount: true,
  });
};

// Security Dashboard (Admin)
export type SecurityCheckStatus = 'pass' | 'warning' | 'fail' | 'disabled';

export type SecurityCheckId = 'web' | 'code' | 'packages' | 'secrets' | 'cloud' | 'waf';

export interface SecurityCheckSummary {
  id: SecurityCheckId;
  label: string;
  status: SecurityCheckStatus;
  enabled: boolean;
  score: number | null; // 0-100, higher is better
  summary: string;
  severityCounts: {
    critical: number;
    high: number;
    medium: number;
    low: number;
  };
  lastCheckedAt: string | null;
}

export interface SecurityDashboardOverview {
  overallScore: number;
  totalChecks: number;
  passedChecks: number;
  lastUpdated: string;
  nextScanInMinutes: number | null;
  checks: SecurityCheckSummary[];
}

// Admin Security Dashboard AI Assessment
export type AiSecurityCategoryId = SecurityCheckId;

export type AiSecurityRecommendationPriority = 'high' | 'medium' | 'low';

export interface AiSecurityRecommendation {
  id: string;
  category: 'database' | 'packages' | 'waf' | 'cloud' | 'secrets' | 'code' | 'web' | 'misc';
  priority: AiSecurityRecommendationPriority;
  title: string;
  rationale: string;
  suggestedAction: string;
}

export interface AiSecurityAssessment {
  overallSummary: string;
  recommendations: AiSecurityRecommendation[];
  generatedAt: string;
  nextAssessmentAt: string;
}

export const useSecurityDashboardAiAssessment = () => {
  return useQuery<AiSecurityAssessment>({
    queryKey: ['admin', 'security-dashboard', 'ai-assessment'],
    queryFn: async () => {
      const res = await api.get<AiSecurityAssessment>('/api/admin/security-dashboard/ai-assessment');
      return res.data;
    },
    staleTime: 5 * 60 * 1000, // UI is allowed to be slightly stale; server enforces longer cache TTL
    refetchOnWindowFocus: true,
    refetchOnReconnect: true,
    refetchOnMount: true,
  });
};

export interface SecurityDashboardFinding {
  id: string;
  title: string;
  severity: 'low' | 'medium' | 'high' | 'critical';
  description: string;
  recommendation?: string;
  documentationUrl?: string;
}

export interface SecurityDashboardWebSnapshot {
  stage: string;
  scanType: 'web' | 'web-owasp';
  targetUrl: string;
  status: SecurityCheckStatus;
  score: number;
  summary: string;
  findings: SecurityDashboardFinding[];
  checkedAt: string;
}

export const useSecurityDashboardOverview = () => {
  return useQuery<SecurityDashboardOverview>({
    queryKey: ['admin', 'security-dashboard', 'overview'],
    queryFn: async () => {
      const res = await api.get<SecurityDashboardOverview>('/api/admin/security-dashboard/overview');
      return res.data;
    },
    staleTime: 5 * 60 * 1000, // 5 minutes
    refetchOnWindowFocus: true,
    refetchOnReconnect: true,
    refetchOnMount: true,
  });
};

export interface SecurityDashboardCodeSnapshot {
  stage: string;
  scanType: 'code-semgrep';
  targetUrl: string;
  status: SecurityCheckStatus;
  score: number;
  summary: string;
  findings: Array<{
    id: string;
    title: string;
    severity: 'critical' | 'high' | 'medium' | 'low';
    description: string;
    recommendation?: string;
    documentationUrl?: string;
  }>;
  checkedAt: string;
}

export const useSecurityDashboardWeb = () => {
  return useQuery<SecurityDashboardWebSnapshot>({
    queryKey: ['admin', 'security-dashboard', 'web'],
    queryFn: async () => {
      const res = await api.get<SecurityDashboardWebSnapshot>('/api/admin/security-dashboard/web');
      return res.data;
    },
    staleTime: 5 * 60 * 1000, // 5 minutes
    refetchOnWindowFocus: true,
    refetchOnReconnect: true,
    refetchOnMount: true,
  });
};

export const useSecurityDashboardCode = () => {
  return useQuery<SecurityDashboardCodeSnapshot>({
    queryKey: ['admin', 'security-dashboard', 'code'],
    queryFn: async () => {
      const res = await api.get<SecurityDashboardCodeSnapshot>('/api/admin/security-dashboard/code');
      return res.data;
    },
    staleTime: 5 * 60 * 1000, // 5 minutes
    refetchOnWindowFocus: true,
    refetchOnReconnect: true,
    refetchOnMount: true,
  });
};

export interface SecurityDashboardPackagesSnapshot {
  stage: string;
  scanType: 'packages';
  targetUrl: string;
  status: SecurityCheckStatus;
  score: number;
  summary: string;
  findings: Array<{
    id: string;
    title: string;
    severity: 'critical' | 'high' | 'medium' | 'low';
    description: string;
    recommendation?: string;
    documentationUrl?: string;
    metadata?: {
      packageName?: string;
      currentVersion?: string;
      vulnerableRange?: string;
      recommendedVersion?: string;
    };
  }>;
  checkedAt: string;
}

export const useSecurityDashboardPackages = () => {
  return useQuery<SecurityDashboardPackagesSnapshot>({
    queryKey: ['admin', 'security-dashboard', 'packages'],
    queryFn: async () => {
      const res = await api.get<SecurityDashboardPackagesSnapshot>('/api/admin/security-dashboard/packages');
      return res.data;
    },
    staleTime: 5 * 60 * 1000, // 5 minutes
    refetchOnWindowFocus: true,
    refetchOnReconnect: true,
    refetchOnMount: true,
  });
};

export const useRunPackagesSecurityScan = () => {
  const queryClient = useQueryClient();

  return useMutation<RunSecurityScanResponse>({
    mutationFn: async () => {
      const res = await api.post<RunSecurityScanResponse>('/api/admin/security-dashboard/packages');
      return res.data;
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['admin', 'security-dashboard', 'overview'] });
      queryClient.invalidateQueries({ queryKey: ['admin', 'security-dashboard', 'packages'] });
    },
  });
};

export interface RunSecurityScanResponse {
  canRun: boolean;
  queued?: boolean;
  reason?: string;
  hoursRemaining?: number;
}

export const useRunWebSecurityScan = () => {
  const queryClient = useQueryClient();

  return useMutation<RunSecurityScanResponse>({
    mutationFn: async () => {
      const res = await api.post<RunSecurityScanResponse>('/api/admin/security-dashboard/web');
      return res.data;
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['admin', 'security-dashboard', 'overview'] });
      queryClient.invalidateQueries({ queryKey: ['admin', 'security-dashboard', 'web'] });
    },
  });
};

export const useRunCodeSecurityScan = () => {
  const queryClient = useQueryClient();

  return useMutation<RunSecurityScanResponse>({
    mutationFn: async () => {
      const res = await api.post<RunSecurityScanResponse>('/api/admin/security-dashboard/code');
      return res.data;
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['admin', 'security-dashboard', 'overview'] });
      queryClient.invalidateQueries({ queryKey: ['admin', 'security-dashboard', 'code'] });
    },
  });
};

export interface SecurityDashboardSecretsSnapshot {
  stage: string;
  scanType: 'secrets';
  targetUrl: string;
  status: SecurityCheckStatus;
  score: number;
  summary: string;
  findings: Array<{
    id: string;
    title: string;
    severity: 'critical' | 'high' | 'medium' | 'low';
    description: string;
    recommendation?: string;
    documentationUrl?: string;
    metadata?: {
      secretType?: string;
      filePath?: string;
      line?: number;
      commitId?: string;
    };
  }>;
  checkedAt: string;
}

export interface SecurityDashboardCloudSnapshot {
  stage: string;
  scanType: 'cloud';
  targetUrl: string;
  status: SecurityCheckStatus; // 'pass' | 'warning' | 'fail'
  score: number;
  summary: string;
  findings: Array<{
    id: string;
    title: string;
    severity: 'critical' | 'high' | 'medium' | 'low';
    description: string;
    recommendation?: string;
    documentationUrl?: string;
  }>;
  checkedAt: string;
}

export interface SecurityDashboardProwlerSnapshot {
  stage: string;
  scanType: 'cloud-prowler';
  targetUrl: string;
  status: SecurityCheckStatus;
  score: number;
  summary: string;
  findings: Array<{
    id: string;
    title: string;
    severity: 'critical' | 'high' | 'medium' | 'low';
    description: string;
    recommendation?: string;
    documentationUrl?: string;
    metadata?: {
      region?: string;
      resourceArn?: string;
    };
  }>;
  checkedAt: string;
}

export interface SecurityDashboardWafSnapshot {
  stage: string;
  scanType: 'waf';
  targetUrl: string;
  status: SecurityCheckStatus;
  score: number;
  summary: string;
  findings: Array<{
    id: string;
    title: string;
    severity: 'critical' | 'high' | 'medium' | 'low';
    description: string;
    recommendation?: string;
    documentationUrl?: string;
    metadata?: {
      informational?: boolean;
      env?: 'dev' | 'prod';
      webAcls?: string[];
      distributions?: string[];
      discoverySource?: 'none' | 'secrets' | 'tags' | 'secrets+tags';
    };
  }>;
  checkedAt: string;
}

export type WafTrafficRange = '1h' | '24h' | '7d';

export interface WafCustomRange {
  start: string;
  end: string;
}

export type WafRangeInput = WafTrafficRange | WafCustomRange;

/** Converts a WafRangeInput to a stable string key (for React Query). */
function rangeToQueryKey(range: WafRangeInput): string {
  if (typeof range === 'object') return `custom#${range.start}#${range.end}`;
  return range;
}

/** Converts a WafRangeInput to API query params. */
function rangeToApiParams(range: WafRangeInput): Record<string, string> {
  if (typeof range === 'object') return { range: 'custom', start: range.start, end: range.end };
  return { range };
}

export interface SecurityDashboardWafTrafficOverview {
  enabled: boolean;
  stage: string;
  range: WafRangeInput;
  period: '1m' | '5m' | '1h';
  checkedAt: string;
  distributionId?: string;
  webAclArn?: string;
  totals?: {
    allowed: number;
    blocked: number;
    counted: number;
    captcha?: number;
    challenge?: number;
    blockRate: number;
  };
  series?: {
    timestamps: string[];
    allowed: number[];
    blocked: number[];
    counted: number[];
    captcha?: number[];
    challenge?: number[];
  };
  topBlockedRules?: Array<{
    ruleName: string;
    blocked: number;
  }>;
  topBlockedRulesSeries?: {
    timestamps: string[];
    series: Array<{
      ruleName: string;
      blocked: number[];
    }>;
  };
}

export interface SecurityDashboardWafLogsInsightsOverview {
  enabled: boolean;
  stage: string;
  range: WafRangeInput;
  checkedAt: string;
  webAclArn?: string;
  logGroupName?: string;
  logGroupRegion?: string;
  trafficCharacteristics?: {
    topBlockedUris: Array<{ name: string; count: number }>;
    topClientIps: Array<{ name: string; count: number }>;
  };
  managedRuleGroups?: {
    rateLimitUsage: {
      limitPerWindow: number;
      windowSecs: number;
      topIps: Array<{ ip: string; uri: string; peakRequests: number }>;
    };
  };
  reason?: 'no-webacl' | 'no-logging-config' | 'no-log-destination' | 'no-data';
}

export const useSecurityDashboardCloud = () => {
  return useQuery<SecurityDashboardCloudSnapshot>({
    queryKey: ['admin', 'security-dashboard', 'cloud'],
    queryFn: async () => {
      const res = await api.get<SecurityDashboardCloudSnapshot>('/api/admin/security-dashboard/cloud');
      return res.data;
    },
    staleTime: 5 * 60 * 1000, // 5 minutes
    refetchOnWindowFocus: true,
    refetchOnReconnect: true,
    refetchOnMount: true,
  });
};

export const useSecurityDashboardProwler = () => {
  return useQuery<SecurityDashboardProwlerSnapshot | null>({
    queryKey: ['admin', 'security-dashboard', 'cloud-prowler'],
    queryFn: async () => {
      const res = await api.get<SecurityDashboardProwlerSnapshot | null>('/api/admin/security-dashboard/cloud-prowler');
      return res.data ?? null;
    },
    staleTime: 10 * 60 * 1000, // 10 minutes - Prowler runs weekly
    refetchOnWindowFocus: false,
    refetchOnReconnect: true,
    refetchOnMount: true,
  });
};

export const useSecurityDashboardWafTraffic = (params: {
  range: WafRangeInput;
  includeRules?: boolean;
  enabled?: boolean;
}) => {
  const includeRules = params.includeRules === true;
  const enabled = params.enabled ?? true;

  return useQuery<SecurityDashboardWafTrafficOverview>({
    queryKey: ['admin', 'security-dashboard', 'waf-traffic', rangeToQueryKey(params.range), includeRules],
    enabled,
    queryFn: async () => {
      const res = await api.get<SecurityDashboardWafTrafficOverview>('/api/admin/security-dashboard/waf-traffic', {
        params: { ...rangeToApiParams(params.range), includeRules: includeRules ? 'true' : 'false' },
      });
      return res.data;
    },
    staleTime: 5 * 60 * 1000, // 5 minutes - aligns with server-side cache TTL
    refetchOnWindowFocus: true,
    refetchOnReconnect: true,
    refetchOnMount: true,
  });
};

export const useSecurityDashboardWafLogsInsights = (params: { range: WafRangeInput; enabled?: boolean }) => {
  const enabled = params.enabled ?? true;

  return useQuery<SecurityDashboardWafLogsInsightsOverview>({
    queryKey: ['admin', 'security-dashboard', 'waf-logs-insights', rangeToQueryKey(params.range)],
    enabled,
    queryFn: async () => {
      const res = await api.get<SecurityDashboardWafLogsInsightsOverview>(
        '/api/admin/security-dashboard/waf-logs-insights',
        {
          params: rangeToApiParams(params.range),
        }
      );
      return res.data;
    },
    staleTime: 5 * 60 * 1000, // 5 minutes - aligns with server-side cache TTL
    refetchOnWindowFocus: true,
    refetchOnReconnect: true,
    refetchOnMount: true,
  });
};

export interface SecurityDashboardWafBlockedRequest {
  timestamp: string;
  action: string;
  terminatingRuleId: string;
  clientIp: string;
  country: string;
  headers: Array<{ name: string; value: string }>;
  uri: string;
  args: string;
  httpVersion: string;
  httpMethod: string;
  requestId: string;
}

export interface SecurityDashboardWafBlockedRequestsResult {
  enabled: boolean;
  stage: string;
  range: WafRangeInput;
  checkedAt: string;
  webAclArn?: string;
  requests: SecurityDashboardWafBlockedRequest[];
  total: number;
  reason?: 'no-webacl' | 'no-logging-config' | 'no-data';
}

export const useSecurityDashboardWafBlockedRequests = (params: { range: WafRangeInput; enabled?: boolean }) => {
  const enabled = params.enabled ?? true;

  return useQuery<SecurityDashboardWafBlockedRequestsResult>({
    queryKey: ['admin', 'security-dashboard', 'waf-blocked-requests', rangeToQueryKey(params.range)],
    enabled,
    queryFn: async () => {
      const res = await api.get<SecurityDashboardWafBlockedRequestsResult>(
        '/api/admin/security-dashboard/waf-blocked-requests',
        { params: rangeToApiParams(params.range) }
      );
      return res.data;
    },
    staleTime: 5 * 60 * 1000, // 5 minutes - aligns with server-side cache TTL
    refetchOnWindowFocus: true,
    refetchOnReconnect: true,
    refetchOnMount: true,
  });
};

export const useSecurityDashboardWaf = () => {
  return useQuery<SecurityDashboardWafSnapshot>({
    queryKey: ['admin', 'security-dashboard', 'waf'],
    queryFn: async () => {
      const res = await api.get<SecurityDashboardWafSnapshot>('/api/admin/security-dashboard/waf');
      return res.data;
    },
    staleTime: 5 * 60 * 1000, // 5 minutes
    refetchOnWindowFocus: true,
    refetchOnReconnect: true,
    refetchOnMount: true,
  });
};

export const useSecurityDashboardSecrets = () => {
  return useQuery<SecurityDashboardSecretsSnapshot>({
    queryKey: ['admin', 'security-dashboard', 'secrets'],
    queryFn: async () => {
      const res = await api.get<SecurityDashboardSecretsSnapshot>('/api/admin/security-dashboard/secrets');
      return res.data;
    },
    staleTime: 5 * 60 * 1000, // 5 minutes
    refetchOnWindowFocus: true,
    refetchOnReconnect: true,
    refetchOnMount: true,
  });
};

export const useRunSecretsSecurityScan = () => {
  const queryClient = useQueryClient();

  return useMutation<RunSecurityScanResponse>({
    mutationFn: async () => {
      const res = await api.post<RunSecurityScanResponse>('/api/admin/security-dashboard/secrets');
      return res.data;
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['admin', 'security-dashboard', 'overview'] });
      queryClient.invalidateQueries({ queryKey: ['admin', 'security-dashboard', 'secrets'] });
    },
  });
};

export const useRunCloudSecurityScan = () => {
  const queryClient = useQueryClient();

  return useMutation<RunSecurityScanResponse>({
    mutationFn: async () => {
      const res = await api.post<RunSecurityScanResponse>('/api/admin/security-dashboard/cloud');
      return res.data;
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['admin', 'security-dashboard', 'cloud'] });
      queryClient.invalidateQueries({ queryKey: ['admin', 'security-dashboard', 'overview'] });
    },
  });
};

export const useRunProwlerScan = () => {
  return useMutation<{ queued: boolean; environment: string }>({
    mutationFn: async () => {
      const res = await api.post<{ queued: boolean; environment: string }>(
        '/api/admin/security-dashboard/cloud-prowler'
      );
      return res.data;
    },
    // Prowler results arrive asynchronously (~10 min via GitHub Actions).
    // No automatic invalidation - the user refreshes the Prowler Audit tab
    // when they expect the scan to be complete.
  });
};

// Security Scan Schedules
export interface SecurityScanSchedule {
  stage: string;
  scanType: string;
  enabled: boolean;
  dayOfWeek: number;
  timeOfDay: string;
  nextRunAt: string | null;
  lastRunAt?: string | null;
}

export const useSecurityScanSchedule = (scanType: string) => {
  return useQuery<SecurityScanSchedule>({
    queryKey: ['admin', 'security-scan-schedule', scanType],
    queryFn: async () => {
      const res = await api.get<SecurityScanSchedule>(`/api/admin/security-scan-schedule/${scanType}`);
      return res.data;
    },
    staleTime: 60 * 1000, // 1 minute
    refetchOnWindowFocus: true,
  });
};

/**
 * Batch response interface for all security scan schedules
 * Solves N+1 API problem by fetching all schedules in a single request
 */
export interface SecurityScanSchedules {
  web: Omit<SecurityScanSchedule, 'stage' | 'scanType'> | null;
  code: Omit<SecurityScanSchedule, 'stage' | 'scanType'> | null;
  packages: Omit<SecurityScanSchedule, 'stage' | 'scanType'> | null;
  secrets: Omit<SecurityScanSchedule, 'stage' | 'scanType'> | null;
  cloud: Omit<SecurityScanSchedule, 'stage' | 'scanType'> | null;
}

/**
 * Fetch all security scan schedules in a single request
 * Replaces 5 individual `useSecurityScanSchedule` calls with one batch request
 */
export const useSecurityScanSchedules = () => {
  return useQuery<SecurityScanSchedules>({
    queryKey: ['admin', 'security-scan-schedules'],
    queryFn: async () => {
      const res = await api.get<SecurityScanSchedules>('/api/admin/security-scan-schedules');
      return res.data;
    },
    staleTime: 60 * 1000, // 1 minute
    refetchOnWindowFocus: true,
  });
};

export const useUpdateSecurityScanSchedule = (scanType: string) => {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: async (config: { enabled: boolean }) => {
      const res = await api.post(`/api/admin/security-scan-schedule/${scanType}`, config);
      return res.data;
    },
    onSuccess: () => {
      queryClient.invalidateQueries({
        queryKey: ['admin', 'security-scan-schedule', scanType],
      });
      queryClient.invalidateQueries({
        queryKey: ['admin', 'security-dashboard', 'overview'],
      });
    },
  });
};

export const useRunWafSecurityScan = () => {
  const queryClient = useQueryClient();

  return useMutation<RunSecurityScanResponse>({
    mutationFn: async () => {
      const res = await api.post<RunSecurityScanResponse>('/api/admin/security-dashboard/waf');
      return res.data;
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['admin', 'security-dashboard', 'waf'] });
      queryClient.invalidateQueries({ queryKey: ['admin', 'security-dashboard', 'overview'] });
    },
  });
};

// Team Members
export const useGetTeamMembers = () => {
  return useQuery({
    queryKey: ['admin', 'team-members'],
    queryFn: async () => {
      const res = await api.get<IInternalTeamMemberDocument[]>('/api/admin/team-members');
      return res.data;
    },
  });
};

export const useCreateTeamMember = () => {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: async (payload: Partial<IInternalTeamMemberDocument>) => {
      const res = await api.post<IInternalTeamMemberDocument>('/api/admin/team-members', payload);
      return res.data;
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['admin', 'team-members'] });
    },
  });
};

export const useUpdateTeamMember = () => {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: async (payload: Partial<IInternalTeamMemberDocument> & { id: string }) => {
      const res = await api.put<IInternalTeamMemberDocument>('/api/admin/team-members', payload);
      return res.data;
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['admin', 'team-members'] });
    },
  });
};

export const useDeleteTeamMember = () => {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: async (id: string) => {
      await api.delete('/api/admin/team-members', {
        params: { id },
      });
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['admin', 'team-members'] });
    },
  });
};

export interface AttackSimulationData {
  stage: string;
  runs: ISecurityFindingRunDocument[];
  findings: ISecurityFindingDocument[];
}

export const useAttackSimulationData = () => {
  return useQuery<AttackSimulationData>({
    queryKey: ['admin', 'security-dashboard', 'attack-simulation'],
    queryFn: async () => {
      const res = await api.get<AttackSimulationData>('/api/admin/security-dashboard/attack-simulation');
      return res.data;
    },
    staleTime: 30 * 1000, // 30 seconds - runs change infrequently outside of active investigation
    refetchOnWindowFocus: true,
    refetchOnReconnect: true,
    refetchOnMount: true,
    // Poll every 10s while a run is in flight so the UI reflects probe progress without
    // requiring the user to refresh. Stops polling once the run reaches a terminal state.
    refetchInterval: data => {
      const latestRun = data?.state?.data?.runs?.[0];
      return latestRun?.status === 'running' ? 10_000 : false;
    },
  });
};

export interface RunAttackSimulationResponse {
  queued: boolean;
  runId: string;
}

export const useRunAttackSimulation = () => {
  const queryClient = useQueryClient();

  return useMutation<RunAttackSimulationResponse>({
    mutationFn: async () => {
      const res = await api.post<RunAttackSimulationResponse>('/api/admin/security-dashboard/run-attack-simulation');
      return res.data;
    },
    onSuccess: () => {
      queryClient.invalidateQueries({
        queryKey: ['admin', 'security-dashboard', 'attack-simulation'],
      });
    },
  });
};

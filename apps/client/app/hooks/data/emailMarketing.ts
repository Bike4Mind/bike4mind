import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import {
  IEmailTemplateDocument,
  IEmailJobDocument,
  IEmailSendAttemptDocument,
  EmailCategory,
  EmailJobStatus,
  EmailJobOverallStatus,
  EmailSendStatus,
} from '@bike4mind/common';
import { PaginatedResponse } from '@bike4mind/common';
import { api } from '@client/app/contexts/ApiContext';

// ================== TEMPLATES ==================

interface ListTemplatesParams {
  page?: number;
  limit?: number;
  search?: string;
  category?: EmailCategory;
}

export const useEmailTemplates = (params: ListTemplatesParams = {}) => {
  return useQuery<PaginatedResponse<IEmailTemplateDocument>>({
    queryKey: ['email-templates', params],
    queryFn: async () => {
      const response = await api.get('/api/admin/email/templates', { params });
      return response.data;
    },
  });
};

export const useEmailTemplate = (id: string) => {
  return useQuery<IEmailTemplateDocument>({
    queryKey: ['email-template', id],
    queryFn: async () => {
      const response = await api.get(`/api/admin/email/templates/${id}`);
      return response.data;
    },
    enabled: !!id,
  });
};

interface CreateTemplateData {
  name: string;
  slug: string;
  description?: string;
  subject: string;
  htmlContent: string;
  textContent?: string;
  category: EmailCategory;
  variables?: string[];
  isActive?: boolean;
}

export const useCreateEmailTemplate = () => {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: async (data: CreateTemplateData) => {
      const response = await api.post('/api/admin/email/templates', data);
      return response.data as IEmailTemplateDocument;
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['email-templates'] });
    },
  });
};

interface UpdateTemplateData extends Partial<CreateTemplateData> {
  id: string;
}

export const useUpdateEmailTemplate = () => {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: async ({ id, ...data }: UpdateTemplateData) => {
      const response = await api.put(`/api/admin/email/templates/${id}`, data);
      return response.data as IEmailTemplateDocument;
    },
    onSuccess: (_, variables) => {
      queryClient.invalidateQueries({ queryKey: ['email-templates'] });
      queryClient.invalidateQueries({ queryKey: ['email-template', variables.id] });
    },
  });
};

export const useDeleteEmailTemplate = () => {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: async (id: string) => {
      await api.delete(`/api/admin/email/templates/${id}`);
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['email-templates'] });
    },
  });
};

export const useCloneEmailTemplate = () => {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: async (id: string) => {
      const response = await api.post(`/api/admin/email/templates/${id}/clone`);
      return response.data as IEmailTemplateDocument;
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['email-templates'] });
    },
  });
};

// ================== JOBS ==================

interface ListJobsParams {
  page?: number;
  limit?: number;
  status?: EmailJobStatus;
  excludeTest?: boolean;
  startDate?: string;
  endDate?: string;
}

export const useEmailJobs = (params: ListJobsParams = {}) => {
  return useQuery<PaginatedResponse<IEmailJobDocument>>({
    queryKey: ['email-jobs', params],
    queryFn: async () => {
      const response = await api.get('/api/admin/email/jobs', { params });
      return response.data;
    },
  });
};

export const useEmailJob = (id: string) => {
  return useQuery<IEmailJobDocument>({
    queryKey: ['email-job', id],
    queryFn: async () => {
      const response = await api.get(`/api/admin/email/jobs/${id}`);
      return response.data;
    },
    enabled: !!id,
  });
};

interface CreateJobData {
  name: string;
  templateId: string;
  subject?: string;
  variables?: Record<string, string>;
  recipientFilter?: {
    all?: boolean;
    allUsers?: boolean;
    allSubscribers?: boolean;
    userIds?: string[];
    subscriberIds?: string[];
    specificEmails?: string[];
    tags?: string[];
  };
  isTestMode?: boolean;
  testEmailAddresses?: string[];
}

export const useCreateEmailJob = () => {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: async (data: CreateJobData) => {
      const response = await api.post('/api/admin/email/jobs', data);
      return response.data as IEmailJobDocument;
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['email-jobs'] });
    },
  });
};

export const useUpdateEmailJob = () => {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: async ({ id, ...data }: { id: string } & Partial<CreateJobData>) => {
      const response = await api.put(`/api/admin/email/jobs/${id}`, data);
      return response.data as IEmailJobDocument;
    },
    onSuccess: (_, variables) => {
      queryClient.invalidateQueries({ queryKey: ['email-jobs'] });
      queryClient.invalidateQueries({ queryKey: ['email-job', variables.id] });
    },
  });
};

export const useStartEmailJob = () => {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: async (id: string) => {
      const response = await api.post(`/api/admin/email/jobs/${id}/start`);
      return response.data;
    },
    onSuccess: (_, id) => {
      queryClient.invalidateQueries({ queryKey: ['email-jobs'] });
      queryClient.invalidateQueries({ queryKey: ['email-job', id] });
    },
  });
};

export const useCancelEmailJob = () => {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: async (id: string) => {
      const response = await api.post(`/api/admin/email/jobs/${id}/cancel`);
      return response.data;
    },
    onSuccess: (_, id) => {
      queryClient.invalidateQueries({ queryKey: ['email-jobs'] });
      queryClient.invalidateQueries({ queryKey: ['email-job', id] });
    },
  });
};

export const useScheduleEmailJob = () => {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: async ({ id, scheduledAt }: { id: string; scheduledAt: Date }) => {
      const response = await api.post(`/api/admin/email/jobs/${id}/schedule`, {
        scheduledAt: scheduledAt.toISOString(),
      });
      return response.data;
    },
    onSuccess: (_, { id }) => {
      queryClient.invalidateQueries({ queryKey: ['email-jobs'] });
      queryClient.invalidateQueries({ queryKey: ['email-job', id] });
    },
  });
};

export const useCloneEmailJob = () => {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: async (id: string) => {
      const response = await api.post(`/api/admin/email/jobs/${id}/clone`);
      return response.data as IEmailJobDocument;
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['email-jobs'] });
    },
  });
};

// ================== SEND (REUSABLE CAMPAIGNS) ==================

interface RecipientFilter {
  allUsers?: boolean;
  allSubscribers?: boolean;
  userIds?: string[];
  subscriberIds?: string[];
  specificEmails?: string[];
  all?: boolean;
}

interface SendJobParams {
  id: string;
  userIds?: string[];
  testMode?: boolean;
  testRecipients?: string[];
  testSubjectIndicator?: boolean;
  recipientFilter?: RecipientFilter;
}

export const useSendEmailJob = () => {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: async ({ id, ...params }: SendJobParams) => {
      const response = await api.post(`/api/admin/email/jobs/${id}/send`, params);
      return response.data;
    },
    onSuccess: (_, { id }) => {
      queryClient.invalidateQueries({ queryKey: ['email-jobs'] });
      queryClient.invalidateQueries({ queryKey: ['email-job', id] });
      queryClient.invalidateQueries({ queryKey: ['email-job-summary', id] });
      queryClient.invalidateQueries({ queryKey: ['email-job-history', id] });
    },
  });
};

// ================== JOB SUMMARY ==================

interface JobSummary {
  total: number;
  pending: number;
  processing: number;
  sent: number;
  failed: number;
  cancelled: number;
  testEmails: {
    total: number;
    pending: number;
    processing: number;
    sent: number;
    failed: number;
    cancelled: number;
  };
  jobMetrics: {
    recipientCount: number;
    overallStatus: EmailJobOverallStatus;
    lastSentAt?: Date;
    lastSentBy?: string;
    openedCount: number;
    clickedCount: number;
  };
}

export const useEmailJobSummary = (id: string, options?: { enabled?: boolean; refetchInterval?: number }) => {
  return useQuery<JobSummary>({
    queryKey: ['email-job-summary', id],
    queryFn: async () => {
      const response = await api.get(`/api/admin/email/jobs/${id}/summary`);
      return response.data;
    },
    enabled: options?.enabled !== false && !!id,
    refetchInterval: options?.refetchInterval ?? 5000, // Auto-refetch every 5 seconds
  });
};

// ================== JOB HISTORY (SEND ATTEMPTS) ==================

interface HistoryParams {
  page?: number;
  limit?: number;
  status?: string;
  search?: string;
  excludeTest?: boolean;
  startDate?: string;
  endDate?: string;
}

export const useEmailJobHistory = (id: string, params: HistoryParams = {}) => {
  return useQuery<PaginatedResponse<IEmailSendAttemptDocument>>({
    queryKey: ['email-job-history', id, params],
    queryFn: async () => {
      const queryParams: Record<string, string> = {
        page: String(params.page || 1),
        limit: String(params.limit || 10),
      };

      if (params.status && params.status !== 'all') {
        queryParams.status = params.status;
      }
      if (params.search) {
        queryParams.search = params.search;
      }
      if (params.excludeTest) {
        queryParams.excludeTest = 'true';
      }
      if (params.startDate) {
        queryParams.startDate = params.startDate;
      }
      if (params.endDate) {
        queryParams.endDate = params.endDate;
      }

      const response = await api.get(`/api/admin/email/jobs/${id}/analytics`, { params: queryParams });
      // Analytics endpoint returns attempts in the response
      return response.data.attempts || { data: [], meta: { currentPage: 1, totalPages: 0, total: 0 } };
    },
    enabled: !!id,
    refetchInterval: 5000, // Auto-refetch during active sends
  });
};

// ================== JOB RECIPIENTS ==================

interface RecipientWithStatus {
  id: string;
  email: string;
  name?: string;
  type: 'user' | 'subscriber' | 'direct';
  lastSentAt?: Date;
  sendCount: number;
}

interface RecipientsResponse {
  recipients: RecipientWithStatus[];
  meta: {
    currentPage: number;
    totalPages: number;
    total: number;
    totalEligible: number;
    totalAll: number;
  };
}

interface RecipientsParams {
  page?: number;
  limit?: number;
  search?: string;
}

export const useEmailJobRecipients = (id: string, params: RecipientsParams = {}) => {
  return useQuery<RecipientsResponse>({
    queryKey: ['email-job-recipients', id, params],
    queryFn: async () => {
      const response = await api.get(`/api/admin/email/jobs/${id}/recipients`, { params });
      return response.data;
    },
    enabled: !!id,
  });
};

// ================== PREVIEW FOR USER ==================

interface PreviewForUserParams {
  jobId: string;
  userId: string;
  type?: 'user' | 'subscriber';
}

interface PreviewForUserResponse {
  subject: string;
  html: string;
  recipient: {
    id: string;
    email: string;
    name?: string;
    type: 'user' | 'subscriber';
  };
  variables: Record<string, string>;
}

export const usePreviewForUser = (params: PreviewForUserParams | null) => {
  return useQuery<PreviewForUserResponse>({
    queryKey: ['email-preview-for-user', params?.jobId, params?.userId, params?.type],
    queryFn: async () => {
      if (!params) throw new Error('Missing params');
      const response = await api.get(`/api/admin/email/jobs/${params.jobId}/preview-for-user`, {
        params: { userId: params.userId, type: params.type || 'user' },
      });
      return response.data;
    },
    enabled: !!params?.jobId && !!params?.userId,
  });
};

// ================== CANCEL PENDING EMAILS ==================

interface CancelParams {
  jobId: string;
  recipientIds?: string[];
}

export const useCancelPendingEmails = () => {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: async ({ jobId, recipientIds }: CancelParams) => {
      const response = await api.post(`/api/admin/email/jobs/${jobId}/cancel`, { recipientIds });
      return response.data;
    },
    onSuccess: (_, { jobId }) => {
      queryClient.invalidateQueries({ queryKey: ['email-jobs'] });
      queryClient.invalidateQueries({ queryKey: ['email-job', jobId] });
      queryClient.invalidateQueries({ queryKey: ['email-job-summary', jobId] });
      queryClient.invalidateQueries({ queryKey: ['email-job-history', jobId] });
    },
  });
};

// ================== ANALYTICS ==================

interface JobAnalytics {
  job: {
    id: string;
    name: string;
    status: EmailJobStatus;
    recipientCount: number;
    sentCount: number;
    failedCount: number;
    openedCount: number;
    clickedCount: number;
    openRate: string;
    clickRate: string;
    failureRate: string;
    startedAt?: Date;
    completedAt?: Date;
  };
  attempts: PaginatedResponse<{
    id: string;
    recipientEmail: string;
    status: EmailSendStatus;
    sentAt?: Date;
    openedAt?: Date;
    clickedAt?: Date;
    errorMessage?: string;
  }>;
}

interface GetAnalyticsParams {
  page?: number;
  limit?: number;
  status?: EmailSendStatus;
}

export const useEmailJobAnalytics = (id: string, params: GetAnalyticsParams = {}) => {
  return useQuery<JobAnalytics>({
    queryKey: ['email-job-analytics', id, params],
    queryFn: async () => {
      const response = await api.get(`/api/admin/email/jobs/${id}/analytics`, { params });
      return response.data;
    },
    enabled: !!id,
    refetchInterval: 5000, // Refetch every 5 seconds for real-time updates
  });
};

// ================== RECIPIENT PREVIEW ==================

interface PreviewRecipient {
  id: string;
  email: string;
  name?: string;
  type: 'user' | 'subscriber' | 'direct';
}

interface RecipientPreviewResponse {
  totalCount: number;
  eligibleCount: number;
  excludedCount: number;
  recipients: PreviewRecipient[];
  hasMore: boolean;
}

interface PreviewRecipientsParams {
  recipientFilter?: CreateJobData['recipientFilter'];
  category?: string;
}

export const usePreviewRecipients = () => {
  return useMutation<RecipientPreviewResponse, Error, PreviewRecipientsParams>({
    mutationFn: async ({ recipientFilter, category }) => {
      const response = await api.post('/api/admin/email/jobs/preview-recipients', {
        recipientFilter,
        category,
      });
      return response.data;
    },
  });
};

// ================== WHAT'S NEW CONTENT ==================

interface WhatsNewContentResponse {
  html: string;
  count: number;
  modals: Array<{
    id: string;
    title: string;
    subtitle?: string;
    createdAt: string;
  }>;
}

interface FetchWhatsNewParams {
  days?: number;
  ids?: string[]; // Specific modal IDs to fetch
}

export const useFetchWhatsNewContent = () => {
  return useMutation<WhatsNewContentResponse, Error, FetchWhatsNewParams>({
    mutationFn: async ({ days = 7, ids }) => {
      const params: Record<string, string> = {};

      if (ids && ids.length > 0) {
        params.ids = ids.join(',');
      } else {
        params.days = String(days);
      }

      const response = await api.get('/api/admin/email/whats-new-content', {
        params,
      });
      return response.data;
    },
  });
};

import { useMutation, useQuery } from '@tanstack/react-query';
import { api } from '@client/app/contexts/ApiContext';

export interface MFASetupResponse {
  secret: string;
  qrCodeUrl: string;
  manualEntryKey: string;
  backupCodes: string[];
}

export interface MFAStatusResponse {
  enabled: boolean;
  required: boolean;
  canDisable: boolean;
  setupAt?: string;
  lastUsedAt?: string;
  backupCodesCount: number;
}

export interface MFAVerifyResponse {
  success: boolean;
  user?: any;
  backupCodes?: string[];
}

export interface RegenerateBackupCodesResponse {
  backupCodes: string[];
  user: any;
}

/**
 * Hook to set up MFA for the current user
 */
export function useSetupMFA() {
  return useMutation<MFASetupResponse, Error>({
    mutationFn: async () => {
      const response = await api.post('/api/auth/mfa/setup');
      return response.data;
    },
  });
}

/**
 * Hook to verify MFA setup
 */
export function useVerifyMFASetup() {
  return useMutation<MFAVerifyResponse, Error, { token: string }>({
    mutationFn: async ({ token }) => {
      const response = await api.post('/api/auth/mfa/verify-setup', { token });
      return response.data;
    },
  });
}

/**
 * Hook to verify MFA during login (now requires authentication token)
 */
export function useVerifyMFA() {
  return useMutation<any, Error, { token: string }>({
    mutationFn: async ({ token }) => {
      const response = await api.post('/api/auth/mfa/verify', { token });
      return response.data;
    },
  });
}

/**
 * Hook to disable MFA
 */
export function useDisableMFA() {
  return useMutation<{ success: boolean; user: any }, Error>({
    mutationFn: async () => {
      const response = await api.post('/api/auth/mfa/disable');
      return response.data;
    },
  });
}

/**
 * Hook to regenerate backup codes
 */
export function useRegenerateBackupCodes() {
  return useMutation<RegenerateBackupCodesResponse, Error>({
    mutationFn: async () => {
      const response = await api.post('/api/auth/mfa/regenerate-backup-codes');
      return response.data;
    },
  });
}

/**
 * Hook to cancel MFA setup
 */
export function useCancelMFASetup() {
  return useMutation<{ success: boolean }, Error>({
    mutationFn: async () => {
      const response = await api.post('/api/auth/mfa/cancel-setup');
      return response.data;
    },
  });
}

/**
 * Hook to force reset MFA for a user (admin only)
 */
export function useForceResetMFA() {
  return useMutation<{ success: boolean; user: any }, Error, { userId: string }>({
    mutationFn: async ({ userId }) => {
      const response = await api.post('/api/auth/mfa/force-reset', { userId });
      return response.data;
    },
  });
}

/**
 * Hook to get MFA status for the current user
 */
export function useMFAStatus(enabled = true) {
  return useQuery<MFAStatusResponse, Error>({
    queryKey: ['mfa', 'status'],
    queryFn: async () => {
      const response = await api.get('/api/auth/mfa/status');
      return response.data;
    },
    retry: false,
    refetchOnWindowFocus: false,
    enabled,
  });
}

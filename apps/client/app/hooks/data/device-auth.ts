import { api } from '@client/app/contexts/ApiContext';
import { useMutation } from '@tanstack/react-query';
import { toast } from 'sonner';
import { AxiosError } from 'axios';

interface VerifyDeviceRequest {
  user_code: string;
  action: 'approve' | 'deny';
}

interface VerifyDeviceResponse {
  success: true;
  device_info: {
    client_type: string;
    ip_address: string;
    created_at: string;
  };
}

interface DeviceAuthError {
  error: string;
  // Absent on the auth-middleware consent 403 (see apps/client/server/auth/auth.ts) - read `error`
  // as the fallback there.
  error_description?: string;
  // Set by the server consent gate when the account has not accepted the AUP/ToS. The code is
  // valid; the account must accept policies first. Callers route to /accept-policies. See issue #369.
  policyAcceptanceRequired?: boolean;
}

/**
 * Hook for verifying (approving/denying) a device authorization request
 */
export function useVerifyDevice() {
  return useMutation<VerifyDeviceResponse, AxiosError<DeviceAuthError>, VerifyDeviceRequest>({
    mutationFn: async (data: VerifyDeviceRequest) => {
      const response = await api.post<VerifyDeviceResponse>('/api/oauth/device/verify', data);
      return response.data;
    },
    onSuccess: (_, variables) => {
      if (variables.action === 'approve') {
        toast.success('Device activated successfully!');
      } else {
        toast.success('Device authorization denied');
      }
    },
    onError: error => {
      const data = error.response?.data;
      const message = data?.policyAcceptanceRequired
        ? 'Accept the Terms of Service and Acceptable Use Policy to continue.'
        : data?.error_description || 'Action failed';
      toast.error(message);
    },
  });
}

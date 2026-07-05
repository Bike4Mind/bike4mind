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
  error_description: string;
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
      const message = error.response?.data?.error_description || 'Action failed';
      toast.error(message);
    },
  });
}

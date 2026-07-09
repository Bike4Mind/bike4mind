import { ICreditTransactionDocument } from '@bike4mind/database';
import { api } from '@client/app/contexts/ApiContext';
import { useQuery } from '@tanstack/react-query';

export interface CreditsBalance {
  currentCredits: number;
  expiringSoon: { amount: number; expiresAt: string }[];
}

export function useGetCreditsBalance(options: { enabled?: boolean } = {}) {
  return useQuery<CreditsBalance>({
    queryKey: ['credits-balance'],
    queryFn: async () => {
      const response = await api.get('/api/credits/balance');
      return response.data;
    },
    enabled: options.enabled,
  });
}

export function useGetCreditTransactions(
  options: {
    enabled?: boolean;
    days?: number;
    type?: 'all' | 'added' | 'deducted';
  } = {}
) {
  const { enabled, days = 30, type = 'all' } = options;

  return useQuery<ICreditTransactionDocument[]>({
    queryKey: ['credit-transactions', days, type],
    queryFn: async () => {
      const params = new URLSearchParams();
      if (days) params.append('days', days.toString());
      if (type) params.append('type', type);

      const response = await api.get(`/api/credits/transactions?${params.toString()}`);
      return response.data;
    },
    enabled,
  });
}

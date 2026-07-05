import { api } from '@client/app/contexts/ApiContext';
import { getErrorMessage } from '@client/app/utils/error';
import { ISubscription, SubscriptionOwnerType } from '@client/lib/subscriptions/types';
import { subscriptionPlanSchema } from '@client/lib/userSubscriptions/schemas';
import { IUserSubscription } from '@client/lib/userSubscriptions/types';
import { type OrgSubscriptionSubscribeRequest } from '@client/lib/subscriptions/schema';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { toast } from 'sonner';
import { z } from 'zod';

export const useSubscribePlan = () => {
  return useMutation({
    mutationFn: async (data: z.infer<typeof subscriptionPlanSchema>) => {
      const response = await api.post<{ sessionUrl: string }>(`/api/subscriptions/subscribe`, data);
      return response.data;
    },
    onError: err => {
      toast.error(getErrorMessage(err));
    },
  });
};

export const useCancelSubscription = () => {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: async (priceId: string) => {
      const response = await api.post<IUserSubscription>(`/api/subscriptions/cancel`, { priceId });
      return response.data;
    },
    onSuccess: userSubscription => {
      queryClient.setQueryData<IUserSubscription[]>(['subscriptions'], oldData => {
        return (oldData ?? []).map(subscription => {
          if (subscription.priceId === userSubscription.priceId) {
            return { ...subscription, canceledAt: userSubscription.canceledAt };
          }
          return subscription;
        });
      });
      toast.success('Subscription cancelled successfully');
    },
    onError: err => {
      toast.error(getErrorMessage(err));
    },
  });
};

export const useChangeSubscription = () => {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: async (data: z.infer<typeof subscriptionPlanSchema>) => {
      const response = await api.put<{ subscriptionId: string; priceId: string }>(`/api/subscriptions/change`, data);
      return response.data;
    },
    onSuccess: data => {
      queryClient.setQueryData<IUserSubscription[]>(['subscriptions'], oldData => {
        // Update current subscription's priceId
        return (oldData ?? []).map(subscription => {
          if (subscription.subscriptionId === data.subscriptionId) {
            return { ...subscription, priceId: data.priceId };
          }
          return subscription;
        });
      });
      toast.success('Subscription changed successfully');
    },
    onError: err => {
      toast.error(getErrorMessage(err));
    },
  });
};

export const useGetSubscriptionsByOwner = (ownerType: SubscriptionOwnerType, ownerId: string) => {
  return useQuery({
    queryKey: ['subscriptions', ownerType, ownerId],
    queryFn: async () => {
      const response = await api.get<ISubscription[]>(`/api/subscriptions/${ownerType}/${ownerId}`);
      return response.data;
    },
  });
};

export const useGetSubscriptions = (
  options: {
    enabled?: boolean;
  } = {}
) => {
  const { enabled = true } = options;

  return useQuery({
    queryKey: ['subscriptions'],
    queryFn: async () => {
      const response = await api.get<IUserSubscription[]>(`/api/subscriptions/own`);
      return response.data;
    },
    enabled,
  });
};

/**
 * Hook for admin users to get all subscriptions across the platform
 */
export const useGetAllSubscriptions = (
  options: {
    enabled?: boolean;
    search?: string;
    page?: number;
    limit?: number;
  } = {}
) => {
  const { enabled = true, search, page = 1, limit = 10 } = options;

  return useQuery({
    queryKey: ['admin', 'subscriptions', search, page, limit],
    queryFn: async () => {
      const params = {
        ...(search ? { search } : {}),
        page,
        limit,
      };
      const response = await api.get<{
        subscriptions: Array<
          IUserSubscription & { user: { username: string; email: string; name: string; _id: string } }
        >;
        pagination: {
          total: number;
          page: number;
          limit: number;
          totalPages: number;
        };
      }>('/api/subscriptions', { params });
      return response.data;
    },
    enabled,
  });
};

/**
 * Hook for admin users to get subscription statistics
 */
export const useGetSubscriptionStats = (
  options: {
    enabled?: boolean;
  } = {}
) => {
  const { enabled = true } = options;

  return useQuery({
    queryKey: ['admin', 'subscription-stats'],
    queryFn: async () => {
      const response = await api.get<{
        total: number;
        active: number;
        expiringThisMonth: number;
        canceled: number;
      }>('/api/subscriptions/stats');
      return response.data;
    },
    enabled,
  });
};

/**
 * Hook for users to subscribe to a team plan. This will also create a new organization.
 */
export const useSubscribeTeamPlan = () => {
  return useMutation({
    mutationFn: async (data: OrgSubscriptionSubscribeRequest) => {
      const response = await api.post<{ sessionUrl: string }>('/api/organizations/subscriptions/subscribe', data);
      return response.data;
    },
    onError: err => {
      toast.error(getErrorMessage(err));
    },
  });
};

/**
 * DEV-ONLY: Create organization without Stripe for local development
 */
export const useCreateTeamDev = () => {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: async (data: { name: string; seats?: number }) => {
      const response = await api.post<{
        organization: {
          id: string;
          name: string;
          seats: number;
        };
      }>('/api/organizations/create-dev', data);
      return response.data;
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['organizations'] });
      toast.success('Team created successfully (dev mode)');
    },
    onError: err => {
      toast.error(getErrorMessage(err));
    },
  });
};

export interface UpdateSubscriptionSeatsResponse {
  seats: number;
  currentTeamSize: number;
  minimumRequiredSeats: number;
  nextBillingDate: string;
  proration: {
    amount: number | null;
    currency: string;
  };
}

export const useUpdateSubscriptionSeats = () => {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: async ({ organizationId, seats }: { organizationId: string; seats: number }) => {
      const { data } = await api.post<UpdateSubscriptionSeatsResponse>(
        '/api/organizations/subscriptions/update-seats',
        {
          organizationId,
          seats,
        }
      );
      return data;
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['subscriptions'] });
      queryClient.invalidateQueries({ queryKey: ['organization'] });
    },
    onError: err => {
      toast.error(getErrorMessage(err));
    },
  });
};

export const useGrantSubscription = () => {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: async ({
      userId,
      subscriptionType,
      priceId,
      seats,
      organizationName,
      organizationId,
      durationMonths = 1,
      billingOwnerId,
      managerId,
    }: {
      userId: string;
      subscriptionType: 'individual' | 'team';
      priceId?: string;
      seats?: number;
      organizationName?: string;
      organizationId?: string;
      durationMonths?: number;
      billingOwnerId?: string;
      managerId?: string;
    }) => {
      const { data } = await api.post<{
        success: boolean;
        message: string;
        credits?: number;
        organizationId?: string;
        seats?: number;
      }>(`/api/admin/users/${userId}/grant-subscription`, {
        subscriptionType,
        priceId,
        seats,
        organizationName,
        organizationId,
        durationMonths,
        billingOwnerId,
        managerId,
      });
      return data;
    },
    onSuccess: data => {
      queryClient.invalidateQueries({ queryKey: ['subscriptions'] });
      queryClient.invalidateQueries({ queryKey: ['organizations'] });
      queryClient.invalidateQueries({ queryKey: ['admin', 'subscriptions'] });
      queryClient.invalidateQueries({ queryKey: ['admin', 'user-subscriptions'] });
      toast.success(data.message);
    },
    onError: err => {
      toast.error(getErrorMessage(err));
    },
  });
};

/**
 * Hook for admins to get all subscription information for a specific user
 */
export const useGetUserSubscriptions = (userId: string) => {
  return useQuery({
    queryKey: ['admin', 'user-subscriptions', userId],
    queryFn: async () => {
      const { data } = await api.get<{
        individualSubscriptions: Array<
          IUserSubscription & {
            planName?: string;
            planCredits?: number;
            effectiveCreditsPerCycle?: number;
          }
        >;
        teamSubscriptions: Array<{
          organization: {
            id: string;
            name: string;
            seats: number;
            currentCredits: number;
            users: Array<{ userId: string; email: string; name: string }>;
          };
          subscription: ISubscription & {
            effectiveCreditsPerCycle?: number;
            defaultCreditsPerCycle?: number;
          };
        }>;
        userCredits: number;
      }>(`/api/admin/users/${userId}/subscriptions`);
      return data;
    },
    enabled: !!userId,
  });
};

/**
 * Hook for admins to remove a subscription
 */
export const useRemoveSubscription = () => {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: async ({ userId, subscriptionId }: { userId: string; subscriptionId: string }) => {
      const { data } = await api.delete<{
        success: boolean;
        message: string;
      }>(`/api/admin/users/${userId}/subscriptions/${subscriptionId}/remove`);
      return data;
    },
    onSuccess: (data, variables) => {
      queryClient.invalidateQueries({ queryKey: ['subscriptions'] });
      queryClient.invalidateQueries({ queryKey: ['organizations'] });
      queryClient.invalidateQueries({ queryKey: ['admin', 'subscriptions'] });
      queryClient.invalidateQueries({ queryKey: ['admin', 'user-subscriptions', variables.userId] });
      toast.success(data.message);
    },
    onError: err => {
      toast.error(getErrorMessage(err));
    },
  });
};

/**
 * Hook for admins to update credits per billing cycle for a subscription
 */
export const useUpdateSubscriptionCredits = () => {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: async ({
      userId,
      subscriptionId,
      creditsPerCycle,
    }: {
      userId: string;
      subscriptionId: string;
      creditsPerCycle: number;
    }) => {
      const { data } = await api.put<{
        success: boolean;
        message: string;
        creditsPerCycle: number;
      }>(`/api/admin/users/${userId}/subscriptions/${subscriptionId}/credits`, {
        creditsPerCycle,
      });
      return data;
    },
    onSuccess: (data, variables) => {
      queryClient.invalidateQueries({ queryKey: ['subscriptions'] });
      queryClient.invalidateQueries({ queryKey: ['organizations'] });
      queryClient.invalidateQueries({ queryKey: ['admin', 'subscriptions'] });
      queryClient.invalidateQueries({ queryKey: ['admin', 'user-subscriptions', variables.userId] });
      queryClient.invalidateQueries({ queryKey: ['users', variables.userId] });
      toast.success(data.message);
    },
    onError: err => {
      toast.error(getErrorMessage(err));
    },
  });
};

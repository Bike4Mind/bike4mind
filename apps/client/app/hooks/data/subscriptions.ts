import { api } from '@client/app/contexts/ApiContext';
import { getErrorMessage } from '@client/app/utils/error';
import { resolveConsent } from '@client/app/utils/consentRegion';
import { checkoutSurfaceParam, trackBeginCheckout, type UpsellSurface } from '@client/app/utils/funnelEvents';
import { SUBSCRIPTION_PLANS_MAP } from '@client/lib/userSubscriptions/constants';
import { ISubscription, SubscriptionOwnerType } from '@bike4mind/server-utils/lib/subscriptions/types';
import { subscriptionPlanSchema } from '@bike4mind/server-utils/lib/userSubscriptions/schemas';
import { IUserSubscription } from '@bike4mind/server-utils/lib/userSubscriptions/types';
import { ADMIN_GRANTS_KEY } from './adminOrganizations';
import { type OrgSubscriptionSubscribeRequest } from '@bike4mind/server-utils/lib/subscriptions/schema';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { toast } from 'sonner';
import { z } from 'zod';

export const useSubscribePlan = () => {
  return useMutation({
    mutationFn: async (data: z.infer<typeof subscriptionPlanSchema> & { surface?: UpsellSurface }) => {
      trackBeginCheckout({
        plan: SUBSCRIPTION_PLANS_MAP[data.priceId]?.name ?? 'unknown',
        priceId: data.priceId,
        ownerType: 'user',
        surface: data.surface,
      });
      const response = await api.post<{ sessionUrl: string }>(`/api/subscriptions/subscribe`, {
        ...data,
        surface: checkoutSurfaceParam(data.surface),
        attributionConsent: resolveConsent() === 'granted',
      });
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
          // Match on identity, not priceId: a user can hold two rows at one price (a
          // stale delinquent row beside the active one), and patching on priceId would
          // write the same status onto both.
          if (userSubscription.subscriptionId && subscription.subscriptionId === userSubscription.subscriptionId) {
            // `status` matters as much as `canceledAt`: an immediate cancel returns
            // Stripe's 'canceled', and that is what drops the row out of the
            // "still cancellable" filters. Re-fetching here instead would race the
            // webhook that owns the local row and could put the stale status back.
            return {
              ...subscription,
              canceledAt: userSubscription.canceledAt,
              status: userSubscription.status ?? subscription.status,
            };
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
 * Hook for users to subscribe to a team plan. This will also create a new organization.
 */
export const useSubscribeTeamPlan = () => {
  return useMutation({
    mutationFn: async (data: Omit<OrgSubscriptionSubscribeRequest, 'attributionConsent'>) => {
      trackBeginCheckout({
        plan: 'team',
        priceId: data.priceId,
        ownerType: 'organization',
        surface: data.surface,
        quantity: data.quantity,
      });
      const response = await api.post<{ sessionUrl: string }>('/api/organizations/subscriptions/subscribe', {
        ...data,
        surface: checkoutSurfaceParam(data.surface),
        attributionConsent: resolveConsent() === 'granted',
      });
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
      reason,
    }: {
      userId: string;
      subscriptionType: 'individual' | 'team';
      priceId?: string;
      seats?: number;
      organizationName?: string;
      organizationId?: string;
      durationMonths?: number;
      billingOwnerId?: string;
      reason: string;
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
        reason,
      });
      return data;
    },
    onSuccess: data => {
      queryClient.invalidateQueries({ queryKey: ['subscriptions'] });
      queryClient.invalidateQueries({ queryKey: ['organizations'] });
      queryClient.invalidateQueries({ queryKey: ['admin', 'subscriptions'] });
      queryClient.invalidateQueries({ queryKey: ['admin', 'user-subscriptions'] });
      queryClient.invalidateQueries({ queryKey: ADMIN_GRANTS_KEY });
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
            cancelAtPeriodEnd?: boolean;
            cancelAt?: Date | null;
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
            /** The Subscription document's Mongo id, which the admin detail page is keyed by. */
            id: string;
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
    mutationFn: async ({
      userId,
      subscriptionId,
      reason,
    }: {
      userId: string;
      subscriptionId: string;
      reason: string;
    }) => {
      const { data } = await api.delete<{
        success: boolean;
        message: string;
      }>(`/api/admin/users/${userId}/subscriptions/${subscriptionId}/remove`, { data: { reason } });
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
 * Hook for admins to update credits per billing cycle for a subscription. Success shows nothing: the
 * caller confirms with an UndoToast.
 */
export const useUpdateSubscriptionCredits = () => {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: async ({
      userId,
      subscriptionId,
      creditsPerCycle,
      reason,
    }: {
      userId: string;
      subscriptionId: string;
      /** `null` clears the admin override, so the plan's own rate applies again. */
      creditsPerCycle: number | null;
      reason: string;
    }) => {
      const { data } = await api.put<{
        success: boolean;
        message: string;
        creditsPerCycle: number | null;
      }>(`/api/admin/users/${userId}/subscriptions/${subscriptionId}/credits`, {
        creditsPerCycle,
        reason,
      });
      return data;
    },
    onSuccess: (_data, variables) => {
      queryClient.invalidateQueries({ queryKey: ['subscriptions'] });
      queryClient.invalidateQueries({ queryKey: ['organizations'] });
      queryClient.invalidateQueries({ queryKey: ['admin', 'subscriptions'] });
      queryClient.invalidateQueries({ queryKey: ['admin', 'user-subscriptions', variables.userId] });
      queryClient.invalidateQueries({ queryKey: ['users', variables.userId] });
    },
    onError: err => {
      toast.error(getErrorMessage(err));
    },
  });
};

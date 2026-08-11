export interface SubscriptionData {
  id: string;
  userId: string;
  /** Stripe Subscription ID. Absent for admin-granted subscriptions. */
  subscriptionId?: string;
  priceId: string;
  status: string;
  canceledAt: Date | null;
  periodStartsAt: Date;
  periodEndsAt: Date;
  createdAt: Date;
  updatedAt: Date;
  // Must stay named `owner`: subscriptionRepository.findWithOwnerDetails projects the
  // joined account under `owner`. Always the User shape here, since /api/subscriptions
  // filters to SubscriptionOwnerType.User.
  owner?: {
    username: string;
    email: string;
    name: string;
    _id: string;
  };
}

export interface SubscriptionStats {
  total: number;
  active: number;
  expiringThisMonth: number;
  canceled: number;
}

export interface SubscriptionPagination {
  total: number;
  page: number;
  limit: number;
  totalPages: number;
}

export interface SubscriptionListResponse {
  subscriptions: SubscriptionData[];
  pagination: SubscriptionPagination;
}

export interface PlanInfo {
  name: string;
  amount: number;
  interval: string;
}

export interface StatusDisplay {
  icon: React.ComponentType<any>;
  color: 'success' | 'neutral' | 'warning' | 'primary' | 'danger';
  label: string;
  tooltip: string;
}

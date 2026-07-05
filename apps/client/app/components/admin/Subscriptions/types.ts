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
  user?: {
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

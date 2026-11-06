export interface NotificationState {
  open: boolean;
  message: string;
  color: 'success' | 'danger' | 'warning' | 'neutral';
}

export type CreditChange = { kind: 'delta'; delta: number } | { kind: 'set'; balance: number };

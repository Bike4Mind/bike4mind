export interface NotificationState {
  open: boolean;
  message: string;
  color: 'success' | 'danger' | 'warning' | 'neutral';
}

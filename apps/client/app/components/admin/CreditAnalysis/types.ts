export interface ModelCostSetting {
  id: string;
  inputCost: number;
  outputCost: number;
  type: 'text' | 'image';
}

export interface ModelCostOverride {
  inputCost: number;
  outputCost: number;
}

export interface NotificationState {
  open: boolean;
  message: string;
  color: 'success' | 'danger' | 'warning' | 'neutral';
}

import { create } from 'zustand';

/** Admin notices the admin dismissed this session (the waiting-subscribers badge). */
export const useAdminNotifications = create<{
  hiddenNotifications: string[];
  hideNotification: (notificationId: string) => void;
}>((set, get) => ({
  hiddenNotifications: [],
  hideNotification: (notificationId: string) => {
    const current = get().hiddenNotifications;
    if (!current.includes(notificationId)) {
      set({ hiddenNotifications: [...current, notificationId] });
    }
  },
}));

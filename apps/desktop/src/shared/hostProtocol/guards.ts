import type { HostMessage, HostNotification, HostRequest, HostResponse } from './envelope';
import { hostMethods, hostNotifications, type HostMethod, type HostNotificationName } from './methods';

export const isHostMethod = (name: string): name is HostMethod => Object.hasOwn(hostMethods, name);

export const isHostNotificationName = (name: string): name is HostNotificationName =>
  Object.hasOwn(hostNotifications, name);

export const isHostRequest = (message: HostMessage): message is HostRequest => 'method' in message && 'id' in message;

export const isHostNotification = (message: HostMessage): message is HostNotification =>
  'method' in message && !('id' in message);

export const isHostResponse = (message: HostMessage): message is HostResponse => !('method' in message);

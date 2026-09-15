import { IBaseEvent } from '../../../types';
import { AuthStrategy } from '../../user';

export enum AuthEvents {
  LOGOUT = 'User Logout',
  LOGIN = 'User Login',
  REGISTER = 'User Registration',
  RESET_PASSWORD = 'Password Reset Requested',
  RESET_LAND_PASSWORD = 'Password Reset Landed',
  RESET_PASSWORD_TOKEN_EXPIRED = 'Password Reset Token Expired',
  CHANGE_PASSWORD = 'Password Changed',
  FORCE_CHANGE_PASSWORD = 'Forced Password Changed',
  ADMIN_RESET_PASSWORD = 'Admin Password Reset',
  FAILED_LOGIN = 'Failed Login Attempt',
  EMAIL_VERIFIED = 'Email Verified',
}

export interface ILoginEvent extends IBaseEvent {
  type: AuthEvents.LOGIN;
  metadata: {
    /** Auth strategy used to login */
    strategy: AuthStrategy | 'local' | 'otc';
    /** IP address of the login attempt */
    ip?: string;
    /** User agent of the login attempt */
    userAgent?: string;
  };
}

export interface ILogoutEvent extends IBaseEvent {
  type: AuthEvents.LOGOUT;
}

export interface IRegisterEvent extends IBaseEvent {
  type: AuthEvents.REGISTER;
  metadata: {
    /** Auth strategy used to register, if any */
    strategy?: AuthStrategy | 'otc';
    /** Invite code used to register, if any */
    inviteCode?: string;
  };
}

export interface IPasswordResetEvent extends IBaseEvent {
  type: AuthEvents.RESET_PASSWORD;
  metadata: {
    // Token used to reset password
    token: string;
  };
}

export interface IPasswordResetLandedEvent extends IBaseEvent {
  type: AuthEvents.RESET_LAND_PASSWORD;
  metadata: {
    // Token used to reset password
    token: string;
  };
}

export interface IPasswordResetTokenExpiredEvent extends IBaseEvent {
  type: AuthEvents.RESET_PASSWORD_TOKEN_EXPIRED;
  metadata: {
    // Token used to reset password
    token: string;
  };
}

export interface IPasswordChangeEvent extends IBaseEvent {
  type: AuthEvents.CHANGE_PASSWORD;
  metadata: Record<string, never>;
}

export interface IForceChangePasswordEvent extends IBaseEvent {
  type: AuthEvents.FORCE_CHANGE_PASSWORD;
  metadata: Record<string, never>;
}

export interface IAdminPasswordResetEvent extends IBaseEvent {
  type: AuthEvents.ADMIN_RESET_PASSWORD;
  metadata: {
    /** ID of the user whose password was reset */
    targetUserId: string;
    /** Username of the user whose password was reset */
    targetUsername: string;
  };
}

export interface IFailedLoginEvent extends IBaseEvent {
  type: AuthEvents.FAILED_LOGIN;
  metadata: {
    /** Auth strategy used for failed login attempt */
    strategy: AuthStrategy | 'local' | 'otc';
    /** Username or email attempted */
    username?: string;
    /** IP address of the failed attempt */
    ip?: string;
    /** User agent of the failed attempt */
    userAgent?: string;
    /** Reason for failure */
    reason?: string;
  };
}

export interface IEmailVerifiedEvent extends IBaseEvent {
  type: AuthEvents.EMAIL_VERIFIED;
  metadata: Record<string, never>;
}

export type AuthEventPayload =
  | ILoginEvent
  | ILogoutEvent
  | IRegisterEvent
  | IPasswordResetEvent
  | IPasswordResetLandedEvent
  | IPasswordResetTokenExpiredEvent
  | IPasswordChangeEvent
  | IForceChangePasswordEvent
  | IAdminPasswordResetEvent
  | IFailedLoginEvent
  | IEmailVerifiedEvent;

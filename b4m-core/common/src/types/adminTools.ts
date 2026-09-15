import { IUserDocument } from './entities/UserTypes';
import { IModal } from './entities/ModalTypes';
import { IChatHistoryItem } from './entities/SessionTypes';

// Type definitions for better type safety
export interface Ability {
  can: (action: string, subject: string) => boolean;
  cannot: (action: string, subject: string) => boolean;
}

// Specific data types for admin tools
export interface ModalData {
  id?: string;
  title?: string;
  description?: string;
  textMessage?: string;
  type: 'modal' | 'banner';
  priority: number;
  enabled: boolean;
  tags: string[];
  startDate?: string;
  endDate?: string;
  imageUrl?: string;
}

export interface UserData {
  id: string;
  username: string;
  name: string;
  email?: string;
  isAdmin: boolean;
  isBanned: boolean;
  currentCredits: number;
  level: string;
}

export interface AnalyticsData {
  metric: string;
  value: number | string;
  timestamp: Date;
  metadata?: Record<string, string | number>;
}

export interface SystemData {
  status: 'healthy' | 'warning' | 'error';
  message: string;
  timestamp: Date;
  details?: Record<string, string | number>;
}

// Additional data types for admin tool results
export interface ModalListData {
  type: 'modalList';
  modals: any[];
  message?: string;
}

export interface TriggerModalData {
  type: 'triggerModal';
  modal: any;
}

export interface ListData {
  type: 'list';
  data: string;
  message?: string;
}

// Union type for all possible data types - made more flexible
export type AdminToolData =
  | ModalData
  | UserData
  | AnalyticsData
  | SystemData
  | ModalListData
  | TriggerModalData
  | ListData
  | { type: string; [key: string]: any } // Allow any object with a type property
  | Record<string, any>; // Allow any record for flexibility

// Preview content types
export interface ModalPreviewContent {
  type: 'modal';
  modal: Partial<IModal>;
  suggestions?: string[];
  confidence?: number;
}

export interface BannerPreviewContent {
  type: 'banner';
  message: string;
  priority: number;
  tags: string[];
}

export interface DataPreviewContent {
  type: 'data';
  data: AdminToolData;
  format: 'table' | 'chart' | 'list';
}

export type PreviewContent = ModalPreviewContent | BannerPreviewContent | DataPreviewContent;

// Action parameter types
export interface ConfirmActionParams {
  action: 'confirm';
  confirmed: boolean;
  data?: AdminToolData;
}

export interface EditActionParams {
  action: 'edit';
  field: string;
  value: string | number | boolean | null;
  data?: AdminToolData;
}

export interface CancelActionParams {
  action: 'cancel';
  reason?: string;
}

export type ActionParams = ConfirmActionParams | EditActionParams | CancelActionParams;

// Metadata types for different contexts
export interface AttachmentMetadata {
  filename?: string;
  size?: number;
  mimeType?: string;
  uploadedAt?: Date;
}

export interface AuditMetadata {
  ipAddress?: string;
  userAgent?: string;
  sessionId?: string;
  requestId?: string;
}

export interface PermissionMetadata {
  resource?: string;
  context?: string;
  conditions?: Record<string, string | number | boolean | null>;
}

// Base types for admin tools system
export interface AdminTool {
  name: string;
  description: string;
  command: string;
  requiredPermissions: string[];
  requiresAdmin: boolean;
  handler: AdminToolHandler;
}

export interface AdminToolContext {
  user: IUserDocument;
  chatHistory?: IChatHistoryItem[]; // Message history from chat
  attachments?: AdminToolAttachment[];
  sessionId?: string;
  ability?: Ability; // CASL ability object
}

export interface AdminToolAttachment {
  type: 'image' | 'file' | 'text';
  url?: string;
  content?: string;
  metadata?: AttachmentMetadata;
}

export interface AdminToolResult {
  success: boolean;
  data?: AdminToolData | string | any; // Allow any data type for maximum flexibility
  error?: string;
  message?: string;
  type?: 'modal' | 'preview' | 'help' | 'list' | 'success' | 'error';
  preview?: AdminToolPreview;
  requiresConfirmation?: boolean;
  nextAction?: AdminToolAction;
}

export interface AdminToolPreview {
  type: 'modal' | 'banner' | 'data';
  content: PreviewContent;
  editable?: boolean;
}

export interface AdminToolAction {
  type: 'confirm' | 'edit' | 'cancel';
  handler: (params: ActionParams) => Promise<AdminToolResult>;
}

export type AdminToolHandler = (context: AdminToolContext, params: AdminToolParams) => Promise<AdminToolResult>;

export interface AdminToolParams {
  action?: string;
  query?: string;
  data?: AdminToolData;
  options?: Record<string, string | number | boolean>;
}

// Modal-specific admin tool types
export interface ModalGenerationParams {
  type?: 'modal' | 'banner';
  fromContext?: boolean;
  contextMessages?: number;
  title?: string;
  description?: string;
  imageUrl?: string;
  tags?: string[];
  priority?: number;
  enabled?: boolean;
  startDate?: string;
  endDate?: string;
}

export interface ModalGenerationResult {
  modal: Partial<IModal>;
  suggestions?: string[];
  confidence?: number;
  reasoning?: string;
}

// Admin command types
export type AdminCommand = 'modal' | 'user' | 'credits' | 'analytics' | 'system';

export interface AdminCommandHandler {
  command: AdminCommand;
  subcommands: string[];
  description: string;
  examples: string[];
  handler: (params: AdminToolParams) => Promise<AdminToolResult>;
}

// Audit log types for admin actions
export interface AdminActionLog {
  userId: string;
  action: string;
  tool: string;
  params: AdminToolParams;
  result: 'success' | 'failure';
  error?: string;
  timestamp: Date;
  metadata?: AuditMetadata;
}

// Permission types
export interface AdminPermission {
  tool: string;
  actions: string[];
  conditions?: PermissionMetadata;
}

export interface AdminToolRegistry {
  tools: Map<string, AdminTool>;
  register(tool: AdminTool): void;
  get(name: string): AdminTool | undefined;
  list(user: IUserDocument): AdminTool[];
  canAccess(user: IUserDocument, toolName: string): boolean;
}

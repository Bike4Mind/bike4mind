import { DetailedHTMLProps, HTMLAttributes, ReactNode } from 'react';
import {
  IChatHistoryItem,
  IChatHistoryItemDocument,
  IFabFileDocument,
  PromptMeta,
  SnippetMeta,
} from '@bike4mind/common';
import { SendMessageOptions } from '@client/app/utils/llm';

export type UserPromptProps = {
  prompt: string;
  messageFiles: IFabFileDocument[];
  search?: string;
  onEdit?: (prompt: string) => void;
  onSendMessage: PromptReplyProps['onSendMessage'];
  messageId?: string;
};

export type MarkdownProps = {
  node: any;
  children: ReactNode;
  className?: string;
  inline?: boolean;
} & DetailedHTMLProps<HTMLAttributes<HTMLElement>, HTMLElement>;

export type SnippetCardProps = {
  meta: SnippetMeta;
  content: string;
  expanded: boolean;
  isEditMode: boolean;
  onEdit?: (content: string) => void;
};

export interface PromptReplyProps {
  messageData: Omit<IChatHistoryItem, 'reply'> & {
    reply?: string | null;
    replies?: string[];
    images?: string[];
    videos?: string[];
    status?: string;
    promptMeta?: PromptMeta;
    deepResearchState?: IChatHistoryItem['deepResearchState'];
  };
  onSendMessage: (message: Partial<IChatHistoryItemDocument>, options: SendMessageOptions) => Promise<void>;
  showSyntaxHighlight?: boolean;
  search?: string;
  isExpandable?: boolean;
  messageId?: string;
  onEdit?: (newReply: string) => void;
}

export interface ReplyContainerProps {
  onSendMessage: PromptReplyProps['onSendMessage'];
  showSyntaxHighlight?: boolean;
  reply: string;
  thought?: string;
  images?: string[];
  /** Non-image files a tool generated this turn (e.g. .xlsx), rendered as download chips. */
  generatedFiles?: { name: string; url: string }[];
  videos?: string[];
  search?: string;
  isExpandable?: boolean;
  completed?: boolean;
  /** Machine-readable classifier for an error quest, drives targeted error UI (e.g. the Add Credits CTA). */
  errorCode?: IChatHistoryItem['errorCode'];
  questMasterPlanId?: string;
  promptMeta?: PromptMeta;
  messageId?: string;
  onEdit?: (newReply: string) => void;
  agentIds?: string[];
  deepResearchState?: IChatHistoryItem['deepResearchState'];
  originalPrompt?: string;
  enhancedPrompt?: string;
  promptWasEnhanced?: boolean;
  /** Resolver intent for image-gen prompts. Used to differentiate the prompt-banner copy. */
  promptIntent?: 'fresh' | 'continuation';
  /** Pending MCP action awaiting user confirmation (for button-based confirmation flow) */
  pendingAction?: IChatHistoryItem['pendingAction'];
  /** Callback when user confirms or cancels the pending action */
  onPendingActionResponse?: (confirmed: boolean) => Promise<void>;
  /** Attachment list for download buttons (from Jira/Confluence list attachments) */
  attachmentList?: IChatHistoryItem['attachmentList'];
  /** Navigation intents from navigate_view tool (inline action buttons) */
  navigationIntents?: IChatHistoryItem['navigationIntents'];
  /** Generalized UI side-effects from tool results */
  uiSideEffects?: IChatHistoryItem['uiSideEffects'];
  /** Jupyter notebook execution state and content */
  jupyterNotebook?: IChatHistoryItem['jupyterNotebook'];
  /** The notebook JSON content (from generate_jupyter_notebook tool) */
  notebookContent?: string;
}

export interface CopyCodeButtonProps {
  code: string;
  language?: string;
}

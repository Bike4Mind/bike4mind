import { IBaseEvent } from '../../../types';
import { HelpFeedbackRating, HelpFeedbackReportType } from '../../../types/entities/FeedbackTypes';

export enum HelpEvents {
  HELP_ARTICLE_VIEW = 'Help Article Viewed',
  HELP_SEARCH = 'Help Search',
  HELP_ARTICLE_FEEDBACK = 'Help Article Feedback',
  HELP_CHAT_QUERY = 'Help Chat Query',
  HELP_CHAT_FEEDBACK = 'Help Chat Feedback',
}

interface IHelpArticleViewEvent extends IBaseEvent {
  type: HelpEvents.HELP_ARTICLE_VIEW;
  metadata: {
    slug: string;
    articleTitle?: string;
  };
}

interface IHelpSearchEvent extends IBaseEvent {
  type: HelpEvents.HELP_SEARCH;
  metadata: {
    searchQuery: string;
    searchResultCount: number;
  };
}

interface IHelpArticleFeedbackEvent extends IBaseEvent {
  type: HelpEvents.HELP_ARTICLE_FEEDBACK;
  metadata: {
    slug: string;
    rating?: HelpFeedbackRating;
    reportType?: HelpFeedbackReportType;
    comment?: string;
  };
}

interface IHelpChatQueryEvent extends IBaseEvent {
  type: HelpEvents.HELP_CHAT_QUERY;
  metadata: {
    chatQuestion: string;
  };
}

interface IHelpChatFeedbackEvent extends IBaseEvent {
  type: HelpEvents.HELP_CHAT_FEEDBACK;
  metadata: {
    chatQuestion: string;
    chatAnswer: string;
    rating: HelpFeedbackRating;
    comment?: string;
  };
}

export type HelpEventPayload =
  IHelpArticleViewEvent | IHelpSearchEvent | IHelpArticleFeedbackEvent | IHelpChatQueryEvent | IHelpChatFeedbackEvent;

import { IBaseEvent } from '../../../types/analytics';

export enum MarketingReportEvents {
  // Viewer events
  OPENED = 'Marketing Report Opened',
  SLIDE_CHANGED = 'Marketing Report Slide Changed',
  CLOSED = 'Marketing Report Closed',
  // Admin events
  CREATED = 'Marketing Report Created',
  EDITED = 'Marketing Report Edited',
  PUBLISHED = 'Marketing Report Published',
  UNPUBLISHED = 'Marketing Report Unpublished',
  DELETED = 'Marketing Report Deleted',
}

interface IMarketingReportOpenedEvent extends IBaseEvent {
  type: MarketingReportEvents.OPENED;
  metadata: {
    reportId: string;
    source: string;
  };
}

interface IMarketingReportSlideChangedEvent extends IBaseEvent {
  type: MarketingReportEvents.SLIDE_CHANGED;
  metadata: {
    reportId: string;
    slideIndex: number;
    durationMs: number;
  };
}

interface IMarketingReportClosedEvent extends IBaseEvent {
  type: MarketingReportEvents.CLOSED;
  metadata: {
    reportId: string;
    durationMs: number;
    slidesViewed: number;
  };
}

interface IMarketingReportCreatedEvent extends IBaseEvent {
  type: MarketingReportEvents.CREATED;
  metadata: {
    reportId: string;
    status: string;
    contentHash: string;
    viaApiKeyId?: string;
  };
}

interface IMarketingReportEditedEvent extends IBaseEvent {
  type: MarketingReportEvents.EDITED;
  metadata: {
    reportId: string;
    fieldsChanged: string[];
    contentHash?: string;
    viaApiKeyId?: string;
  };
}

interface IMarketingReportPublishedEvent extends IBaseEvent {
  type: MarketingReportEvents.PUBLISHED;
  metadata: {
    reportId: string;
    firstPublish: boolean;
  };
}

interface IMarketingReportUnpublishedEvent extends IBaseEvent {
  type: MarketingReportEvents.UNPUBLISHED;
  metadata: {
    reportId: string;
  };
}

interface IMarketingReportDeletedEvent extends IBaseEvent {
  type: MarketingReportEvents.DELETED;
  metadata: {
    reportId: string;
  };
}

export type MarketingReportEventPayload =
  | IMarketingReportOpenedEvent
  | IMarketingReportSlideChangedEvent
  | IMarketingReportClosedEvent
  | IMarketingReportCreatedEvent
  | IMarketingReportEditedEvent
  | IMarketingReportPublishedEvent
  | IMarketingReportUnpublishedEvent
  | IMarketingReportDeletedEvent;

import { IBaseEvent } from '../../../types';

// Modal related events
export enum ModalEvents {
  VIEW_MODAL = 'Modal Viewed',
  AGREE_MODAL = 'Modal Agreed To',
  VIEW_BANNER = 'Banner Viewed',
  WHATS_NEW_OPENED = "What's New Opened",
  WHATS_NEW_CLOSED = "What's New Closed",
  WHATS_NEW_SLIDE_CHANGED = "What's New Slide Changed",
  WHATS_NEW_PERFORMANCE = "What's New Performance",
  MODAL_MANAGER_PERFORMANCE = 'Modal Manager Performance',
  MODAL_MANAGER_AUTO_TRIGGER = 'Modal Manager Auto Trigger',
  MODAL_MANAGER_QUEUE_CHANGE = 'Modal Manager Queue Change',
}

interface ViewModalEvent extends IBaseEvent {
  type: ModalEvents.VIEW_MODAL;
  metadata: {
    /** ID of the modal that was viewed */
    id: string;
  };
}

interface AgreeModalEvent extends IBaseEvent {
  type: ModalEvents.AGREE_MODAL;
  metadata: {
    /** ID of the modal where agree action was taken */
    id: string;
  };
}

interface ViewBannerEvent extends IBaseEvent {
  type: ModalEvents.VIEW_BANNER;
  metadata: {
    /** ID of the banner that was viewed */
    id: string;
  };
}

interface WhatsNewOpenedEvent extends IBaseEvent {
  type: ModalEvents.WHATS_NEW_OPENED;
  metadata: {
    /** Source of modal opening: 'auto' or 'manual' */
    source: 'auto' | 'manual';
    /** Number of modals in the slider */
    modal_count: number;
    /** Render duration in milliseconds */
    render_duration: number;
    /** Timestamp when modal opened */
    timestamp: number;
  };
}

interface WhatsNewClosedEvent extends IBaseEvent {
  type: ModalEvents.WHATS_NEW_CLOSED;
  metadata: {
    /** Total duration modal was open in milliseconds */
    total_duration: number;
    /** Slide index user was on when closing */
    final_slide: number;
    /** Total number of slides */
    total_slides: number;
    /** Number of unique slides viewed */
    slides_viewed: number;
    /** Detailed slide view data */
    slide_view_data: Array<{
      slide: number;
      duration: number;
      modal_id?: string;
    }>;
    /** Timestamp when modal closed */
    timestamp: number;
  };
}

interface WhatsNewSlideChangedEvent extends IBaseEvent {
  type: ModalEvents.WHATS_NEW_SLIDE_CHANGED;
  metadata: {
    /** Previous slide index */
    from_slide: number;
    /** New slide index */
    to_slide: number;
    /** Duration on previous slide in milliseconds */
    duration_on_previous: number;
    /** Total number of slides */
    total_slides: number;
    /** ID of the current modal */
    modal_id?: string;
  };
}

interface WhatsNewPerformanceEvent extends IBaseEvent {
  type: ModalEvents.WHATS_NEW_PERFORMANCE;
  metadata: {
    /** Component name */
    component: string;
    /** Performance metric type */
    metric: 'presigned_url_load_time' | 'presigned_url_load_error';
    /** Duration of the operation in milliseconds */
    duration: number;
    /** Number of images being loaded */
    image_count: number;
  };
}

interface ModalManagerPerformanceEvent extends IBaseEvent {
  type: ModalEvents.MODAL_MANAGER_PERFORMANCE;
  metadata: {
    /** Performance metric type */
    metric: 'filter_duration';
    /** Duration of the operation in milliseconds */
    duration: number;
    /** Total number of modals being filtered */
    modal_count: number;
    /** Number of modals after filtering */
    filtered_count: number;
  };
}

interface ModalManagerAutoTriggerEvent extends IBaseEvent {
  type: ModalEvents.MODAL_MANAGER_AUTO_TRIGGER;
  metadata: {
    /** Number of What's New modals */
    whats_new_count: number;
    /** Number of regular modals */
    regular_modals_count: number;
    /** Total auto-trigger count */
    auto_trigger_count: number;
    /** Timestamp of auto-trigger */
    timestamp: number;
  };
}

interface ModalManagerQueueChangeEvent extends IBaseEvent {
  type: ModalEvents.MODAL_MANAGER_QUEUE_CHANGE;
  metadata: {
    /** Previous queue length */
    previous_length: number;
    /** New queue length */
    new_length: number;
    /** Change in queue length (positive or negative) */
    change: number;
    /** Timestamp of queue change */
    timestamp: number;
  };
}

export type ModalEventPayload =
  | ViewModalEvent
  | AgreeModalEvent
  | ViewBannerEvent
  | WhatsNewOpenedEvent
  | WhatsNewClosedEvent
  | WhatsNewSlideChangedEvent
  | WhatsNewPerformanceEvent
  | ModalManagerPerformanceEvent
  | ModalManagerAutoTriggerEvent
  | ModalManagerQueueChangeEvent;

import { IBaseEvent } from '../../../types';

export enum MiscEvents {
  DOWNLOAD_FAILED = 'Download Failed',
  ROLLED_DICE = 'Rolled Dice',
}

interface IRolledDiceEvent extends IBaseEvent {
  type: MiscEvents.ROLLED_DICE;
}

interface IDownloadFailedEvent extends IBaseEvent {
  type: MiscEvents.DOWNLOAD_FAILED;
}

export type MiscEventPayload = IRolledDiceEvent | IDownloadFailedEvent;

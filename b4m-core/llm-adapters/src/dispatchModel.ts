import type { ModelDispatchProfile, ModelInfo } from '@bike4mind/common';

/**
 * The catalog view of the model a backend was resolved for, as the request
 * builders read it.
 *
 * `complete()` takes a model id, not a record, so the record has to arrive some
 * other way: getLlmByModel hands it to the instance it just constructed, and
 * every read is keyed by the model actually being completed. A backend instance
 * reused for a different id therefore falls back to its own tables rather than
 * shaping one model's request from another model's profile.
 */
export class DispatchModel {
  private info?: ModelInfo;

  set(info: ModelInfo): void {
    this.info = info;
  }

  /** The record, only when it describes `model`. */
  for(model: string): ModelInfo | undefined {
    return this.info && String(this.info.id) === model ? this.info : undefined;
  }

  /**
   * The profile a builder must prefer over its hardcoded id tables. Undefined
   * means "no catalog opinion", which is the case that has to reproduce today's
   * behavior byte for byte.
   */
  profileFor(model: string): ModelDispatchProfile | undefined {
    return this.for(model)?.dispatchProfile;
  }
}

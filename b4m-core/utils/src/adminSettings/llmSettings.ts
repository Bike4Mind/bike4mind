/**
 * `isModelAccessible` is the single source of truth in `@bike4mind/common`
 * (`utils/modelHelpers`): pure, browser-safe, and unit-tested there. Re-exported
 * here so the historical `@bike4mind/utils` import path (server + services) keeps
 * working without change. The client `useAccessibleModels` hook imports it from
 * `@bike4mind/common` directly, so there is no longer a duplicated copy.
 */
export { isModelAccessible } from '@bike4mind/common';

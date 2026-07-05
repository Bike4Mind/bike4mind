/**
 * @bike4mind/core - re-export wrapper around @bike4mind/common.
 *
 * This is the leaf of the B4Mv3 dependency graph. All other extracted
 * @bike4mind/* packages depend on this package instead of importing
 * @bike4mind/common directly.
 */
export * from '@bike4mind/common';
export { dayjs } from '@bike4mind/common';

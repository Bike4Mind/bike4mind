// The static v1 segment outranks pages/api/[type]/[id], so v1 misses get the shared 404 envelope, not the invite 404.
export { default } from '../[...unmatchedApiPath]';

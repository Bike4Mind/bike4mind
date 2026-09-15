/**
 * @bike4mind/eslint-config
 *
 * Shared ESLint configurations for Bike4Mind monorepo
 *
 * Available configurations:
 * - base: Common JavaScript rules
 * - typescript: TypeScript-specific rules (extends base)
 * - next: Next.js-specific rules (extends typescript)
 */
module.exports = {
  configs: {
    base: require('./base'),
    typescript: require('./typescript'),
    next: require('./next'),
  },
};

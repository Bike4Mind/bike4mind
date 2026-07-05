/**
 * Base ESLint configuration
 * Common rules shared across all packages
 */
module.exports = {
  rules: {
    'dot-location': ['error', 'property'],
    'no-unused-vars': [
      'error',
      {
        ignoreRestSiblings: true,
        args: 'none',
      },
    ],
    'no-tabs': 'error',
    'no-trailing-spaces': 'error',
    'rest-spread-spacing': 'error',
    'prefer-const': 'error',
  },
};

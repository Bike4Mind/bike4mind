// Stands in for an add-on's contracts module, which loads as CommonJS under the
// generated list: `require` here resolves zod's CJS build, not the ESM one registry.ts extends.
const { z } = require('zod');

exports.contracts = [
  {
    method: 'get',
    path: '/api/v1/cjs-widgets',
    operationId: 'listCjsWidgets',
    summary: 'List CJS widgets',
    tags: ['Widgets'],
    auth: 'apiKeyOrJwt',
    scopes: ['ai:generate'],
    responses: { 200: { description: 'The widgets.', schema: z.object({ ids: z.array(z.string()) }) } },
  },
];

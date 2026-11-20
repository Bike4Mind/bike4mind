import { defineEndpoint } from '../defineEndpoint';
import { sessionGetContract } from './sessionGet.contract';

export const getSessionByIdContract = defineEndpoint({
  ...sessionGetContract,
  path: '/api/v1/sessions/{id}',
  operationId: 'getSessionById',
  description:
    'Reads a session you own or that was shared with you, including its name, attached knowledge files, ' +
    'tags, and retrieval settings. A missing, deleted, malformed, or inaccessible session is 404. ' +
    'An API key needs notebooks:read or notebooks:write.',
});

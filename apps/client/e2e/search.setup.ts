import { setupSpecUser } from './helpers/spec-setup';
import { apiCreateFile, apiCreateSession } from './helpers/api';

const TEST_RUN_ID = Date.now().toString().slice(-6);

setupSpecUser({
  key: 'search',
  authFile: 'search-user.json',
  afterCreate: async ({ request, accessToken }) => {
    // Create files with distinct names and types for search/filter tests
    await apiCreateFile(request, accessToken, {
      fileName: `E2E-SearchTest-Report-${TEST_RUN_ID}.pdf`,
      content: 'PDF report content for e2e search testing',
      mimeType: 'application/pdf',
    });

    await apiCreateFile(request, accessToken, {
      fileName: `E2E-SearchTest-Notes-${TEST_RUN_ID}.txt`,
      content: 'Text notes content for e2e search testing',
    });

    await apiCreateFile(request, accessToken, {
      fileName: `E2E-SearchTest-Data-${TEST_RUN_ID}.csv`,
      content: 'col1,col2\nval1,val2',
      mimeType: 'text/csv',
    });

    await apiCreateFile(request, accessToken, {
      fileName: `E2E-SearchTest-Code-${TEST_RUN_ID}.ts`,
      content: 'export const hello = "world";',
      mimeType: 'text/plain',
    });

    await apiCreateFile(request, accessToken, {
      fileName: `E2E-SearchUniqueFile-${TEST_RUN_ID}.txt`,
      content: 'Unique file for exact match search',
    });

    // Create sessions/notebooks with distinct names
    await apiCreateSession(request, accessToken, `E2E Search Notebook Alpha ${TEST_RUN_ID}`);
    await apiCreateSession(request, accessToken, `E2E Search Notebook Beta ${TEST_RUN_ID}`);
    await apiCreateSession(request, accessToken, `E2E Search Notebook Gamma ${TEST_RUN_ID}`);
  },
});

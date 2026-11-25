import { AdminToolService } from '@client/app/services/adminTools/AdminToolService';
import { ModalManagementToolServer } from './ModalManagementToolServer';
import { Logger } from '@bike4mind/observability';

const logger = new Logger({ metadata: { service: 'adminToolsServer' } });

let initialized = false;

/**
 * Initialize admin tools for server-side use (API routes)
 * Uses server implementations that directly access the database
 */
export function initializeServerAdminTools(): AdminToolService {
  if (initialized) {
    return AdminToolService.getInstance();
  }

  const service = AdminToolService.getInstance();

  // Register server-side Modal Management Tool
  const modalTool = new ModalManagementToolServer();
  service.register(modalTool);

  // Future server-side tools will be registered here
  // service.register(new CreditManagementToolServer());
  // service.register(new UserManagementToolServer());

  initialized = true;
  logger.info('Server admin tools initialized', { tools: Array.from(service.tools.keys()) });
  return service;
}

/**
 * Get the admin tool service instance (server-side)
 */
export function getServerAdminToolService(): AdminToolService {
  return AdminToolService.getInstance();
}

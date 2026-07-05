import { AdminToolService } from './AdminToolService';
import { ModalManagementToolClient } from './ModalManagementToolClient';

// Initialize and register admin tools (client-side)
let initialized = false;

/**
 * Initialize admin tools for client-side use
 * Uses client implementations that make HTTP calls
 */
export function initializeAdminTools(): AdminToolService {
  if (initialized) {
    return AdminToolService.getInstance();
  }

  const service = AdminToolService.getInstance();

  // Register client-side Modal Management Tool
  const modalTool = new ModalManagementToolClient();
  service.register(modalTool);

  // Future client-side tools will be registered here.

  initialized = true;
  console.log('[AdminTools] Client admin tools initialized with tools:', Array.from(service.tools.keys()));
  return service;
}

// Export service instance getter
export function getAdminToolService(): AdminToolService {
  return AdminToolService.getInstance();
}

// Export types and classes
export { AdminToolService } from './AdminToolService';
export { ModalManagementToolClient as ModalManagementTool } from './ModalManagementToolClient';
export type {
  AdminTool,
  AdminToolContext,
  AdminToolParams,
  AdminToolResult,
  AdminToolPreview,
  AdminToolAction,
  ModalGenerationParams,
  ModalGenerationResult,
} from '@bike4mind/common';

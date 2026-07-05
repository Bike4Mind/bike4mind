/**
 * Jupyter Kernel Constants and Validation
 *
 * Shared constants for Jupyter kernel validation used by both the CLI
 * (JupyterClient) and backend services (JupyterExecutionService).
 */

/**
 * Whitelist of allowed Jupyter kernel names.
 * Only these kernels can be used for notebook execution.
 */
export const ALLOWED_JUPYTER_KERNELS = [
  'python3',
  'python',
  'python2',
  'ir', // R kernel
  'julia-1.9',
  'julia-1.10',
  'julia',
] as const;

/**
 * Type for allowed Jupyter kernel names
 */
export type AllowedJupyterKernel = (typeof ALLOWED_JUPYTER_KERNELS)[number];

/**
 * Set for O(1) kernel validation lookup
 */
const ALLOWED_KERNELS_SET = new Set<string>(ALLOWED_JUPYTER_KERNELS);

/**
 * Check if a kernel name is in the allowed list
 */
export function isAllowedJupyterKernel(kernelName: string): kernelName is AllowedJupyterKernel {
  return ALLOWED_KERNELS_SET.has(kernelName);
}

/**
 * Get the list of allowed kernels as a comma-separated string (for error messages)
 */
export function getAllowedKernelsList(): string {
  return ALLOWED_JUPYTER_KERNELS.join(', ');
}

/**
 * Validation result for Jupyter inputs
 */
export interface JupyterValidationResult {
  valid: boolean;
  error?: string;
}

/**
 * Validate a Jupyter kernel name
 */
export function validateJupyterKernelName(kernelName: string): JupyterValidationResult {
  if (!kernelName || typeof kernelName !== 'string') {
    return { valid: false, error: 'Kernel name is required' };
  }

  if (!isAllowedJupyterKernel(kernelName)) {
    return {
      valid: false,
      error: `Invalid kernel: '${kernelName}'. Allowed kernels: ${getAllowedKernelsList()}`,
    };
  }

  return { valid: true };
}

/**
 * Validate a notebook path to prevent path traversal attacks.
 *
 * @param path - The notebook path to validate
 * @param requireIpynbExtension - If true, requires .ipynb extension (default: false for CLI, true for backend)
 */
export function validateNotebookPath(path: string, requireIpynbExtension = false): JupyterValidationResult {
  if (!path || typeof path !== 'string') {
    return { valid: false, error: 'Notebook path is required' };
  }

  // Check for path traversal patterns
  if (path.includes('..') || path.includes('//')) {
    return { valid: false, error: 'Invalid notebook path: path traversal not allowed' };
  }

  // eslint-disable-next-line no-control-regex -- Intentionally detecting malicious control characters
  if (/[\x00-\x1f]/.test(path)) {
    return { valid: false, error: 'Invalid notebook path: contains control characters' };
  }

  // Optional .ipynb extension check (backend requires it, CLI may not)
  if (requireIpynbExtension && !path.endsWith('.ipynb')) {
    return { valid: false, error: 'Invalid notebook path: must end with .ipynb' };
  }

  return { valid: true };
}

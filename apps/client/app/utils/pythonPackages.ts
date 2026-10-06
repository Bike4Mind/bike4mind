/**
 * Pure helpers for Python artifacts, shared by the Pyodide manager and the artifact preview card.
 * Kept free of the manager so the preview card does not pull in the sandbox transport.
 *
 * Detection here only drives the package chips and the worker's micropip backstop. The worker
 * resolves what to load from the code itself via `pyodide.loadPackagesFromImports`, so a miss
 * here no longer means a package is never loaded.
 */

/** Distribution names advertised as supported (see `getSupportedPackages`). */
export const SUPPORTED_PYTHON_PACKAGES = ['numpy', 'pandas', 'matplotlib', 'scipy', 'scikit-learn'];

// Import names, which is what detection returns: `import sklearn`, not `scikit-learn`.
const DETECTABLE_IMPORTS = new Set(['numpy', 'pandas', 'matplotlib', 'scipy', 'sklearn']);

const IMPORT_LINE = /^[ \t]*import[ \t]+([^#\n;]+)/gm;
const FROM_IMPORT_LINE = /^[ \t]*from[ \t]+([\w.]+)[ \t]+import\b/gm;

const topLevelModule = (dotted: string): string => dotted.split('.')[0];

/**
 * Supported packages referenced by import statements, deduplicated, as top-level import names.
 * Handles `import a.b`, `import a, b as c`, and `from a.b import c`; relative imports are ignored.
 */
export function detectPythonPackages(code: string): string[] {
  const found = new Set<string>();

  for (const match of code.matchAll(IMPORT_LINE)) {
    for (const clause of match[1].split(',')) {
      const name = topLevelModule(clause.trim().split(/\s+/)[0] ?? '');
      if (DETECTABLE_IMPORTS.has(name)) found.add(name);
    }
  }

  for (const match of code.matchAll(FROM_IMPORT_LINE)) {
    const name = topLevelModule(match[1]);
    if (DETECTABLE_IMPORTS.has(name)) found.add(name);
  }

  return Array.from(found);
}

const MILP_HINT = 'Use scipy.optimize.milp (HiGHS-backed) or scipy.optimize.linprog instead.';

// Packages models commonly reach for that the browser runtime cannot provide.
const UNAVAILABLE_HINTS: Record<string, string> = {
  highspy: 'Use scipy.optimize.milp (HiGHS-backed) instead.',
  gurobipy: MILP_HINT,
  cplex: MILP_HINT,
  docplex: MILP_HINT,
  pulp: MILP_HINT,
  pyomo: MILP_HINT,
  ortools: MILP_HINT,
  cvxpy: MILP_HINT,
  seaborn: 'Plot with matplotlib directly instead.',
};

const GENERIC_UNAVAILABLE_HINT =
  'Only packages bundled with Pyodide can be loaded here; packages from PyPI and native extensions cannot be installed.';

// Top-level import names the runtime bundles. Used only to tell "this submodule does not exist
// in the version we ship" (e.g. `sklearn.externals`, removed upstream) apart from "this top-level
// package is not available at all" (e.g. `highspy`) - both raise the same ModuleNotFoundError shape.
const KNOWN_BUNDLED_MODULES = new Set([
  'numpy',
  'pandas',
  'matplotlib',
  'scipy',
  'sklearn',
  'statsmodels',
  'sympy',
  'networkx',
  'micropip',
]);

/**
 * Prefix a Python import failure with a plain-language explanation. The original traceback is
 * kept underneath; any other error is returned unchanged.
 */
export function describePythonImportError(error: string): string {
  const notLoaded = /The module '([\w.]+)' is included in the Pyodide distribution, but it is not installed/.exec(
    error
  );
  if (notLoaded) {
    const name = topLevelModule(notLoaded[1]);
    return (
      `\`${name}\` is part of the browser Python runtime but was not loaded. Check your network ` +
      `connection and run again; if the module is imported dynamically (importlib or __import__), ` +
      `add a plain \`import ${name}\` at the top.\n\n${error}`
    );
  }

  const missing = /ModuleNotFoundError: No module named '([\w.]+)'/.exec(error);
  if (missing) {
    const fullName = missing[1];
    const name = topLevelModule(fullName);

    // A dotted miss on a package we do bundle is a missing submodule, not a missing package -
    // e.g. `sklearn.externals` (removed upstream) still leaves `sklearn` itself available.
    if (fullName !== name && KNOWN_BUNDLED_MODULES.has(name)) {
      return (
        `\`${fullName}\` does not exist in the version of \`${name}\` bundled with the browser ` +
        `Python runtime.\n\n${error}`
      );
    }

    const hint = UNAVAILABLE_HINTS[name] ?? GENERIC_UNAVAILABLE_HINT;
    return `\`${name}\` is not available in the browser Python runtime. ${hint}\n\n${error}`;
  }

  return error;
}

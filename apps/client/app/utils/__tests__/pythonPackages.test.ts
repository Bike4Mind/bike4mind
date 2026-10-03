import { describe, it, expect } from 'vitest';
import { describePythonImportError, detectPythonPackages } from '../pythonPackages';

describe('detectPythonPackages', () => {
  it('detects scipy from a dotted from-import', () => {
    expect(detectPythonPackages('from scipy.optimize import milp, LinearConstraint, Bounds')).toEqual(['scipy']);
  });

  it('detects the top-level module of a dotted import', () => {
    expect(detectPythonPackages('import matplotlib.pyplot as plt')).toEqual(['matplotlib']);
  });

  it('deduplicates across import styles', () => {
    expect(detectPythonPackages('import numpy\nimport numpy as np\nfrom numpy.linalg import inv')).toEqual(['numpy']);
  });

  it('ignores unsupported and commented-out imports', () => {
    expect(detectPythonPackages('import highspy\n# import pandas\nimport os, sys')).toEqual([]);
  });
});

describe('describePythonImportError', () => {
  it('suggests scipy.optimize.milp for highspy', () => {
    const error = "ModuleNotFoundError: No module named 'highspy'";
    expect(describePythonImportError(error)).toBe(
      `\`highspy\` is not available in the browser Python runtime. Use scipy.optimize.milp (HiGHS-backed) instead.\n\n${error}`
    );
  });

  it('names the top-level package for a dotted module and gives a MILP hint for solvers', () => {
    const message = describePythonImportError("ModuleNotFoundError: No module named 'gurobipy.gurobipy'");
    expect(message).toMatch(/^`gurobipy` is not available/);
    expect(message).toContain('scipy.optimize.milp');
  });

  it('gives a generic explanation for an unknown package', () => {
    const message = describePythonImportError("ModuleNotFoundError: No module named 'somepkg'");
    expect(message).toMatch(/^`somepkg` is not available in the browser Python runtime\. Only packages bundled/);
  });

  it('reports a bundled package that failed to load', () => {
    const error =
      "ModuleNotFoundError: The module 'scipy' is included in the Pyodide distribution, but it is not installed.";
    expect(describePythonImportError(error)).toMatch(
      /^`scipy` is part of the browser Python runtime but failed to load/
    );
  });

  it('leaves other errors untouched', () => {
    const error = 'ZeroDivisionError: division by zero';
    expect(describePythonImportError(error)).toBe(error);
  });
});

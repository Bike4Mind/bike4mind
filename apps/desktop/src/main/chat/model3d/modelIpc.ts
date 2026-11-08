import { realpath, stat, writeFile } from 'node:fs/promises';
import { basename, dirname, join, resolve } from 'node:path';
import { BrowserWindow, dialog, ipcMain, type IpcMainInvokeEvent } from 'electron';
import { IPC_CHANNELS } from '@shared/ipc';
import { type ModelBuildReport, siblingGlbPath } from '@shared/model3d';
import { stampModelPaneGlb } from './glbMarker';
import type { ModelLiveView } from './ModelLiveView';

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

async function sameLocation(a: string, b: string): Promise<boolean> {
  if (basename(a) !== basename(b)) return false;
  const [first, second] = await Promise.all([
    realpath(dirname(a)).catch(() => null),
    realpath(dirname(b)).catch(() => null),
  ]);
  return first !== null && first === second;
}

async function isSameFile(a: string, b: string): Promise<boolean> {
  const [first, second] = await Promise.all([stat(a).catch(() => null), stat(b).catch(() => null)]);
  return first !== null && second !== null && first.dev === second.dev && first.ino === second.ino;
}

/**
 * Writes an export to `target`. A GLB exported onto the open model's own sibling carries the pane's
 * marker, so the next build may replace it (ModelLiveView refuses unmarked siblings); exported
 * anywhere else it stays an ordinary user asset. The sibling is matched by file identity, so another
 * spelling of it (case on a case-insensitive disk, a symlinked folder) is still the sibling.
 */
export async function writeExport(
  format: 'glb' | 'stl',
  bytes: Uint8Array,
  target: string,
  modelPath: string | null
): Promise<void> {
  const sibling = format === 'glb' && modelPath ? siblingGlbPath(modelPath) : null;
  const isSibling = async () =>
    sibling !== null &&
    (resolve(target) === resolve(sibling) ||
      (await sameLocation(target, sibling)) ||
      (await isSameFile(target, sibling)));
  if (await isSibling()) {
    await writeFile(target, stampModelPaneGlb(bytes));
    return;
  }
  await writeFile(target, bytes);
  // A target that did not exist yet has no identity to compare until it is written.
  if (await isSibling()) await writeFile(target, stampModelPaneGlb(bytes));
}

/** Only the fields main acts on; anything else the renderer sends is dropped. */
export function parseBuildReport(value: unknown): ModelBuildReport | null {
  if (!isRecord(value) || typeof value.generation !== 'number' || typeof value.ok !== 'boolean') return null;
  const report: ModelBuildReport = { generation: value.generation, ok: value.ok };
  if (typeof value.error === 'string') report.error = value.error.slice(0, 4000);
  if (typeof value.glbError === 'string') report.glbError = value.glbError.slice(0, 4000);
  if (typeof value.line === 'number') report.line = value.line;
  const summary = value.summary;
  if (
    isRecord(summary) &&
    Array.isArray(summary.parts) &&
    Array.isArray(summary.size) &&
    summary.size.length === 3 &&
    typeof summary.units === 'string' &&
    typeof summary.triangles === 'number' &&
    isRecord(summary.params)
  ) {
    const params: Record<string, number> = {};
    for (const [key, raw] of Object.entries(summary.params)) if (typeof raw === 'number') params[key] = raw;
    report.summary = {
      parts: summary.parts.filter((part): part is string => typeof part === 'string'),
      size: [Number(summary.size[0]), Number(summary.size[1]), Number(summary.size[2])],
      units: summary.units,
      triangles: summary.triangles,
      params,
    };
    if (Array.isArray(summary.joints)) {
      const joints = summary.joints.filter((joint): joint is string => typeof joint === 'string');
      if (joints.length) report.summary.joints = joints;
    }
  }
  return report;
}

function windowOf(event: IpcMainInvokeEvent): BrowserWindow | null {
  return BrowserWindow.fromWebContents(event.sender);
}

/**
 * Renderer -> main handlers for the model pane. Every write lands where ModelLiveView allows
 * (the open model's sibling GLB, its params) or where the user chose in a save dialog.
 */
export function modelIpcHandlers(view: ModelLiveView): void {
  ipcMain.handle(IPC_CHANNELS.modelGetState, () => view.current());
  ipcMain.handle(IPC_CHANNELS.modelClose, () => view.close());
  ipcMain.handle(IPC_CHANNELS.modelReadAsset, () => view.readAsset());

  ipcMain.handle(IPC_CHANNELS.modelOpenDialog, async event => {
    const window = windowOf(event);
    const options: Electron.OpenDialogOptions = {
      title: 'Open a 3D model',
      properties: ['openFile'],
      filters: [{ name: '3D models', extensions: ['glb', 'stl', 'js'] }],
    };
    const picked = await (window ? dialog.showOpenDialog(window, options) : dialog.showOpenDialog(options));
    const path = picked.canceled ? undefined : picked.filePaths[0];
    return path ? view.open(path) : null;
  });

  ipcMain.handle(IPC_CHANNELS.modelBuildReport, (event, value: unknown) => {
    const report = parseBuildReport(value);
    if (report) view.reportBuild(report, event.sender.id);
  });

  ipcMain.handle(IPC_CHANNELS.modelWriteGlb, (_event, value: unknown) => {
    if (!isRecord(value) || typeof value.generation !== 'number' || !(value.bytes instanceof Uint8Array)) return null;
    return view.writeGlb(value.generation, value.bytes);
  });

  ipcMain.handle(IPC_CHANNELS.modelSetParam, (_event, value: unknown) => {
    if (!isRecord(value) || typeof value.key !== 'string' || typeof value.value !== 'number') return false;
    return view.setParam(value.key, value.value);
  });

  ipcMain.handle(IPC_CHANNELS.modelSaveExport, async (event, value: unknown) => {
    if (
      !isRecord(value) ||
      (value.format !== 'glb' && value.format !== 'stl') ||
      !(value.bytes instanceof Uint8Array)
    ) {
      return null;
    }
    const format = value.format;
    const current = view.current().path;
    const stem = current ? basename(current).replace(/\.(model\.js|glb|stl)$/i, '') : 'model';
    const window = windowOf(event);
    const options: Electron.SaveDialogOptions = {
      title: `Export ${format.toUpperCase()}`,
      // Beside the model, where a game project keeps its assets, not wherever the last dialog was.
      defaultPath: current ? join(dirname(current), `${stem}.${format}`) : `${stem}.${format}`,
      filters: [{ name: format.toUpperCase(), extensions: [format] }],
    };
    const picked = await (window ? dialog.showSaveDialog(window, options) : dialog.showSaveDialog(options));
    if (picked.canceled || !picked.filePath) return null;
    await writeExport(format, value.bytes, picked.filePath, current);
    return picked.filePath;
  });

  ipcMain.on(IPC_CHANNELS.modelCaptureResult, (_event, value: unknown) => {
    if (!isRecord(value) || typeof value.id !== 'string') return;
    view.resolveCapture(value.id, {
      bytes: value.bytes instanceof Uint8Array ? value.bytes : undefined,
      error: typeof value.error === 'string' ? value.error : undefined,
    });
  });
}

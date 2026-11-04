import { writeFile } from 'node:fs/promises';
import { basename, dirname, join } from 'node:path';
import { BrowserWindow, dialog, ipcMain, type IpcMainInvokeEvent } from 'electron';
import { IPC_CHANNELS } from '@shared/ipc';
import type { ModelBuildReport } from '@shared/model3d';
import type { ModelLiveView } from './ModelLiveView';

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

/** Only the fields main acts on; anything else the renderer sends is dropped. */
export function parseBuildReport(value: unknown): ModelBuildReport | null {
  if (!isRecord(value) || typeof value.generation !== 'number' || typeof value.ok !== 'boolean') return null;
  const report: ModelBuildReport = { generation: value.generation, ok: value.ok };
  if (typeof value.error === 'string') report.error = value.error.slice(0, 4000);
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
      filters: [{ name: '3D models', extensions: ['glb', 'gltf', 'stl', 'js'] }],
    };
    const picked = await (window ? dialog.showOpenDialog(window, options) : dialog.showOpenDialog(options));
    const path = picked.canceled ? undefined : picked.filePaths[0];
    return path ? view.open(path) : null;
  });

  ipcMain.handle(IPC_CHANNELS.modelBuildReport, (_event, value: unknown) => {
    const report = parseBuildReport(value);
    if (report) view.reportBuild(report);
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
    const stem = current ? basename(current).replace(/\.(model\.js|glb|gltf|stl)$/i, '') : 'model';
    const window = windowOf(event);
    const options: Electron.SaveDialogOptions = {
      title: `Export ${format.toUpperCase()}`,
      // Beside the model, where a game project keeps its assets, not wherever the last dialog was.
      defaultPath: current ? join(dirname(current), `${stem}.${format}`) : `${stem}.${format}`,
      filters: [{ name: format.toUpperCase(), extensions: [format] }],
    };
    const picked = await (window ? dialog.showSaveDialog(window, options) : dialog.showSaveDialog(options));
    if (picked.canceled || !picked.filePath) return null;
    await writeFile(picked.filePath, value.bytes);
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

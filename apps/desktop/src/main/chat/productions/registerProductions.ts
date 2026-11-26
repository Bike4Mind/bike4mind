import type { IpcMain } from 'electron';
import { IPC_CHANNELS } from '@shared/ipc';
import {
  productionFileRefSchema,
  productionRefSchema,
  productionRenameSchema,
  productionRenderRequestSchema,
  productionReorderSchema,
  productionsListRequestSchema,
} from '@shared/productions';
import type { AuthService } from '../../auth/AuthService';
import type { SessionStore } from '../SessionStore';
import type { MediaStore } from '../media/MediaStore';
import { MediaApiClient } from '../media/MediaApiClient';
import { ProductionsClient } from './ProductionsClient';
import { ProductionsService } from './ProductionsService';

/** The Studio place's Productions tab IPC. Every request is parsed before it reaches the service. */
export function registerProductions(deps: {
  ipc: IpcMain;
  sessions: SessionStore;
  media: MediaStore;
  auth: AuthService;
}): ProductionsService {
  const { sessions, auth, ipc } = deps;
  const service = new ProductionsService({
    connection: () => {
      const scope = sessions.scopeKey();
      const api = auth.getSessionBoundApiClient();
      return scope && api ? { scope, productions: new ProductionsClient(api), files: new MediaApiClient(api) } : null;
    },
    media: deps.media,
  });
  ipc.handle(IPC_CHANNELS.productionsList, (_event, raw: unknown) =>
    service.list(productionsListRequestSchema.parse(raw))
  );
  ipc.handle(IPC_CHANNELS.productionsGet, (_event, raw: unknown) => service.get(productionRefSchema.parse(raw)));
  ipc.handle(IPC_CHANNELS.productionsRename, (_event, raw: unknown) =>
    service.rename(productionRenameSchema.parse(raw))
  );
  ipc.handle(IPC_CHANNELS.productionsReorder, (_event, raw: unknown) =>
    service.reorder(productionReorderSchema.parse(raw))
  );
  ipc.handle(IPC_CHANNELS.productionsRenders, (_event, raw: unknown) =>
    service.renders(productionRefSchema.parse(raw))
  );
  ipc.handle(IPC_CHANNELS.productionsRender, (_event, raw: unknown) =>
    service.render(productionRenderRequestSchema.parse(raw))
  );
  ipc.handle(IPC_CHANNELS.productionsMedia, (_event, raw: unknown) =>
    service.media(productionFileRefSchema.parse(raw))
  );
  return service;
}

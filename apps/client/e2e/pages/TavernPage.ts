import { expect } from '@playwright/test';
import { BasePage } from './BasePage';
import { TIMEOUTS } from '../constants';

/**
 * TavernPage - Page Object for the tavern tile engine.
 *
 * Canvas pixels aren't DOM-testable, so store-based methods use
 * page.evaluate() against window.__e2e_tavern (exposed in dev mode).
 *
 * IMPORTANT: page.evaluate callbacks run in browser context and cannot
 * reference Node.js scope. Access the bridge via (window as any).__e2e_tavern
 * directly inside each evaluate call - never via a Node.js helper function.
 */
/* eslint-disable @typescript-eslint/no-explicit-any */
export class TavernPage extends BasePage {
  // ---------------------------------------------------------------------------
  // Navigation & Loading
  // ---------------------------------------------------------------------------

  /**
   * Turns on the tavern's dev tools (FPS readout, debug overlays) for every later
   * navigation in this page. Call before gotoTavern(): the flag is read once, when
   * the tavern bundle loads. The storage key must stay in sync with the tavern
   * overlay's dev-tools flag.
   */
  async enableDevTools() {
    await this.page.addInitScript(() => {
      try {
        localStorage.setItem('tavern-dev-tools', '1');
      } catch {
        // Storage blocked; the dev drawer assertions will fail with a clear locator error.
      }
    });
  }

  async gotoTavern() {
    await this.page.goto('/hud?tab=tavern');
    await this.page.waitForLoadState('domcontentloaded');
    await this.dismissModals();
    await expect(this.page.getByTestId('tavern-actionbar')).toBeVisible({
      timeout: TIMEOUTS.ACTION,
    });
  }

  async waitForSceneReady(timeout = TIMEOUTS.ACTION) {
    await expect
      .poll(
        () =>
          this.page.evaluate(() => {
            const t = (window as any).__e2e_tavern ?? null;
            return t ? t.tileMapStore.getState().loaded : false;
          }),
        { timeout, message: 'Tile map did not load' }
      )
      .toBeTruthy();
  }

  async waitForEntities(minCount = 1, timeout = TIMEOUTS.ACTION) {
    await expect
      .poll(
        () =>
          this.page.evaluate(() => {
            const t = (window as any).__e2e_tavern ?? null;
            return t ? t.sceneStore.getState().entityCount : 0;
          }),
        { timeout, message: `Expected at least ${minCount} entities` }
      )
      .toBeGreaterThanOrEqual(minCount);
  }

  // ---------------------------------------------------------------------------
  // Store Reads
  // ---------------------------------------------------------------------------

  async isTileMapLoaded(): Promise<boolean> {
    return this.page.evaluate(() => {
      const t = (window as any).__e2e_tavern ?? null;
      return t ? t.tileMapStore.getState().loaded : false;
    });
  }

  async getEntityIds(): Promise<string[]> {
    return this.page.evaluate(() => {
      const t = (window as any).__e2e_tavern ?? null;
      return t ? Object.keys(t.sceneStore.getState().entities) : [];
    });
  }

  async getEntityPosition(id: string): Promise<{ x: number; y: number } | null> {
    return this.page.evaluate(eid => {
      const t = (window as any).__e2e_tavern ?? null;
      if (!t) return null;
      const entity = t.sceneStore.getState().entities[eid];
      return entity ? { x: entity.position.x, y: entity.position.y } : null;
    }, id);
  }

  async isEntityIdle(id: string): Promise<boolean> {
    return this.page.evaluate(eid => {
      const t = (window as any).__e2e_tavern ?? null;
      if (!t) return true;
      const entity = t.sceneStore.getState().entities[eid];
      return entity ? !entity.activeTween : true;
    }, id);
  }

  async isTileBlocked(col: number, row: number): Promise<boolean> {
    return this.page.evaluate(
      ({ c, r }) => {
        const t = (window as any).__e2e_tavern ?? null;
        if (!t) return true;
        t.collisionMap.ensureCollisionMap();
        return t.collisionMap.isBlocked(c, r);
      },
      { c: col, r: row }
    );
  }

  async getCollisionVersion(): Promise<number> {
    return this.page.evaluate(() => {
      const t = (window as any).__e2e_tavern ?? null;
      return t ? t.collisionMap.getCollisionVersion() : -1;
    });
  }

  async findWallTile(): Promise<{ col: number; row: number } | null> {
    return this.page.evaluate(() => {
      const t = (window as any).__e2e_tavern ?? null;
      if (!t) return null;
      const walls = t.tileMapStore.getState().layers.walls;
      for (const key of walls.keys()) {
        const comma = key.indexOf(',');
        return { col: Number(key.slice(0, comma)), row: Number(key.slice(comma + 1)) };
      }
      return null;
    });
  }

  async findWalkableTileNear(
    centerCol: number,
    centerRow: number,
    maxRadius = 10
  ): Promise<{ col: number; row: number } | null> {
    return this.page.evaluate(
      ({ cx, cy, mr }) => {
        const t = (window as any).__e2e_tavern ?? null;
        if (!t) return null;
        t.collisionMap.ensureCollisionMap();
        for (let r = 1; r <= mr; r++) {
          for (let dy = -r; dy <= r; dy++) {
            for (let dx = -r; dx <= r; dx++) {
              if (Math.abs(dx) !== r && Math.abs(dy) !== r) continue;
              const c = cx + dx;
              const rr = cy + dy;
              if (!t.collisionMap.isBlocked(c, rr)) return { col: c, row: rr };
            }
          }
        }
        return null;
      },
      { cx: centerCol, cy: centerRow, mr: maxRadius }
    );
  }

  /**
   * Finds a walkable start tile and a target 5-8 tiles away that is reachable from
   * it, by BFS over the active floor's collision grid. The default map's bounds and
   * layout change over time, so hard-coded coordinates can land on a blocked or
   * out-of-bounds tile, where walkTo() refuses to start.
   */
  async findWalkPair(): Promise<{
    start: { col: number; row: number };
    target: { col: number; row: number };
  } | null> {
    return this.page.evaluate(() => {
      const t = (window as any).__e2e_tavern ?? null;
      if (!t) return null;
      t.collisionMap.ensureCollisionMap();
      const { minCol, minRow, width, height } = t.collisionMap.getCollisionGrid();
      if (!width || !height) return null;
      const walkable = (c: number, r: number) =>
        c >= 0 && c < width && r >= 0 && r < height && !t.collisionMap.isBlocked(c + minCol, r + minRow);

      // Try starts in rings around the grid center so the walk stays in the main area.
      const cx = Math.floor(width / 2);
      const cy = Math.floor(height / 2);
      const maxRadius = Math.max(width, height);
      let starts = 0;
      for (let radius = 0; radius <= maxRadius && starts < 50; radius++) {
        for (let dy = -radius; dy <= radius && starts < 50; dy++) {
          for (let dx = -radius; dx <= radius && starts < 50; dx++) {
            if (Math.max(Math.abs(dx), Math.abs(dy)) !== radius) continue;
            const sc = cx + dx;
            const sr = cy + dy;
            if (!walkable(sc, sr)) continue;
            starts++;

            // 4-neighbour BFS: any 4-connected route is also valid for the 8-way pathfinder.
            const seen = new Uint8Array(width * height);
            seen[sr * width + sc] = 1;
            const queue: number[] = [sr * width + sc];
            for (let i = 0; i < queue.length && i < 5000; i++) {
              const c = queue[i] % width;
              const r = Math.floor(queue[i] / width);
              const dist = Math.max(Math.abs(c - sc), Math.abs(r - sr));
              if (dist >= 5 && dist <= 8) {
                return {
                  start: { col: sc + minCol, row: sr + minRow },
                  target: { col: c + minCol, row: r + minRow },
                };
              }
              for (const [nc, nr] of [
                [c + 1, r],
                [c - 1, r],
                [c, r + 1],
                [c, r - 1],
              ]) {
                if (walkable(nc, nr) && !seen[nr * width + nc]) {
                  seen[nr * width + nc] = 1;
                  queue.push(nr * width + nc);
                }
              }
            }
          }
        }
      }
      return null;
    });
  }

  // ---------------------------------------------------------------------------
  // Store Commands
  // ---------------------------------------------------------------------------

  /** Returns walkTo()'s result: false when no walk started (no path, blocked start, other floor). */
  async walkEntityTo(id: string, x: number, y: number, speed = 2): Promise<boolean> {
    return this.page.evaluate(
      ({ eid, tx, ty, sp }) => {
        const t = (window as any).__e2e_tavern ?? null;
        return t ? t.sceneStore.getState().walkTo(eid, { x: tx, y: ty }, { speed: sp }) === true : false;
      },
      { eid: id, tx: x, ty: y, sp: speed }
    );
  }

  async waitForEntityIdle(id: string, timeout = TIMEOUTS.ACTION) {
    await expect
      .poll(
        () =>
          this.page.evaluate(eid => {
            const t = (window as any).__e2e_tavern ?? null;
            if (!t) return true;
            const entity = t.sceneStore.getState().entities[eid];
            return entity ? !entity.activeTween : true;
          }, id),
        { timeout, message: `Entity "${id}" did not become idle` }
      )
      .toBeTruthy();
  }

  // ---------------------------------------------------------------------------
  // DOM Interactions
  // ---------------------------------------------------------------------------

  async spawnTestEntity(
    id = 'e2e-test-entity',
    spriteSheetId = 'host',
    position: { x: number; y: number } = { x: 5, y: 3 }
  ) {
    await this.page.evaluate(
      ({ eid, sheetId, pos }) => {
        const t = (window as any).__e2e_tavern ?? null;
        if (t)
          t.sceneStore.getState().addEntity({
            id: eid,
            spriteSheetId: sheetId,
            position: pos,
            facing: 'right',
            visible: true,
          });
      },
      { eid: id, sheetId: spriteSheetId, pos: position }
    );
  }

  /** Requires enableDevTools() before gotoTavern(); the button is hidden otherwise. */
  async openDevDrawer() {
    await this.page.getByTestId('tavern-actionbar-dev').click();
    await expect(this.page.getByTestId('tavern-dev-drawer')).toBeVisible({
      timeout: TIMEOUTS.VISIBLE,
    });
  }

  async closeDevDrawer() {
    await this.page.getByTestId('tavern-dev-drawer-close').click();
    await expect(this.page.getByTestId('tavern-dev-drawer')).toBeHidden({
      timeout: TIMEOUTS.ELEMENT_STATE,
    });
  }

  async setDebugOverlay(configKey: 'showCollisionOverlay' | 'showPathOverlay', enabled: boolean) {
    const toggle = this.page.getByTestId(`tavern-dev-${configKey}-toggle`);
    // The test id sits on the Joy Switch root; the checked state lives on its input.
    const input = toggle.locator('input');
    if ((await input.isChecked()) !== enabled) await toggle.click();
    await expect(input).toBeChecked({ checked: enabled, timeout: TIMEOUTS.ELEMENT_STATE });
  }

  async getDebugOverlay(configKey: 'showCollisionOverlay' | 'showPathOverlay'): Promise<boolean | null> {
    return this.page.evaluate(key => {
      const t = (window as any).__e2e_tavern ?? null;
      return t ? Boolean(t.configStore.getState()[key]) : null;
    }, configKey);
  }
}

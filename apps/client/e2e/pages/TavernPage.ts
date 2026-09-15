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

  // ---------------------------------------------------------------------------
  // Store Commands
  // ---------------------------------------------------------------------------

  async walkEntityTo(id: string, x: number, y: number, speed = 2) {
    await this.page.evaluate(
      ({ eid, tx, ty, sp }) => {
        const t = (window as any).__e2e_tavern ?? null;
        if (t) t.sceneStore.getState().walkTo(eid, { x: tx, y: ty }, { speed: sp });
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

  async spawnTestEntity(id = 'e2e-test-entity', spriteSheetId = 'host') {
    await this.page.evaluate(
      ({ eid, sheetId }) => {
        const t = (window as any).__e2e_tavern ?? null;
        if (t)
          t.sceneStore.getState().addEntity({
            id: eid,
            spriteSheetId: sheetId,
            position: { x: 5, y: 3 },
            facing: 'right',
            visible: true,
          });
      },
      { eid: id, sheetId: spriteSheetId }
    );
  }

  async openConfigPanel() {
    await this.page.getByTestId('tavern-actionbar-config').click();
    await expect(this.page.getByTestId('tavern-config-close-btn')).toBeVisible({
      timeout: TIMEOUTS.VISIBLE,
    });
  }

  async closeConfigPanel() {
    await this.page.getByTestId('tavern-config-close-btn').click();
  }

  async toggleCollisionOverlay(enabled: boolean) {
    const toggle = this.page.getByTestId('tavern-config-showCollisionOverlay-toggle');
    const ariaChecked = await toggle.getAttribute('aria-checked');
    if ((ariaChecked === 'true') !== enabled) await toggle.click();
  }

  async togglePathOverlay(enabled: boolean) {
    const toggle = this.page.getByTestId('tavern-config-showPathOverlay-toggle');
    const ariaChecked = await toggle.getAttribute('aria-checked');
    if ((ariaChecked === 'true') !== enabled) await toggle.click();
  }
}

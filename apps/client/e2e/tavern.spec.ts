import { test, expect } from './fixtures';
import { TIMEOUTS } from './constants';

test.describe('Tavern - Scene, Collision & Pathfinding', () => {
  test('scene loads and initializes correctly', async ({ tavernPage }) => {
    await test.step('navigate to tavern', async () => {
      await tavernPage.gotoTavern();
    });

    await test.step('verify tile map loaded', async () => {
      await tavernPage.waitForSceneReady();
      const loaded = await tavernPage.isTileMapLoaded();
      expect(loaded).toBe(true);
    });

    await test.step('verify collision map built', async () => {
      const version = await tavernPage.getCollisionVersion();
      expect(version).toBeGreaterThanOrEqual(0);
    });

    await test.step('verify entities exist in scene', async () => {
      await tavernPage.spawnTestEntity();
      await tavernPage.waitForEntities(1);
      const ids = await tavernPage.getEntityIds();
      expect(ids.length).toBeGreaterThanOrEqual(1);
    });

    await test.step('verify FPS counter visible', async () => {
      await expect(tavernPage.page.getByTestId('tavern-actionbar-fps')).toBeVisible({
        timeout: TIMEOUTS.ELEMENT_STATE,
      });
    });
  });

  test('collision map correctly blocks walls and allows ground', async ({ tavernPage }) => {
    await tavernPage.gotoTavern();
    await tavernPage.waitForSceneReady();

    await test.step('wall tile is blocked', async () => {
      const wallTile = await tavernPage.findWallTile();
      expect(wallTile).not.toBeNull();
      const blocked = await tavernPage.isTileBlocked(wallTile!.col, wallTile!.row);
      expect(blocked).toBe(true);
    });

    await test.step('walkable tile is not blocked', async () => {
      // Find a walkable tile near center of map
      const walkable = await tavernPage.findWalkableTileNear(48, 48);
      expect(walkable).not.toBeNull();
      const blocked = await tavernPage.isTileBlocked(walkable!.col, walkable!.row);
      expect(blocked).toBe(false);
    });

    await test.step('out-of-bounds is blocked', async () => {
      const oob = await tavernPage.isTileBlocked(-1, -1);
      expect(oob).toBe(true);
    });
  });

  test('entity navigates via pathfinding', async ({ tavernPage }) => {
    test.slow(); // Doubles timeout — scene load + walk + idle wait

    await tavernPage.gotoTavern();
    await tavernPage.waitForSceneReady();
    await tavernPage.spawnTestEntity();
    await tavernPage.waitForEntities(1);

    await test.step('get entity and find walkable target', async () => {
      const ids = await tavernPage.getEntityIds();
      const entityId = ids[0];
      const pos = await tavernPage.getEntityPosition(entityId);
      expect(pos).not.toBeNull();

      // Find a walkable target ~5-8 tiles away
      const target = await tavernPage.findWalkableTileNear(Math.round(pos!.x) + 5, Math.round(pos!.y) + 5);
      expect(target).not.toBeNull();

      await test.step('walk entity to target', async () => {
        await tavernPage.walkEntityTo(entityId, target!.col, target!.row, 3);
      });

      await test.step('wait for entity to arrive', async () => {
        await tavernPage.waitForEntityIdle(entityId, TIMEOUTS.ACTION);
      });

      await test.step('verify entity arrived near target', async () => {
        const finalPos = await tavernPage.getEntityPosition(entityId);
        expect(finalPos).not.toBeNull();
        // Allow 2-tile tolerance (closestReachable may be used if exact target blocked)
        const dx = Math.abs(finalPos!.x - target!.col);
        const dy = Math.abs(finalPos!.y - target!.row);
        expect(Math.max(dx, dy)).toBeLessThanOrEqual(2);
      });
    });
  });

  test('debug overlays toggle via config panel', async ({ tavernPage }) => {
    await tavernPage.gotoTavern();
    await tavernPage.waitForSceneReady();

    await test.step('open config panel', async () => {
      await tavernPage.openConfigPanel();
    });

    await test.step('toggle collision overlay on', async () => {
      const toggle = tavernPage.page.getByTestId('tavern-config-showCollisionOverlay-toggle');
      await expect(toggle).toBeVisible({ timeout: TIMEOUTS.ELEMENT_STATE });
      await tavernPage.toggleCollisionOverlay(true);
    });

    await test.step('toggle path overlay on', async () => {
      const toggle = tavernPage.page.getByTestId('tavern-config-showPathOverlay-toggle');
      await expect(toggle).toBeVisible({ timeout: TIMEOUTS.ELEMENT_STATE });
      await tavernPage.togglePathOverlay(true);
    });

    await test.step('close config panel', async () => {
      await tavernPage.closeConfigPanel();
    });
  });

  test('action bar controls are accessible', async ({ tavernPage }) => {
    await tavernPage.gotoTavern();

    await test.step('action bar is visible', async () => {
      await expect(tavernPage.page.getByTestId('tavern-actionbar')).toBeVisible();
    });

    await test.step('config button is clickable', async () => {
      const btn = tavernPage.page.getByTestId('tavern-actionbar-config');
      await expect(btn).toBeVisible();
      await expect(btn).toBeEnabled();
    });

    await test.step('heartbeat button is visible', async () => {
      await expect(tavernPage.page.getByTestId('tavern-actionbar-heartbeat')).toBeVisible();
    });

    await test.step('emergency stop is visible', async () => {
      await expect(tavernPage.page.getByTestId('tavern-actionbar-emergency-stop')).toBeVisible();
    });
  });
});

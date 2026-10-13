import { test, expect } from './fixtures';
import { TIMEOUTS } from './constants';

test.describe('Tavern - Scene, Collision & Pathfinding', () => {
  test('scene loads and initializes correctly', async ({ tavernPage }) => {
    await test.step('navigate to tavern', async () => {
      await tavernPage.enableDevTools();
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
      // The FPS readout lives in the dev drawer, not the action bar.
      await tavernPage.openDevDrawer();
      await expect(tavernPage.page.getByTestId('tavern-dev-fps')).toBeVisible({
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

    await test.step('spawn entity on a walkable tile with a reachable target', async () => {
      const pair = await tavernPage.findWalkPair();
      expect(pair, 'no walkable start with a reachable target 5-8 tiles away').not.toBeNull();
      const { start, target } = pair!;

      const entityId = 'e2e-test-entity';
      await tavernPage.spawnTestEntity(entityId, 'host', { x: start.col, y: start.row });
      await tavernPage.waitForEntities(1);

      await test.step('walk entity to target', async () => {
        const started = await tavernPage.walkEntityTo(entityId, target.col, target.row, 3);
        expect(started, `walkTo did not start from (${start.col},${start.row})`).toBe(true);
      });

      await test.step('wait for entity to arrive', async () => {
        await tavernPage.waitForEntityIdle(entityId, TIMEOUTS.ACTION);
      });

      await test.step('verify entity arrived near target', async () => {
        const finalPos = await tavernPage.getEntityPosition(entityId);
        expect(finalPos).not.toBeNull();
        // Tolerance absorbs sub-tile position rounding; the target is walkable and reachable.
        const dx = Math.abs(finalPos!.x - target.col);
        const dy = Math.abs(finalPos!.y - target.row);
        expect(Math.max(dx, dy)).toBeLessThanOrEqual(2);
      });
    });
  });

  test('debug overlays toggle via dev drawer', async ({ tavernPage }) => {
    await tavernPage.enableDevTools();
    await tavernPage.gotoTavern();
    await tavernPage.waitForSceneReady();

    await test.step('open dev drawer', async () => {
      await tavernPage.openDevDrawer();
    });

    try {
      await test.step('toggle collision overlay on', async () => {
        await tavernPage.setDebugOverlay('showCollisionOverlay', true);
        expect(await tavernPage.getDebugOverlay('showCollisionOverlay')).toBe(true);
      });

      await test.step('toggle path overlay on', async () => {
        await tavernPage.setDebugOverlay('showPathOverlay', true);
        expect(await tavernPage.getDebugOverlay('showPathOverlay')).toBe(true);
      });
    } finally {
      // Runs even if a toggle above failed, so a broken run does not leave the overlays on.
      await test.step('toggle overlays back off', async () => {
        await tavernPage.setDebugOverlay('showCollisionOverlay', false);
        await tavernPage.setDebugOverlay('showPathOverlay', false);
        expect(await tavernPage.getDebugOverlay('showCollisionOverlay')).toBe(false);
        expect(await tavernPage.getDebugOverlay('showPathOverlay')).toBe(false);
      });
    }

    await test.step('close dev drawer', async () => {
      await tavernPage.closeDevDrawer();
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

import { unstable_dev } from "wrangler";
import type { Unstable_DevWorker } from "wrangler";
import { describe, expect, it, beforeAll, afterAll } from "vitest";

interface CharacterOperatorState {
  gameAddress: string;
  playerId: string;
  teamA: boolean;
  lastActionTime: number;
}

interface CharacterOperatorActionResult {
  executed: boolean;
  reason?: string;
}

describe("CharacterOperator", () => {
  let worker: Unstable_DevWorker;

  beforeAll(async () => {
    worker = await unstable_dev("src/index.ts", {
      experimental: { disableExperimentalWarning: true },
    });
  });

  afterAll(async () => {
    await worker.stop();
  });

  describe("start endpoint", () => {
    it("should return 400 if gameAddress is missing", async () => {
      const resp = await worker.fetch("http://character-operator/start");
      expect(resp.status).toBe(400);
      const text = await resp.text();
      expect(text).toBe("Missing gameAddress or playerId or teamA");
    });

    it("should return 400 if playerId is missing", async () => {
      const resp = await worker.fetch("http://character-operator/start?gameAddress=0xgame");
      expect(resp.status).toBe(400);
      const text = await resp.text();
      expect(text).toBe("Missing gameAddress or playerId or teamA");
    });

    it("should return 400 if teamA is missing", async () => {
      const resp = await worker.fetch("http://character-operator/start?gameAddress=0xgame&playerId=1");
      expect(resp.status).toBe(400);
      const text = await resp.text();
      expect(text).toBe("Missing gameAddress or playerId or teamA");
    });

    it("should start character operator with valid parameters", async () => {
      const resp = await worker.fetch("http://character-operator/start?gameAddress=0xgame&playerId=1&teamA=true");
      expect(resp.status).toBe(200);
      const text = await resp.text();
      expect(text).toBe("CharacterOperator started");
    });
  });

  describe("character operator state", () => {
    it("should maintain state between requests", async () => {
      // Start the character operator
      const startResp = await worker.fetch("http://character-operator/start?gameAddress=0xgame&playerId=1&teamA=true");
      expect(startResp.status).toBe(200);

      // Check state
      const stateResp = await worker.fetch("http://character-operator/state");
      expect(stateResp.status).toBe(200);
      const state = await stateResp.json() as CharacterOperatorState;
      expect(state).toEqual({
        gameAddress: "0xgame",
        playerId: "1",
        teamA: true,
        lastActionTime: expect.any(Number)
      });
    });
  });

  describe("character operator actions", () => {
    it("should not execute actions if game has ended", async () => {
      // Start the character operator
      await worker.fetch("http://character-operator/start?gameAddress=0xgame&playerId=1&teamA=true");

      // Mock game state as ended
      const mockResp = await worker.fetch("http://character-operator/mock?state=3");
      expect(mockResp.status).toBe(200);

      // Check if character operator executes actions
      const actionResp = await worker.fetch("http://character-operator/execute");
      expect(actionResp.status).toBe(200);
      const result = await actionResp.json() as CharacterOperatorActionResult;
      expect(result.executed).toBe(false);
      expect(result.reason).toBe("Game has ended");
    });

    it("should not execute actions if not our turn", async () => {
      // Start the character operator
      await worker.fetch("http://character-operator/start?gameAddress=0xgame&playerId=1&teamA=true");

      // Mock game state as in progress but not our turn
      const mockResp = await worker.fetch("http://character-operator/mock?state=2&isTeamATurn=false");
      expect(mockResp.status).toBe(200);

      // Check if character operator executes actions
      const actionResp = await worker.fetch("http://character-operator/execute");
      expect(actionResp.status).toBe(200);
      const result = await actionResp.json() as CharacterOperatorActionResult;
      expect(result.executed).toBe(false);
      expect(result.reason).toBe("Not our turn");
    });

    it("should execute actions when it's our turn", async () => {
      // Start the character operator
      await worker.fetch("http://character-operator/start?gameAddress=0xgame&playerId=1&teamA=true");

      // Mock game state as in progress and our turn
      const mockResp = await worker.fetch("http://character-operator/mock?state=2&isTeamATurn=true");
      expect(mockResp.status).toBe(200);

      // Check if character operator executes actions
      const actionResp = await worker.fetch("http://character-operator/execute");
      expect(actionResp.status).toBe(200);
      const result = await actionResp.json() as CharacterOperatorActionResult;
      expect(result.executed).toBe(true);
    });
  });
}); 
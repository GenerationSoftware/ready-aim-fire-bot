import { Env } from "./Env";

export class Bot {
  private state: DurableObjectState;
  private env: Env;
  private gameAddress: string | null = null;
  private playerId: string | null = null;

  constructor(state: DurableObjectState, env: Env) {
    this.state = state;
    this.env = env;
  }

  private async executeBotLogic() {
    // Retrieve stored values
    const storedGameAddress = await this.state.storage.get("gameAddress");
    const storedPlayerId = await this.state.storage.get("playerId");

    if (typeof storedGameAddress === 'string' && typeof storedPlayerId === 'string') {
      this.gameAddress = storedGameAddress;
      this.playerId = storedPlayerId;
      console.log(`Game Address: ${this.gameAddress}, Player ID: ${this.playerId}`);
    }
  }

  async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);

    if (url.pathname === "/start") {
      // Store game address and player ID
      this.gameAddress = url.searchParams.get("gameAddress");
      this.playerId = url.searchParams.get("playerId");

      if (!this.gameAddress || !this.playerId) {
        return new Response("Missing gameAddress or playerId", { status: 400 });
      }

      // Store in durable storage
      await this.state.storage.put("gameAddress", this.gameAddress);
      await this.state.storage.put("playerId", this.playerId);
      await this.state.storage.put("lastRun", Date.now());

      // Execute bot logic and set the alarm
      await this.executeBotLogic();
      await this.state.storage.setAlarm(Date.now() + 5000);
      return new Response("Bot started");
    }

    return new Response("Not found", { status: 404 });
  }

  async alarm() {
    await this.executeBotLogic();
    // Set the next alarm for 5 seconds from now
    await this.state.storage.setAlarm(Date.now() + 5000);
  }
} 
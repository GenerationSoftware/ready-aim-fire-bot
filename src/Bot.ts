import { Env } from "./Env";
import { createPublicClient, http } from "viem";
import { arbitrum } from "viem/chains";
import { ReadyAimFireABI } from "./abis/ReadyAimFireABI";

interface Player {
  address: string;
  playerId: string;
  teamA: boolean;
}

export class Bot {
  private state: DurableObjectState;
  private env: Env;
  private gameAddress: string | null = null;
  private playerId: string | null = null;
  private teamA: boolean | null = null;

  constructor(state: DurableObjectState, env: Env) {
    this.state = state;
    this.env = env;
  }

  private async getGamePlayers(gameAddress: string): Promise<Player[]> {
    const publicClient = createPublicClient({
      chain: arbitrum,
      transport: http(this.env.ETH_RPC_URL)
    });

    const playerJoinedEvent = ReadyAimFireABI.find(item => item.type === 'event' && item.name === 'PlayerJoinedEvent');
    if (!playerJoinedEvent) {
      throw new Error('PlayerJoinedEvent not found in ABI');
    }

    const currentBlock = await publicClient.getBlockNumber();
    const logs = await publicClient.getLogs({
      event: playerJoinedEvent,
      address: gameAddress as `0x${string}`,
      fromBlock: 0n,
      toBlock: currentBlock
    });

    return logs.map(log => {
      const args = log.args as { owner: `0x${string}`, playerId: bigint, locationX: bigint };
      return {
        address: args.owner,
        playerId: args.playerId.toString(),
        teamA: args.locationX === 0n
      };
    });
  }

  private async executeBotLogic() {
    // Retrieve stored values
    const storedGameAddress = await this.state.storage.get("gameAddress");
    const storedPlayerId = await this.state.storage.get("playerId");
    const storedTeamA = await this.state.storage.get("teamA") as boolean | null;
    let storedPlayers = await this.state.storage.get("players");
    if (typeof storedPlayers === 'string') {
      storedPlayers = JSON.parse(storedPlayers);
    }

    if (typeof storedGameAddress === 'string' && typeof storedPlayerId === 'string') {
      this.gameAddress = storedGameAddress;
      this.playerId = storedPlayerId;
      this.teamA = storedTeamA;
      console.log(`Game Address: ${this.gameAddress}, Player ID: ${this.playerId}, Team A: ${this.teamA}`);
      if (storedPlayers) {
        console.log('Players:', storedPlayers);
      }
    }
  }

  async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);

    if (url.pathname === "/start") {
      // Store game address and player ID
      this.gameAddress = url.searchParams.get("gameAddress");
      this.playerId = url.searchParams.get("playerId");
      this.teamA = url.searchParams.get("teamA") === "true";

      if (!this.gameAddress || !this.playerId || this.teamA === null) {
        return new Response("Missing gameAddress or playerId or teamA", { status: 400 });
      }

      // Get and store all players
      const players = await this.getGamePlayers(this.gameAddress);
      await this.state.storage.put("players", JSON.stringify(players));

      // Store in durable storage
      await this.state.storage.put("gameAddress", this.gameAddress);
      await this.state.storage.put("playerId", this.playerId);
      await this.state.storage.put("teamA", this.teamA);
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
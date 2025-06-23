import { Env } from "./Env";
import BattleABI from "./contracts/abis/Battle.json";
import BattleFactoryABI from "./contracts/abis/BattleFactory.json";
import MinterABI from "./contracts/abis/Minter.json";
import { createPublicClient, createWalletClient, http, encodeFunctionData, PublicClient, Log, type Abi } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { arbitrum } from "viem/chains";
import { forwardTransaction } from "./forwarder/forwardTransaction";
import { CONTRACT_ADDRESSES } from "./utils/deployments";

// WebSocket interface to match Cloudflare Workers WebSocket API
interface WebSocketEventHandlers {
  onopen: (event: Event) => void;
  onmessage: (event: MessageEvent) => void;
  onclose: (event: CloseEvent) => void;
  onerror: (event: Event) => void;
}

export class OperatorManager {
    state: DurableObjectState;
    websocket: WebSocket & WebSocketEventHandlers | null = null;
    env: Env;
  
    constructor(state: DurableObjectState, env: Env) {
      this.state = state;
      this.env = env;
    }

    private async mapGameState(publicClient: PublicClient, gameAddresses: string[]): Promise<Record<string, number>> {
      const results: Record<string, number> = {};

      // Process logs in batches of 100
      const BATCH_SIZE = 100;
      for (let i = 0; i < gameAddresses.length; i += BATCH_SIZE) {
        const batch = gameAddresses.slice(i, i + BATCH_SIZE);
        
        // Create multicall contracts for this batch
        const contracts = batch.map(address => ({
          address: address as `0x${string}`,
          abi: BattleABI as Abi,
          functionName: 'getGameState' as const
        }));

        // Execute multicall
        const responses = await publicClient.multicall({
          contracts
        });

        // Process results
        for (let j = 0; j < responses.length; j++) {
          const gameAddress = contracts[j].address;
          const response = responses[j];
          if (!response.status) {
            console.error("Failed to get game state for", gameAddress);
            continue;
          }
          results[gameAddress] = response.result as number;
        }
      }

      return results
    }

    private async checkPlayerJoined(publicClient: PublicClient, fromBlock: bigint, toBlock: bigint) {
      const playerJoinedEvent = (BattleABI as Abi).find(item => item.type === 'event' && 'name' in item && item.name === 'PlayerJoinedEvent') as any;
      if (!playerJoinedEvent) {
        throw new Error('PlayerJoinedEvent not found in ABI');
      }

      const logs = await publicClient.getLogs({
        event: playerJoinedEvent,
        fromBlock: fromBlock,
        toBlock: toBlock,
        args: {
          owner: this.env.BOT_ADDRESS as `0x${string}`
        }
      });

      console.log("Found games with bots: ", logs.length);

      // Get stored game addresses
      const storedGames = await this.state.storage.get("gameAddresses") as Set<string> || new Set<string>();
      
      // Filter logs to only include games in our stored set
      const filteredLogs = logs.filter(log => storedGames.has(log.address.toLowerCase().toString()));

      console.log("Filtered player joined logs:", filteredLogs.length, "out of", logs.length);

      const gameStates = await this.mapGameState(publicClient, filteredLogs.map(log => log.address));

      for (const log of filteredLogs) {
        const gameAddress = log.address;
        const gameState = gameStates[gameAddress];
        if (gameState <= 2) {
          console.log("READY TO PLAY");
          const args = (log as any).args as { owner: `0x${string}`, playerId: bigint, locationX: bigint };
          const isTeamA = args.locationX === 0n;
          const id = this.env.CHARACTER_OPERATOR.idFromName(args.playerId.toString());
          const characterOperator = this.env.CHARACTER_OPERATOR.get(id);
          characterOperator.fetch(new Request(`http://character-operator/start?gameAddress=${log.address}&playerId=${args.playerId}&teamA=${isTeamA}`));
        }
      }
    }

    private async checkOperators(publicClient: PublicClient, fromBlock: bigint, toBlock: bigint) {
      const createdGameEvent = (BattleFactoryABI as Abi).find(item => item.type === 'event' && 'name' in item && item.name === 'CreatedGame') as any;
      if (!createdGameEvent) {
        throw new Error('CreatedGame not found in ABI');
      }

      const logs = await publicClient.getLogs({
        event: createdGameEvent,
        fromBlock: fromBlock,
        toBlock: toBlock,
        address: CONTRACT_ADDRESSES.BATTLE_FACTORY as `0x${string}`,
        args: {
          operator: this.env.OPERATOR_ADDRESS as `0x${string}`
        }
      });

      const gameAddresses = logs.map(log => {
        const args = (log as any).args as { gameAddress: `0x${string}` };
        return args.gameAddress.toLowerCase();
      });

      console.log("GAMES CREATED WITH OPERATOR", gameAddresses.length);

      // Get existing game addresses from storage
      const existingGames = await this.state.storage.get("gameAddresses") as Set<string> || new Set<string>();
      
      // Add new game addresses to the set
      for (const gameAddress of gameAddresses) {
        existingGames.add(gameAddress.toString());
      }

      // Store updated set back in storage
      await this.state.storage.put("gameAddresses", existingGames);

      const gameStates = await this.mapGameState(publicClient, gameAddresses);

      for (const gameAddress of gameAddresses) {
        const gameState = gameStates[gameAddress];
        console.log("GAME STATE", gameAddress, gameState);
        if (gameState <= 2) {
          console.log("GAME STARTED WITH OPERATOR", gameAddress);
          const id = this.env.BATTLE_OPERATOR.idFromName(gameAddress.toString());
          const operator = this.env.BATTLE_OPERATOR.get(id);
          operator.fetch(new Request(`http://operator/start?gameAddress=${gameAddress}`));
        }
      }
    }

    private async checkLogsAndStartBots(fromBlock: bigint): Promise<bigint> {
        // Create a public client for reading contract state
        const publicClient = createPublicClient({
          chain: arbitrum,
          transport: http(this.env.ETH_RPC_URL)
        });

        // Get logs from the specified block
        const currentBlock = await publicClient.getBlockNumber();

        await this.checkPlayerJoined(publicClient, fromBlock, currentBlock);
        await this.checkOperators(publicClient, fromBlock, currentBlock);
        
        return currentBlock;
    }
  
    async fetch(request: Request): Promise<Response> {
      const url = new URL(request.url);
  
      if (url.pathname === "/start") {
        try {
          await this.doWork();
        } catch (error: unknown) {
          console.error("Error in /start:", error);
          const errorMessage = error instanceof Error ? error.message : "Unknown error occurred";
          await this.state.storage.setAlarm(Date.now() + 5000);
          return new Response(`Error starting bot: ${errorMessage}.  Re-trying in 5 seconds`, { status: 500 });
        }
        await this.state.storage.setAlarm(Date.now() + 5000);
        return new Response("Awaiting games.");
      } else if (url.pathname === "/reset") {
        await this.state.storage.deleteAlarm();
        await this.state.storage.deleteAll();
        return new Response("Reset listener");
      }

      return new Response("Not found", { status: 404 });
    }

  private async checkMint(address: string): Promise<boolean> {
    try {
      // Create public client for reading contract state
      const publicClient = createPublicClient({
        chain: arbitrum,
        transport: http(this.env.ETH_RPC_URL)
      });

      // console.log("Checking mint status for address:", address);
      // console.log("Using Minter contract at:", this.env.MINTER_ADDRESS);

      // Check if player has already minted
      const hasMinted = await publicClient.readContract({
        address: CONTRACT_ADDRESSES.MINTER as `0x${string}`,
        abi: MinterABI as Abi,
        functionName: 'playerMinted',
        args: [address as `0x${string}`]
      }).catch(error => {
        console.error("Error reading playerMinted:", error);
        throw error;
      });

      // console.log("Mint status:", hasMinted);

      if (hasMinted) {
        // console.log("Player has already minted");
        return true;
      }

      // console.log("Player has not minted, proceeding with mint transaction");

      // Create wallet client for sending transactions
      const account = privateKeyToAccount(this.env.BOT_PRIVATE_KEY as `0x${string}`);
      const walletClient = createWalletClient({
        account,
        chain: arbitrum,
        transport: http(this.env.ETH_RPC_URL)
      });

      // Encode the mintCollection function call
      const data = encodeFunctionData({
        abi: MinterABI as Abi,
        functionName: 'mintCollection',
        args: [address as `0x${string}`]
      });

      // console.log("Encoded mintCollection data:", data);

      // Forward the transaction using the forwarder
      const hash = await forwardTransaction(
        {
          to: CONTRACT_ADDRESSES.MINTER as `0x${string}`,
          data: data,
          rpcUrl: this.env.ETH_RPC_URL,
          relayerUrl: this.env.RELAYER_URL
        },
        walletClient,
        this.env.ERC2771_FORWARDER_ADDRESS as `0x${string}`
      );

      // console.log("Mint transaction forwarded:", hash);
      return false;
    } catch (error) {
      console.error("Error in checkMint:", error);
      throw error;
    }
  }

  async doWork() {
    await this.checkMint(this.env.BOT_ADDRESS);
    const latestBlock = await this.state.storage.get("latestBlock") as string | undefined;
    const fromBlock = latestBlock ? BigInt(latestBlock) : 0n;
    const currentBlock = await this.checkLogsAndStartBots(fromBlock);
    await this.state.storage.put("latestBlock", currentBlock.toString());
  }

    async alarm() {
      console.log("OperatorManager waking up...");
      try {
        await this.doWork();
      } catch (error) {
        console.error("Error in alarm:", error);
      }
      await this.state.storage.setAlarm(Date.now() + 5000);
    }
  }

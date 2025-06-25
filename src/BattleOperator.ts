import { DurableObject } from "cloudflare:workers";
import { Env } from "./Env";
import BattleABI from "./contracts/abis/Battle.json";
import { createPublicClient, createWalletClient, http, webSocket, encodeFunctionData, type Abi } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { arbitrum } from "viem/chains";
import { forwardTransaction } from "./forwarder/forwardTransaction";
import { createGraphQLClient, GraphQLQueries, type Battle, type BattleTurn } from "./utils/graphql";

export class BattleOperator {
  private state: DurableObjectState;
  private env: Env;
  private gameAddress: string | null = null;
  private wsClient: any = null;
  private wsUnwatch: (() => void) | null = null;

  constructor(state: DurableObjectState, env: Env) {
    this.state = state;
    this.env = env;
    
    // Restore connection if it was previously established
    this.restoreConnection();
  }

  private async restoreConnection(): Promise<void> {
    try {
      this.gameAddress = await this.state.storage.get("gameAddress") as string;
      if (this.gameAddress && !this.wsClient) {
        this.opLog("Restoring WebSocket connection for game:", this.gameAddress);
        await this.setupWebSocketConnection();
      }
    } catch (error) {
      this.opError("Error restoring WebSocket connection:", error);
    }
  }

  private async cleanupWebSocketConnection(): Promise<void> {
    try {
      if (this.wsUnwatch) {
        this.wsUnwatch();
        this.wsUnwatch = null;
      }
      this.wsClient = null;
    } catch (error) {
      this.opError("Error cleaning up WebSocket connection:", error);
    }
  }

  private opLog(this: BattleOperator, ...args: any[]): void {
    console.log({
      origin: "BATTLE_OPERATOR",
      gameAddress: this.gameAddress,
      ...args
    });
  }

  private opError(this: BattleOperator, ...args: any[]): void {
    console.error({
      origin: "BATTLE_OPERATOR",
      gameAddress: this.gameAddress,
      ...args
    });
  }

  private async checkAndAdvanceTurn(): Promise<boolean> {
    if (!this.gameAddress) return false;

    const publicClient = createPublicClient({
      chain: arbitrum,
      transport: http(this.env.ETH_RPC_URL)
    });

    try {
      // Use GraphQL to get battle state and recent turn data
      const graphqlClient = createGraphQLClient(this.env);
      
      // Get battle data from GraphQL
      const battleResult = await graphqlClient.query<{battles: {items: Battle[]}}>(GraphQLQueries.getBattlesByGameState);
      
      const battle = battleResult.battles.items.find(b => b.id.toLowerCase() === this.gameAddress!.toLowerCase());
      
      if (!battle) {
        this.opLog("Battle not found in GraphQL, checking contract state");
        // Fallback to contract check
        const gameState = await publicClient.readContract({
          address: this.gameAddress as `0x${string}`,
          abi: BattleABI as Abi,
          functionName: 'getGameState'
        }) as bigint;
        
        if (gameState > 2n) {
          this.opLog("Game has ended, stopping operator");
          return false;
        } else if (gameState == 1n) {
          this.opLog("Game has not started, delaying");
          await this.state.storage.setAlarm(Date.now() + 5000);
          return true;
        }
      } else if (!battle.gameStartedAt) {
        this.opLog("Game has not started according to GraphQL, delaying");
        await this.state.storage.setAlarm(Date.now() + 5000);
        return true;
      }

      // Check turn status and game state using multicall (real-time data)
      const multicallResults = await publicClient.multicall({
        contracts: [
          {
            address: this.gameAddress as `0x${string}`,
            abi: BattleABI as Abi,
            functionName: 'isTurnOver'
          },
          {
            address: this.gameAddress as `0x${string}`,
            abi: BattleABI as Abi,
            functionName: 'getGameState'
          }
        ]
      });

      if (multicallResults[0].status === 'failure' || multicallResults[1].status === 'failure') {
        this.opError("Multicall failed:", {
          isTurnOver: multicallResults[0].status === 'failure' ? multicallResults[0].error : 'success',
          gameState: multicallResults[1].status === 'failure' ? multicallResults[1].error : 'success'
        });
        await this.state.storage.setAlarm(Date.now() + 5000);
        return true;
      }

      const isTurnOver = multicallResults[0].result as boolean;
      const gameState = multicallResults[1].result as bigint;

      // Only proceed if game is still active (state <= 2)
      if (gameState > 2n) {
        this.opLog("Game has ended, stopping operator");
        return false;
      }

      if (gameState == 1n) {
        this.opLog("Game has not started, delaying");
        await this.state.storage.setAlarm(Date.now() + 5000);
        return true;
      }

      this.opLog("Game state:", gameState, "Turn over:", isTurnOver);

      if (gameState == 2n && isTurnOver) {
        this.opLog("Turn has ended, advancing to next turn");
        
        // Get the latest turn information from GraphQL for context
        const turnsResult = await graphqlClient.query<{battleTurns: {items: BattleTurn[]}}>(GraphQLQueries.getBattleTurns, {
          battleId: this.gameAddress.toLowerCase()
        });
        
        if (turnsResult.battleTurns.items.length > 0) {
          const latestTurn = turnsResult.battleTurns.items[0];
          this.opLog("Latest turn from GraphQL:", {
            turn: latestTurn.turn,
            startedAt: latestTurn.startedAt,
            duration: latestTurn.duration,
            endTurnCount: latestTurn.endTurnCount
          });
        }
        
        // Create wallet client for sending transactions
        const account = privateKeyToAccount(this.env.OPERATOR_PRIVATE_KEY as `0x${string}`);
        const walletClient = createWalletClient({
          account,
          chain: arbitrum,
          transport: http(this.env.ETH_RPC_URL)
        });

        // Encode the nextTurn function call
        const data = encodeFunctionData({
          abi: BattleABI as Abi,
          functionName: 'nextTurn'
        });

        this.opLog("Calling nextTurn for game ", this.gameAddress);

        // Forward the transaction
        let hash;
        try {
          hash = await forwardTransaction(
            {
              to: this.gameAddress as `0x${string}`,
              data: data,
              rpcUrl: this.env.ETH_RPC_URL,
              relayerUrl: this.env.RELAYER_URL
            },
            walletClient,
            this.env.ERC2771_FORWARDER_ADDRESS as `0x${string}`
          );
        } catch (error) {
          console.error("Error forwarding transaction:", error);
          // Schedule another check in 1 second
          await this.state.storage.setAlarm(Date.now() + 1000);
          return true;
        }

        this.opLog("Next turn transaction forwarded:", hash);

        // Wait for transaction receipt only if we have a valid hash
        if (hash) {
          try {
            const receipt = await publicClient.waitForTransactionReceipt({ hash });
            this.opLog("Next turn transaction confirmed:", receipt);
          } catch (error) {
            console.error("Error waiting for transaction receipt:", error);
            // Schedule another check in 1 second
            await this.state.storage.setAlarm(Date.now() + 1000);
            return true;
          }
        } else {
          console.error("No transaction hash received from forwardTransaction for game ", this.gameAddress);
          // Schedule another check in 1 second
          await this.state.storage.setAlarm(Date.now() + 1000);
          return true;
        }

        this.opLog("Reading currentTurnEndsAt");

        // Get the new turn end time
        const currentTurnEndsAt = await publicClient.readContract({
          address: this.gameAddress as `0x${string}`,
          abi: BattleABI as Abi,
          functionName: 'currentTurnEndsAt'
        }) as bigint;

        this.opLog("Scheduling next check at", currentTurnEndsAt);

        // Schedule next check at turn end time
        await this.state.storage.setAlarm(Number(currentTurnEndsAt) * 1000 + 500);
      } else {
        this.opLog("Turn has not ended, checking again in 1 second");
        // Check again in 1 second
        await this.state.storage.setAlarm(Date.now() + 1000);
      }
    } catch (error) {
      console.error("Error in checkAndAdvanceTurn:", error);
      // On error, try again in 5 seconds
      await this.state.storage.setAlarm(Date.now() + 5000);
    }

    return true;
  }

  private async setupWebSocketConnection(): Promise<void> {
    if (!this.gameAddress) {
      this.opError("Cannot setup WebSocket without gameAddress");
      return;
    }

    try {
      // Find EndedTurnEvent in the ABI
      const endedTurnEvent = (BattleABI as any[]).find(
        item => item.type === 'event' && item.name === 'EndedTurnEvent'
      );

      if (!endedTurnEvent) {
        throw new Error("EndedTurnEvent not found in Battle ABI");
      }

      this.opLog("Found EndedTurnEvent in ABI:", endedTurnEvent);

      // Create WebSocket client
      this.wsClient = createPublicClient({
        chain: arbitrum,
        transport: webSocket(this.env.ETH_RPC_URL)
      });

      // Listen for EndedTurnEvent from this specific Battle using the ABI event
      const unwatch = this.wsClient.watchEvent({
        address: this.gameAddress as `0x${string}`,
        event: endedTurnEvent,
        onLogs: (logs: any[]) => {
          for (const log of logs) {
            this.opLog("EndedTurnEvent received:", {
              turn: log.args.turn?.toString(),
              player: log.args.player
            });
            
            // Trigger turn advancement check
            this.checkAndAdvanceTurn();
          }
        }
      });

      // Store the unwatch function for cleanup
      this.wsUnwatch = unwatch;
      
      this.opLog("WebSocket connection established for Battle events");
      
    } catch (error) {
      this.opError("Error setting up WebSocket connection:", error);
      throw error; // Re-throw to prevent silent failures
    }
  }

  async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);

    if (url.pathname === "/start") {
      const requestedGameAddress = url.searchParams.get("gameAddress");

      if (!requestedGameAddress) {
        return new Response("Missing gameAddress", { status: 400 });
      }

      // Get stored game address
      const storedGameAddress = await this.state.storage.get("gameAddress") as string;
      
      // Set up new connection
      this.gameAddress = requestedGameAddress;
      await this.state.storage.put("gameAddress", this.gameAddress);

      let hasError = false;
      let errorMessage = "";

      // Setup WebSocket connection if not already connected
      if (!this.wsClient) {
        try {
          // Clean up any existing connection
          await this.cleanupWebSocketConnection();
          
          // Setup WebSocket connection
          await this.setupWebSocketConnection();
          this.opLog("WebSocket connection established");
        } catch (error) {
          this.opError("Failed to setup WebSocket connection:", error);
          hasError = true;
          errorMessage += `WebSocket error: ${error}; `;
        }
      } else {
        // this.opLog("WebSocket connection already exists");
      }

      // Setup alarm if none exists or if existing alarm is in the past
      try {
        const currentAlarm = await this.state.storage.getAlarm();
        const currentTime = Date.now();
        
        if (currentAlarm === null || currentAlarm < currentTime) {
          this.state.storage.setAlarm(currentTime + 5000);
          this.opLog("Alarm scheduled for periodic checks");
        } else {
          // this.opLog("Alarm already scheduled");
        }
      } catch (error) {
        this.opError("Failed to setup alarm:", error);
        hasError = true;
        errorMessage += `Alarm error: ${error}; `;
      }

      if (hasError) {
        return new Response(`BattleOperator started with errors: ${errorMessage}`, { status: 207 });
      }
      
      return new Response("BattleOperator started");
    }

    return new Response("Not found", { status: 404 });
  }

  async alarm(): Promise<void> {
    try {
      this.opLog("BattleOperator alarm triggered");
      // Perform periodic check of battle state and turn advancement
      if (!await this.checkAndAdvanceTurn()) {
        // Game is over or we don't need to continue, clean up resources
        await this.state.storage.deleteAll();
        this.opLog("Operator resources released - game ended or no longer needed");
      }
    } catch (error) {
      this.opError("Error in alarm:", error);
      // Continue with next alarm even on error
      this.state.storage.setAlarm(Date.now() + 5000);
    }
  }
}

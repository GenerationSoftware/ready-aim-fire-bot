import { Env } from "./Env";
import BattleABI from "./contracts/abis/Battle.json";
import { createPublicClient, createWalletClient, http, encodeFunctionData, type Abi } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { arbitrum } from "viem/chains";
import { forwardTransaction } from "./forwarder/forwardTransaction";
import { createGraphQLClient, GraphQLQueries, type Battle, type BattleTurn } from "./utils/graphql";
import { Operator, type EventSubscription } from "./Operator";

export class BattleOperator extends Operator {
  private get gameAddress(): string | null {
    return this.operatorId;
  }

  // Abstract method implementations
  protected getOperatorIdKey(): string {
    return "gameAddress";
  }

  protected getEventSubscriptions(): EventSubscription[] {
    return [
      {
        eventName: "EndedTurnEvent",
        abi: BattleABI as any[],
        onEvent: async (logs: any[]) => {
          for (const log of logs) {
            this.log("EndedTurnEvent received:", {
              turn: log.args.turn?.toString(),
              player: log.args.player
            });
            
            // Trigger turn advancement check
            this.checkAndAdvanceTurn();
          }
        }
      }
    ];
  }

  protected async performPeriodicCheck(): Promise<number> {
    // checkAndAdvanceTurn now returns the next alarm time directly
    return await this.checkAndAdvanceTurn();
  }

  // Override logging methods to maintain battle-specific naming
  protected log(...args: any[]): void {
    console.log({
      origin: "BATTLE_OPERATOR",
      gameAddress: this.gameAddress,
      ...args
    });
  }

  protected error(...args: any[]): void {
    console.error({
      origin: "BATTLE_OPERATOR",
      gameAddress: this.gameAddress,
      ...args
    });
  }

  private async checkAndAdvanceTurn(): Promise<number> {
    if (!this.gameAddress) return 0;

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
        this.log("Battle not found in GraphQL, checking contract state");
        // Fallback to contract check
        const gameState = await publicClient.readContract({
          address: this.gameAddress as `0x${string}`,
          abi: BattleABI as Abi,
          functionName: 'getGameState'
        }) as bigint;
        
        if (gameState > 2n) {
          this.log("Game has ended, stopping operator");
          return 0;
        } else if (gameState == 1n) {
          this.log("Game has not started, delaying");
          return Date.now() + 5000;
        }
      } else if (!battle.gameStartedAt) {
        this.log("Game has not started according to GraphQL, delaying");
        return Date.now() + 5000;
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
        this.error("Multicall failed:", {
          isTurnOver: multicallResults[0].status === 'failure' ? multicallResults[0].error : 'success',
          gameState: multicallResults[1].status === 'failure' ? multicallResults[1].error : 'success'
        });
        return Date.now() + 5000;
      }

      const isTurnOver = multicallResults[0].result as boolean;
      const gameState = multicallResults[1].result as bigint;

      // Only proceed if game is still active (state <= 2)
      if (gameState > 2n) {
        this.log("Game has ended, stopping operator");
        return 0;
      }

      if (gameState == 1n) {
        this.log("Game has not started, delaying");
        return Date.now() + 5000;
      }

      this.log("Game state:", gameState, "Turn over:", isTurnOver);

      if (gameState == 2n && isTurnOver) {
        this.log("Turn has ended, advancing to next turn");
        
        // Get the latest turn information from GraphQL for context
        const turnsResult = await graphqlClient.query<{battleTurns: {items: BattleTurn[]}}>(GraphQLQueries.getBattleTurns, {
          battleId: this.gameAddress.toLowerCase()
        });
        
        if (turnsResult.battleTurns.items.length > 0) {
          const latestTurn = turnsResult.battleTurns.items[0];
          this.log("Latest turn from GraphQL:", {
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

        this.log("Calling nextTurn for game ", this.gameAddress);

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
          return Date.now() + 1000;
        }

        this.log("Next turn transaction forwarded:", hash);

        // Wait for transaction receipt only if we have a valid hash
        if (hash) {
          try {
            const receipt = await publicClient.waitForTransactionReceipt({ hash });
            this.log("Next turn transaction confirmed:", receipt);
          } catch (error) {
            console.error("Error waiting for transaction receipt:", error);
            // Schedule another check in 1 second
            return Date.now() + 1000;
          }
        } else {
          console.error("No transaction hash received from forwardTransaction for game ", this.gameAddress);
          // Schedule another check in 1 second
          return Date.now() + 1000;
        }

        this.log("Reading currentTurnEndsAt");

        // Get the new turn end time
        const currentTurnEndsAt = await publicClient.readContract({
          address: this.gameAddress as `0x${string}`,
          abi: BattleABI as Abi,
          functionName: 'currentTurnEndsAt'
        }) as bigint;

        this.log("Scheduling next check at", currentTurnEndsAt);

        // Schedule next check at turn end time
        return Number(currentTurnEndsAt) * 1000 + 500;
      } else {
        this.log("Turn has not ended, checking again in 1 second");
        // Check again in 1 second
        return Date.now() + 1000;
      }
    } catch (error) {
      console.error("Error in checkAndAdvanceTurn:", error);
      // On error, try again in 5 seconds
      return Date.now() + 5000;
    }
  }
}

import { Env } from "./Env";
import BattleABI from "./contracts/abis/Battle.json";
import { createPublicClient, createWalletClient, http, encodeFunctionData, type Abi } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { arbitrum } from "viem/chains";
import { forwardTransaction } from "./forwarder/forwardTransaction";
import { createGraphQLClient, GraphQLQueries, type Battle } from "./utils/graphql";
import { Operator, type EventSubscription } from "./Operator";

export class BattleOperator extends Operator {
  private gameAddress: string | undefined;

  private async getGameAddress(): Promise<string | undefined> {
    if (!this.gameAddress) {
      this.gameAddress = await this.state.storage.get("gameAddress") as string | undefined;
    }
    return this.gameAddress;
  }

  protected async getEventSubscriptions(): Promise<EventSubscription[]> {
    return [
      {
        eventName: "EndedTurnEvent",
        abi: BattleABI as any[],
        address: await this.getGameAddress(),
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
    const gameAddress = await this.getGameAddress();
    if (!gameAddress) return 0;

    const publicClient = createPublicClient({
      chain: arbitrum,
      transport: http(this.env.ETH_RPC_URL)
    });

    try {
      // Use GraphQL to get battle state and recent turn data
      const graphqlClient = createGraphQLClient(this.env);
      
      // Get battle data from GraphQL
      const battleResult = await graphqlClient.query<{battles: {items: Battle[]}}>(GraphQLQueries.getBattlesByGameState);
      
      const battle = battleResult.battles.items.find(b => b.id.toLowerCase() === gameAddress.toLowerCase());
      
      if (!battle) {
        this.log("Battle not found in GraphQL, checking contract state");
        // Fallback to contract check
        const gameState = await publicClient.readContract({
          address: gameAddress as `0x${string}`,
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
            address: gameAddress as `0x${string}`,
            abi: BattleABI as Abi,
            functionName: 'isTurnOver'
          },
          {
            address: gameAddress as `0x${string}`,
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
        
        // Get current turn information from contract
        const currentTurn = await publicClient.readContract({
          address: gameAddress as `0x${string}`,
          abi: BattleABI as Abi,
          functionName: 'currentTurn'
        }) as bigint;
        
        const currentTurnEndsAt = await publicClient.readContract({
          address: gameAddress as `0x${string}`,
          abi: BattleABI as Abi,
          functionName: 'currentTurnEndsAt'
        }) as bigint;
        
        this.log("Current turn information from contract:", {
          turn: currentTurn.toString(),
          endsAt: currentTurnEndsAt.toString(),
          endsAtDate: new Date(Number(currentTurnEndsAt) * 1000).toISOString()
        });
        
        // Create wallet client for sending transactions
        const account = privateKeyToAccount(this.env.OPERATOR_PRIVATE_KEY as `0x${string}`);
        const walletClient = createWalletClient({
          account,
          chain: arbitrum,
          transport: http(this.env.ETH_RPC_URL)
        });

        // Generate a random number for nextTurn
        const randomNumber = BigInt(Math.floor(Math.random() * Number.MAX_SAFE_INTEGER));
        
        // Encode the nextTurn function call
        const data = encodeFunctionData({
          abi: BattleABI as Abi,
          functionName: 'nextTurn',
          args: [randomNumber]
        });

        this.log("Calling nextTurn for game ", gameAddress);

        // Forward the transaction
        let hash;
        try {
          hash = await forwardTransaction(
            {
              to: gameAddress as `0x${string}`,
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
          console.error("No transaction hash received from forwardTransaction for game ", gameAddress);
          // Schedule another check in 1 second
          return Date.now() + 1000;
        }

        this.log("Reading new turn end time");

        // Get the new turn end time after nextTurn() was called
        const newTurnEndsAt = await publicClient.readContract({
          address: gameAddress as `0x${string}`,
          abi: BattleABI as Abi,
          functionName: 'currentTurnEndsAt'
        }) as bigint;

        this.log("Scheduling next check at", newTurnEndsAt);

        // Schedule next check at turn end time
        return Number(newTurnEndsAt) * 1000 + 500;
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

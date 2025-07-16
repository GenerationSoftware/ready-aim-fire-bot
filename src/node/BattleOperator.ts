import { createPublicClient, createWalletClient, encodeFunctionData, type Abi } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { arbitrum } from "viem/chains";
import BattleABI from "../contracts/abis/Battle.json";
import { forwardTransaction } from "../forwarder/forwardTransaction";
import { createGraphQLClient, GraphQLQueries, type Battle } from "../utils/graphql";
import { createAuthenticatedHttpTransport } from "../utils/rpc";
import { EventAggregator } from "./EventAggregator";
import { createLogger } from "../utils/logger";
import type { Logger } from "pino";

export interface BattleOperatorConfig {
  ethRpcUrl: string;
  ethWsRpcUrl: string;
  graphqlUrl: string;
  operatorAddress: string;
  operatorPrivateKey: string;
  relayerUrl: string;
  erc2771ForwarderAddress: string;
  gameAddress: string;
  eventAggregator: EventAggregator;
}

export class BattleOperator {
  private config: BattleOperatorConfig;
  private intervalId?: NodeJS.Timeout;
  private isRunning: boolean = false;
  private lastCheckTime: number = 0;
  private eventUnsubscribe?: () => void;
  private logger: Logger;

  constructor(config: BattleOperatorConfig) {
    this.config = config;
    this.logger = createLogger({ operator: 'BattleOperator', battleAddress: config.gameAddress });
  }

  private log(...args: any[]) {
    if (args.length === 1) {
      this.logger.info(args[0]);
    } else {
      this.logger.info(args[0], ...args.slice(1));
    }
  }

  private error(...args: any[]) {
    if (args.length === 1) {
      this.logger.error(args[0]);
    } else {
      this.logger.error(args[0], ...args.slice(1));
    }
  }

  start() {
    if (this.isRunning) {
      this.log("Already running");
      return;
    }

    this.isRunning = true;
    this.log("Starting...");

    // Subscribe to EndedTurnEvent
    this.eventUnsubscribe = this.config.eventAggregator.subscribe({
      eventName: "EndedTurnEvent",
      abi: BattleABI as any[],
      address: this.config.gameAddress,
      onEvent: async (logs: any[]) => {
        this.log(`EndedTurnEvent triggered with ${logs.length} logs`);
        for (const log of logs) {
          this.log("EndedTurnEvent details:", {
            address: log.address,
            turn: log.args?.turn?.toString(),
            player: log.args?.player,
            transactionHash: log.transactionHash,
            blockNumber: log.blockNumber
          });
        }
        // Trigger turn advancement check
        this.checkAndAdvanceTurn();
      }
    });

    // Initial check
    this.checkAndAdvanceTurn();

    // Set up periodic checks every second
    this.intervalId = setInterval(() => {
      this.checkAndAdvanceTurn();
    }, 1000);
  }

  stop() {
    if (!this.isRunning) {
      this.log("Not running");
      return;
    }

    this.log("Stopping...");
    this.isRunning = false;

    if (this.intervalId) {
      clearInterval(this.intervalId);
      this.intervalId = undefined;
    }

    if (this.eventUnsubscribe) {
      this.eventUnsubscribe();
      this.eventUnsubscribe = undefined;
    }
  }

  isAlive(): boolean {
    if (!this.isRunning) return false;
    
    const timeSinceLastCheck = Date.now() - this.lastCheckTime;
    
    // Consider dead if no check in 30 seconds
    if (timeSinceLastCheck > 30000) return false;
    
    return true;
  }

  private async checkAndAdvanceTurn() {
    this.lastCheckTime = Date.now();
    
    const publicClient = createPublicClient({
      chain: arbitrum,
      transport: createAuthenticatedHttpTransport(this.config.ethRpcUrl, { ETH_RPC_URL: this.config.ethRpcUrl })
    });

    try {
      // Use GraphQL to get battle state and recent turn data
      const graphqlClient = createGraphQLClient({ GRAPHQL_URL: this.config.graphqlUrl });
      
      // Get battle data from GraphQL
      const battleResult = await graphqlClient.query<{ battles: { items: Battle[] } }>(GraphQLQueries.getBattlesByGameState);
      
      const battle = battleResult.battles.items.find(b => b.id.toLowerCase() === this.config.gameAddress.toLowerCase());
      
      if (!battle) {
        this.log("Battle not found in GraphQL, checking contract state");
        // Fallback to contract check
        const gameState = await publicClient.readContract({
          address: this.config.gameAddress as `0x${string}`,
          abi: BattleABI as Abi,
          functionName: 'getGameState'
        }) as bigint;
        
        if (gameState > 2n) {
          this.log("Game has ended, stopping operator");
          this.stop();
          return;
        } else if (gameState == 1n) {
          this.log("Game has not started, delaying");
          return;
        }
      } else if (!battle.gameStartedAt) {
        this.log("Game has not started according to GraphQL, delaying");
        return;
      }

      // Check turn status and game state using multicall (real-time data)
      const multicallResults = await publicClient.multicall({
        contracts: [
          {
            address: this.config.gameAddress as `0x${string}`,
            abi: BattleABI as Abi,
            functionName: 'isTurnOver'
          },
          {
            address: this.config.gameAddress as `0x${string}`,
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
        return;
      }

      const isTurnOver = multicallResults[0].result as boolean;
      const gameState = multicallResults[1].result as bigint;

      this.log("Multicall results:", {
        isTurnOver,
        gameState
      });

      // Only proceed if game is still active (state <= 2)
      if (gameState > 2n) {
        this.log("Game has ended, stopping operator");
        this.stop();
        return;
      }

      if (gameState == 1n) {
        this.log("Game has not started, delaying");
        return;
      }

      this.log("Game state:", gameState, "Turn over:", isTurnOver);

      if (gameState == 2n && isTurnOver) {
        this.log("Turn has ended, advancing to next turn");
        
        // Create wallet client for sending transactions
        const account = privateKeyToAccount(this.config.operatorPrivateKey as `0x${string}`);
        this.log("Using operator address:", account.address);
        
        const walletClient = createWalletClient({
          account,
          chain: arbitrum,
          transport: createAuthenticatedHttpTransport(this.config.ethRpcUrl, { ETH_RPC_URL: this.config.ethRpcUrl })
        });

        // Generate a random number for nextTurn
        const randomNumber = BigInt(Math.floor(Math.random() * Number.MAX_SAFE_INTEGER));
        
        // Encode the nextTurn function call
        const data = encodeFunctionData({
          abi: BattleABI as Abi,
          functionName: 'nextTurn',
          args: [randomNumber]
        });

        this.log("Calling nextTurn for game", this.config.gameAddress);
        this.log("Using forwarder address:", this.config.erc2771ForwarderAddress);
        this.log("Using relayer URL:", this.config.relayerUrl);

        // Forward the transaction
        let hash;
        try {
          hash = await forwardTransaction(
            {
              to: this.config.gameAddress as `0x${string}`,
              data: data,
              rpcUrl: this.config.ethRpcUrl,
              relayerUrl: this.config.relayerUrl,
              env: { ETH_RPC_URL: this.config.ethRpcUrl } as any
            },
            walletClient,
            this.config.erc2771ForwarderAddress as `0x${string}`
          );
        } catch (error) {
          this.error("Error forwarding transaction:", error);
          return;
        }

        this.log("Next turn transaction forwarded:", hash);

        // Wait for transaction receipt only if we have a valid hash
        if (hash) {
          try {
            const receipt = await publicClient.waitForTransactionReceipt({ hash });
            this.log("Next turn transaction confirmed:", receipt);
          } catch (error) {
            this.error("Error waiting for transaction receipt:", error);
            return;
          }
        } else {
          this.error("No transaction hash received from forwardTransaction for game", this.config.gameAddress);
          return;
        }

        this.log("Turn successfully advanced");
      } else {
        this.log("Turn has not ended yet");
      }
    } catch (error) {
      this.error("Error in checkAndAdvanceTurn:", error);
    }
  }
}
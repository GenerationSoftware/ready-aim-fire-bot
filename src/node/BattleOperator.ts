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


  start() {
    if (this.isRunning) {
      this.logger.info("Already running");
      return;
    }

    this.isRunning = true;
    this.logger.info("Starting...");

    // Subscribe to EndedTurnEvent
    this.eventUnsubscribe = this.config.eventAggregator.subscribe({
      eventName: "EndedTurnEvent",
      abi: BattleABI as any[],
      address: this.config.gameAddress,
      onEvent: async (logs: any[]) => {
        this.logger.info(`EndedTurnEvent triggered with ${logs.length} logs`);
        for (const log of logs) {
          this.logger.info({
            address: log.address,
            turn: log.args?.turn?.toString(),
            player: log.args?.player,
            transactionHash: log.transactionHash,
            blockNumber: log.blockNumber
          }, "EndedTurnEvent details");
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
      this.logger.info("Not running");
      return;
    }

    this.logger.info("Stopping...");
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
      
      // Get specific battle data from GraphQL
      const battleResult = await graphqlClient.query<{ battle: Battle | null }>(GraphQLQueries.getBattleById, {
        battleId: this.config.gameAddress.toLowerCase()
      });
      
      const battle = battleResult.battle;
      
      if (!battle) {
        this.logger.info("Battle not found in GraphQL, checking contract state");
        // Fallback to contract check
        const gameState = await publicClient.readContract({
          address: this.config.gameAddress as `0x${string}`,
          abi: BattleABI as Abi,
          functionName: 'getGameState'
        }) as bigint;
        
        if (gameState > 2n) {
          this.logger.info("Game has ended, stopping operator");
          this.stop();
          return;
        } else if (gameState == 1n) {
          this.logger.info("Game has not started, delaying");
          return;
        }
      } else if (!battle.gameStartedAt) {
        this.logger.info("Game has not started according to GraphQL, delaying");
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
          },
          {
            address: this.config.gameAddress as `0x${string}`,
            abi: BattleABI as Abi,
            functionName: 'winner'
          }
        ]
      });

      if (multicallResults[0].status === 'failure' || multicallResults[1].status === 'failure' || multicallResults[2].status === 'failure') {
        this.logger.error({
          isTurnOver: multicallResults[0].status === 'failure' ? multicallResults[0].error?.message || multicallResults[0].error : multicallResults[0].result,
          gameState: multicallResults[1].status === 'failure' ? multicallResults[1].error?.message || multicallResults[1].error : multicallResults[1].result?.toString(),
          winner: multicallResults[2].status === 'failure' ? multicallResults[2].error?.message || multicallResults[2].error : multicallResults[2].result?.toString()
        }, "Multicall failed");
        
        // If game state check succeeded but shows ended, stop the operator
        if (multicallResults[1].status === 'success') {
          const gameState = multicallResults[1].result as bigint;
          if (gameState > 2n) {
            this.logger.info({ gameState: gameState.toString() }, "Game has ended despite multicall partial failure, stopping operator");
            this.stop();
            return;
          }
        }
        
        // Also check winner field
        if (multicallResults[2].status === 'success') {
          const winner = multicallResults[2].result as bigint;
          if (winner !== 0n) {
            this.logger.info({ winner: winner.toString() }, "Game has a winner, stopping operator");
            this.stop();
            return;
          }
        }
        
        return;
      }

      const isTurnOver = multicallResults[0].result as boolean;
      const gameState = multicallResults[1].result as bigint;
      const winner = multicallResults[2].result as bigint;

      this.logger.info({
        isTurnOver,
        gameState: gameState.toString(),
        winner: winner.toString()
      }, "Multicall results");

      // Check if there's a winner (game has ended)
      if (winner !== 0n) {
        this.logger.info({ winner: winner.toString() }, "Game has a winner, stopping operator");
        this.stop();
        return;
      }

      // Only proceed if game is still active (state <= 2)
      if (gameState > 2n) {
        this.logger.info({ gameState: gameState.toString() }, "Game has ended (state > 2), stopping operator");
        this.stop();
        return;
      }

      if (gameState == 1n) {
        this.logger.info("Game has not started (state == 1), delaying");
        return;
      }

      this.logger.info({ gameState: gameState.toString(), isTurnOver, winner: winner.toString() }, "Game state");

      if (gameState == 2n && isTurnOver) {
        this.logger.info("Turn has ended, advancing to next turn");
        
        // Create wallet client for sending transactions
        const account = privateKeyToAccount(this.config.operatorPrivateKey as `0x${string}`);
        this.logger.info({ address: account.address }, "Using operator address");
        
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

        this.logger.info({ gameAddress: this.config.gameAddress }, "Calling nextTurn for game");
        this.logger.info({ forwarderAddress: this.config.erc2771ForwarderAddress }, "Using forwarder address");
        this.logger.info({ relayerUrl: this.config.relayerUrl }, "Using relayer URL");

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
        } catch (error: any) {
          console.error(error);
          console.error("I SHOUDL BE ABLE TO SEE THIS");
          this.logger.error({ error: error?.message || error, stack: error?.stack }, "Error forwarding transaction");
          return;
        }

        this.logger.info({ hash }, "Next turn transaction forwarded");

        // Wait for transaction receipt only if we have a valid hash
        if (hash) {
          try {
            const receipt = await publicClient.waitForTransactionReceipt({ hash });
            this.logger.info({ receipt }, "Next turn transaction confirmed");
          } catch (error: any) {
            this.logger.error({ error: error?.message || error, stack: error?.stack }, "Error waiting for transaction receipt");
            return;
          }
        } else {
          this.logger.error({ gameAddress: this.config.gameAddress }, "No transaction hash received from forwardTransaction for game");
          return;
        }

        this.logger.info("Turn successfully advanced");
      } else {
        this.logger.info("Turn has not ended yet");
      }
    } catch (error: any) {
      this.logger.error({ error: error?.message || error, stack: error?.stack }, "Error in checkAndAdvanceTurn");
    }
  }
}
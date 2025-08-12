import { createPublicClient, type Abi } from "viem";
import { arbitrum } from "viem/chains";
import BattleABI from "../contracts/abis/Battle.json";
import { createGraphQLClient, GraphQLQueries, queryAllPages, type Battle, type Character, type Act } from "../utils/graphql";
import { createAuthenticatedHttpTransport } from "../utils/rpc";
import { CharacterOperator } from "./CharacterOperator";
import { BattleOperator } from "./BattleOperator";
import { ActOperator } from "./ActOperator";
import { EventAggregator } from "./EventAggregator";
import { createLogger } from "../utils/logger";
import type { Logger } from "pino";

export interface OperatorManagerConfig {
  ethRpcUrl: string;
  ethWsRpcUrl: string;
  graphqlUrl: string;
  operatorAddress: string;
  operatorPrivateKey: string;
  relayerUrl: string;
  erc2771ForwarderAddress: string;
}

export class OperatorManager {
  private config: OperatorManagerConfig;
  private characterOperators: Map<string, CharacterOperator> = new Map();
  private battleOperators: Map<string, BattleOperator> = new Map();
  private actOperators: Map<string, ActOperator> = new Map();
  private eventAggregator: EventAggregator;
  private intervalId?: NodeJS.Timeout;
  private isRunning: boolean = false;
  private logger: Logger;

  constructor(config: OperatorManagerConfig) {
    this.config = config;
    this.eventAggregator = new EventAggregator(config);
    this.logger = createLogger({ operator: 'OperatorManager' });
  }

  private async checkCharacterOperators() {
    this.logger.debug("Checking character operators...");
    try {
      const graphqlClient = createGraphQLClient({ GRAPHQL_URL: this.config.graphqlUrl });
      
      // Step 1: Get all characters owned by the operator
      // Get all characters owned by the operator (with pagination)
      const characters = await queryAllPages<{ items: Character[] }>(
        graphqlClient,
        GraphQLQueries.getCharactersByOwner,
        { owner: this.config.operatorAddress.toLowerCase() }
      );

      if (!characters.length) {
        this.logger.debug("No characters found for operator");
        return;
      }

      const characterIds = characters.map(c => c.id);
      this.logger.debug(`Found ${characterIds.length} characters for operator`);

      // Step 2: Get all active battles where these characters are playing
      const battlesResult = await graphqlClient.query<{ battles: { items: any[] } }>(
        GraphQLQueries.getActiveBattlesForCharacters,
        { characterIds }
      );

      let foundCharacters = 0;

      for (const battle of battlesResult.battles.items) {
        if (!battle.players?.items) continue;

        for (const player of battle.players.items) {
          if (!player.character) continue;

          foundCharacters++;
          const operatorKey = `${battle.id}-${player.playerId}`;
          let operator = this.characterOperators.get(operatorKey);

          if (!operator || !operator.isAlive()) {
            if (operator) {
              this.logger.info(`CharacterOperator ${operatorKey} is dead, restarting...`);
              operator.stop();
            }

            operator = new CharacterOperator({
              ...this.config,
              gameAddress: battle.id,
              playerId: player.playerId,
              teamA: player.teamA,
              eventAggregator: this.eventAggregator
            });

            this.characterOperators.set(operatorKey, operator);
            operator.start();
            this.logger.info(`Started CharacterOperator for ${operatorKey} (${player.character.name})`);
          } else {
            this.logger.info(`CharacterOperator running for ${operatorKey}`);
          }
        }
      }

      if (foundCharacters === 0) {
        this.logger.debug("No characters found in active battles");
      }
    } catch (error: any) {
      if (error.message?.includes('GraphQL endpoint unavailable')) {
        this.logger.error("GraphQL endpoint is not available. Please ensure the indexer is running.");
      } else {
        this.logger.error("Error checking character operators:", error);
      }
    }
  }

  private async checkBattleOperators() {
    this.logger.debug("Checking battle operators...");
    try {
      const graphqlClient = createGraphQLClient({ GRAPHQL_URL: this.config.graphqlUrl });
      
      // Get all battles where we are operator (with pagination)
      const battles = await queryAllPages<{ items: Battle[] }>(
        graphqlClient,
        GraphQLQueries.getBattlesWithOperator,
        { operator: this.config.operatorAddress.toLowerCase() }
      );

    this.logger.info(`Found ${battles.length} battles where we are operator`);

    const publicClient = createPublicClient({
      chain: arbitrum,
      transport: createAuthenticatedHttpTransport(this.config.ethRpcUrl, { ETH_RPC_URL: this.config.ethRpcUrl })
    });

    const battleAddresses = battles.map(battle => battle.id);
    
    const gameStateContracts = battleAddresses.map(address => ({
      address: address as `0x${string}`,
      abi: BattleABI as Abi,
      functionName: 'getGameState' as const
    }));

    const gameStateResponses = await publicClient.multicall({
      contracts: gameStateContracts
    });

    const activeBattles = battles.filter((battle, index) => {
      const response = gameStateResponses[index];
      if (response.status === 'failure') {
        this.logger.error(`Failed to get game state for battle ${battle.id}:`, response.error);
        return false;
      }
      const gameState = Number(response.result);
      this.logger.debug(`Battle ${battle.id} has gameState: ${gameState}`);
      return gameState === 2;
    });

    this.logger.info(`Found ${activeBattles.length} active battles (gameState == 2)`);

    for (const battle of activeBattles) {
      const battleAddress = battle.id.toLowerCase();
      let operator = this.battleOperators.get(battleAddress);

      if (!operator || !operator.isAlive()) {
        if (operator) {
          this.logger.info(`BattleOperator ${battleAddress} is dead, restarting...`);
          operator.stop();
        }

        operator = new BattleOperator({
          ...this.config,
          gameAddress: battleAddress,
          eventAggregator: this.eventAggregator
        });

        this.battleOperators.set(battleAddress, operator);
        operator.start();
        this.logger.info(`Started BattleOperator for ${battleAddress}`);
      } else {
        this.logger.info(`BattleOperator running for ${battleAddress}`);
      }
    }
    } catch (error: any) {
      if (error.message?.includes('GraphQL endpoint unavailable')) {
        this.logger.error("GraphQL endpoint is not available. Please ensure the indexer is running.");
      } else {
        this.logger.error("Error checking battle operators:", error);
      }
    }
  }

  private async checkActOperators() {
    this.logger.debug("Checking act operators...");
    try {
      const graphqlClient = createGraphQLClient({ GRAPHQL_URL: this.config.graphqlUrl });
      const result = await graphqlClient.query<{ acts: { items: Act[] } }>(GraphQLQueries.getAllOpenActsWithOperator, {
        operator: this.config.operatorAddress.toLowerCase()
      });

    for (const act of result.acts.items) {
      const actAddress = act.address.toLowerCase();
      let operator = this.actOperators.get(actAddress);

      if (!operator || !operator.isAlive()) {
        if (operator) {
          this.logger.info(`ActOperator ${actAddress} is dead, restarting...`);
          operator.stop();
        }

        operator = new ActOperator({
          ...this.config,
          actAddress: actAddress,
          eventAggregator: this.eventAggregator
        });

        this.actOperators.set(actAddress, operator);
        operator.start();
        this.logger.info(`Started ActOperator for ${actAddress}`);
      } else {
        this.logger.info(`ActOperator running for ${actAddress}`);
      }
    }
    } catch (error: any) {
      if (error.message?.includes('GraphQL endpoint unavailable')) {
        this.logger.error("GraphQL endpoint is not available. Please ensure the indexer is running.");
      } else {
        this.logger.error("Error checking act operators:", error);
      }
    }
  }

  private async checkAndStartBots(): Promise<void> {
    await this.checkCharacterOperators();
    await this.checkBattleOperators();
    await this.checkActOperators();
  }

  async start(): Promise<void> {
    if (this.isRunning) {
      this.logger.info("OperatorManager is already running");
      return;
    }

    this.logger.info("Starting OperatorManager...");
    this.isRunning = true;

    // Start the event aggregator
    this.eventAggregator.start();
    this.logger.info("Started EventAggregator");

    // Initial check
    try {
      await this.checkAndStartBots();
    } catch (error) {
      this.logger.error("Error during initial bot check:", error);
    }

    // Set up periodic checks every 5 seconds
    this.intervalId = setInterval(async () => {
      this.logger.debug("OperatorManager periodic check...");
      try {
        await this.checkAndStartBots();
      } catch (error) {
        this.logger.error("Error during periodic check:", error);
      }
    }, 5000);
  }

  async stop(): Promise<void> {
    if (!this.isRunning) {
      this.logger.info("OperatorManager is not running");
      return;
    }

    this.logger.info("Stopping OperatorManager...");
    this.isRunning = false;

    // Clear the interval
    if (this.intervalId) {
      clearInterval(this.intervalId);
      this.intervalId = undefined;
    }

    // Stop all operators
    for (const [key, operator] of this.characterOperators) {
      this.logger.info(`Stopping CharacterOperator ${key}`);
      operator.stop();
    }
    this.characterOperators.clear();

    for (const [key, operator] of this.battleOperators) {
      this.logger.info(`Stopping BattleOperator ${key}`);
      operator.stop();
    }
    this.battleOperators.clear();

    for (const [key, operator] of this.actOperators) {
      this.logger.info(`Stopping ActOperator ${key}`);
      operator.stop();
    }
    this.actOperators.clear();

    // Stop the event aggregator
    this.eventAggregator.stop();
    this.logger.info("Stopped EventAggregator");
  }

  getStatus() {
    return {
      running: this.isRunning,
      characterOperators: Array.from(this.characterOperators.entries()).map(([key, op]) => ({
        key,
        alive: op.isAlive()
      })),
      battleOperators: Array.from(this.battleOperators.entries()).map(([key, op]) => ({
        key,
        alive: op.isAlive()
      })),
      actOperators: Array.from(this.actOperators.entries()).map(([key, op]) => ({
        key,
        alive: op.isAlive()
      })),
      eventAggregator: {
        alive: this.eventAggregator.isAlive()
      }
    };
  }
}
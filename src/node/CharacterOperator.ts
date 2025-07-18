import { createPublicClient, createWalletClient, encodeFunctionData, type Abi } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { arbitrum } from "viem/chains";
import BattleABI from "../contracts/abis/Battle.json";
import { forwardTransaction } from "../forwarder/forwardTransaction";
import { createGraphQLClient, GraphQLQueries, type BattlePlayer } from "../utils/graphql";
import { getPlayerEnergy } from "../utils/playerStats";
import { cardPileBitsToArray } from "../utils/cardPiles";
import { createAuthenticatedHttpTransport } from "../utils/rpc";
import { createLogger } from "../utils/logger";
import type { Logger } from "pino";

export interface CharacterOperatorConfig {
  ethRpcUrl: string;
  ethWsRpcUrl: string;
  graphqlUrl: string;
  operatorAddress: string;
  operatorPrivateKey: string;
  relayerUrl: string;
  erc2771ForwarderAddress: string;
  gameAddress: string;
  playerId: string;
  teamA: boolean;
}

export class CharacterOperator {
  private config: CharacterOperatorConfig;
  private intervalId?: NodeJS.Timeout;
  private isRunning: boolean = false;
  private lastCheckTime: number = 0;
  private lastActionTime: number = 0;
  private logger: Logger;

  constructor(config: CharacterOperatorConfig) {
    this.config = config;
    this.logger = createLogger({ 
      operator: 'CharacterOperator',
      gameAddress: config.gameAddress,
      playerId: config.playerId
    });
  }

  private log(message: string, ...args: any[]) {
    this.logger.info({ ...args[0] }, message);
  }

  private error(message: string, ...args: any[]) {
    this.logger.error({ ...args[0] }, message);
  }

  start() {
    if (this.isRunning) {
      this.log("Already running");
      return;
    }

    this.isRunning = true;
    this.log("Starting...");

    // Initial check
    this.performPeriodicCheck();

    // Set up periodic checks every 5 seconds
    this.intervalId = setInterval(() => {
      this.performPeriodicCheck();
    }, 5000);
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
  }

  isAlive(): boolean {
    if (!this.isRunning) return false;
    
    const timeSinceLastCheck = Date.now() - this.lastCheckTime;
    const timeSinceLastAction = Date.now() - this.lastActionTime;
    
    // Consider dead if no check in 30 seconds
    if (timeSinceLastCheck > 30000) return false;
    
    // Consider dead if no action in 10 minutes
    if (this.lastActionTime > 0 && timeSinceLastAction > 600000) return false;
    
    return true;
  }

  private async performPeriodicCheck() {
    this.lastCheckTime = Date.now();
    
    try {
      const shouldContinue = await this.executeBotLogic();
      if (!shouldContinue) {
        this.log("Bot logic indicated to stop");
        this.stop();
      }
    } catch (error) {
      this.error("Error in periodic check:", error);
    }
  }

  private async executeBotLogic(): Promise<boolean> {
    this.log('executeBotLogic', {
      gameAddress: this.config.gameAddress,
      playerId: this.config.playerId,
      teamA: this.config.teamA
    });

    const publicClient = createPublicClient({
      chain: arbitrum,
      transport: createAuthenticatedHttpTransport(this.config.ethRpcUrl, { ETH_RPC_URL: this.config.ethRpcUrl })
    });

    try {
      // Check if it's our team's turn using GraphQL for efficiency
      const graphqlClient = createGraphQLClient({ GRAPHQL_URL: this.config.graphqlUrl });
      const battleResult = await graphqlClient.query<{ battles: { items: any[] } }>(GraphQLQueries.getBattlesByGameState);
      
      const battle = battleResult.battles.items.find(b => b.id.toLowerCase() === this.config.gameAddress.toLowerCase());
      
      if (!battle) {
        this.log("Battle not found for game address", this.config.gameAddress);
        return false;
      }

      if (battle.winner != null) {
        this.log("Battle already finished with winner", battle.winner, "for game address", this.config.gameAddress);
        return false;
      }

      if (!battle.gameStartedAt) {
        this.log("Battle has not started yet", battle.id);
        return true;
      }

      // Check if it's our team's turn
      const isTeamATurn = await publicClient.readContract({
        address: this.config.gameAddress as `0x${string}`,
        abi: BattleABI as Abi,
        functionName: 'isTeamATurn'
      }) as boolean;

      this.log(`Turn check: isTeamATurn=${isTeamATurn}, botTeamA=${this.config.teamA}, match=${isTeamATurn === this.config.teamA}`);
      
      if (isTeamATurn === this.config.teamA) {
        this.log("It's our turn to play!");
        await this.playTurn(publicClient);
      } else {
        this.log("Not time to play yet");
      }

      return true;
    } catch (error) {
      this.error("Error in executeBotLogic:", error);
      return true;
    }
  }

  private async playTurn(publicClient: any) {
    const playerId = BigInt(this.config.playerId);
    const gameAddress = this.config.gameAddress as `0x${string}`;

    // First check if the game is still active
    const winner = await publicClient.readContract({
      address: gameAddress,
      abi: BattleABI as Abi,
      functionName: 'winner'
    }) as any;

    if (winner !== 0n) {
      this.log('Game has ended with winner:', winner);
      return;
    }

    // Get current energy
    const playerStats = await publicClient.readContract({
      address: gameAddress,
      abi: BattleABI as Abi,
      functionName: 'getPlayerStats',
      args: [playerId]
    }) as any;

    const statsBytes = playerStats.stats as string;
    this.log('Raw player stats:', playerStats);
    
    let currentEnergy = getPlayerEnergy(statsBytes);
    this.log('Current energy:', currentEnergy);

    // Get player's card pile state
    const cardPileState = await publicClient.readContract({
      address: gameAddress,
      abi: BattleABI as Abi,
      functionName: 'getPlayerCardPileState',
      args: [playerId]
    }) as any;

    const handBits = BigInt(cardPileState.hand);
    this.log('Hand bits:', handBits.toString(16));
    
    let handCards = cardPileBitsToArray(handBits);
    this.log('Hand cards:', handCards);

    // Play cards while we have energy
    let actionsThisTurn = 0;
    const maxActionsPerTurn = 5;

    this.log('Starting card play loop:', {
      currentEnergy,
      handCardsLength: handCards.length,
      actionsThisTurn,
      maxActionsPerTurn
    });
    
    while (currentEnergy > 0n && handCards.length > 0 && actionsThisTurn < maxActionsPerTurn) {
      // Re-read hand state before each card play
      const freshCardPileState = await publicClient.readContract({
        address: gameAddress,
        abi: BattleABI as Abi,
        functionName: 'getPlayerCardPileState',
        args: [playerId]
      }) as any;

      const freshHandBits = BigInt(freshCardPileState.hand);
      handCards = cardPileBitsToArray(freshHandBits);
      this.log('Refreshed hand cards:', handCards);

      if (handCards.length === 0) {
        this.log('No cards in hand after refresh');
        break;
      }

      // Find the first card we can afford to play
      let playableCardId = -1;
      let playableHandIndex = -1;
      
      for (let i = 0; i < handCards.length; i++) {
        const cardId = handCards[i];
        const energyRequired = await publicClient.readContract({
          address: gameAddress,
          abi: BattleABI as Abi,
          functionName: 'energyRequired',
          args: [playerId, BigInt(i)]
        }) as bigint;

        this.log(`Checking card ${cardId} at hand index ${i}: energy required=${energyRequired}, current energy=${currentEnergy}`);

        if (energyRequired <= currentEnergy) {
          playableCardId = cardId;
          playableHandIndex = i;
          break;
        }
      }

      if (playableHandIndex === -1) {
        this.log('No playable cards with current energy:', currentEnergy);
        break;
      }

      const energyCost = await publicClient.readContract({
        address: gameAddress,
        abi: BattleABI as Abi,
        functionName: 'energyRequired',
        args: [playerId, BigInt(playableHandIndex)]
      }) as bigint;

      this.log(`Playing card ID ${playableCardId} at hand index ${playableHandIndex}, energy cost: ${energyCost}`);
      
      // Get enemy players to target
      const battlePlayers = await this.getBattlePlayers();
      const enemyPlayers = battlePlayers.filter(p => p.teamA !== this.config.teamA && !p.eliminated);
      
      if (enemyPlayers.length === 0) {
        this.log('No enemy players available');
        break;
      }

      // Target random enemy
      const randomEnemy = enemyPlayers[Math.floor(Math.random() * enemyPlayers.length)];
      
      // Encode action parameters
      const targetPlayerId = BigInt(randomEnemy.playerId);
      const actionParams = `0x${targetPlayerId.toString(16).padStart(64, '0')}`;

      // Play the card using hand index
      const actionData = encodeFunctionData({
        abi: BattleABI as Abi,
        functionName: 'action',
        args: [playerId, BigInt(playableHandIndex), actionParams]
      });

      const account = privateKeyToAccount(this.config.operatorPrivateKey as `0x${string}`);
      this.log("Using operator address:", account.address);
      const walletClient = createWalletClient({
        account,
        chain: arbitrum,
        transport: createAuthenticatedHttpTransport(this.config.ethRpcUrl, { ETH_RPC_URL: this.config.ethRpcUrl })
      });

      try {
        const hash = await forwardTransaction(
          {
            to: gameAddress,
            data: actionData,
            rpcUrl: this.config.ethRpcUrl,
            relayerUrl: this.config.relayerUrl,
            env: { ETH_RPC_URL: this.config.ethRpcUrl } as any
          },
          walletClient,
          this.config.erc2771ForwarderAddress as `0x${string}`
        );

        this.log(`Played card ID ${playableCardId} at hand index ${playableHandIndex} against player ${randomEnemy.playerId}, tx: ${hash}`);
        
        await publicClient.waitForTransactionReceipt({ hash });
        
        // Get updated energy
        const updatedStats = await publicClient.readContract({
          address: gameAddress,
          abi: BattleABI as Abi,
          functionName: 'getPlayerStats',
          args: [playerId]
        }) as any;
        
        const updatedStatsBytes = updatedStats.stats as string;
        currentEnergy = getPlayerEnergy(updatedStatsBytes);
        
        actionsThisTurn++;
        this.log('Updated energy:', currentEnergy, 'Hand size:', handCards.length);
        
        this.lastActionTime = Date.now();
      } catch (error: any) {
        if (error.message?.includes('CardNotInHandError')) {
          this.log('Card no longer in hand, continuing with other cards');
          continue;
        } else if (error.message?.includes('GameHasNotStartedError')) {
          this.log('Game has ended, stopping card play');
          break;
        } else {
          this.log('Error playing card:', error);
          throw error;
        }
      }
    }

    // Check if game is still active before ending turn
    const currentWinner = await publicClient.readContract({
      address: gameAddress,
      abi: BattleABI as Abi,
      functionName: 'winner'
    }) as any;

    if (currentWinner !== 0n) {
      this.log('Game has ended, skipping end turn');
      return;
    }

    // End turn if we haven't already
    const currentTurn = await publicClient.readContract({
      address: gameAddress,
      abi: BattleABI as Abi,
      functionName: 'currentTurn'
    }) as bigint;

    const hasEndedTurn = await publicClient.readContract({
      address: gameAddress,
      abi: BattleABI as Abi,
      functionName: 'playerEndedTurn',
      args: [playerId, currentTurn]
    }) as boolean;

    if (!hasEndedTurn) {
      this.log('Ending turn');
      
      const endTurnData = encodeFunctionData({
        abi: BattleABI as Abi,
        functionName: 'endTurn',
        args: [playerId]
      });

      const account = privateKeyToAccount(this.config.operatorPrivateKey as `0x${string}`);
      const walletClient = createWalletClient({
        account,
        chain: arbitrum,
        transport: createAuthenticatedHttpTransport(this.config.ethRpcUrl, { ETH_RPC_URL: this.config.ethRpcUrl })
      });

      try {
        const hash = await forwardTransaction(
          {
            to: gameAddress,
            data: endTurnData,
            rpcUrl: this.config.ethRpcUrl,
            relayerUrl: this.config.relayerUrl,
            env: { ETH_RPC_URL: this.config.ethRpcUrl } as any
          },
          walletClient,
          this.config.erc2771ForwarderAddress as `0x${string}`
        );

        this.log(`Ended turn, tx: ${hash}`);
        await publicClient.waitForTransactionReceipt({ hash });
      } catch (error: any) {
        if (error.message?.includes('GameHasNotStartedError')) {
          this.log('Game has ended, cannot end turn');
        } else {
          throw error;
        }
      }
    }
  }

  private async getBattlePlayers(): Promise<BattlePlayer[]> {
    const graphqlClient = createGraphQLClient({ GRAPHQL_URL: this.config.graphqlUrl });
    const result = await graphqlClient.query<{ battlePlayers: { items: BattlePlayer[] } }>(GraphQLQueries.getBattlePlayers, {
      battleId: this.config.gameAddress.toLowerCase()
    });
    return result.battlePlayers.items;
  }
}
import { createPublicClient, createWalletClient, encodeFunctionData, type Abi } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { arbitrum } from "viem/chains";
import BattleABI from "../contracts/abis/Battle.json";
import PlayerDeckManagerABI from "../contracts/abis/PlayerDeckManager.json";
import { forwardTransaction } from "../forwarder/forwardTransaction";
import { createGraphQLClient, GraphQLQueries, type BattlePlayer } from "../utils/graphql";
import { getPlayerEnergy } from "../utils/playerStats";
import { cardPileBitsToArray } from "../utils/cardPiles";
import { createAuthenticatedHttpTransport } from "../utils/rpc";
import { EventAggregator } from "./EventAggregator";
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
  eventAggregator: EventAggregator;
}

export class CharacterOperator {
  private config: CharacterOperatorConfig;
  private intervalId?: NodeJS.Timeout;
  private isRunning: boolean = false;
  private lastCheckTime: number = 0;
  private lastActionTime: number = 0;
  private eventUnsubscribe?: () => void;
  private logger: Logger;
  private isExecuting: boolean = false;

  constructor(config: CharacterOperatorConfig) {
    this.config = config;
    this.logger = createLogger({ 
      operator: 'CharacterOperator',
      gameAddress: config.gameAddress,
      playerId: config.playerId
    });
  }


  start() {
    if (this.isRunning) {
      this.logger.info("Already running");
      return;
    }

    this.isRunning = true;
    this.logger.info("Starting...");

    // Subscribe to NextTurnEvent
    this.eventUnsubscribe = this.config.eventAggregator.subscribe({
      eventName: "NextTurnEvent",
      abi: BattleABI as any[],
      address: this.config.gameAddress,
      onEvent: async (logs: any[]) => {
        this.logger.info(`NextTurnEvent triggered with ${logs.length} logs`);
        for (const log of logs) {
          this.logger.info({
            address: log.address,
            turn: log.args?.turn?.toString(),
            team: log.args?.teamATurn ? "A" : "B",
            isOurTurn: log.args?.teamATurn === this.config.teamA
          }, "NextTurnEvent details");
        }
        // Trigger turn check immediately when it's our turn
        this.performPeriodicCheck();
      }
    });

    // Initial check
    this.performPeriodicCheck();

    // Set up periodic checks every 5 seconds
    this.intervalId = setInterval(() => {
      this.performPeriodicCheck();
    }, 5000);
  }

  stop() {
    if (!this.isRunning) {
      this.logger.info("Not running");
      return;
    }

    this.logger.info("Stopping...");
    this.isRunning = false;

    // Unsubscribe from events
    if (this.eventUnsubscribe) {
      this.eventUnsubscribe();
      this.eventUnsubscribe = undefined;
    }

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
        this.logger.info("Bot logic indicated to stop");
        this.stop();
      }
    } catch (error: any) {
      this.logger.error({ error: error?.message || error, stack: error?.stack }, "Error in periodic check");
    }
  }

  private async executeBotLogic(): Promise<boolean> {
    // Prevent concurrent execution
    if (this.isExecuting) {
      this.logger.info('Already executing bot logic, skipping...');
      return true;
    }
    
    this.isExecuting = true;
    
    try {
      this.logger.info({
        gameAddress: this.config.gameAddress,
        playerId: this.config.playerId,
        teamA: this.config.teamA
      }, 'executeBotLogic');

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
        this.logger.info("Battle not found for game address " + this.config.gameAddress);
        return false;
      }

      if (battle.winner != null) {
        this.logger.info("Battle already finished with winner " + battle.winner + " for game address " + this.config.gameAddress);
        return false;
      }

      if (!battle.gameStartedAt) {
        this.logger.info("Battle has not started yet " + battle.id);
        return true;
      }

      // Check if it's our team's turn
      const isTeamATurn = await publicClient.readContract({
        address: this.config.gameAddress as `0x${string}`,
        abi: BattleABI as Abi,
        functionName: 'isTeamATurn'
      }) as boolean;

      this.logger.info(`Turn check: isTeamATurn=${isTeamATurn}, botTeamA=${this.config.teamA}, match=${isTeamATurn === this.config.teamA}`);
      
      if (isTeamATurn === this.config.teamA) {
        this.logger.info("It's our turn to play!");
        await this.playTurn(publicClient);
      } else {
        this.logger.info("Not time to play yet");
      }

      return true;
    } catch (error: any) {
      this.logger.error({ error: error?.message || error, stack: error?.stack }, `Error in executeBotLogic: ${error?.message || error}`);
      return true;
    }
    } finally {
      this.isExecuting = false;
    }
  }

  private async playTurn(publicClient: any) {
    const playerId = BigInt(this.config.playerId);
    const gameAddress = this.config.gameAddress as `0x${string}`;

    // Create wallet client for transactions
    const account = privateKeyToAccount(this.config.operatorPrivateKey as `0x${string}`);
    const walletClient = createWalletClient({
      account,
      chain: arbitrum,
      transport: createAuthenticatedHttpTransport(this.config.ethRpcUrl, { ETH_RPC_URL: this.config.ethRpcUrl })
    });

    // First check if the game is still active
    const winner = await publicClient.readContract({
      address: gameAddress,
      abi: BattleABI as Abi,
      functionName: 'winner'
    }) as any;

    if (winner !== 0n) {
      this.logger.info({ winner: winner.toString() }, 'Game has ended with winner');
      return;
    }

    // Get current turn
    const currentTurn = await publicClient.readContract({
      address: gameAddress,
      abi: BattleABI as Abi,
      functionName: 'currentTurn'
    }) as bigint;

    // Get the PlayerDeckManager address from the Battle contract first
    const playerDeckManagerAddress = await publicClient.readContract({
      address: gameAddress,
      abi: BattleABI as Abi,
      functionName: 'playerDeckManager'
    }) as `0x${string}`;

    // Get the player's deckId from the Battle contract
    let deckId = await publicClient.readContract({
      address: gameAddress,
      abi: BattleABI as Abi,
      functionName: 'playerDeckIds',
      args: [playerId]
    }) as bigint;

    this.logger.info(`Player ${playerId} has deckId: ${deckId}`);

    // If deckId is 0, the deck hasn't been created yet - skip this turn
    if (deckId === 0n) {
      this.logger.info(`Deck not yet created for player ${playerId}, cannot play turn`);
      return;
    }

    // Get lastTurnHandDrawn from GraphQL to check if we need to draw a new hand
    let lastTurnHandDrawn: bigint | undefined;
    try {
      const graphqlClient = createGraphQLClient({ GRAPHQL_URL: this.config.graphqlUrl });
      const battlePlayersResult = await graphqlClient.query<{ battlePlayers: { items: BattlePlayer[] } }>(GraphQLQueries.getBattlePlayers, {
        battleId: gameAddress.toLowerCase()
      });
      
      const thisPlayer = battlePlayersResult.battlePlayers.items.find(
        p => p.playerId === playerId.toString()
      );
      
      if (thisPlayer?.lastTurnHandDrawn) {
        lastTurnHandDrawn = BigInt(thisPlayer.lastTurnHandDrawn);
        this.logger.info(`Player's lastTurnHandDrawn: ${lastTurnHandDrawn}, currentTurn: ${currentTurn}`);
      }
    } catch (error: any) {
      this.logger.warn({ error: error.message }, 'Could not get lastTurnHandDrawn from GraphQL');
    }

    // Determine if we need to draw a new hand or just get the current state
    let pileState: { drawPile: `0x${string}`, hand: `0x${string}`, discardPile: `0x${string}` };
    
    if (lastTurnHandDrawn === undefined || lastTurnHandDrawn !== currentTurn) {
      // Hand needs to be drawn for this turn - use computeDiscardAndDrawHand
      this.logger.info(`Computing new hand for turn ${currentTurn} (lastTurnHandDrawn: ${lastTurnHandDrawn}`);
      
      // Get the random number for this turn from the contract
      const randomSeed = await publicClient.readContract({
        address: gameAddress,
        abi: BattleABI as Abi,
        functionName: 'getCurrentTurnRandomNumber'
      }) as bigint;
      
      const handSize = 5n; // Standard hand size
      
      pileState = await publicClient.readContract({
        address: playerDeckManagerAddress,
        abi: PlayerDeckManagerABI as Abi,
        functionName: 'computeDiscardAndDrawHand',
        args: [deckId, handSize, randomSeed]
      }) as { drawPile: `0x${string}`, hand: `0x${string}`, discardPile: `0x${string}` };
      
      // Now update the player's hand in the Battle contract
      const updateHandData = encodeFunctionData({
        abi: BattleABI as Abi,
        functionName: 'updatePlayerHand',
        args: [playerId]
      });

      try {
        const updateHash = await forwardTransaction(
          {
            to: gameAddress,
            data: updateHandData,
            rpcUrl: this.config.ethRpcUrl,
            relayerUrl: this.config.relayerUrl,
            env: { ETH_RPC_URL: this.config.ethRpcUrl } as any
          },
          walletClient,
          this.config.erc2771ForwarderAddress as `0x${string}`
        );
        this.logger.info({ tx: updateHash }, `Updated player hand in Battle contract`);
        await publicClient.waitForTransactionReceipt({ hash: updateHash });
      } catch (error: any) {
        this.logger.warn({ error: error.message?.substring(0, 100) }, 'updatePlayerHand failed (continuing anyway)');
      }
    } else {
      // Hand is already drawn for this turn - just get the current state
      this.logger.info(`Using existing hand for turn ${currentTurn}`);
      pileState = await publicClient.readContract({
        address: playerDeckManagerAddress,
        abi: PlayerDeckManagerABI as Abi,
        functionName: 'getPileState',
        args: [deckId]
      }) as { drawPile: `0x${string}`, hand: `0x${string}`, discardPile: `0x${string}` };
    }

    // Now get the current energy AFTER drawing the hand
    // This ensures we have the correct energy for the current turn
    const playerStats = await publicClient.readContract({
      address: gameAddress,
      abi: BattleABI as Abi,
      functionName: 'getPlayerStats',
      args: [playerId]
    }) as any;

    const statsBytes = playerStats.stats as string;
    this.logger.info({ stats: playerStats }, 'Raw player stats');
    
    let currentEnergy = getPlayerEnergy(statsBytes);
    this.logger.info({ energy: currentEnergy }, 'Current energy');

    // Convert hand bits to array of card IDs
    const handBits = BigInt(pileState.hand);
    let handCards = cardPileBitsToArray(handBits);
    this.logger.info({ cards: handCards }, 'Hand cards');

    // Calculate energy requirements for all cards at the beginning
    const cardEnergyRequirements: Map<number, bigint> = new Map();
    for (let i = 0; i < handCards.length; i++) {
      const energyRequired = await publicClient.readContract({
        address: gameAddress,
        abi: BattleABI as Abi,
        functionName: 'energyRequired',
        args: [playerId, BigInt(i)]
      }) as bigint;
      cardEnergyRequirements.set(i, energyRequired);
      this.logger.info(`Card ${handCards[i]} at index ${i} requires ${energyRequired} energy`);
    }

    // Play cards while turn has not ended
    let actionsThisTurn = 0;
    const attemptedCardIndices = new Set<number>(); // Track which cards we've tried
    
    // Check if turn has ended
    let hasEndedTurn = await publicClient.readContract({
      address: gameAddress,
      abi: BattleABI as Abi,
      functionName: 'playerEndedTurn',
      args: [playerId, currentTurn]
    }) as boolean;
    
    this.logger.info({
      currentTurn: currentTurn.toString(),
      currentEnergy,
      handCardsLength: handCards.length,
      actionsThisTurn,
      hasEndedTurn
    }, 'Starting card play loop');
    
    while (!hasEndedTurn) {
      // Re-check deckId in case it was created during the game
      if (deckId === 0n) {
        const currentDeckId = await publicClient.readContract({
          address: gameAddress,
          abi: BattleABI as Abi,
          functionName: 'playerDeckIds',
          args: [playerId]
        }) as bigint;
        
        if (currentDeckId === 0n) {
          this.logger.info(`Deck still not created for player ${playerId}, cannot play cards`);
          break;
        }
        // Update deckId if it was just created
        deckId = currentDeckId;
      }

      // Re-read hand state before each card play
      const freshPileState = await publicClient.readContract({
        address: playerDeckManagerAddress,
        abi: PlayerDeckManagerABI as Abi,
        functionName: 'getPileState',
        args: [deckId]
      }) as { drawPile: `0x${string}`, hand: `0x${string}`, discardPile: `0x${string}` };

      const freshHandBits = BigInt(freshPileState.hand);
      handCards = cardPileBitsToArray(freshHandBits);
      this.logger.info({ cards: handCards }, 'Refreshed hand cards');

      // Find all playable cards (those we can afford with current energy and haven't tried yet)
      const playableCards: { handIndex: number; cardId: number; energyCost: bigint }[] = [];
      
      for (let handIndex = 0; handIndex < handCards.length; handIndex++) {
        const cardId = handCards[handIndex];
        
        // Skip cards we've already attempted this turn (by card ID, not hand index)
        if (attemptedCardIndices.has(cardId)) {
          continue;
        }
        
        // Get the current energy requirement for this hand position
        const energyRequired = await publicClient.readContract({
          address: gameAddress,
          abi: BattleABI as Abi,
          functionName: 'energyRequired',
          args: [playerId, BigInt(handIndex)]
        }) as bigint;

        if (energyRequired <= currentEnergy) {
          playableCards.push({ handIndex, cardId, energyCost: energyRequired });
        }
      }

      // Filter out cards we've already attempted
      const untriedPlayableCards = playableCards.filter(card => !attemptedCardIndices.has(card.cardId));
      
      // If no cards can be played or all playable cards have been tried, end the turn
      if (playableCards.length === 0 || untriedPlayableCards.length === 0) {
        this.logger.info({
          currentTurn: currentTurn.toString(),
          currentEnergy,
          playableCardsCount: playableCards.length,
          untriedCount: untriedPlayableCards.length,
          attemptedCount: attemptedCardIndices.size,
          attemptedCards: Array.from(attemptedCardIndices)
        }, 'No more playable cards');
        
        // Check if it's still our turn before ending
        const isStillOurTurn = await publicClient.readContract({
          address: gameAddress,
          abi: BattleABI as Abi,
          functionName: 'isTeamATurn'
        }) as boolean;
        
        if (isStillOurTurn !== this.config.teamA) {
          this.logger.info('Turn has already changed, not ending turn');
          break;
        }
        
        // End the turn
        const endTurnData = encodeFunctionData({
          abi: BattleABI as Abi,
          functionName: 'endTurn',
          args: [playerId]
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
          this.logger.info({ tx: hash }, 'Ended turn (no playable cards)');
          await publicClient.waitForTransactionReceipt({ hash });
          // Update hasEndedTurn flag after successfully ending turn
          hasEndedTurn = true;
        } catch (error: any) {
          if (error.message?.includes('GameHasNotStartedError')) {
            this.logger.info('Game has ended, cannot end turn');
          } else {
            throw error;
          }
        }
        break;
      }

      // Randomly select a card from the untried playable cards
      const selectedCard = untriedPlayableCards[Math.floor(Math.random() * untriedPlayableCards.length)];
      const playableCardId = selectedCard.cardId;
      const playableHandIndex = selectedCard.handIndex;
      const energyCost = selectedCard.energyCost;

      // Mark this card as attempted (by card ID, not hand index)
      attemptedCardIndices.add(playableCardId);

      this.logger.info(`Randomly selected card ID ${playableCardId} at hand index ${playableHandIndex}, energy cost: ${energyCost}`);
      
      // Get active enemy players to target
      const enemyPlayers = await this.getActiveEnemyPlayers();
      
      if (enemyPlayers.length === 0) {
        this.logger.info('No enemy players available');
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

        this.logger.info({ cardId: playableCardId, handIndex: playableHandIndex, targetPlayer: randomEnemy.playerId, tx: hash }, 'Played card');
        
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
        this.logger.info({ energy: currentEnergy, handSize: handCards.length }, 'Updated energy');
        
        this.lastActionTime = Date.now();
        
        // Sleep for 1 second after successfully playing an action
        this.logger.info('Sleeping for 1 second after action...');
        await new Promise(resolve => setTimeout(resolve, 1000));
      } catch (error: any) {
        if (error.message?.includes('CardNotInHandError')) {
          // This can happen if there's a race condition or state mismatch
          this.logger.info({
            playableHandIndex,
            playableCardId,
            attemptedIndices: Array.from(attemptedCardIndices)
          }, 'CardNotInHandError - marking card as attempted and continuing');
          // Continue to next iteration instead of breaking - this allows us to try other cards
          // The attempted card is already marked, so we won't try it again
          continue;
        } else if (error.message?.includes('GameHasNotStartedError')) {
          this.logger.info('Game has ended, stopping card play');
          break;
        } else if (error.message?.includes('InsufficientEnergyError')) {
          this.logger.warn('Insufficient energy for card, this should not happen with proper energy checking');
          break;
        } else {
          this.logger.error({ error: error.message || error }, 'Error playing card');
          throw error;
        }
      }
      
      // Check if turn has ended after playing card
      hasEndedTurn = await publicClient.readContract({
        address: gameAddress,
        abi: BattleABI as Abi,
        functionName: 'playerEndedTurn',
        args: [playerId, currentTurn]
      }) as boolean;
    }

    // Turn should be ended by now, either explicitly when no cards could be played
    // or automatically by the contract when energy is depleted
    this.logger.info('Turn play completed');
  }
  
  private async getBattlePlayers(): Promise<BattlePlayer[]> {
    const graphqlClient = createGraphQLClient({ GRAPHQL_URL: this.config.graphqlUrl });
    const result = await graphqlClient.query<{ battlePlayers: { items: BattlePlayer[] } }>(GraphQLQueries.getBattlePlayers, {
      battleId: this.config.gameAddress.toLowerCase()
    });
    return result.battlePlayers.items;
  }

  private async getActiveEnemyPlayers(): Promise<BattlePlayer[]> {
    const graphqlClient = createGraphQLClient({ GRAPHQL_URL: this.config.graphqlUrl });
    const result = await graphqlClient.query<{ battlePlayers: { items: BattlePlayer[] } }>(GraphQLQueries.getActiveEnemyPlayers, {
      battleId: this.config.gameAddress.toLowerCase(),
      isTeamA: this.config.teamA
    });
    return result.battlePlayers.items;
  }
}

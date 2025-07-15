import { Env } from "./Env";
import { createPublicClient, http, createWalletClient, encodeFunctionData, type Abi } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { arbitrum } from "viem/chains";
import BattleABI from "./contracts/abis/Battle.json";
import { forwardTransaction } from "./forwarder/forwardTransaction";
import { createGraphQLClient, GraphQLQueries, type BattlePlayer } from "./utils/graphql";
import { Operator, type EventSubscription } from "./Operator";
import { getPlayerEnergy } from "./utils/playerStats";
import { cardPileBitsToArray, removeCardFromHand } from "./utils/cardPiles";

export class CharacterOperator extends Operator {
  private gameAddress: string | null = null;
  private playerId: string | null = null;
  private teamA: boolean | null = null;

  constructor(state: DurableObjectState, env: Env) {
    super(state, env);
  }

  protected async getOperatorId(): Promise<string | null> {
    const gameAddress = await this.state.storage.get("gameAddress");
    const playerId = await this.state.storage.get("playerId");
    return gameAddress && playerId ? `${gameAddress}-${playerId}` : null;
  }

  protected getDurableObjectNamespace(): string {
    return "CHARACTER_OPERATOR";
  }

  protected async validateStartParameters(params: URLSearchParams): Promise<string | null> {
    const gameAddress = params.get("gameAddress");
    const playerId = params.get("playerId");
    const teamA = params.get("teamA");
    
    if (!gameAddress || !playerId || teamA === null) {
      return "Missing required parameters: gameAddress, playerId, and teamA are all required";
    }
    
    return null;
  }

  protected async getEventSubscriptions(): Promise<EventSubscription[]> {
    const storedGameAddress = await this.state.storage.get("gameAddress");
    return [
      {
          eventName: "EndedTurnEvent",
          abi: BattleABI as any[],
          address: storedGameAddress as `0x${string}`,
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
              
              // Trigger turn advancement check
              await this.alarm();
            }
          }
      }
    ];
  }

  protected async performPeriodicCheck(): Promise<number> {
    const shouldContinue = await this.executeBotLogic();
    if (!shouldContinue) {
      return 0;
    }
    return Date.now() + 5000;
  }

  private async executeBotLogic(): Promise<boolean> {
    // Retrieve stored values
    const storedGameAddress = await this.state.storage.get("gameAddress");
    const storedPlayerId = await this.state.storage.get("playerId");
    const storedTeamA = await this.state.storage.get("teamA");

    if (typeof storedGameAddress !== 'string' || typeof storedPlayerId !== 'string') {
      console.error("Missing stored game parameters");
      return false;
    }

    this.gameAddress = storedGameAddress;
    this.playerId = storedPlayerId;
    this.teamA = storedTeamA === true || storedTeamA === "true";

    this.log = (message: string, ...args: any[]) => {
      // console.log({
      //   playerId: this.playerId,
      //   message,
      //   arguments: args
      // }, { origin: "CHARACTEROPERATOR" });
    };

    this.log('executeBotLogic', { gameAddress: this.gameAddress, playerId: this.playerId, teamA: this.teamA });

    // Create public client
    const publicClient = createPublicClient({
      chain: arbitrum,
      transport: http(this.env.ETH_RPC_URL)
    });

    try {
      // Check if it's our team's turn using GraphQL for efficiency
      const graphqlClient = createGraphQLClient(this.env);
      const battleResult = await graphqlClient.query<{battles: {items: any[]}}>(GraphQLQueries.getBattlesByGameState);
      
      const battle = battleResult.battles.items.find(b => b.id.toLowerCase() === this.gameAddress!.toLowerCase());
      
      if (!battle) {
        this.log("Battle not found for game address", this.gameAddress);
        return false;
      }

      if (battle.winner != null) {
        this.log("Battle already finished with winner", battle.winner, "for game address", this.gameAddress);
        return false; // No need to continue if the battle is already finished
      }

      if (!battle.gameStartedAt) {
        this.log("Battle has not started yet", battle.id);
        return true; // Wait for the next check
      }

      // Check if it's our team's turn
      const isTeamATurn = await publicClient.readContract({
        address: this.gameAddress as `0x${string}`,
        abi: BattleABI as Abi,
        functionName: 'isTeamATurn'
      }) as boolean;

      this.log(`Turn check: isTeamATurn=${isTeamATurn} (${typeof isTeamATurn}), botTeamA=${this.teamA} (${typeof this.teamA}), match=${isTeamATurn === this.teamA}`);
      
      if (isTeamATurn === this.teamA) {
        this.log("It's our turn to play!");
        await this.playTurn(publicClient, this.log);
      } else {
        this.log("Not time to play yet");
      }

      return true;
    } catch (error) {
      console.error("Error in executeBotLogic:", error);
      return true;
    }
  }

  private async playTurn(publicClient: any) {
    const playerId = BigInt(this.playerId!);
    const gameAddress = this.gameAddress as `0x${string}`;

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

    // Get energy using the utility function
    const statsBytes = playerStats.stats as string;
    this.log('Raw player stats:', playerStats);
    
    let currentEnergy = getPlayerEnergy(statsBytes);
    this.log('Current energy (from utility):', currentEnergy, 'typeof:', typeof currentEnergy);

    // Get player's card pile state
    const cardPileState = await publicClient.readContract({
      address: gameAddress,
      abi: BattleABI as Abi,
      functionName: 'getPlayerCardPileState',
      args: [playerId]
    }) as any;

    const handBits = BigInt(cardPileState.hand);
    this.log('Hand bits:', handBits.toString(16));
    
    // Convert hand bits to array of card indices using utility function
    let handCards = cardPileBitsToArray(handBits);
    
    this.log('Hand cards:', handCards);

    // Play cards while we have energy
    let actionsThisTurn = 0;
    const maxActionsPerTurn = 5; // Prevent infinite loops

    this.log('Starting card play loop:', { currentEnergy, handCardsLength: handCards.length, actionsThisTurn, maxActionsPerTurn });
    
    while (currentEnergy > 0n && handCards.length > 0 && actionsThisTurn < maxActionsPerTurn) {
      // Re-read hand state before each card play to ensure we have latest state
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
          args: [playerId, BigInt(i)] // i is the index in the hand, not card ID
        }) as bigint;

        this.log(`Checking card ${cardId} at hand index ${i}: energy required=${energyRequired}, current energy=${currentEnergy}, affordable=${energyRequired <= currentEnergy}`);

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
      const enemyPlayers = battlePlayers.filter(p => p.teamA !== this.teamA && !p.eliminated);
      
      if (enemyPlayers.length === 0) {
        this.log('No enemy players available');
        break;
      }

      // Target random enemy
      const randomEnemy = enemyPlayers[Math.floor(Math.random() * enemyPlayers.length)];
      
      // Encode action parameters (target player) as hex string
      const targetPlayerId = BigInt(randomEnemy.playerId);
      const actionParams = `0x${targetPlayerId.toString(16).padStart(64, '0')}`;

      // Play the card using hand index
      const actionData = encodeFunctionData({
        abi: BattleABI as Abi,
        functionName: 'action',
        args: [playerId, BigInt(playableHandIndex), actionParams]
      });

      const privateKey = this.env.OPERATOR_PRIVATE_KEY;
      if (!privateKey) {
        this.error("OPERATOR_PRIVATE_KEY is not set in environment");
        throw new Error("Missing OPERATOR_PRIVATE_KEY");
      }
      const account = privateKeyToAccount(privateKey as `0x${string}`);
      this.log("Using operator address:", account.address);
      const walletClient = createWalletClient({
        account,
        chain: arbitrum,
        transport: http(this.env.ETH_RPC_URL)
      });

      try {
        const hash = await forwardTransaction(
          {
            to: gameAddress,
            data: actionData,
            rpcUrl: this.env.ETH_RPC_URL,
            relayerUrl: this.env.RELAYER_URL
          },
          walletClient,
          this.env.ERC2771_FORWARDER_ADDRESS as `0x${string}`
        );

        this.log(`Played card ID ${playableCardId} at hand index ${playableHandIndex} against player ${randomEnemy.playerId}, tx: ${hash}`);
        
        // Wait for transaction and update state
        await publicClient.waitForTransactionReceipt({ hash });
        
        // Get updated energy and hand
        const updatedStats = await publicClient.readContract({
          address: gameAddress,
          abi: BattleABI as Abi,
          functionName: 'getPlayerStats',
          args: [playerId]
        }) as any;
        
        // Get updated energy using the utility function
        const updatedStatsBytes = updatedStats.stats as string;
        currentEnergy = getPlayerEnergy(updatedStatsBytes);
        
        actionsThisTurn++;
        this.log('Updated energy:', currentEnergy, 'Hand size:', handCards.length);
        
        await this.state.storage.put("lastActionTime", Date.now());
      } catch (error: any) {
        if (error.message?.includes('CardNotInHandError')) {
          this.log('Card no longer in hand, continuing with other cards');
          // Continue to next iteration, don't break
          continue;
        } else if (error.message?.includes('GameHasNotStartedError')) {
          this.log('Game has ended, stopping card play');
          break;
        } else {
          this.log('Error playing card:', error);
          // Re-throw other errors
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

      const privateKey = this.env.OPERATOR_PRIVATE_KEY;
      if (!privateKey) {
        this.error("OPERATOR_PRIVATE_KEY is not set in environment");
        throw new Error("Missing OPERATOR_PRIVATE_KEY");
      }
      const account = privateKeyToAccount(privateKey as `0x${string}`);
      this.log("Using operator address:", account.address);
      const walletClient = createWalletClient({
        account,
        chain: arbitrum,
        transport: http(this.env.ETH_RPC_URL)
      });

      try {
        const hash = await forwardTransaction(
          {
            to: gameAddress,
            data: endTurnData,
            rpcUrl: this.env.ETH_RPC_URL,
            relayerUrl: this.env.RELAYER_URL
          },
          walletClient,
          this.env.ERC2771_FORWARDER_ADDRESS as `0x${string}`
        );

        this.log(`Ended turn, tx: ${hash}`);
        console.log("CHARACTER OPERATOR ENDED TUUUUUUUURN!!!!!!!!!!!!!!")
        await publicClient.waitForTransactionReceipt({ hash });
      } catch (error: any) {
        if (error.message?.includes('GameHasNotStartedError')) {
          this.log('Game has ended, cannot end turn');
        } else {
          // Re-throw other errors
          throw error;
        }
      }
    }
  }

  private async getBattlePlayers(): Promise<BattlePlayer[]> {
    const graphqlClient = createGraphQLClient(this.env);
    const result = await graphqlClient.query<{battlePlayers: {items: BattlePlayer[]}}>(GraphQLQueries.getBattlePlayers, {
      battleId: this.gameAddress!.toLowerCase()
    });
    return result.battlePlayers.items;
  }

}
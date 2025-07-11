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

  protected async getEventSubscriptions(): Promise<EventSubscription[]> {
    return [];
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

    const characterLog = (message: string, ...args: any[]) => {
      console.log({
        playerId: this.playerId,
        message,
        arguments: args
      }, { origin: "CHARACTEROPERATOR" });
    };

    characterLog('executeBotLogic', { gameAddress: this.gameAddress, playerId: this.playerId, teamA: this.teamA });

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
      
      if (!battle || !battle.gameStartedAt) {
        characterLog("Game not started yet");
        return true;
      }

      // Check if it's our team's turn
      const isTeamATurn = await publicClient.readContract({
        address: this.gameAddress as `0x${string}`,
        abi: BattleABI as Abi,
        functionName: 'isTeamATurn'
      }) as boolean;

      characterLog(`Turn check: isTeamATurn=${isTeamATurn} (${typeof isTeamATurn}), botTeamA=${this.teamA} (${typeof this.teamA}), match=${isTeamATurn === this.teamA}`);
      
      if (isTeamATurn === this.teamA) {
        characterLog("It's our turn to play!");
        await this.playTurn(publicClient, characterLog);
      } else {
        characterLog("Not time to play yet");
      }

      return true;
    } catch (error) {
      console.error("Error in executeBotLogic:", error);
      return true;
    }
  }

  private async playTurn(publicClient: any, characterLog: (message: string, ...args: any[]) => void) {
    const playerId = BigInt(this.playerId!);
    const gameAddress = this.gameAddress as `0x${string}`;


    // Get current energy
    const playerStats = await publicClient.readContract({
      address: gameAddress,
      abi: BattleABI as Abi,
      functionName: 'getPlayerStats',
      args: [playerId]
    }) as any;

    // Get energy using the utility function
    const statsBytes = playerStats.stats as string;
    characterLog('Raw player stats:', playerStats);
    
    let currentEnergy = getPlayerEnergy(statsBytes);
    characterLog('Current energy (from utility):', currentEnergy, 'typeof:', typeof currentEnergy);

    // Get player's card pile state
    const cardPileState = await publicClient.readContract({
      address: gameAddress,
      abi: BattleABI as Abi,
      functionName: 'getPlayerCardPileState',
      args: [playerId]
    }) as any;

    const handBits = BigInt(cardPileState.hand);
    characterLog('Hand bits:', handBits.toString(16));
    
    // Convert hand bits to array of card indices using utility function
    let handCards = cardPileBitsToArray(handBits);
    
    characterLog('Hand cards:', handCards);

    // Play cards while we have energy
    let actionsThisTurn = 0;
    const maxActionsPerTurn = 5; // Prevent infinite loops

    characterLog('Starting card play loop:', { currentEnergy, handCardsLength: handCards.length, actionsThisTurn, maxActionsPerTurn });
    
    while (currentEnergy > 0n && handCards.length > 0 && actionsThisTurn < maxActionsPerTurn) {
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

        characterLog(`Checking card ${cardId} at hand index ${i}: energy required=${energyRequired}, current energy=${currentEnergy}, affordable=${energyRequired <= currentEnergy}`);

        if (energyRequired <= currentEnergy) {
          playableCardId = cardId;
          playableHandIndex = i;
          break;
        }
      }

      if (playableHandIndex === -1) {
        characterLog('No playable cards with current energy:', currentEnergy);
        break;
      }

      const energyCost = await publicClient.readContract({
        address: gameAddress,
        abi: BattleABI as Abi,
        functionName: 'energyRequired',
        args: [playerId, BigInt(playableHandIndex)]
      }) as bigint;

      characterLog(`Playing card ID ${playableCardId} at hand index ${playableHandIndex}, energy cost: ${energyCost}`);
      
      // Remove the card from our local hand array since it will be discarded
      handCards = removeCardFromHand(handCards, playableCardId);

      // Get enemy players to target
      const battlePlayers = await this.getBattlePlayers();
      const enemyPlayers = battlePlayers.filter(p => p.teamA !== this.teamA && !p.eliminated);
      
      if (enemyPlayers.length === 0) {
        characterLog('No enemy players available');
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

      const account = privateKeyToAccount(this.env.OPERATOR_PRIVATE_KEY as `0x${string}`);
      const walletClient = createWalletClient({
        account,
        chain: arbitrum,
        transport: http(this.env.ETH_RPC_URL)
      });

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

      characterLog(`Played card ID ${playableCardId} at hand index ${playableHandIndex} against player ${randomEnemy.playerId}, tx: ${hash}`);
      
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
      characterLog('Updated energy:', currentEnergy, 'Hand size:', handCards.length);
      
      await this.state.storage.put("lastActionTime", Date.now());
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
      characterLog('Ending turn');
      
      const endTurnData = encodeFunctionData({
        abi: BattleABI as Abi,
        functionName: 'endTurn',
        args: [playerId]
      });

      const account = privateKeyToAccount(this.env.OPERATOR_PRIVATE_KEY as `0x${string}`);
      const walletClient = createWalletClient({
        account,
        chain: arbitrum,
        transport: http(this.env.ETH_RPC_URL)
      });

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

      characterLog(`Ended turn, tx: ${hash}`);
      await publicClient.waitForTransactionReceipt({ hash });
    }
  }

  private async getBattlePlayers(): Promise<BattlePlayer[]> {
    const graphqlClient = createGraphQLClient(this.env);
    const result = await graphqlClient.query<{battlePlayers: {items: BattlePlayer[]}}>(GraphQLQueries.getBattlePlayers, {
      battleId: this.gameAddress!.toLowerCase()
    });
    return result.battlePlayers.items;
  }

  async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);
    
    if (url.pathname === "/start") {
      const requestedGameAddress = url.searchParams.get("gameAddress");
      const requestedPlayerId = url.searchParams.get("playerId");
      const teamAParam = url.searchParams.get("teamA");
      
      if (!requestedGameAddress || !requestedPlayerId || teamAParam === null) {
        return new Response("Missing gameAddress or playerId or teamA", { status: 400 });
      }

      this.playerId = requestedPlayerId;
      this.teamA = teamAParam === "true";
      
      console.log(`CharacterOperator starting: playerId=${this.playerId}, teamAParam="${teamAParam}", teamA=${this.teamA}`);
      
      await this.state.storage.put("playerId", this.playerId);
      await this.state.storage.put("teamA", this.teamA);
      await this.state.storage.put("lastRun", Date.now());
      await this.state.storage.put("lastActionTime", Date.now());

      return await super.fetch(request);
    }

    if (url.pathname === "/status") {
      const playerId = await this.state.storage.get("playerId");
      const teamA = await this.state.storage.get("teamA");
      const lastActionTime = await this.state.storage.get("lastActionTime");

      return new Response(JSON.stringify({
        playerId,
        teamA,
        lastActionTime
      }), {
        headers: { "Content-Type": "application/json" }
      });
    }

    return await super.fetch(request);
  }
}
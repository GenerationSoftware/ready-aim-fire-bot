import { Env } from "./Env";
import { createPublicClient, http, createWalletClient } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { arbitrum } from "viem/chains";
import BattleABI from "./contracts/abis/Battle.json";
import BasicDeckABI from "./contracts/abis/BasicDeck.json";
import { encodeFunctionData, encodePacked, type Abi } from "viem";
import { forwardTransaction } from "./forwarder/forwardTransaction";
import { CONTRACT_ADDRESSES } from "./utils/deployments";
import { createGraphQLClient, GraphQLQueries, type BattlePlayer } from "./utils/graphql";

interface Player {
  address: string;
  playerId: string;
  teamA: boolean;
}


export class CharacterOperator {
  private state: DurableObjectState;
  private env: Env;
  private gameAddress: string | null = null;
  private playerId: string | null = null;
  private teamA: boolean | null = null;

  constructor(state: DurableObjectState, env: Env) {
    this.state = state;
    this.env = env;
  }

  private async getGamePlayers(gameAddress: string): Promise<Player[]> {
    try {
      // Use GraphQL to get battle players instead of scanning events
      const graphqlClient = createGraphQLClient(this.env);
      const result = await graphqlClient.query<{battlePlayers: {items: BattlePlayer[]}}>(GraphQLQueries.getBattlePlayers, {
        battleId: gameAddress.toLowerCase()
      });

      return result.battlePlayers.items.map(player => ({
        address: player.character, // In GraphQL this is the character contract address
        playerId: player.playerId,
        teamA: player.teamA
      }));
    } catch (error) {
      console.error("Error getting players from GraphQL, falling back to events:", error);
      
      // Fallback to original event-based approach
      const publicClient = createPublicClient({
        chain: arbitrum,
        transport: http(this.env.ETH_RPC_URL)
      });

      const playerJoinedEvent = (BattleABI as Abi).find(item => item.type === 'event' && 'name' in item && item.name === 'PlayerJoinedEvent') as any;
      if (!playerJoinedEvent) {
        throw new Error('PlayerJoinedEvent not found in ABI');
      }

      const currentBlock = await publicClient.getBlockNumber();
      const logs = await publicClient.getLogs({
        event: playerJoinedEvent,
        address: gameAddress as `0x${string}`,
        fromBlock: 0n,
        toBlock: currentBlock
      });

      return logs.map(log => {
        const args = (log as any).args as { owner: `0x${string}`, playerId: bigint, locationX: bigint };
        return {
          address: args.owner,
          playerId: args.playerId.toString(),
          teamA: args.locationX === 0n
        };
      });
    }
  }

  private async executeBotLogic() {
    // Retrieve stored values
    const storedGameAddress = await this.state.storage.get("gameAddress");
    const storedPlayerId = await this.state.storage.get("playerId");
    const storedTeamA = await this.state.storage.get("teamA") as boolean | null;
    const lastActionTime = await this.state.storage.get("lastActionTime") as number;
    const players = await this.getGamePlayers(storedGameAddress as string);

    if (typeof storedGameAddress === 'string' && typeof storedPlayerId === 'string') {
      this.gameAddress = storedGameAddress;
      this.playerId = storedPlayerId;
      this.teamA = storedTeamA;

      const characterLog = (message: string, ...args: any[]) => {
        // console.log({
        //   origin: "BOT",
        //   gameAddress: this.gameAddress,
        //   playerId: this.playerId,
        //   message,
        //   arguments: args
        // });
      };

      const characterError = (message: string, ...args: any[]) => {
        console.error({
          origin: "CHARACTER_OPERATOR",
          gameAddress: this.gameAddress,
          playerId: this.playerId,
          message,
          arguments: args
        });
      };

      characterLog(`executeBotLogic`, { gameAddress: this.gameAddress, playerId: this.playerId, teamA: this.teamA});
      if (players) {
        characterLog('Players', players);
      }

      // Create public client for game state checks
      const publicClient = createPublicClient({
        chain: arbitrum,
        transport: http(this.env.ETH_RPC_URL)
      });

      // Check game state - try GraphQL first for efficiency
      let gameState: bigint;
      try {
        const graphqlClient = createGraphQLClient(this.env);
        const battleResult = await graphqlClient.query<{battles: {items: any[]}}>(GraphQLQueries.getBattlesByGameState);
        
        const battle = battleResult.battles.items.find(b => b.id.toLowerCase() === this.gameAddress!.toLowerCase());
        
        if (battle && battle.gameStartedAt) {
          gameState = 2n; // Game is started
          characterLog('Game state from GraphQL: started');
        } else {
          // Fall back to contract call
          gameState = await publicClient.readContract({
            address: this.gameAddress as `0x${string}`,
            abi: BattleABI as Abi,
            functionName: 'getGameState'
          }) as bigint;
          characterLog('Game state from contract:', gameState);
        }
      } catch (error) {
        characterError('Error getting game state from GraphQL, falling back to contract:', error);
        gameState = await publicClient.readContract({
          address: this.gameAddress as `0x${string}`,
          abi: BattleABI as Abi,
          functionName: 'getGameState'
        }) as bigint;
      }

      characterLog('executeBotLogic', { gameAddress: this.gameAddress, gameState });

      if (gameState === 2n) {
        // Check if it's our team's turn
        const isTeamATurn = await publicClient.readContract({
          address: this.gameAddress as `0x${string}`,
          abi: BattleABI as Abi,
          functionName: 'isTeamATurn'
        }) as boolean;

        if (isTeamATurn === this.teamA) {
          characterLog("It's our turn to play!");

          // Get our player stats to check energy
          const playerStats = await publicClient.readContract({
            address: this.gameAddress as `0x${string}`,
            abi: BattleABI as Abi,
            functionName: 'getPlayerStats',
            args: [BigInt(this.playerId)]
          }) as any;

          let currentEnergy = playerStats.stats[1] as bigint; // Second field is energy
          characterLog('Current energy', { currentEnergy });

          // Get our cards
          const playerCards = await publicClient.readContract({
            address: this.gameAddress as `0x${string}`,
            abi: BattleABI as Abi,
            functionName: 'playerCards',
            args: [BigInt(this.playerId)]
          }) as any[];

          // Use multicall to get action types for all cards
          const actionTypeCalls = playerCards.map(card => ({
            address: CONTRACT_ADDRESSES.BASIC_DECK as `0x${string}`,
            abi: BasicDeckABI as Abi,
            functionName: 'tokenActionType',
            args: [BigInt(card.tokenId)]
          }));

          const actionTypes = await publicClient.multicall({
            contracts: actionTypeCalls
          });

          // Filter for cards with action types 1, 3, or 4
          const validCards = playerCards.filter((card, index) => {
            const actionType = actionTypes[index].result;
            if (actionType === undefined) {
              characterError('Undefined action type', { tokenId: card.tokenId });
              return false;
            }
            const actionTypeBigInt = typeof actionType === 'string' ? BigInt(actionType) : (actionType as bigint);
            characterLog('Card info', { tokenId: card.tokenId, actionType: actionTypeBigInt});
            return [1n, 3n, 4n].includes(actionTypeBigInt);
          });

          characterLog('Valid cards', { validCards: validCards.length });

          while (currentEnergy > 0n) {
            characterLog("Remaining energy", { currentEnergy });
            if (validCards.length > 0) {
              // Select a random valid card
              const randomCard = validCards[Math.floor(Math.random() * validCards.length)];
              const cardIndex = playerCards.indexOf(randomCard);

              characterLog('Playing card index:', cardIndex);

              // Get enemy players
              const enemyPlayers = (players as Player[]).filter(p => p.teamA !== this.teamA);
              if (enemyPlayers.length > 0) {
                // Select a random enemy
                const randomEnemy = enemyPlayers[Math.floor(Math.random() * enemyPlayers.length)];

                characterLog('Playing card against player:', randomEnemy.playerId);

                // Prepare the action
                const actionParams = encodePacked(
                  ['uint256'],
                  [BigInt(randomEnemy.playerId)]
                );

                const encodedData = encodeFunctionData({
                  abi: BattleABI as Abi,
                  functionName: 'action',
                  args: [BigInt(this.playerId), BigInt(cardIndex), actionParams]
                });

                // Forward the transaction
                const account = privateKeyToAccount(this.env.OPERATOR_PRIVATE_KEY as `0x${string}`);
                const walletClient = createWalletClient({
                    account,
                    chain: arbitrum,
                    transport: http(this.env.ETH_RPC_URL)
                });

                const hash = await forwardTransaction(
                  {
                    to: this.gameAddress as `0x${string}`,
                    data: encodedData,
                    rpcUrl: this.env.ETH_RPC_URL,
                    relayerUrl: this.env.RELAYER_URL
                  },
                  walletClient,
                  this.env.ERC2771_FORWARDER_ADDRESS as `0x${string}`
                );

                characterLog(`Played card ${cardIndex} against player ${randomEnemy.playerId}, tx: ${hash}`);

                // Wait for transaction to be mined
                await publicClient.waitForTransactionReceipt({ hash });

                // Update energy after action
                const updatedStats = await publicClient.readContract({
                  address: this.gameAddress as `0x${string}`,
                  abi: BattleABI as Abi,
                  functionName: 'getPlayerStats',
                  args: [BigInt(this.playerId)]
                }) as any;
                currentEnergy = updatedStats.stats[1] as bigint;
                characterLog('Updated energy:', currentEnergy);
                
                // Update last action time
                await this.state.storage.put("lastActionTime", Date.now());
              } else {
                characterLog('No enemy players found');
                break;
              }
            } else {
              characterLog('No valid cards found');
              break;
            }
          }

          // end turn
          const currentTurn = await publicClient.readContract({
            address: this.gameAddress as `0x${string}`,
            abi: BattleABI as Abi,
            functionName: 'currentTurn'
          }) as bigint;

          const hasEndedTurn = await publicClient.readContract({
            address: this.gameAddress as `0x${string}`,
            abi: BattleABI as Abi,
            functionName: 'playerEndedTurn',
            args: [BigInt(this.playerId), currentTurn]
          }) as boolean;

          if (!hasEndedTurn) {
            characterLog('Ending turn');
            const encodedData = encodeFunctionData({
              abi: BattleABI as Abi,
              functionName: 'endTurn',
              args: [BigInt(this.playerId)]
            });

            const account = privateKeyToAccount(this.env.OPERATOR_PRIVATE_KEY as `0x${string}`);
            const walletClient = createWalletClient({
              account,
              chain: arbitrum,
              transport: http(this.env.ETH_RPC_URL)
            });

            const hash = await forwardTransaction(
              {
                to: this.gameAddress as `0x${string}`,
                data: encodedData,
                rpcUrl: this.env.ETH_RPC_URL,
                relayerUrl: this.env.RELAYER_URL
              },
              walletClient,
              this.env.ERC2771_FORWARDER_ADDRESS as `0x${string}`
            );

            characterLog(`Ended turn, tx: ${hash}`);
            await publicClient.waitForTransactionReceipt({ hash });
          }
          
        } else {
          characterLog("Not time to play yet");
        }
      } else {
        if (gameState < 2n) {
            characterLog("Game not started yet");
        } else if (gameState > 2n) {
            characterLog("Game ended");
            return false;
        }
      }

      // If no action was taken in this execution, check the timeout
      const TEN_MINUTES = 10 * 60 * 1000; // 10 minutes in milliseconds
      if (Date.now() - lastActionTime > TEN_MINUTES) {
        characterLog("No action taken in 10 minutes, releasing resources");
        return false;
      }
    }
    return true;
  }

  async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);

    if (url.pathname === "/start") {
      // Check if operator is already running by looking for stored data
      const requestedGameAddress = url.searchParams.get("gameAddress");
      const requestedPlayerId = url.searchParams.get("playerId");
      
      // Store game address and player ID
      this.gameAddress = requestedGameAddress;
      this.playerId = requestedPlayerId;
      this.teamA = url.searchParams.get("teamA") === "true";

      if (!this.gameAddress || !this.playerId || this.teamA === null) {
        return new Response("Missing gameAddress or playerId or teamA", { status: 400 });
      }

      // Store in durable storage
      await this.state.storage.put("gameAddress", this.gameAddress);
      await this.state.storage.put("playerId", this.playerId);
      await this.state.storage.put("teamA", this.teamA);
      await this.state.storage.put("lastRun", Date.now());
      await this.state.storage.put("lastActionTime", Date.now());

      // Execute character logic and set the alarm
      try {
        await this.executeBotLogic();
      } catch (error) {
        console.error("Error executing character logic", error);
      }

      if (await this.state.storage.getAlarm() == null) {
        await this.state.storage.setAlarm(Date.now() + 5000);
      }
      return new Response("CharacterOperator started");
    }

    return new Response("Not found", { status: 404 });
  }

  async alarm() {
    if (await this.executeBotLogic()) {
        // Set the next alarm for 5 seconds from now
        await this.state.storage.setAlarm(Date.now() + 5000);
    } else {
        // Game is over or we don't need to continue, clean up resources
        await this.state.storage.deleteAll();
        console.log("Bot resources released - game ended or no longer needed");
    }
  }
} 
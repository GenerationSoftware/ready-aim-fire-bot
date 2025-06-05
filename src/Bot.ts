import { Env } from "./Env";
import { createPublicClient, http, createWalletClient } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { arbitrum } from "viem/chains";
import { ReadyAimFireABI } from "./abis/ReadyAimFireABI";
import { BasicDeckABI } from "./abis/BasicDeckABI";
import { encodeFunctionData, encodePacked } from "viem";
import { forwardTransaction } from "./forwarder/forwardTransaction";

interface Player {
  address: string;
  playerId: string;
  teamA: boolean;
}

export class Bot {
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
    const publicClient = createPublicClient({
      chain: arbitrum,
      transport: http(this.env.ETH_RPC_URL)
    });

    const playerJoinedEvent = ReadyAimFireABI.find(item => item.type === 'event' && item.name === 'PlayerJoinedEvent');
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
      const args = log.args as { owner: `0x${string}`, playerId: bigint, locationX: bigint };
      return {
        address: args.owner,
        playerId: args.playerId.toString(),
        teamA: args.locationX === 0n
      };
    });
  }

  private async executeBotLogic() {
    // Retrieve stored values
    const storedGameAddress = await this.state.storage.get("gameAddress");
    const storedPlayerId = await this.state.storage.get("playerId");
    const storedTeamA = await this.state.storage.get("teamA") as boolean | null;
    let storedPlayers = await this.state.storage.get("players");
    if (typeof storedPlayers === 'string') {
      storedPlayers = JSON.parse(storedPlayers);
    }

    if (typeof storedGameAddress === 'string' && typeof storedPlayerId === 'string') {
      this.gameAddress = storedGameAddress;
      this.playerId = storedPlayerId;
      this.teamA = storedTeamA;
      console.log(`Game Address: ${this.gameAddress}, Player ID: ${this.playerId}, Team A: ${this.teamA}`);
      if (storedPlayers) {
        console.log('Players:', storedPlayers);
      }

      // Create public client for game state checks
      const publicClient = createPublicClient({
        chain: arbitrum,
        transport: http(this.env.ETH_RPC_URL)
      });

      // Check if game has started
      const gameState = await publicClient.readContract({
        address: this.gameAddress as `0x${string}`,
        abi: ReadyAimFireABI,
        functionName: 'getGameState'
      });

      console.log('Current game state:', gameState);

      if (BigInt(gameState) === 2n) {
        // Check if it's our team's turn
        const isTeamATurn = await publicClient.readContract({
          address: this.gameAddress as `0x${string}`,
          abi: ReadyAimFireABI,
          functionName: 'isTeamATurn'
        });

        if (isTeamATurn === this.teamA) {
          console.log("It's our turn to play!");

          // Get our player stats to check energy
          const playerStats = await publicClient.readContract({
            address: this.gameAddress as `0x${string}`,
            abi: ReadyAimFireABI,
            functionName: 'getPlayerStatsArray',
            args: [BigInt(this.playerId)]
          });

          let currentEnergy = playerStats[1]; // Second field is energy
          console.log('Current energy:', currentEnergy);

          // Get our cards
          const playerCards = await publicClient.readContract({
            address: this.gameAddress as `0x${string}`,
            abi: ReadyAimFireABI,
            functionName: 'playerCards',
            args: [BigInt(this.playerId)]
          });

          // Filter for cards with action types 1, 3, or 4
          const validCards = [];
          for (const card of playerCards) {
            console.log('Checking card tokenId:', card.tokenId);
            const actionType = await publicClient.readContract({
              address: this.env.BASIC_DECK_ADDRESS as `0x${string}`,
              abi: BasicDeckABI,
              functionName: 'tokenActionType',
              args: [BigInt(card.tokenId)]
            });
            
            console.log('Card action type:', actionType);
            if ([1n, 3n, 4n].includes(actionType)) {
              validCards.push(card);
            }
          }

          console.log('Valid cards found:', validCards.length);

          while (currentEnergy > 0n) {
            if (validCards.length > 0) {
              // Select a random valid card
              const randomCard = validCards[Math.floor(Math.random() * validCards.length)];
              const cardIndex = playerCards.indexOf(randomCard);

              console.log('Playing card index:', cardIndex);

              // Get enemy players
              const enemyPlayers = (storedPlayers as Player[]).filter(p => p.teamA !== this.teamA);
              if (enemyPlayers.length > 0) {
                // Select a random enemy
                const randomEnemy = enemyPlayers[Math.floor(Math.random() * enemyPlayers.length)];

                console.log('Playing card against player:', randomEnemy.playerId);

                // Prepare the action
                const actionParams = encodePacked(
                  ['uint256'],
                  [BigInt(randomEnemy.playerId)]
                );

                const encodedData = encodeFunctionData({
                  abi: ReadyAimFireABI,
                  functionName: 'action',
                  args: [BigInt(this.playerId), BigInt(cardIndex), actionParams]
                });

                // Forward the transaction
                const account = privateKeyToAccount(this.env.PRIVATE_KEY as `0x${string}`);
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

                console.log(`Played card ${cardIndex} against player ${randomEnemy.playerId}, tx: ${hash}`);

                // Wait for transaction to be mined
                await publicClient.waitForTransactionReceipt({ hash });

                // Update energy after action
                const updatedStats = await publicClient.readContract({
                  address: this.gameAddress as `0x${string}`,
                  abi: ReadyAimFireABI,
                  functionName: 'getPlayerStatsArray',
                  args: [BigInt(this.playerId)]
                });
                currentEnergy = updatedStats[1];
                console.log('Updated energy:', currentEnergy);
              } else {
                console.log('No enemy players found');
                break;
              }
            } else {
              console.log('No valid cards found');
              break;
            }
          }
        } else {
          console.log("Not time to play yet");
        }
      } else {
        if (BigInt(gameState) < 2n) {
            console.log("Game not started yet");
        } else if (BigInt(gameState) > 2n) {
            console.log("Game ended");
            return false;
        }
      }
    }
    return true;
  }

  async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);

    if (url.pathname === "/start") {
      // Store game address and player ID
      this.gameAddress = url.searchParams.get("gameAddress");
      this.playerId = url.searchParams.get("playerId");
      this.teamA = url.searchParams.get("teamA") === "true";

      if (!this.gameAddress || !this.playerId || this.teamA === null) {
        return new Response("Missing gameAddress or playerId or teamA", { status: 400 });
      }

      // Get and store all players
      const players = await this.getGamePlayers(this.gameAddress);
      await this.state.storage.put("players", JSON.stringify(players));

      // Store in durable storage
      await this.state.storage.put("gameAddress", this.gameAddress);
      await this.state.storage.put("playerId", this.playerId);
      await this.state.storage.put("teamA", this.teamA);
      await this.state.storage.put("lastRun", Date.now());

      // Execute bot logic and set the alarm
      await this.executeBotLogic();
      await this.state.storage.setAlarm(Date.now() + 5000);
      return new Response("Bot started");
    }

    return new Response("Not found", { status: 404 });
  }

  async alarm() {
    if (await this.executeBotLogic()) {
        // Set the next alarm for 5 seconds from now
        await this.state.storage.setAlarm(Date.now() + 5000);
    }
  }
} 
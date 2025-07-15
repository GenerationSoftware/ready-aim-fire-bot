import { Env } from "./Env";
import BattleABI from "./contracts/abis/Battle.json";
import { createPublicClient, http, type Abi } from "viem";
import { arbitrum } from "viem/chains";
import { createGraphQLClient, GraphQLQueries, type Battle, type Character, type Ziggurat } from "./utils/graphql";

export class OperatorManager {
    state: DurableObjectState;
    env: Env;
  
    constructor(state: DurableObjectState, env: Env) {
      this.state = state;
      this.env = env;
    }

    private async checkCharacterOperators() {
      console.log("Checking character operators...");
      // Use GraphQL to find characters where our address is the operator, and get their battle players
      const graphqlClient = createGraphQLClient(this.env);
      const result = await graphqlClient.query<{characters: {items: Character[]}}>(GraphQLQueries.getMonsters, {
        owner: this.env.OPERATOR_ADDRESS.toLowerCase()
      });

      let totalBattlePlayers = 0;
      
      // Check each character and their battle players
      for (const character of result.characters.items) {
        // console.log("Checking character:", character.id);
        if (!character.battlePlayers?.items) continue;
        
        for (const battlePlayer of character.battlePlayers.items) {
          // console.log("Found battle player:", battlePlayer.playerId, "in team", battlePlayer.teamA ? "A" : "B");
          totalBattlePlayers++;
          const battle = battlePlayer.battle;
          
          // Skip if battle hasn't started
          if (!battle.gameStartedAt) {
            // console.log("Battle not started for ", battlePlayer.playerId, "in battle", battle.id);
            continue;
          }

          // console.log("battle winner: ", battle.winner)

          if (battle.winner != null) {
            // console.log("Battle already finished for player", battlePlayer.playerId, "in battle", battle.id);
            continue;
          }

          // Start character operator
          const id = this.env.CHARACTER_OPERATOR.idFromName(battlePlayer.playerId.toString());
          const characterOperator = this.env.CHARACTER_OPERATOR.get(id);
          
          // Check if operator is already running
          try {
            const statusResponse = await characterOperator.fetch(new Request(`http://operator/status`));
            if (statusResponse.ok) {
              const status = await statusResponse.json() as any;
              const lastCheckTime = status.lastCheckTime || 0;
              const timeSinceLastCheck = Date.now() - lastCheckTime;
              
              // Use the operator's own alive check
              if (!status.alive) {
                console.log(`CharacterOperator ${battle.id}-${battlePlayer.playerId} is dead (last check: ${timeSinceLastCheck}ms ago), restarting...`);
              } else if (status.running && 
                  status.parameters.gameAddress === battle.id && 
                  status.parameters.playerId === battlePlayer.playerId) {
                console.log(`CharacterOperator running for ${battle.id}-${battlePlayer.playerId} (alive: ${status.alive}, alarm in: ${status.alarmInMs}ms)`);
                continue;
              }
            }
          } catch (error) {
            // If status check fails, assume operator needs to be started
            console.log(`Status check failed for CharacterOperator ${battle.id}-${battlePlayer.playerId}, starting...`);
          }
          
          // Start the operator if not running
          characterOperator.fetch(new Request(`http://character-operator/start?gameAddress=${battle.id}&playerId=${battlePlayer.playerId}&teamA=${battlePlayer.teamA}`));
        }
      }
      
      // console.log("Found monster characters:", result.characters.items.length, "with total battle players:", totalBattlePlayers);
    }

    private async checkBattleOperators() {
      console.log("Checking battle operators...");
      // Use GraphQL to find battles where our address is the operator
      const graphqlClient = createGraphQLClient(this.env);
      
      const result = await graphqlClient.query<{battles: {items: Battle[]}}>(GraphQLQueries.getBattlesWithOperator, {
        operator: this.env.OPERATOR_ADDRESS.toLowerCase()
      });

      console.log(`Found ${result.battles.items.length} battles where we are operator`);

      // Filter battles by gameState using multicall
      const publicClient = createPublicClient({
        chain: arbitrum,
        transport: http(this.env.ETH_RPC_URL)
      });

      const battleAddresses = result.battles.items.map(battle => battle.id);
      
      // Create multicall contracts to check game state for all battles
      const gameStateContracts = battleAddresses.map(address => ({
        address: address as `0x${string}`,
        abi: BattleABI as Abi,
        functionName: 'getGameState' as const
      }));

      // Execute multicall to get all game states
      const gameStateResponses = await publicClient.multicall({
        contracts: gameStateContracts
      });

      // Filter battles where gameState == 2 (active games)
      const activeBattles = result.battles.items.filter((battle, index) => {
        const response = gameStateResponses[index];
        if (response.status === 'failure') {
          console.error(`Failed to get game state for battle ${battle.id}:`, response.error);
          return false;
        }
        const gameState = Number(response.result);
        console.log(`Battle ${battle.id} has gameState: ${gameState}`);
        return gameState === 2;
      });

      console.log(`Found ${activeBattles.length} active battles (gameState == 2)`)

      for (const battle of activeBattles) {
        const battleAddress = battle.id.toLowerCase();
        const id = this.env.BATTLE_OPERATOR.idFromName(battleAddress);
        const operator = this.env.BATTLE_OPERATOR.get(id);
        
        // Check if operator is already running
        try {
          const statusResponse = await operator.fetch(new Request(`http://operator/status`));
          if (statusResponse.ok) {
            const status = await statusResponse.json() as any;
            const lastCheckTime = status.lastCheckTime || 0;
            const timeSinceLastCheck = Date.now() - lastCheckTime;
            
            // Use the operator's own alive check
            if (!status.alive) {
              console.log(`BattleOperator ${battleAddress} is dead (last check: ${timeSinceLastCheck}ms ago), restarting...`);
            } else if (status.running && status.parameters.gameAddress === battleAddress) {
              console.log(`BattleOperator running for ${battleAddress} (alive: ${status.alive}, alarm in: ${status.alarmInMs}ms)`);
              continue;
            }
          }
        } catch (error) {
          // If status check fails, assume operator needs to be started
          console.log(`Status check failed for BattleOperator ${battleAddress}, starting...`);
        }
        
        // Start the operator if not running
        operator.fetch(new Request(`http://operator/start?gameAddress=${battleAddress}`));
      }
    }

    private async checkZigguratOperators() {
      console.log("Checking ziggurat operators...");
      // Use GraphQL to find parties where our operator is the character
      const graphqlClient = createGraphQLClient(this.env);
      const result = await graphqlClient.query<{ziggurats: {items: Ziggurat[]}}>(GraphQLQueries.getAllOpenZigguratsWithOperator, {
        operator: this.env.OPERATOR_ADDRESS.toLowerCase()
      });

      // console.log("Found %s open ziggurats:", result.ziggurats.items.length);
      
      for (const zig of result.ziggurats.items) {
        const zigAddress = zig.address.toLowerCase();
        const id = this.env.ZIGGURAT_OPERATOR.idFromName(zigAddress);
        const zigguratOperator = this.env.ZIGGURAT_OPERATOR.get(id);
        
        // Check if operator is already running
        try {
          const statusResponse = await zigguratOperator.fetch(new Request(`http://operator/status`));
          if (statusResponse.ok) {
            const status = await statusResponse.json() as any;
            const lastCheckTime = status.lastCheckTime || 0;
            const timeSinceLastCheck = Date.now() - lastCheckTime;
            
            // Use the operator's own alive check
            if (!status.alive) {
              console.log(`ZigguratOperator ${zigAddress} is dead (last check: ${timeSinceLastCheck}ms ago), restarting...`);
            } else if (status.running && status.parameters.zigguratAddress === zigAddress) {
              console.log(`ZigguratOperator running for ${zigAddress} (alive: ${status.alive}, alarm in: ${status.alarmInMs}ms)`);
              continue;
            }
          }
        } catch (error) {
          // If status check fails, assume operator needs to be started
          console.log(`Status check failed for ZigguratOperator ${zigAddress}, starting...`);
        }
        
        // Start the operator if not running
        zigguratOperator.fetch(new Request(`http://ziggurat-operator/start?zigguratAddress=${zigAddress}`));
      }
    }

    private async checkAndStartBots(): Promise<void> {
        // Use GraphQL to discover and start operators
        await this.checkCharacterOperators();
        await this.checkBattleOperators();
        await this.checkZigguratOperators();
    }
  
    async fetch(request: Request): Promise<Response> {
      const url = new URL(request.url);
  
      if (url.pathname === "/start") {
        await this.state.storage.deleteAlarm();
        await this.state.storage.deleteAll();
        
        // Initialize the EventAggregator
        try {
          const aggregator = this.env.EVENT_AGGREGATOR.get(
            this.env.EVENT_AGGREGATOR.idFromName("global")
          );
          const statusResponse = await aggregator.fetch(new Request('http://aggregator/status'));
          const status = await statusResponse.json() as any;
          console.log("EventAggregator status:", status);
        } catch (error) {
          console.error("Error checking EventAggregator:", error);
        }
        
        try {
          await this.checkAndStartBots();
        } catch (error: unknown) {
          console.error("Error in /start:", error);
          const errorMessage = error instanceof Error ? error.message : "Unknown error occurred";
          await this.state.storage.setAlarm(Date.now() + 5000);
          return new Response(`Error starting bot: ${errorMessage}.  Re-trying in 5 seconds`, { status: 500 });
        }
        await this.state.storage.setAlarm(Date.now() + 5000);
        return new Response("Awaiting games.");
      } else if (url.pathname === "/reset") {
        await this.state.storage.deleteAlarm();
        await this.state.storage.deleteAll();
        return new Response("Reset listener");
      }

      return new Response("Not found", { status: 404 });
    }

  async alarm() {
    console.log("OperatorManager waking up...");
    try {
      await this.checkAndStartBots();
    } catch (error) {
      console.error("Error in alarm:", error);
    }
    await this.state.storage.setAlarm(Date.now() + 5000);
  }
}

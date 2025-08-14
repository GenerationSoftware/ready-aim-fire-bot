import { createPublicClient, createWalletClient, encodeFunctionData, type Abi } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { arbitrum } from "viem/chains";
import ActABI from "../contracts/abis/Act.json";
import BattleRoomABI from "../contracts/abis/BattleRoom.json";
import { forwardTransaction } from "../forwarder/forwardTransaction";
import { createGraphQLClient, GraphQLQueries, type Party, type ActRoom } from "../utils/graphql";
import { createAuthenticatedHttpTransport } from "../utils/rpc";
import { createLogger } from "../utils/logger";
import type { Logger } from "pino";

import type { EventAggregator } from "./EventAggregator";

// Room struct matching the Solidity contract
interface Room {
  roomType: number;
  monsterIndex1: number;
  monsterIndex2: number;
  monsterIndex3: number;
  nextRooms: number[]; // uint32[6] array
}

// Map room from the JSON - flat array structure
interface MapRoom {
  id: number;
  roomType: number; // 0=NULL, 1=BATTLE, 2=GOAL
  monsterIndex1: number | null; // Monster index (0-65535) or null
  nextRooms: number[]; // Array of next room IDs (up to 6)
}

export interface ActOperatorConfig {
  ethRpcUrl: string;
  ethWsRpcUrl: string;
  graphqlUrl: string;
  operatorAddress: string;
  operatorPrivateKey: string;
  relayerUrl: string;
  erc2771ForwarderAddress: string;
  actAddress: string;
  eventAggregator: EventAggregator;
  rafApiUrl?: string;
  rafApiUsername?: string;
  rafApiPassword?: string;
}

export class ActOperator {
  private config: ActOperatorConfig;
  private intervalId?: NodeJS.Timeout;
  private isRunning: boolean = false;
  private lastCheckTime: number = 0;
  private logger: Logger;
  private eventUnsubscribes: Array<() => void> = [];
  private processingParties: Set<string> = new Set(); // Track parties being processed
  private recentlyProcessedParties: Map<string, number> = new Map(); // Track recently processed parties with timestamp
  private roomMap: Map<number, Room> = new Map(); // Cache of room ID to Room struct
  private startingRoomId?: number; // Cache the starting room ID
  private battleRoomAddress?: string; // Cache the BattleRoom contract address

  constructor(config: ActOperatorConfig) {
    this.config = config;
    this.logger = createLogger({ operator: 'ActOperator', actAddress: config.actAddress });
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

  private async fetchAndProcessMap(): Promise<void> {
    try {
      // Get environment variables with fallbacks
      const rafApiUrl = this.config.rafApiUrl || process.env.RAF_API_URL;
      const rafApiUsername = this.config.rafApiUsername || process.env.RAF_API_USERNAME;
      const rafApiPassword = this.config.rafApiPassword || process.env.RAF_API_PASSWORD;

      if (!rafApiUrl || !rafApiUsername || !rafApiPassword) {
        this.error("Missing RAF API configuration. Please set RAF_API_URL, RAF_API_USERNAME, and RAF_API_PASSWORD");
        return;
      }

      // Get the starting room ID from the contract
      const publicClient = createPublicClient({
        chain: arbitrum,
        transport: createAuthenticatedHttpTransport(this.config.ethRpcUrl, { ETH_RPC_URL: this.config.ethRpcUrl })
      });

      this.startingRoomId = Number(await publicClient.readContract({
        address: this.config.actAddress as `0x${string}`,
        abi: ActABI as Abi,
        functionName: 'STARTING_ROOM_ID'
      }));

      this.log(`Starting room ID: ${this.startingRoomId}`);
      
      // Get the BattleRoom contract address
      this.battleRoomAddress = await publicClient.readContract({
        address: this.config.actAddress as `0x${string}`,
        abi: ActABI as Abi,
        functionName: 'battleRoom'
      }) as string;
      
      this.log(`BattleRoom address: ${this.battleRoomAddress}`);

      // Query GraphQL to get season name and act index for this act
      const graphqlClient = createGraphQLClient({ GRAPHQL_URL: this.config.graphqlUrl });
      
      // First get the seasonAct to find the season and act index
      const seasonActQuery = `
        query GetSeasonActInfo($actAddress: String!) {
          seasonActs(where: { actAddress: $actAddress }) {
            items {
              seasonAddress
              actIndex
              actAddress
            }
          }
        }
      `;
      
      const seasonActResult = await graphqlClient.query<{ seasonActs: { items: any[] } }>(seasonActQuery, {
        actAddress: this.config.actAddress.toLowerCase()
      });

      if (!seasonActResult.seasonActs.items || seasonActResult.seasonActs.items.length === 0) {
        this.error(`SeasonAct not found in GraphQL for address ${this.config.actAddress}`);
        return;
      }

      const seasonActInfo = seasonActResult.seasonActs.items[0];
      const actIndex = seasonActInfo.actIndex;
      
      // Now get the season name
      const seasonQuery = `
        query GetSeasonInfo($seasonAddress: String!) {
          seasons(where: { address: $seasonAddress }) {
            items {
              address
              name
            }
          }
        }
      `;
      
      const seasonResult = await graphqlClient.query<{ seasons: { items: any[] } }>(seasonQuery, {
        seasonAddress: seasonActInfo.seasonAddress.toLowerCase()
      });

      if (!seasonResult.seasons.items || seasonResult.seasons.items.length === 0) {
        this.error(`Season not found in GraphQL for address ${seasonActInfo.seasonAddress}`);
        return;
      }

      const seasonName = seasonResult.seasons.items[0].name;
      
      this.log(`Act info: season=${seasonName}, actIndex=${actIndex}`);

      // Fetch the map JSON with new URL structure
      const mapUrl = `${rafApiUrl}/season/${seasonName}/act/${actIndex}/map.json`;
      
      this.log(`Fetching map from: ${mapUrl}`);
      
      const auth = btoa(`${rafApiUsername}:${rafApiPassword}`);
      const response = await fetch(mapUrl, {
        headers: {
          'Authorization': `Basic ${auth}`
        }
      });

      if (!response.ok) {
        throw new Error(`Failed to fetch map: ${response.status} ${response.statusText}`);
      }

      const mapResponse: any = await response.json();
      this.log(`Map data fetched successfully - raw response type: ${typeof mapResponse}, isArray: ${Array.isArray(mapResponse)}`);
      
      // The response should be a direct array of rooms
      if (!Array.isArray(mapResponse)) {
        this.error(`Expected array but got: ${JSON.stringify(mapResponse).substring(0, 500)}`);
        throw new Error(`Map response is not an array`);
      }
      
      const mapData = mapResponse as MapRoom[];
      this.log(`Processing ${mapData.length} rooms from map`);

      // Process the flat array of rooms into room ID -> Room struct mapping
      this.processMapRooms(mapData);
      this.log(`Processed ${this.roomMap.size} rooms from map`);

    } catch (error: any) {
      this.error(`Error fetching or processing map: ${error.message || error}`, {
        message: error.message,
        stack: error.stack,
        rafApiUrl: this.config.rafApiUrl || process.env.RAF_API_URL,
        actAddress: this.config.actAddress,
        error: error.toString()
      });
    }
  }

  private processMapRooms(mapRooms: MapRoom[]): void {
    // Process each room in the flat array
    for (const mapRoom of mapRooms) {
      // roomType is already a number: 0=NULL, 1=BATTLE, 2=GOAL
      const roomTypeNum = mapRoom.roomType;
      
      // monsterIndex1 is now directly an integer or null
      const monsterIndex = mapRoom.monsterIndex1 ?? 0;
      
      // Ensure nextRooms array is exactly 6 elements
      const nextRooms = [...mapRoom.nextRooms];
      while (nextRooms.length < 6) {
        nextRooms.push(0);
      }
      // Trim to exactly 6 if somehow longer
      nextRooms.splice(6);
      
      // Create the Room struct matching the Solidity structure
      const room: Room = {
        roomType: roomTypeNum,
        monsterIndex1: monsterIndex,
        monsterIndex2: 0, // Not used in current map format
        monsterIndex3: 0, // Not used in current map format
        nextRooms: nextRooms
      };
      
      // Store the room by its ID
      this.roomMap.set(mapRoom.id, room);
      
      const roomTypeStr = roomTypeNum === 0 ? 'NULL' : roomTypeNum === 1 ? 'BATTLE' : roomTypeNum === 2 ? 'GOAL' : 'UNKNOWN';
      this.log(`Stored room: id=${mapRoom.id}, type=${roomTypeStr}(${roomTypeNum}), monster=${monsterIndex}, nextRooms=[${nextRooms.filter(r => r > 0).join(',')}]`);
    }
  }



  async start() {
    if (this.isRunning) {
      this.log("Already running");
      return;
    }

    this.isRunning = true;
    this.log("Starting...");

    // Fetch and process the map data
    await this.fetchAndProcessMap();

    // Subscribe to events
    this.subscribeToEvents();

    // Initial check
    this.performPeriodicCheck();

    // Set up periodic checks every 5 seconds
    this.intervalId = setInterval(() => {
      this.performPeriodicCheck();
    }, 5000);
  }


  private subscribeToEvents() {
    // Subscribe to PartyStartedEvent
    this.eventUnsubscribes.push(
      this.config.eventAggregator.subscribe({
        eventName: "PartyStartedEvent",
        abi: ActABI as any[],
        address: this.config.actAddress,
        onEvent: async (logs: any[]) => {
          for (const log of logs) {
            this.log("PartyStartedEvent received:", {
              partyId: log.args?.partyId?.toString()
            });
            // Check if party needs to enter a room
            await this.checkSinglePartyProgress(log.args?.partyId);
          }
        }
      })
    );

    // Subscribe to NextRoomChosenEvent
    this.eventUnsubscribes.push(
      this.config.eventAggregator.subscribe({
        eventName: "NextRoomChosenEvent",
        abi: ActABI as any[],
        address: this.config.actAddress,
        onEvent: async (logs: any[]) => {
          for (const log of logs) {
            this.log("NextRoomChosenEvent received:", {
              partyId: log.args?.partyId?.toString(),
              roomId: log.args?.roomId?.toString()
            });
            // Check if party needs to enter a room
            await this.checkSinglePartyProgress(log.args?.partyId);
          }
        }
      })
    );

    // Note: RoomRevealedEvent no longer exists in the new Act contract
    // Room reveals are now handled differently - rooms are revealed when parties enter them
    // The ActOperator will check room states via GraphQL instead

    // Subscribe to RoomEnteredEvent - but don't try to process these parties
    this.eventUnsubscribes.push(
      this.config.eventAggregator.subscribe({
        eventName: "RoomEnteredEvent",
        abi: ActABI as any[],
        address: this.config.actAddress,
        onEvent: async (logs: any[]) => {
          for (const log of logs) {
            this.log("RoomEnteredEvent received:", {
              partyId: log.args?.partyId?.toString(),
              roomId: log.args?.roomId?.toString()
            });
            // Mark this party as recently processed since they've already entered
            const partyKey = log.args?.partyId?.toString();
            if (partyKey) {
              this.recentlyProcessedParties.set(partyKey, Date.now());
              this.log(`Party ${partyKey} has entered room, marking as processed`);
            }
          }
        }
      })
    );

    // Subscribe to BattleStarted event from BattleRoom contract
    if (this.battleRoomAddress) {
      this.eventUnsubscribes.push(
        this.config.eventAggregator.subscribe({
          eventName: "BattleStarted",
          abi: BattleRoomABI as any[],
          address: this.battleRoomAddress,
          onEvent: async (logs: any[]) => {
            for (const log of logs) {
              this.log("BattleStarted event received:", {
                battleAddress: log.args?.battleAddress,
                actAddress: log.args?.actAddress,
                partyId: log.args?.partyId?.toString()
              });
              // Mark this party as recently processed since they're in battle
              const partyKey = log.args?.partyId?.toString();
              if (partyKey) {
                this.recentlyProcessedParties.set(partyKey, Date.now());
                this.log(`Party ${partyKey} has started battle, marking as processed`);
              }
            }
          }
        })
      );
    } else {
      this.error("BattleRoom address not found, cannot subscribe to BattleStarted event");
    }
  }

  stop() {
    if (!this.isRunning) {
      this.log("Not running");
      return;
    }

    this.log("Stopping...");
    this.isRunning = false;

    // Unsubscribe from events
    for (const unsubscribe of this.eventUnsubscribes) {
      try {
        unsubscribe();
      } catch (error: any) {
        this.error("Error unsubscribing from event:", {
          message: error.message,
          stack: error.stack
        });
      }
    }
    this.eventUnsubscribes = [];

    if (this.intervalId) {
      clearInterval(this.intervalId);
      this.intervalId = undefined;
    }
  }

  isAlive(): boolean {
    if (!this.isRunning) return false;
    
    const timeSinceLastCheck = Date.now() - this.lastCheckTime;
    
    // Consider dead if no check in 30 seconds
    if (timeSinceLastCheck > 30000) return false;
    
    return true;
  }

  private async performPeriodicCheck() {
    this.lastCheckTime = Date.now();
    
    try {
      const hasActiveParties = await this.checkAllPartiesProgress();
      if (!hasActiveParties) {
        this.log("No active parties found, stopping operator");
        this.stop();
      }
    } catch (error: any) {
      this.error("Error in periodic check:", {
        message: error.message,
        stack: error.stack
      });
    }
  }

  private async checkSinglePartyProgress(partyId: bigint): Promise<void> {
    try {
      // Get the specific party from GraphQL
      const graphqlClient = createGraphQLClient({ GRAPHQL_URL: this.config.graphqlUrl });
      const result = await graphqlClient.query<{partys: {items: Party[]}}>(GraphQLQueries.getSpecificPartyByAct, {
        actAddress: this.config.actAddress.toLowerCase(),
        partyId: partyId.toString()
      });

      // Should be 0 or 1 results
      const party = result.partys.items[0];
      
      if (party) {
        this.log(`Processing party ${partyId} after event`);
        await this.checkParty(partyId, party);
      } else {
        this.log(`Party ${partyId} not found or not in ROOM_CHOSEN state`);
      }

    } catch (error: any) {
      this.error(`Error in checkSinglePartyProgress for party ${partyId}:`, {
        message: error.message,
        stack: error.stack,
        partyId: partyId.toString()
      });
    }
  }

  private async checkAllPartiesProgress(): Promise<boolean> {
    try {
      // Use GraphQL to get all ROOM_CHOSEN parties for this act
      const graphqlClient = createGraphQLClient({ GRAPHQL_URL: this.config.graphqlUrl });
      const result = await graphqlClient.query<{ partys: { items: Party[] } }>(GraphQLQueries.getPartiesByActWithStateRoomChosen, {
        actAddress: this.config.actAddress.toLowerCase()
      });

      const roomChosenParties = result.partys.items;
      
      this.log(`Periodic check - Found ${roomChosenParties.length} parties in ROOM_CHOSEN state`);

      // Check each party to see if they need to enter their chosen room
      for (const party of roomChosenParties) {
        await this.checkParty(BigInt(party.partyId), party);
      }

      // Always return true to keep the operator running
      // The operator will handle parties as they appear
      return true;
    } catch (error: any) {
      this.error("Error in checkAllPartiesProgress:", {
        message: error.message,
        stack: error.stack
      });
      return true; // Continue running even on error
    }
  }

  private async checkParty(partyId: bigint, partyGraphQLData: Party): Promise<void> {
    const partyKey = partyId.toString();
    
    // Check if party is already being processed
    if (this.processingParties.has(partyKey)) {
      this.log(`Party ${partyId} is already being processed, skipping`);
      return;
    }
    
    // Check if party was recently processed (within last 30 seconds)
    const lastProcessed = this.recentlyProcessedParties.get(partyKey);
    if (lastProcessed && Date.now() - lastProcessed < 30000) {
      this.log(`Party ${partyId} was recently processed, skipping`);
      return;
    }
    
    // Mark party as being processed
    this.processingParties.add(partyKey);
    
    try {
      this.log(`Checking party ${partyId}:`, { 
        state: partyGraphQLData.state,
        roomId: partyGraphQLData.roomId
      });
      
      // Party is guaranteed to be in ROOM_CHOSEN state from GraphQL filter
      // The roomId field contains the ID of the room they want to enter
      
      if (!partyGraphQLData.roomId || partyGraphQLData.roomId === "") {
        this.error(`Party ${partyId} in ROOM_CHOSEN state but has no roomId`);
        return;
      }
      
      // Convert roomId string to number
      const roomIdToEnter = Number(partyGraphQLData.roomId);
      
      // Get the room data from our map
      const room = this.roomMap.get(roomIdToEnter);
      
      if (!room) {
        this.error(`Room not found in map for ID ${roomIdToEnter} (party ${partyId})`);
        this.log(`Available room IDs in map (first 10): ${Array.from(this.roomMap.keys()).slice(0, 10).join(', ')}...`);
        return;
      }
      
      this.log(`Party ${partyId} entering room ID ${roomIdToEnter} (type: ${room.roomType})`);
      await this.executeEnterRoom(partyId, room);
      
      // Mark party as successfully processed
      this.recentlyProcessedParties.set(partyKey, Date.now());
    
    // Clean up old entries (older than 60 seconds)
    const cutoffTime = Date.now() - 60000;
    for (const [key, timestamp] of this.recentlyProcessedParties) {
      if (timestamp < cutoffTime) {
        this.recentlyProcessedParties.delete(key);
      }
    }
    
    } catch (error: any) {
      this.error(`Error processing party ${partyId}:`, {
        message: error.message,
        stack: error.stack,
        partyId: partyId.toString()
      });
    } finally {
      // Always remove from processing set
      this.processingParties.delete(partyKey);
    }
  }


  private async executeEnterRoom(partyId: bigint, room: Room): Promise<void> {
    try {
      this.log(`Executing enterRoom for party ${partyId} with room:`, {
        roomType: room?.roomType,
        monsterIndex1: room?.monsterIndex1,
        monsterIndex2: room?.monsterIndex2,
        monsterIndex3: room?.monsterIndex3,
        nextRooms: room?.nextRooms,
        room: room
      });

      // Validate room struct
      if (!room || room.roomType === undefined || 
          room.monsterIndex1 === undefined || room.monsterIndex2 === undefined ||
          room.monsterIndex3 === undefined || !room.nextRooms) {
        this.error(`Invalid room struct for party ${partyId}:`, {
          room: room,
          partyId: partyId.toString()
        });
        return;
      }

      // Create wallet client for sending transactions
      const account = privateKeyToAccount(this.config.operatorPrivateKey as `0x${string}`);
      const walletClient = createWalletClient({
        account,
        chain: arbitrum,
        transport: createAuthenticatedHttpTransport(this.config.ethRpcUrl, { ETH_RPC_URL: this.config.ethRpcUrl })
      });

      // Encode the enterRoom function call with the Room struct
      const data = encodeFunctionData({
        abi: ActABI as Abi,
        functionName: 'enterRoom',
        args: [partyId, room]
      });

      this.log("Calling enterRoom for party", partyId, "with room type", room.roomType);

      // Forward the transaction
      let hash;
      try {
        hash = await forwardTransaction(
          {
            to: this.config.actAddress as `0x${string}`,
            data: data,
            rpcUrl: this.config.ethRpcUrl,
            relayerUrl: this.config.relayerUrl,
            env: { ETH_RPC_URL: this.config.ethRpcUrl } as any
          },
          walletClient,
          this.config.erc2771ForwarderAddress as `0x${string}`
        );
      } catch (error: any) {
        // Check for specific error types
        if (error.message?.includes('InvalidPartyStateError')) {
          this.log(`Party ${partyId} is no longer in ROOM_CHOSEN state, skipping`);
          return;
        }
        this.error(`Error forwarding enterRoom transaction: ${error.message || error}`, {
          error: error.message || error,
          stack: error.stack,
          partyId: partyId.toString(),
          room: room
        });
        return;
      }

      this.log("EnterRoom transaction forwarded:", hash);

      // Wait for transaction receipt
      if (hash) {
        try {
          const publicClient = createPublicClient({
            chain: arbitrum,
            transport: createAuthenticatedHttpTransport(this.config.ethRpcUrl, { ETH_RPC_URL: this.config.ethRpcUrl })
          });
          const receipt = await publicClient.waitForTransactionReceipt({ hash });
          this.log("EnterRoom transaction confirmed:", receipt);
        } catch (error: any) {
          this.error(`Error waiting for enterRoom transaction receipt: ${error.message || error}`, {
            error: error.message || error,
            stack: error.stack,
            partyId: partyId.toString()
          });
        }
      } else {
        this.error("No transaction hash received from forwardTransaction for party", partyId);
      }
    } catch (error: any) {
      this.error(`Error executing enterRoom for party ${partyId}: ${error.message || error}`, {
        error: error.message || error,
        stack: error.stack,
        partyId: partyId.toString(),
        room: room
      });
    }
  }
}
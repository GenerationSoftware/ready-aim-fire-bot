import { createPublicClient, createWalletClient, encodeFunctionData, encodeAbiParameters, type Abi } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { arbitrum } from "viem/chains";
import ActABI from "../contracts/abis/Act.json";
import BattleRoomABI from "../contracts/abis/BattleRoom.json";
import { forwardTransaction } from "../forwarder/forwardTransaction";
import { createGraphQLClient, GraphQLQueries, PartyState, type Party, type ActRoom } from "../utils/graphql";
import { createAuthenticatedHttpTransport } from "../utils/rpc";
import { createLogger } from "../utils/logger";
import type { Logger } from "pino";

import type { EventAggregator } from "./EventAggregator";

// Room struct matching the Solidity contract
interface Room {
  roomType: number; // uint16
  nextRooms: number[]; // uint32[6] array  
  roomData: `0x${string}`; // bytes - ABI encoded BattleRoomData
}

// Internal room data before encoding
interface RoomInternal {
  roomType: number;
  monsterIndex1: number;
  monsterIndex2: number;
  monsterIndex3: number;
  nextRooms: number[];
}

// Map room from the JSON - flat array structure
interface MapRoom {
  id: number;
  roomType: number; // 0=NULL, 1=BATTLE, 2=GOAL
  roomData: {
    monsterIndex1: number;
  } | null; // Room data with monster index for BATTLE rooms, null otherwise
  nextRooms: number[]; // Array of 6 room IDs, with 0 meaning no connection
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
  private roomMap: Map<number, RoomInternal> = new Map(); // Cache of room ID to Room struct
  private startingRoomId?: number; // Cache the starting room ID
  private battleRoomAddress?: string; // Cache the BattleRoom contract address

  constructor(config: ActOperatorConfig) {
    this.config = config;
    this.logger = createLogger({ operator: 'ActOperator', actAddress: config.actAddress });
  }





  private async fetchAndProcessMap(): Promise<void> {
    try {
      // Get environment variables with fallbacks
      const rafApiUrl = this.config.rafApiUrl || process.env.RAF_API_URL;
      const rafApiUsername = this.config.rafApiUsername || process.env.RAF_API_USERNAME;
      const rafApiPassword = this.config.rafApiPassword || process.env.RAF_API_PASSWORD;

      if (!rafApiUrl || !rafApiUsername || !rafApiPassword) {
        this.logger.error("Missing RAF API configuration. Please set RAF_API_URL, RAF_API_USERNAME, and RAF_API_PASSWORD");
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

      this.logger.info(`Starting room ID: ${this.startingRoomId}`);
      
      // Get the BattleRoom contract address
      this.battleRoomAddress = await publicClient.readContract({
        address: this.config.actAddress as `0x${string}`,
        abi: ActABI as Abi,
        functionName: 'battleRoom'
      }) as string;
      
      this.logger.info(`BattleRoom address: ${this.battleRoomAddress}`);

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
        this.logger.error(`SeasonAct not found in GraphQL for address ${this.config.actAddress}`);
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
        this.logger.error(`Season not found in GraphQL for address ${seasonActInfo.seasonAddress}`);
        return;
      }

      const seasonName = seasonResult.seasons.items[0].name;
      
      this.logger.info(`Act info: season=${seasonName}, actIndex=${actIndex}`);

      // Fetch the map JSON with new URL structure
      const mapUrl = `${rafApiUrl}/season/${seasonName}/act/${actIndex}/map.json`;
      
      this.logger.info(`Fetching map from: ${mapUrl}`);
      
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
      this.logger.info(`Map data fetched successfully - raw response type: ${typeof mapResponse}, isArray: ${Array.isArray(mapResponse)}`);
      
      // The response should be a direct array of rooms
      if (!Array.isArray(mapResponse)) {
        this.logger.error(`Expected array but got: ${JSON.stringify(mapResponse).substring(0, 500)}`);
        throw new Error(`Map response is not an array`);
      }
      
      const mapData = mapResponse as MapRoom[];
      this.logger.info(`Processing ${mapData.length} rooms from map`);
      
      // Log first room to check structure
      if (mapData.length > 0) {
        this.logger.info({ structure: JSON.stringify(mapData[0], null, 2) }, `First room structure:`);
      }

      // Process the flat array of rooms into room ID -> Room struct mapping
      this.processMapRooms(mapData);
      this.logger.info(`Processed ${this.roomMap.size} rooms from map`);

    } catch (error: any) {
      this.logger.error({
        message: error.message,
        stack: error.stack,
        rafApiUrl: this.config.rafApiUrl || process.env.RAF_API_URL,
        actAddress: this.config.actAddress,
        error: error.toString()
      }, `Error fetching or processing map: ${error.message || error}`);
    }
  }

  private processMapRooms(mapRooms: MapRoom[]): void {
    // Process each room in the flat array
    for (const mapRoom of mapRooms) {
      // roomType is already a number: 0=NULL, 1=BATTLE, 2=GOAL
      const roomTypeNum = mapRoom.roomType;
      
      // Extract monsterIndex1 from roomData for BATTLE rooms
      const monsterIndex = mapRoom.roomData?.monsterIndex1 ?? 0;
      
      // Ensure nextRooms array is exactly 6 elements
      if (!mapRoom.nextRooms) {
        this.logger.error({ room: mapRoom }, `Room ${mapRoom.id} has undefined nextRooms!`);
        throw new Error(`Room ${mapRoom.id} is missing nextRooms array`);
      }
      const nextRooms = [...mapRoom.nextRooms];
      while (nextRooms.length < 6) {
        nextRooms.push(0);
      }
      // Trim to exactly 6 if somehow longer
      nextRooms.splice(6);
      
      // Create the internal room struct
      const room: RoomInternal = {
        roomType: roomTypeNum,
        monsterIndex1: monsterIndex,
        monsterIndex2: 0, // Not used in current map format
        monsterIndex3: 0, // Not used in current map format
        nextRooms: nextRooms
      };
      
      // Store the room by its ID
      this.roomMap.set(mapRoom.id, room);
      
      const roomTypeStr = roomTypeNum === 0 ? 'NULL' : roomTypeNum === 1 ? 'BATTLE' : roomTypeNum === 2 ? 'GOAL' : 'UNKNOWN';
      this.logger.info(`Stored room: id=${mapRoom.id}, type=${roomTypeStr}(${roomTypeNum}), monster=${monsterIndex}, nextRooms=[${nextRooms.filter(r => r > 0).join(',')}]`);
    }
  }



  async start() {
    if (this.isRunning) {
      this.logger.info("Already running");
      return;
    }

    this.isRunning = true;
    this.logger.info("Starting...");

    // Fetch and process the map data
    await this.fetchAndProcessMap();
    
    // Log the state of roomMap after fetching
    this.logger.info(`Map fetching complete. roomMap size: ${this.roomMap.size}`);
    if (this.roomMap.size === 0) {
      this.logger.error("WARNING: roomMap is empty after fetchAndProcessMap!");
    } else {
      this.logger.info(`Room IDs in map: ${Array.from(this.roomMap.keys()).join(', ')}`);
    }

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
            this.logger.info({
              partyId: log.args?.partyId?.toString()
            }, "PartyStartedEvent received:");
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
            this.logger.info({
              partyId: log.args?.partyId?.toString(),
              roomId: log.args?.roomId?.toString()
            }, "NextRoomChosenEvent received:");
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
            this.logger.info({
              partyId: log.args?.partyId?.toString(),
              roomId: log.args?.roomId?.toString()
            }, "RoomEnteredEvent received:");
            // Mark this party as recently processed since they've already entered
            const partyKey = log.args?.partyId?.toString();
            if (partyKey) {
              this.recentlyProcessedParties.set(partyKey, Date.now());
              this.logger.info(`Party ${partyKey} has entered room, marking as processed`);
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
              this.logger.info({
                battleAddress: log.args?.battleAddress,
                actAddress: log.args?.actAddress,
                partyId: log.args?.partyId?.toString()
              }, "BattleStarted event received:");
              // Mark this party as recently processed since they're in battle
              const partyKey = log.args?.partyId?.toString();
              if (partyKey) {
                this.recentlyProcessedParties.set(partyKey, Date.now());
                this.logger.info(`Party ${partyKey} has started battle, marking as processed`);
              }
            }
          }
        })
      );
    } else {
      this.logger.error("BattleRoom address not found, cannot subscribe to BattleStarted event");
    }
  }

  stop() {
    if (!this.isRunning) {
      this.logger.info("Not running");
      return;
    }

    this.logger.info("Stopping...");
    this.isRunning = false;

    // Unsubscribe from events
    for (const unsubscribe of this.eventUnsubscribes) {
      try {
        unsubscribe();
      } catch (error: any) {
        this.logger.error({ error: {
          message: error.message,
          stack: error.stack
        }?.message || {
          message: error.message,
          stack: error.stack
        }, stack: {
          message: error.message,
          stack: error.stack
        }?.stack }, "Error unsubscribing from event:");
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
        this.logger.info("No active parties found, stopping operator");
        this.stop();
      }
    } catch (error: any) {
      this.logger.error({ error: {
        message: error.message,
        stack: error.stack
      }?.message || {
        message: error.message,
        stack: error.stack
      }, stack: {
        message: error.message,
        stack: error.stack
      }?.stack }, "Error in periodic check:");
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
        // Only process parties in ROOM_CHOSEN state (state = 1)
        // GraphQL returns state as a string, need to convert to number
        const partyStateNum = Number(party.state);
        if (partyStateNum === PartyState.ROOM_CHOSEN) {
          this.logger.info(`Processing party ${partyId} after event (state: ${partyStateNum})`);
          await this.checkParty(partyId, party);
        } else {
          this.logger.info(`Party ${partyId} is in state ${partyStateNum}, not ROOM_CHOSEN (${PartyState.ROOM_CHOSEN}), skipping`);
        }
      } else {
        this.logger.info(`Party ${partyId} not found`);
      }

    } catch (error: any) {
      this.logger.error({
        message: error.message,
        stack: error.stack,
        partyId: partyId.toString()
      }, `Error in checkSinglePartyProgress for party ${partyId}:`);
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
      
      this.logger.info(`Periodic check - Found ${roomChosenParties.length} parties in ROOM_CHOSEN state`);

      // Check each party to see if they need to enter their chosen room
      for (const party of roomChosenParties) {
        await this.checkParty(BigInt(party.partyId), party);
      }

      // Always return true to keep the operator running
      // The operator will handle parties as they appear
      return true;
    } catch (error: any) {
      this.logger.error({ error: {
        message: error.message,
        stack: error.stack
      }?.message || {
        message: error.message,
        stack: error.stack
      }, stack: {
        message: error.message,
        stack: error.stack
      }?.stack }, "Error in checkAllPartiesProgress:");
      return true; // Continue running even on error
    }
  }

  private async checkParty(partyId: bigint, partyGraphQLData: Party): Promise<void> {
    const partyKey = partyId.toString();
    
    // Check if party is already being processed
    if (this.processingParties.has(partyKey)) {
      this.logger.info(`Party ${partyId} is already being processed, skipping`);
      return;
    }
    
    // Check if party was recently processed (within last 30 seconds)
    const lastProcessed = this.recentlyProcessedParties.get(partyKey);
    if (lastProcessed && Date.now() - lastProcessed < 30000) {
      this.logger.info(`Party ${partyId} was recently processed, skipping`);
      return;
    }
    
    // Mark party as being processed
    this.processingParties.add(partyKey);
    
    try {
      this.logger.info({ 
        state: partyGraphQLData.state,
        roomId: partyGraphQLData.roomId
      }, `Checking party ${partyId}:`);
      
      // Double-check that party is in ROOM_CHOSEN state
      // GraphQL returns state as a string, but we need to compare as number
      const partyStateNum = Number(partyGraphQLData.state);
      if (partyStateNum !== PartyState.ROOM_CHOSEN) {
        this.logger.info(`Party ${partyId} is not in ROOM_CHOSEN state (state: ${partyStateNum}), skipping`);
        return;
      }
      
      // The roomId field contains the ID of the room they want to enter
      
      if (!partyGraphQLData.roomId || partyGraphQLData.roomId === "") {
        this.logger.error(`Party ${partyId} in ROOM_CHOSEN state but has no roomId`);
        return;
      }
      
      // Convert roomId string to number
      const roomIdToEnter = Number(partyGraphQLData.roomId);
      
      // Room ID should never be 0 - this indicates an error
      if (roomIdToEnter === 0) {
        this.logger.error({
          partyId: partyId.toString(),
          partyData: partyGraphQLData,
          state: partyGraphQLData.state,
          roomId: partyGraphQLData.roomId
        }, `Party ${partyId} has invalid roomId 0 - this should never happen!`);
        throw new Error(`Party ${partyId} has invalid roomId 0`);
      }
      
      // Get the room data from our map
      this.logger.info(`Looking up room ID ${roomIdToEnter} in roomMap (size: ${this.roomMap.size})`);
      const roomInternal = this.roomMap.get(roomIdToEnter);
      
      if (!roomInternal) {
        this.logger.error(`Room not found in map for ID ${roomIdToEnter} (party ${partyId})`);
        this.logger.info(`roomMap size: ${this.roomMap.size}`);
        this.logger.info(`Available room IDs in map: ${Array.from(this.roomMap.keys()).join(', ')}`);
        this.logger.info(`Was map fetched? Starting room ID: ${this.startingRoomId}`);
        return;
      }
      
      // Validate room has nextRooms before proceeding
      if (!roomInternal.nextRooms) {
        this.logger.error({ room: roomInternal }, `Room ${roomIdToEnter} exists but has no nextRooms array!`);
        return;
      }
      
      // Convert internal room to contract format with ABI-encoded roomData
      const room = this.encodeRoomForContract(roomInternal);
      
      this.logger.info(`Party ${partyId} entering room ID ${roomIdToEnter} (type: ${roomInternal.roomType})`);
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
      this.logger.error({
        message: error.message,
        stack: error.stack,
        partyId: partyId.toString()
      }, `Error processing party ${partyId}:`);
    } finally {
      // Always remove from processing set
      this.processingParties.delete(partyKey);
    }
  }

  private encodeRoomForContract(roomInternal: RoomInternal): Room {
    // Encode BattleRoomData struct as bytes
    let roomData: `0x${string}`;
    
    if (roomInternal.roomType === 1) { // BATTLE room
      // Encode BattleRoomData { uint16 monsterIndex1 }
      roomData = encodeAbiParameters(
        [{ type: 'uint16', name: 'monsterIndex1' }],
        [roomInternal.monsterIndex1]
      ) as `0x${string}`;
    } else {
      // For non-battle rooms, use empty bytes
      roomData = '0x' as `0x${string}`;
    }
    
    return {
      roomType: roomInternal.roomType,
      nextRooms: roomInternal.nextRooms,
      roomData: roomData
    };
  }


  private async executeEnterRoom(partyId: bigint, room: Room): Promise<void> {
    try {
      this.logger.info({
        roomType: room?.roomType,
        roomData: room?.roomData,
        nextRoomsLength: room?.nextRooms?.length,
        nextRooms: room?.nextRooms ? JSON.stringify(room.nextRooms) : 'undefined',
        roomStringified: JSON.stringify(room)
      }, `Executing enterRoom for party ${partyId} with room:`);

      // Validate room struct
      if (!room || room.roomType === undefined || 
          room.roomData === undefined || !room.nextRooms) {
        this.logger.error({
          room: room,
          partyId: partyId.toString()
        }, `Invalid room struct for party ${partyId}:`);
        return;
      }

      // Create wallet client for sending transactions
      const account = privateKeyToAccount(this.config.operatorPrivateKey as `0x${string}`);
      const walletClient = createWalletClient({
        account,
        chain: arbitrum,
        transport: createAuthenticatedHttpTransport(this.config.ethRpcUrl, { ETH_RPC_URL: this.config.ethRpcUrl })
      });

      this.logger.info({
        room,
        partyId
      }, "ACT OPERATOR enterRoom()")

      // Encode the enterRoom function call with the Room struct
      let data;
      try {
        data = encodeFunctionData({
          abi: ActABI as Abi,
          functionName: 'enterRoom',
          args: [partyId, room]
        });
      } catch (encodeError: any) {
        this.logger.error({
          error: encodeError.message,
          stack: encodeError.stack,
          partyId: partyId.toString(),
          room: JSON.stringify(room),
          roomNextRooms: room?.nextRooms,
          roomNextRoomsType: typeof room?.nextRooms,
          roomNextRoomsIsArray: Array.isArray(room?.nextRooms),
          roomKeys: room ? Object.keys(room) : 'room is null/undefined'
        }, `Failed to encode enterRoom function data: ${encodeError.message}`);
        throw encodeError;
      }

      this.logger.info({ partyId, roomType: room.roomType }, "Calling enterRoom for party");

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
          this.logger.info(`Party ${partyId} is no longer in ROOM_CHOSEN state, skipping`);
          return;
        }
        this.logger.error({
          error: error.message || error,
          stack: error.stack,
          partyId: partyId.toString(),
          room: room
        }, `Error forwarding enterRoom transaction: ${error.message || error}`);
        return;
      }

      this.logger.info({ hash }, "EnterRoom transaction forwarded:");

      // Wait for transaction receipt
      if (hash) {
        try {
          const publicClient = createPublicClient({
            chain: arbitrum,
            transport: createAuthenticatedHttpTransport(this.config.ethRpcUrl, { ETH_RPC_URL: this.config.ethRpcUrl })
          });
          const receipt = await publicClient.waitForTransactionReceipt({ hash });
          this.logger.info({ receipt }, "EnterRoom transaction confirmed:");
        } catch (error: any) {
          this.logger.error({
            error: error.message || error,
            stack: error.stack,
            partyId: partyId.toString()
          }, `Error waiting for enterRoom transaction receipt: ${error.message || error}`);
        }
      } else {
        this.logger.error({ partyId: partyId.toString() }, "No transaction hash received from forwardTransaction for party");
      }
    } catch (error: any) {
      this.logger.error({
        error: error.message || error,
        stack: error.stack,
        partyId: partyId.toString(),
        room: room
      }, `Error executing enterRoom for party ${partyId}: ${error.message || error}`);
    }
  }
}
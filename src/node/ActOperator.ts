import { createPublicClient, createWalletClient, encodeFunctionData, type Abi, keccak256, encodeAbiParameters } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { arbitrum } from "viem/chains";
import ActABI from "../contracts/abis/Act.json";
import { forwardTransaction } from "../forwarder/forwardTransaction";
import { createGraphQLClient, GraphQLQueries, type Party, type ActRoom } from "../utils/graphql";
import { createAuthenticatedHttpTransport } from "../utils/rpc";
import { createLogger } from "../utils/logger";
import type { Logger } from "pino";

import type { EventAggregator } from "./EventAggregator";

// Room struct matching the Solidity contract
interface Room {
  depth: number;
  roomType: number;
  doorCount: number;
  monsterIndex1: number;
}

// Map node from the JSON
interface MapNode {
  type: number;
  doors: number;
  monster1?: number;
  monster2?: number;
  monster3?: number;
  children?: MapNode[];
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
  private roomMap: Map<string, Room> = new Map(); // Cache of room hash to Room struct
  private rootRoomHash?: string; // Cache the root room hash

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

      // Get the root room hash from the contract
      const publicClient = createPublicClient({
        chain: arbitrum,
        transport: createAuthenticatedHttpTransport(this.config.ethRpcUrl, { ETH_RPC_URL: this.config.ethRpcUrl })
      });

      this.rootRoomHash = await publicClient.readContract({
        address: this.config.actAddress as `0x${string}`,
        abi: ActABI as Abi,
        functionName: 'ROOT_ROOM_HASH'
      }) as string;

      this.log(`Root room hash: ${this.rootRoomHash}`);

      // Fetch the map JSON
      const actAddressLowercase = this.config.actAddress.toLowerCase();
      const mapUrl = `${rafApiUrl}/act/${actAddressLowercase}/map.json`;
      
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

      const mapData = await response.json() as MapNode;
      this.log("Map data fetched successfully");

      // Process the map into room hash -> Room struct mapping
      this.processMapNode(mapData, this.rootRoomHash, 0, 0);
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

  private processMapNode(node: MapNode, parentRoomHash: string, childIndex: number, depth: number = 0): void {
    // Calculate the room hash for this node
    const roomHash = this.calculateRoomHash(parentRoomHash, childIndex);
    
    // Create the Room struct - ensure all values are defined
    const room: Room = {
      depth: depth ?? 0,
      roomType: node.type ?? 0,
      doorCount: node.doors ?? 0,
      monsterIndex1: node.monster1 ?? 0
    };
    
    // Validate room before storing
    if (room.depth === undefined || room.roomType === undefined || 
        room.doorCount === undefined || room.monsterIndex1 === undefined) {
      this.error(`Invalid room data for hash ${roomHash}:`, {
        node: node,
        depth: depth,
        room: room
      });
      return;
    }

    // Store in the map
    this.roomMap.set(roomHash, room);

    // Process children recursively
    if (node.children) {
      node.children.forEach((childNode, index) => {
        this.processMapNode(childNode, roomHash, index, depth + 1);
      });
    }
  }

  private calculateRoomHash(parentRoomHash: string, childIndex: number): string {
    // If this is the root node
    if (parentRoomHash === this.rootRoomHash && childIndex === 0) {
      return this.rootRoomHash!;
    }

    // Calculate hash as keccak256(abi.encode(parentRoomHash, childIndex))
    const encoded = encodeAbiParameters(
      [{ type: 'bytes32' }, { type: 'uint256' }],
      [parentRoomHash as `0x${string}`, BigInt(childIndex)]
    );
    
    return keccak256(encoded);
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
              roomHash: log.args?.roomHash
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
              roomHash: log.args?.roomHash
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

    // Subscribe to BattleStartedEvent - parties in battle don't need door processing
    this.eventUnsubscribes.push(
      this.config.eventAggregator.subscribe({
        eventName: "BattleStartedEvent",
        abi: ActABI as any[],
        address: this.config.actAddress,
        onEvent: async (logs: any[]) => {
          for (const log of logs) {
            this.log("BattleStartedEvent received:", {
              partyId: log.args?.partyId?.toString(),
              battleAddress: log.args?.battleAddress
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
        roomHash: partyGraphQLData.roomHash
      });
      
      // Party is guaranteed to be in ROOM_CHOSEN state from GraphQL filter
      // The roomHash field contains the hash of the room they want to enter
      
      if (!partyGraphQLData.roomHash || partyGraphQLData.roomHash === "") {
        this.error(`Party ${partyId} in ROOM_CHOSEN state but has no roomHash`);
        return;
      }
      
      // The roomHash is the room they want to enter
      const roomHashToEnter = partyGraphQLData.roomHash;
      
      // Get the room data from our map
      const room = this.roomMap.get(roomHashToEnter);
      
      if (!room) {
        this.error(`Room not found in map for hash ${roomHashToEnter} (party ${partyId})`);
        this.log(`Available room hashes in map (first 10): ${Array.from(this.roomMap.keys()).slice(0, 10).join(', ')}...`);
        return;
      }
      
      this.log(`Party ${partyId} entering room at hash ${roomHashToEnter} (type: ${room.roomType})`);
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
        depth: room?.depth,
        roomType: room?.roomType,
        doorCount: room?.doorCount,
        monsterIndex1: room?.monsterIndex1,
        room: room
      });

      // Validate room struct
      if (!room || room.depth === undefined || room.roomType === undefined || 
          room.doorCount === undefined || room.monsterIndex1 === undefined) {
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
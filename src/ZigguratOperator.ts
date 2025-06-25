import { DurableObject } from "cloudflare:workers";
import { Env } from "./Env";
import ZigguratABI from "./contracts/abis/Ziggurat.json";
import { createPublicClient, createWalletClient, http, webSocket, encodeFunctionData, type Abi, keccak256, encodePacked } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { arbitrum } from "viem/chains";
import { forwardTransaction } from "./forwarder/forwardTransaction";
import { CONTRACT_ADDRESSES } from "./utils/deployments";
import { createGraphQLClient, GraphQLQueries, type Party, type ZigguratRoom, PartyState } from "./utils/graphql";

export class ZigguratOperator {
  private state: DurableObjectState;
  private env: Env;
  private zigguratAddress: string | null = null;
  private wsClient: any = null;
  private wsUnwatch: (() => void) | null = null;

  constructor(state: DurableObjectState, env: Env) {
    this.state = state;
    this.env = env;
    
    // Restore WebSocket connection if it was previously established
    this.restoreConnection();
  }

  private async restoreConnection(): Promise<void> {
    try {
      this.zigguratAddress = await this.state.storage.get("zigguratAddress") as string;
      if (this.zigguratAddress && !this.wsClient) {
        this.zigLog("Restoring WebSocket connection for ziggurat:", this.zigguratAddress);
        await this.setupWebSocketConnection();
      }
    } catch (error) {
      this.zigError("Error restoring WebSocket connection:", error);
    }
  }

  private async cleanupWebSocketConnection(): Promise<void> {
    try {
      if (this.wsUnwatch) {
        this.wsUnwatch();
        this.wsUnwatch = null;
      }
      this.wsClient = null;
    } catch (error) {
      this.zigError("Error cleaning up WebSocket connection:", error);
    }
  }

  private zigLog(this: ZigguratOperator, ...args: any[]): void {
    console.log({
      origin: "ZIGGURAT_OPERATOR",
      zigguratAddress: this.zigguratAddress,
      ...args
    });
  }

  private zigError(this: ZigguratOperator, ...args: any[]): void {
    console.error({
      origin: "ZIGGURAT_OPERATOR",
      zigguratAddress: this.zigguratAddress,
      ...args
    });
  }

  private async setupWebSocketConnection(): Promise<void> {
    if (!this.zigguratAddress) {
      this.zigError("Cannot setup WebSocket without zigguratAddress");
      return;
    }

    try {
      // Find NextRoomChosenEvent in the ABI
      const nextRoomChosenEvent = (ZigguratABI as any[]).find(
        item => item.type === 'event' && item.name === 'NextRoomChosenEvent'
      );

      if (!nextRoomChosenEvent) {
        throw new Error("NextRoomChosenEvent not found in Ziggurat ABI");
      }

      this.zigLog("Found NextRoomChosenEvent in ABI:", nextRoomChosenEvent);

      // Create WebSocket client
      this.wsClient = createPublicClient({
        chain: arbitrum,
        transport: webSocket(this.env.ETH_RPC_URL)
      });

      // Listen for NextRoomChosenEvent from this specific Ziggurat using the ABI event
      const unwatch = this.wsClient.watchEvent({
        address: this.zigguratAddress as `0x${string}`,
        event: nextRoomChosenEvent,
        onLogs: (logs: any[]) => {
          for (const log of logs) {
            this.zigLog("NextRoomChosenEvent received:", {
              partyId: log.args.partyId?.toString(),
              doorIndex: log.args.doorIndex?.toString()
            });
            
            // Trigger single party check
            this.checkSinglePartyProgress(log.args.partyId);
          }
        }
      });

      // Store the unwatch function for cleanup
      this.wsUnwatch = unwatch;
      
      this.zigLog("WebSocket connection established for Ziggurat events");
      
    } catch (error) {
      this.zigError("Error setting up WebSocket connection:", error);
      throw error; // Re-throw to prevent silent failures
    }
  }

  private async checkSinglePartyProgress(partyId: bigint): Promise<void> {
    if (!this.zigguratAddress) return;

    try {
      // Get the specific party from GraphQL
      const graphqlClient = createGraphQLClient(this.env);
      const result = await graphqlClient.query<{partys: {items: Party[]}}>(GraphQLQueries.getSpecificPartyByZiggurat, {
        zigguratAddress: this.zigguratAddress.toLowerCase(),
        partyId: partyId.toString()
      });

      // Should be 0 or 1 results
      const party = result.partys.items[0];
      
      if (party) {
        this.zigLog(`Processing party ${partyId} after NextRoomChosenEvent`);
        await this.checkParty(partyId, party);
      } else {
        this.zigLog(`Party ${partyId} not found or not in DOOR_CHOSEN state`);
      }

    } catch (error) {
      this.zigError(`Error in checkSinglePartyProgress for party ${partyId}:`, error);
    }
  }

  private async checkAllPartiesProgress(): Promise<boolean> {
    if (!this.zigguratAddress) return false;

    try {
      // Use GraphQL to get all DOOR_CHOSEN parties for this ziggurat
      const graphqlClient = createGraphQLClient(this.env);
      const result = await graphqlClient.query<{partys: {items: Party[]}}>(GraphQLQueries.getPartiesByZigguratWithStateDoorChosen, {
        zigguratAddress: this.zigguratAddress.toLowerCase()
      });

      const doorChosenParties = result.partys.items;
      
      this.zigLog("Periodic check - Door chosen parties:", doorChosenParties.length);

      // Check each party to see if they need operator intervention
      for (const party of doorChosenParties) {
        await this.checkParty(BigInt(party.partyId), party);
      }

      return true;
    } catch (error) {
      this.zigError("Error in checkAllPartiesProgress:", error);
      return true; // Continue running even on error
    }
  }

  private async checkParty(partyId: bigint, partyGraphQLData: Party): Promise<void> {
    this.zigLog(`Checking party ${partyId}:`, { 
      state: partyGraphQLData.state,
      roomHash: partyGraphQLData.roomHash,
      chosenDoor: partyGraphQLData.chosenDoor
    });
    
    // Party is guaranteed to be in DOOR_CHOSEN state from GraphQL filter
    
    // Use GraphQL data
    const parentRoomHash = partyGraphQLData.roomHash;
    const chosenDoorIndex = Number(partyGraphQLData.chosenDoor);

    // Use GraphQL to check if specific room has been revealed
    const graphqlClient = createGraphQLClient(this.env);
    const roomsResult = await graphqlClient.query<{zigguratRooms: {items: ZigguratRoom[]} | null}>(GraphQLQueries.getSpecificZigguratRoom, {
      zigguratAddress: this.zigguratAddress!.toLowerCase(),
      parentRoomHash: parentRoomHash,
      parentDoorIndex: chosenDoorIndex
    });

    if (!roomsResult.zigguratRooms) {
      this.zigError("No zigguratRooms data received from GraphQL");
      return;
    }

    const existingRoom = roomsResult.zigguratRooms.items[0]; // Should be 0 or 1 results

    this.zigLog(`Party ${partyId} door ${chosenDoorIndex} status:`, { 
      roomExists: !!existingRoom,
      roomRevealed: existingRoom?.revealedAt !== null 
    });

    if (!existingRoom || existingRoom.revealedAt === null) {
      // Room hasn't been revealed yet, reveal it first
      this.zigLog(`Party ${partyId} chose unrevealed room, revealing door ${chosenDoorIndex}`);
      const revealSuccess = await this.executeRevealDoor(parentRoomHash, chosenDoorIndex);
      
      if (revealSuccess) {           
        this.zigLog(`Room revealed successfully, now entering door for party ${partyId}`);
        await this.executeEnterDoor(partyId);
      } else {
        this.zigError(`Failed to reveal door for party ${partyId}, retrying later`);
      }
    } else {
      // Room is already revealed, ready to enter
      this.zigLog(`Party ${partyId} is ready to enter revealed door`);
      await this.executeEnterDoor(partyId);
    }
  }

  private async executeRevealDoor(roomHash: string, doorIndex: number): Promise<boolean> {
    try {
      this.zigLog(`Executing revealDoor for room ${roomHash}, door ${doorIndex}`);

      // Create wallet client for signing
      const account = privateKeyToAccount(this.env.OPERATOR_PRIVATE_KEY as `0x${string}`);
      const walletClient = createWalletClient({
        account,
        chain: arbitrum,
        transport: http(this.env.ETH_RPC_URL)
      });

      // Get the actual chain ID from the RPC
      const chainId = await walletClient.getChainId();

      // Create the message to sign according to the contract
      // The contract expects: keccak256(abi.encodePacked(block.chainid, address(this), _roomHash, _doorIndex))
      this.zigLog('Creating signature with params:', {
        chainId: chainId,
        contractAddress: this.zigguratAddress,
        roomHash: roomHash,
        doorIndex: doorIndex,
        operatorAddress: account.address
      });

      const messageHash = keccak256(
        encodePacked(
          ['uint256', 'address', 'bytes32', 'uint256'],
          [BigInt(chainId), this.zigguratAddress as `0x${string}`, roomHash as `0x${string}`, BigInt(doorIndex)]
        )
      );

      // Sign the message hash directly - the contract will handle the Ethereum signed message prefix
      const signature = await walletClient.signMessage({
        message: { raw: messageHash }
      });

      this.zigLog('Signed reveal message:', { 
        messageHash, 
        signature,
        signatureLength: signature.length 
      });

      // Verify we can recover the signature locally for debugging
      try {
        const ethSignedMessageHash = keccak256(
          encodePacked(
            ['string', 'bytes32'],
            ['\x19Ethereum Signed Message:\n32', messageHash]
          )
        );
        this.zigLog('Verification hash for debugging:', { ethSignedMessageHash });
      } catch (verifyError) {
        this.zigLog('Error in local verification:', verifyError);
      }

      // Encode the revealDoor function call
      const data = encodeFunctionData({
        abi: ZigguratABI as Abi,
        functionName: 'revealDoor',
        args: [roomHash, doorIndex, signature]
      });

      this.zigLog("Calling revealDoor through forwarder");

      // Forward the transaction
      let hash;
      try {
        hash = await forwardTransaction(
          {
            to: this.zigguratAddress as `0x${string}`,
            data: data,
            rpcUrl: this.env.ETH_RPC_URL,
            relayerUrl: this.env.RELAYER_URL
          },
          walletClient,
          this.env.ERC2771_FORWARDER_ADDRESS as `0x${string}`
        );
      } catch (error) {
        this.zigError("Error forwarding revealDoor transaction:", error);
        return false;
      }

      this.zigLog("RevealDoor transaction forwarded:", hash);

      // Wait for transaction receipt
      if (hash) {
        try {
          const publicClient = createPublicClient({
            chain: arbitrum,
            transport: http(this.env.ETH_RPC_URL)
          });
          const receipt = await publicClient.waitForTransactionReceipt({ hash });
          this.zigLog("RevealDoor transaction confirmed:", receipt);
        } catch (error) {
          this.zigError("Error waiting for revealDoor transaction receipt:", error);
          return false;
        }
      } else {
        this.zigError("No transaction hash received from forwardTransaction for revealDoor");
        return false;
      }
      return true;
    } catch (error) {
      this.zigError(`Error executing revealDoor:`, error);
      return false;
    }
  }

  private async executeEnterDoor(partyId: bigint): Promise<void> {
    try {
      this.zigLog(`Executing enterDoor for party ${partyId}`);

      // Create wallet client for sending transactions
      const account = privateKeyToAccount(this.env.OPERATOR_PRIVATE_KEY as `0x${string}`);
      const walletClient = createWalletClient({
        account,
        chain: arbitrum,
        transport: http(this.env.ETH_RPC_URL)
      });

      // Encode the enterDoor function call
      const data = encodeFunctionData({
        abi: ZigguratABI as Abi,
        functionName: 'enterDoor',
        args: [partyId]
      });

      this.zigLog("Calling enterDoor for party", partyId);

      // Forward the transaction
      let hash;
      try {
        hash = await forwardTransaction(
          {
            to: this.zigguratAddress as `0x${string}`,
            data: data,
            rpcUrl: this.env.ETH_RPC_URL,
            relayerUrl: this.env.RELAYER_URL
          },
          walletClient,
          this.env.ERC2771_FORWARDER_ADDRESS as `0x${string}`
        );
      } catch (error) {
        this.zigError("Error forwarding enterDoor transaction:", error);
        return;
      }

      this.zigLog("EnterDoor transaction forwarded:", hash);

      // Wait for transaction receipt
      if (hash) {
        try {
          const publicClient = createPublicClient({
            chain: arbitrum,
            transport: http(this.env.ETH_RPC_URL)
          });
          const receipt = await publicClient.waitForTransactionReceipt({ hash });
          this.zigLog("EnterDoor transaction confirmed:", receipt);
        } catch (error) {
          this.zigError("Error waiting for enterDoor transaction receipt:", error);
        }
      } else {
        this.zigError("No transaction hash received from forwardTransaction for party", partyId);
      }
    } catch (error) {
      this.zigError(`Error executing enterDoor for party ${partyId}:`, error);
    }
  }

  async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);

    if (url.pathname === "/start") {
      const requestedZigguratAddress = url.searchParams.get("zigguratAddress");

      if (!requestedZigguratAddress) {
        return new Response("Missing zigguratAddress", { status: 400 });
      }

      // Get stored ziggurat address
      const storedZigguratAddress = await this.state.storage.get("zigguratAddress") as string;
      
      // Set up new connection
      this.zigguratAddress = requestedZigguratAddress;
      await this.state.storage.put("zigguratAddress", this.zigguratAddress);

      let hasError = false;
      let errorMessage = "";

      // Setup WebSocket connection if not already connected
      if (!this.wsClient) {
        try {
          // Clean up any existing connection
          await this.cleanupWebSocketConnection();
          
          // Setup WebSocket connection
          await this.setupWebSocketConnection();
          this.zigLog("WebSocket connection established");
        } catch (error) {
          this.zigError("Failed to setup WebSocket connection:", error);
          hasError = true;
          errorMessage += `WebSocket error: ${error}; `;
        }
      }

      // Setup alarm if none exists or if existing alarm is in the past
      try {
        const currentAlarm = await this.state.storage.getAlarm();
        const currentTime = Date.now();
        
        if (currentAlarm === null || currentAlarm < currentTime) {
          this.state.storage.setAlarm(currentTime + 5000);
          this.zigLog("Alarm scheduled for periodic checks");
        }
      } catch (error) {
        this.zigError("Failed to setup alarm:", error);
        hasError = true;
        errorMessage += `Alarm error: ${error}; `;
      }

      if (hasError) {
        return new Response(`ZigguratOperator started with errors: ${errorMessage}`, { status: 207 });
      }
      
      return new Response("ZigguratOperator started");
    }

    return new Response("Not found", { status: 404 });
  }

  async alarm(): Promise<void> {
    try {
      // Perform periodic check of all parties in DOOR_CHOSEN state
      await this.checkAllPartiesProgress();
      
      // Schedule the next alarm in 5 seconds
      this.state.storage.setAlarm(Date.now() + 5000);
    } catch (error) {
      this.zigError("Error in alarm:", error);
      // Continue with next alarm even on error
      this.state.storage.setAlarm(Date.now() + 5000);
    }
  }
}
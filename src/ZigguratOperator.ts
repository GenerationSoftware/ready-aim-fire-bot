import ZigguratABI from "./contracts/abis/Ziggurat.json";
import { createPublicClient, createWalletClient, encodeFunctionData, type Abi, keccak256, encodePacked } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { arbitrum } from "viem/chains";
import { forwardTransaction } from "./forwarder/forwardTransaction";
import { createGraphQLClient, GraphQLQueries, type Party, type ZigguratRoom } from "./utils/graphql";
import { Operator, type EventSubscription } from "./Operator";
import { createAuthenticatedHttpTransport } from "./utils/rpc";

export class ZigguratOperator extends Operator {
  private zigguratAddress: string | undefined;

  private async getZigguratAddress(): Promise<string | undefined> {
    if (!this.zigguratAddress) {
      this.zigguratAddress = await this.state.storage.get("zigguratAddress") as string | undefined;
    }
    return this.zigguratAddress;
  }

  protected async getOperatorId(): Promise<string | null> {
    return await this.getZigguratAddress() || null;
  }

  protected getDurableObjectNamespace(): string {
    return "ZIGGURAT_OPERATOR";
  }

  protected async validateStartParameters(params: URLSearchParams): Promise<string | null> {
    const zigguratAddress = params.get("zigguratAddress");
    if (!zigguratAddress) {
      return "Missing required parameter: zigguratAddress";
    }
    return null;
  }

  protected async getEventSubscriptions(): Promise<EventSubscription[]> {
    return [
      {
        eventName: "NextRoomChosenEvent",
        abi: ZigguratABI as any[],
        address: await this.getZigguratAddress(),
        onEvent: async (logs: any[]) => {
          for (const log of logs) {
            this.log("NextRoomChosenEvent received:", {
              partyId: log.args.partyId?.toString(),
              doorIndex: log.args.doorIndex?.toString()
            });
            
            // Trigger single party check
            this.checkSinglePartyProgress(log.args.partyId);
          }
        }
      },
      {
        eventName: "PartyStartedEvent",
        abi: ZigguratABI as any[],
        address: await this.getZigguratAddress(),
        onEvent: async (logs: any[]) => {
          for (const log of logs) {
            this.log("PartyStartedEvent received:", {
              partyId: log.args.partyId?.toString()
            });
            
            // Trigger single party check
            this.checkSinglePartyProgress(log.args.partyId);
          }
        }
      },
      {
        eventName: "RoomRevealedEvent",
        abi: ZigguratABI as any[],
        address: await this.getZigguratAddress(),
        onEvent: async (logs: any[]) => {
          for (const log of logs) {
            this.log("RoomRevealedEvent received:", {
              roomHash: log.args.roomHash,
              doorIndex: log.args.doorIndex?.toString(),
              childRoomHash: log.args.childRoomHash
            });

            // Query all parties waiting for this room revelation
            const graphqlClient = createGraphQLClient(this.env);
            const zigguratAddress = await this.getZigguratAddress();
            if (!zigguratAddress) continue;

            try {
              const result = await graphqlClient.query<{partys: {items: Party[]}}>(
                GraphQLQueries.getPartiesWaitingForRoom, 
                {
                  zigguratAddress: zigguratAddress.toLowerCase(),
                  roomHash: log.args.roomHash,
                  doorIndex: log.args.doorIndex?.toString() || "0" // Convert BigInt to string for JSON serialization
                }
              );

              const waitingParties = result.partys.items;
              this.log(`Found ${waitingParties.length} parties waiting for room ${log.args.roomHash} door ${log.args.doorIndex}`);

              // Process each waiting party
              for (const party of waitingParties) {
                this.log(`Processing party ${party.partyId} after room revelation`);
                await this.checkSinglePartyProgress(BigInt(party.partyId));
              }
            } catch (error) {
              this.error("Error querying parties waiting for room:", error);
            }
          }
        }
      }
    ];
  }

  protected async performPeriodicCheck(): Promise<number> {
    const hasActiveParties = await this.checkAllPartiesProgress();
    if (!hasActiveParties) {
      return 0; // Shutdown - no active parties
    }
    return Date.now() + 5000; // 5 second intervals for Ziggurat
  }

  // Override logging methods to maintain ziggurat-specific naming
  protected log(...args: any[]): void {
    console.log({
      origin: "ZIGGURAT_OPERATOR",
      zigguratAddress: this.zigguratAddress,
      ...args
    });
  }

  protected error(...args: any[]): void {
    console.error({
      origin: "ZIGGURAT_OPERATOR",
      zigguratAddress: this.zigguratAddress,
      ...args
    });
  }

  private async checkSinglePartyProgress(partyId: bigint): Promise<void> {
    const zigguratAddress = await this.getZigguratAddress();
    if (!zigguratAddress) return;

    try {
      // Get the specific party from GraphQL
      const graphqlClient = createGraphQLClient(this.env);
      const result = await graphqlClient.query<{partys: {items: Party[]}}>(GraphQLQueries.getSpecificPartyByZiggurat, {
        zigguratAddress: zigguratAddress.toLowerCase(),
        partyId: partyId.toString()
      });

      // Should be 0 or 1 results
      const party = result.partys.items[0];
      
      if (party) {
        this.log(`Processing party ${partyId} after NextRoomChosenEvent`);
        await this.checkParty(partyId, party);
      } else {
        this.log(`Party ${partyId} not found or not in DOOR_CHOSEN state`);
      }

    } catch (error) {
      this.error(`Error in checkSinglePartyProgress for party ${partyId}:`, error);
    }
  }

  private async checkAllPartiesProgress(): Promise<boolean> {
    const zigguratAddress = await this.getZigguratAddress();
    if (!zigguratAddress) {
      this.log("No zigguratAddress set, skipping checkAllPartiesProgress");
      return false;
    }

    try {
      // Use GraphQL to get all DOOR_CHOSEN parties for this ziggurat
      const graphqlClient = createGraphQLClient(this.env);
      const result = await graphqlClient.query<{partys: {items: Party[]}}>(GraphQLQueries.getPartiesByZigguratWithStateDoorChosen, {
        zigguratAddress: zigguratAddress.toLowerCase()
      });

      const doorChosenParties = result.partys.items;
      
      this.log("Periodic check - Door chosen parties:", doorChosenParties.length);

      // Check each party to see if they need operator intervention
      for (const party of doorChosenParties) {
        await this.checkParty(BigInt(party.partyId), party);
      }

      return true;
    } catch (error) {
      this.error("Error in checkAllPartiesProgress:", error);
      return true; // Continue running even on error
    }
  }

  private async checkParty(partyId: bigint, partyGraphQLData: Party): Promise<void> {
    this.log(`Checking party ${partyId}:`, { 
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
    const zigguratAddress = await this.getZigguratAddress();
    if (!zigguratAddress) return;
    
    const roomsResult = await graphqlClient.query<{zigguratRooms: {items: ZigguratRoom[]} | null}>(GraphQLQueries.getSpecificZigguratRoom, {
      zigguratAddress: zigguratAddress.toLowerCase(),
      parentRoomHash: parentRoomHash,
      parentDoorIndex: chosenDoorIndex
    });

    if (!roomsResult.zigguratRooms) {
      this.error("No zigguratRooms data received from GraphQL");
      return;
    }

    const existingRoom = roomsResult.zigguratRooms.items[0]; // Should be 0 or 1 results

    this.log(`Party ${partyId} door ${chosenDoorIndex} status:`, { 
      roomExists: !!existingRoom,
      roomRevealed: existingRoom?.revealedAt !== null 
    });

    if (!existingRoom || existingRoom.revealedAt === null) {
      // Room hasn't been revealed yet, reveal it first
      this.log(`Party ${partyId} chose unrevealed room, revealing door ${chosenDoorIndex}`);
      const revealSuccess = await this.executeRevealDoor(parentRoomHash, chosenDoorIndex);
      
      if (revealSuccess) {           
        this.log(`Room revealed successfully, now entering door for party ${partyId}`);
        await this.executeEnterDoor(partyId);
      } else {
        this.error(`Failed to reveal door for party ${partyId}, retrying later`);
      }
    } else {
      // Room is already revealed, ready to enter
      this.log(`Party ${partyId} is ready to enter revealed door`);
      await this.executeEnterDoor(partyId);
    }
  }

  private async executeRevealDoor(roomHash: string, doorIndex: number): Promise<boolean> {
    try {
      this.log(`Executing revealDoor for room ${roomHash}, door ${doorIndex}`);

      // Create wallet client for signing
      const account = privateKeyToAccount(this.env.OPERATOR_PRIVATE_KEY as `0x${string}`);
      const walletClient = createWalletClient({
        account,
        chain: arbitrum,
        transport: createAuthenticatedHttpTransport(this.env.ETH_RPC_URL, this.env)
      });

      // Get the actual chain ID from the RPC
      const chainId = await walletClient.getChainId();

      // Create the message to sign according to the contract
      // The contract expects: keccak256(abi.encodePacked(block.chainid, address(this), _roomHash, _doorIndex))
      this.log('Creating signature with params:', {
        chainId: chainId,
        contractAddress: await this.getZigguratAddress(),
        roomHash: roomHash,
        doorIndex: doorIndex,
        operatorAddress: account.address
      });

      const messageHash = keccak256(
        encodePacked(
          ['uint256', 'address', 'bytes32', 'uint256'],
          [BigInt(chainId), (await this.getZigguratAddress()) as `0x${string}`, roomHash as `0x${string}`, BigInt(doorIndex)]
        )
      );

      // Sign the message hash directly - the contract will handle the Ethereum signed message prefix
      const signature = await walletClient.signMessage({
        message: { raw: messageHash }
      });

      this.log('Signed reveal message:', { 
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
        this.log('Verification hash for debugging:', { ethSignedMessageHash });
      } catch (verifyError) {
        this.log('Error in local verification:', verifyError);
      }

      // Encode the revealDoor function call
      const data = encodeFunctionData({
        abi: ZigguratABI as Abi,
        functionName: 'revealDoor',
        args: [roomHash, doorIndex, signature]
      });

      this.log("Calling revealDoor through forwarder");

      // Forward the transaction
      let hash;
      try {
        hash = await forwardTransaction(
          {
            to: (await this.getZigguratAddress()) as `0x${string}`,
            data: data,
            rpcUrl: this.env.ETH_RPC_URL,
            relayerUrl: this.env.RELAYER_URL,
            env: this.env
          },
          walletClient,
          this.env.ERC2771_FORWARDER_ADDRESS as `0x${string}`
        );
      } catch (error) {
        this.error("Error forwarding revealDoor transaction:", error);
        return false;
      }

      this.log("RevealDoor transaction forwarded:", hash);

      // Wait for transaction receipt
      if (hash) {
        try {
          const publicClient = createPublicClient({
            chain: arbitrum,
            transport: createAuthenticatedHttpTransport(this.env.ETH_RPC_URL, this.env)
          });
          const receipt = await publicClient.waitForTransactionReceipt({ hash });
          this.log("RevealDoor transaction confirmed:", receipt);
        } catch (error) {
          this.error("Error waiting for revealDoor transaction receipt:", error);
          return false;
        }
      } else {
        this.error("No transaction hash received from forwardTransaction for revealDoor");
        return false;
      }
      return true;
    } catch (error) {
      this.error(`Error executing revealDoor:`, error);
      return false;
    }
  }

  private async executeEnterDoor(partyId: bigint): Promise<void> {
    try {
      this.log(`Executing enterDoor for party ${partyId}`);

      // Create wallet client for sending transactions
      const account = privateKeyToAccount(this.env.OPERATOR_PRIVATE_KEY as `0x${string}`);
      const walletClient = createWalletClient({
        account,
        chain: arbitrum,
        transport: createAuthenticatedHttpTransport(this.env.ETH_RPC_URL, this.env)
      });

      // Encode the enterDoor function call
      const data = encodeFunctionData({
        abi: ZigguratABI as Abi,
        functionName: 'enterDoor',
        args: [partyId]
      });

      this.log("Calling enterDoor for party", partyId);

      // Forward the transaction
      let hash;
      try {
        hash = await forwardTransaction(
          {
            to: (await this.getZigguratAddress()) as `0x${string}`,
            data: data,
            rpcUrl: this.env.ETH_RPC_URL,
            relayerUrl: this.env.RELAYER_URL,
            env: this.env
          },
          walletClient,
          this.env.ERC2771_FORWARDER_ADDRESS as `0x${string}`
        );
      } catch (error) {
        this.error("Error forwarding enterDoor transaction:", error);
        return;
      }

      this.log("EnterDoor transaction forwarded:", hash);

      // Wait for transaction receipt
      if (hash) {
        try {
          const publicClient = createPublicClient({
            chain: arbitrum,
            transport: createAuthenticatedHttpTransport(this.env.ETH_RPC_URL, this.env)
          });
          const receipt = await publicClient.waitForTransactionReceipt({ hash });
          this.log("EnterDoor transaction confirmed:", receipt);
        } catch (error) {
          this.error("Error waiting for enterDoor transaction receipt:", error);
        }
      } else {
        this.error("No transaction hash received from forwardTransaction for party", partyId);
      }
    } catch (error) {
      this.error(`Error executing enterDoor for party ${partyId}:`, error);
    }
  }

}
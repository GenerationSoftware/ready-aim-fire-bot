import { createPublicClient, createWalletClient, encodeFunctionData, type Abi, keccak256, encodePacked } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { arbitrum } from "viem/chains";
import ZigguratABI from "../contracts/abis/Ziggurat.json";
import { forwardTransaction } from "../forwarder/forwardTransaction";
import { createGraphQLClient, GraphQLQueries, type Party, type ZigguratRoom } from "../utils/graphql";
import { createAuthenticatedHttpTransport } from "../utils/rpc";
import { createLogger } from "../utils/logger";
import type { Logger } from "pino";

export interface ZigguratOperatorConfig {
  ethRpcUrl: string;
  ethWsRpcUrl: string;
  graphqlUrl: string;
  operatorAddress: string;
  operatorPrivateKey: string;
  relayerUrl: string;
  erc2771ForwarderAddress: string;
  zigguratAddress: string;
}

export class ZigguratOperator {
  private config: ZigguratOperatorConfig;
  private intervalId?: NodeJS.Timeout;
  private isRunning: boolean = false;
  private lastCheckTime: number = 0;
  private logger: Logger;

  constructor(config: ZigguratOperatorConfig) {
    this.config = config;
    this.logger = createLogger({ operator: 'ZigguratOperator', zigguratAddress: config.zigguratAddress });
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

  start() {
    if (this.isRunning) {
      this.log("Already running");
      return;
    }

    this.isRunning = true;
    this.log("Starting...");

    // Initial check
    this.performPeriodicCheck();

    // Set up periodic checks every 5 seconds
    this.intervalId = setInterval(() => {
      this.performPeriodicCheck();
    }, 5000);
  }

  stop() {
    if (!this.isRunning) {
      this.log("Not running");
      return;
    }

    this.log("Stopping...");
    this.isRunning = false;

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
    } catch (error) {
      this.error("Error in periodic check:", error);
    }
  }

  private async checkAllPartiesProgress(): Promise<boolean> {
    try {
      // Use GraphQL to get all DOOR_CHOSEN parties for this ziggurat
      const graphqlClient = createGraphQLClient({ GRAPHQL_URL: this.config.graphqlUrl });
      const result = await graphqlClient.query<{ partys: { items: Party[] } }>(GraphQLQueries.getPartiesByZigguratWithStateDoorChosen, {
        zigguratAddress: this.config.zigguratAddress.toLowerCase()
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

  private async checkSinglePartyProgress(partyId: bigint): Promise<void> {
    try {
      // Get the specific party from GraphQL
      const graphqlClient = createGraphQLClient({ GRAPHQL_URL: this.config.graphqlUrl });
      const result = await graphqlClient.query<{ partys: { items: Party[] } }>(GraphQLQueries.getSpecificPartyByZiggurat, {
        zigguratAddress: this.config.zigguratAddress.toLowerCase(),
        partyId: partyId.toString()
      });

      // Should be 0 or 1 results
      const party = result.partys.items[0];
      
      if (party) {
        this.log(`Processing party ${partyId} after event`);
        await this.checkParty(partyId, party);
      } else {
        this.log(`Party ${partyId} not found or not in DOOR_CHOSEN state`);
      }

    } catch (error) {
      this.error(`Error in checkSinglePartyProgress for party ${partyId}:`, error);
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
    const graphqlClient = createGraphQLClient({ GRAPHQL_URL: this.config.graphqlUrl });
    
    const roomsResult = await graphqlClient.query<{ zigguratRooms: { items: ZigguratRoom[] } | null }>(GraphQLQueries.getSpecificZigguratRoom, {
      zigguratAddress: this.config.zigguratAddress.toLowerCase(),
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
      const account = privateKeyToAccount(this.config.operatorPrivateKey as `0x${string}`);
      const walletClient = createWalletClient({
        account,
        chain: arbitrum,
        transport: createAuthenticatedHttpTransport(this.config.ethRpcUrl, { ETH_RPC_URL: this.config.ethRpcUrl })
      });

      // Get the actual chain ID from the RPC
      const chainId = await walletClient.getChainId();

      // Create the message to sign according to the contract
      this.log('Creating signature with params:', {
        chainId: chainId,
        contractAddress: this.config.zigguratAddress,
        roomHash: roomHash,
        doorIndex: doorIndex,
        operatorAddress: account.address
      });

      const messageHash = keccak256(
        encodePacked(
          ['uint256', 'address', 'bytes32', 'uint256'],
          [BigInt(chainId), this.config.zigguratAddress as `0x${string}`, roomHash as `0x${string}`, BigInt(doorIndex)]
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
            to: this.config.zigguratAddress as `0x${string}`,
            data: data,
            rpcUrl: this.config.ethRpcUrl,
            relayerUrl: this.config.relayerUrl,
            env: { ETH_RPC_URL: this.config.ethRpcUrl } as any
          },
          walletClient,
          this.config.erc2771ForwarderAddress as `0x${string}`
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
            transport: createAuthenticatedHttpTransport(this.config.ethRpcUrl, { ETH_RPC_URL: this.config.ethRpcUrl })
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
      const account = privateKeyToAccount(this.config.operatorPrivateKey as `0x${string}`);
      const walletClient = createWalletClient({
        account,
        chain: arbitrum,
        transport: createAuthenticatedHttpTransport(this.config.ethRpcUrl, { ETH_RPC_URL: this.config.ethRpcUrl })
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
            to: this.config.zigguratAddress as `0x${string}`,
            data: data,
            rpcUrl: this.config.ethRpcUrl,
            relayerUrl: this.config.relayerUrl,
            env: { ETH_RPC_URL: this.config.ethRpcUrl } as any
          },
          walletClient,
          this.config.erc2771ForwarderAddress as `0x${string}`
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
            transport: createAuthenticatedHttpTransport(this.config.ethRpcUrl, { ETH_RPC_URL: this.config.ethRpcUrl })
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
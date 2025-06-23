import { DurableObject } from "cloudflare:workers";
import { Env } from "./Env";
import ZigguratABI from "./contracts/abis/Ziggurat.json";
import { createPublicClient, createWalletClient, http, encodeFunctionData, type Abi, keccak256, encodePacked } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { arbitrum } from "viem/chains";
import { forwardTransaction } from "./forwarder/forwardTransaction";
import { CONTRACT_ADDRESSES } from "./utils/deployments";

export class ZigguratOperator {
  private state: DurableObjectState;
  private env: Env;
  private zigguratAddress: string | null = null;

  constructor(state: DurableObjectState, env: Env) {
    this.state = state;
    this.env = env;
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

  private async checkPartyProgress(): Promise<boolean> {
    if (!this.zigguratAddress) return false;

    const publicClient = createPublicClient({
      chain: arbitrum,
      transport: http(this.env.ETH_RPC_URL)
    });

    try {
      // Get the current party count
      const partyCount = await publicClient.readContract({
        address: this.zigguratAddress as `0x${string}`,
        abi: ZigguratABI as Abi,
        functionName: 'partyCount'
      }) as bigint;

      this.zigLog("Current party count:", partyCount);

      // Check each active party to see if they need operator intervention
      for (let i = 1n; i <= partyCount; i++) {
        await this.checkParty(i, publicClient);
      }

      return true;
    } catch (error) {
      this.zigError("Error in checkPartyProgress:", error);
      // On error, try again in 5 seconds
      await this.state.storage.setAlarm(Date.now() + 5000);
      return true;
    }
  }

  private async checkParty(partyId: bigint, publicClient: any): Promise<void> {
    try {
      // Get party information
      const [party, location] = await publicClient.multicall({
        contracts: [
          {
            address: this.zigguratAddress as `0x${string}`,
            abi: ZigguratABI as Abi,
            functionName: 'parties',
            args: [partyId]
          },
          {
            address: this.zigguratAddress as `0x${string}`,
            abi: ZigguratABI as Abi,
            functionName: 'partyLocation',
            args: [partyId]
          }
        ]
      });

      if (party.status === 'failure' || location.status === 'failure') {
        this.zigError("Failed to get party data for party", partyId);
        return;
      }

      const partyData = party.result as any;
      const locationData = location.result as any;

      // Skip if party hasn't started or has ended
      if (!partyData.isStarted || partyData.isEnded) {
        return;
      }

      this.zigLog(`Checking party ${partyId}:`, { partyData, locationData });

      // Check if room is completed and door is chosen
      const isRoomCompleted = await publicClient.readContract({
        address: this.zigguratAddress as `0x${string}`,
        abi: ZigguratABI as Abi,
        functionName: 'isRoomCompleted',
        args: [partyId]
      }) as boolean;

      if (isRoomCompleted && locationData.isNextDoorChosen) {
        // Check if the chosen room has been revealed
        const chosenRoomHash = await publicClient.readContract({
          address: this.zigguratAddress as `0x${string}`,
          abi: ZigguratABI as Abi,
          functionName: 'childRoomHashes',
          args: [locationData.parentRoomHash, locationData.chosenDoorIndex]
        }) as string;

        if (chosenRoomHash === '0x0000000000000000000000000000000000000000000000000000000000000000') {
          // Room hasn't been revealed yet, reveal it first
          this.zigLog(`Party ${partyId} chose unrevealed room, revealing door ${locationData.chosenDoorIndex}`);
          const revealSuccess = await this.executeRevealDoor(locationData.parentRoomHash, locationData.chosenDoorIndex);
          
          // If reveal was successful, proceed to enter the door
          if (revealSuccess) {
            this.zigLog(`Room revealed successfully, now entering door for party ${partyId}`);
            await this.executeEnterDoor(partyId);
          }
        } else {
          // Room is revealed, ready to enter
          this.zigLog(`Party ${partyId} is ready to enter revealed door`);
          await this.executeEnterDoor(partyId);
        }
      }

    } catch (error) {
      this.zigError(`Error checking party ${partyId}:`, error);
    }
  }

  private async executeRevealDoor(parentRoomHash: string, parentDoorIndex: number): Promise<boolean> {
    try {
      this.zigLog(`Executing revealDoor for room ${parentRoomHash}, door ${parentDoorIndex}`);

      // Create wallet client for signing
      const account = privateKeyToAccount(this.env.OPERATOR_PRIVATE_KEY as `0x${string}`);
      const walletClient = createWalletClient({
        account,
        chain: arbitrum,
        transport: http(this.env.ETH_RPC_URL)
      });

      // Create the message to sign according to the contract
      // The contract expects: keccak256(abi.encodePacked(block.chainid, address(this), _parentRoomHash, _parentDoorIndex))
      const messageHash = keccak256(
        encodePacked(
          ['uint256', 'address', 'bytes32', 'uint256'],
          [BigInt(arbitrum.id), this.zigguratAddress as `0x${string}`, parentRoomHash as `0x${string}`, BigInt(parentDoorIndex)]
        )
      );

      // Create the Ethereum signed message hash
      const ethSignedMessageHash = keccak256(
        encodePacked(
          ['string', 'bytes32'],
          ['\x19Ethereum Signed Message:\n32', messageHash]
        )
      );

      // Sign the message hash
      const signature = await walletClient.signMessage({
        message: { raw: messageHash }
      });

      this.zigLog('Signed reveal message:', { messageHash, signature });

      // Encode the revealDoor function call
      const data = encodeFunctionData({
        abi: ZigguratABI as Abi,
        functionName: 'revealDoor',
        args: [parentRoomHash, parentDoorIndex, signature]
      });

      this.zigLog("Calling revealDoor");

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
      this.zigguratAddress = url.searchParams.get("zigguratAddress");
      if (!this.zigguratAddress) {
        return new Response("Missing zigguratAddress", { status: 400 });
      }

      // Store ziggurat address
      await this.state.storage.put("zigguratAddress", this.zigguratAddress);

      // Start checking party progress
      await this.state.storage.setAlarm(Date.now() + 5000);
      return new Response("ZigguratOperator started");
    }

    return new Response("Not found", { status: 404 });
  }

  async alarm() {
    this.zigLog("ZigguratOperator wake up for ziggurat", this.zigguratAddress);
    
    // Restore ziggurat address from storage if not set
    if (!this.zigguratAddress) {
      this.zigguratAddress = await this.state.storage.get("zigguratAddress") as string;
    }

    if (!await this.checkPartyProgress()) {
      // Ziggurat is closed or we don't need to continue, clean up resources
      await this.state.storage.deleteAll();
      this.zigLog("ZigguratOperator resources released - ziggurat closed or no longer needed");
    } else {
      // Continue checking party progress
      await this.state.storage.setAlarm(Date.now() + 5000);
      this.zigLog("ZigguratOperator will check again in 5 seconds");
    }
  }
}
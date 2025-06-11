import { DurableObject } from "cloudflare:workers";
import { Env } from "./Env";
import { ReadyAimFireABI } from "./abis/ReadyAimFireABI";
import { createPublicClient, createWalletClient, http, encodeFunctionData, encodeEventTopics } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { arbitrum } from "viem/chains";
import { forwardTransaction } from "./forwarder/forwardTransaction";

// WebSocket interface to match Cloudflare Workers WebSocket API
interface WebSocketEventHandlers {
  onopen: (event: Event) => void;
  onmessage: (event: MessageEvent) => void;
  onclose: (event: CloseEvent) => void;
  onerror: (event: Event) => void;
}

export class Operator {
  private state: DurableObjectState;
  private env: Env;
  private websocket: WebSocket & WebSocketEventHandlers | null = null;
  private gameAddress: string | null = null;

  constructor(state: DurableObjectState, env: Env) {
    this.state = state;
    this.env = env;
  }

  private opLog(this: Operator, ...args: any[]): void {
    console.log({
      origin: "OPERATOR",
      gameAddress: this.gameAddress,
      ...args
    });
  }

  private opError(this: Operator, ...args: any[]): void {
    console.error({
      origin: "OPERATOR",
      gameAddress: this.gameAddress,
      ...args
    });
  }

  private async checkAndAdvanceTurn(): Promise<boolean> {
    if (!this.gameAddress) return false;

    const publicClient = createPublicClient({
      chain: arbitrum,
      transport: http(this.env.ETH_RPC_URL)
    });

    try {
      // Check if turn has ended and game state using multicall
      const [isTurnOver, gameState] = await publicClient.multicall({
        contracts: [
          {
            address: this.gameAddress as `0x${string}`,
            abi: ReadyAimFireABI,
            functionName: 'isTurnOver'
          },
          {
            address: this.gameAddress as `0x${string}`,
            abi: ReadyAimFireABI,
            functionName: 'getGameState'
          }
        ]
      });

      if (isTurnOver.status === 'failure' || gameState.status === 'failure') {
        console.error("Failed to get game state:", { isTurnOver, gameState });
        await this.state.storage.setAlarm(Date.now() + 1000);
        return false;
      }

      // Only proceed if game is still active (state <= 2)
      if (BigInt(gameState.result) > 2n) {
        this.opLog("Game has ended, stopping operator");
        return false;
      }

      if (isTurnOver.result) {
        this.opLog("Turn has ended, advancing to next turn");
        
        // Create wallet client for sending transactions
        const account = privateKeyToAccount(this.env.OPERATOR_PRIVATE_KEY as `0x${string}`);
        const walletClient = createWalletClient({
          account,
          chain: arbitrum,
          transport: http(this.env.ETH_RPC_URL)
        });

        // Encode the nextTurn function call
        const data = encodeFunctionData({
          abi: ReadyAimFireABI,
          functionName: 'nextTurn'
        });

        this.opLog("Calling nextTurn for game ", this.gameAddress);

        // Forward the transaction
        let hash;
        try {
          hash = await forwardTransaction(
            {
              to: this.gameAddress as `0x${string}`,
              data: data,
              rpcUrl: this.env.ETH_RPC_URL,
              relayerUrl: this.env.RELAYER_URL
            },
            walletClient,
            this.env.ERC2771_FORWARDER_ADDRESS as `0x${string}`
          );
        } catch (error) {
          console.error("Error forwarding transaction:", error);
          // Schedule another check in 1 second
          await this.state.storage.setAlarm(Date.now() + 1000);
          return true;
        }

        this.opLog("Next turn transaction forwarded:", hash);

        // Wait for transaction receipt only if we have a valid hash
        if (hash) {
          try {
            const receipt = await publicClient.waitForTransactionReceipt({ hash });
            this.opLog("Next turn transaction confirmed:", receipt);
          } catch (error) {
            console.error("Error waiting for transaction receipt:", error);
            // Schedule another check in 1 second
            await this.state.storage.setAlarm(Date.now() + 1000);
            return true;
          }
        } else {
          console.error("No transaction hash received from forwardTransaction for game ", this.gameAddress);
          // Schedule another check in 1 second
          await this.state.storage.setAlarm(Date.now() + 1000);
          return true;
        }

        this.opLog("Reading currentTurnEndsAt");

        // Get the new turn end time
        const currentTurnEndsAt = await publicClient.readContract({
          address: this.gameAddress as `0x${string}`,
          abi: ReadyAimFireABI,
          functionName: 'currentTurnEndsAt'
        });

        this.opLog("Scheduling next check at", currentTurnEndsAt);

        // Schedule next check at turn end time
        await this.state.storage.setAlarm(Number(currentTurnEndsAt) * 1000);
      } else {
        this.opLog("Turn has not ended, checking again in 1 second");
        // Check again in 1 second
        await this.state.storage.setAlarm(Date.now() + 1000);
      }
    } catch (error) {
      console.error("Error in checkAndAdvanceTurn:", error);
      // On error, try again in 5 seconds
      await this.state.storage.setAlarm(Date.now() + 5000);
    }

    return true;
  }

  private async connect() {
    if (this.websocket) return;

    // Convert HTTP URL to WebSocket URL
    const wsUrl = this.env.ETH_RPC_URL.replace('http://', 'ws://').replace('https://', 'wss://');
    this.opLog("Connecting to WebSocket", wsUrl);

    const ws = new WebSocket(wsUrl) as WebSocket & WebSocketEventHandlers;

    ws.onopen = () => {
      this.opLog("✅ WebSocket connected");

      // Get the EndedTurnEvent from the ABI
      const endedTurnEvent = ReadyAimFireABI.find(
        (item) => item.type === "event" && item.name === "EndedTurnEvent"
      );

      if (!endedTurnEvent) {
        throw new Error("EndedTurnEvent not found in ABI");
      }

      // Get the event topic using viem's encodeEventTopics
      const eventTopic = encodeEventTopics({
        abi: [endedTurnEvent],
        eventName: 'EndedTurnEvent'
      })[0];

      // Subscribe to EndedTurnEvent
      const subscribePayload = {
        jsonrpc: '2.0',
        id: 1,
        method: "eth_subscribe",
        params: [
          "logs",
          {
            address: this.gameAddress,
            topics: [eventTopic]
          }
        ]
      };

      this.opLog("Subscribing with payload:", JSON.stringify(subscribePayload));
      ws.send(JSON.stringify(subscribePayload));
    };

    ws.onmessage = async (event: MessageEvent) => {
      try {
        const data = JSON.parse(event.data as string);
        if (data.method === "eth_subscription") {
          this.opLog("📦 EndedTurnEvent received");
          await this.checkAndAdvanceTurn();
        }
      } catch (err) {
        console.error("⚠️ Failed to parse log message", err);
      }
    };

    ws.onclose = () => {
      this.opLog("🔁 WebSocket closed, retrying...");
      this.websocket = null;
      setTimeout(() => this.connect(), 5000);
    };

    ws.onerror = (err: Event) => {
      console.error("🛑 WebSocket error", err);
    };

    this.websocket = ws;
  }

  async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);

    if (url.pathname === "/start") {
      this.gameAddress = url.searchParams.get("gameAddress");
      if (!this.gameAddress) {
        return new Response("Missing gameAddress", { status: 400 });
      }

      // Store game address
      await this.state.storage.put("gameAddress", this.gameAddress);

      // Connect to WebSocket
      try {
        await this.connect();
      } catch (error) {
        console.error("Error connecting to WebSocket", error);
      }

      // Get initial turn end time and set alarm
      const publicClient = createPublicClient({
        chain: arbitrum,
        transport: http(this.env.ETH_RPC_URL)
      });

      const currentTurnEndsAt = await publicClient.readContract({
        address: this.gameAddress as `0x${string}`,
        abi: ReadyAimFireABI,
        functionName: 'currentTurnEndsAt'
      });

      await this.state.storage.setAlarm(Number(currentTurnEndsAt) * 1000);
      return new Response("Operator started");
    }

    return new Response("Not found", { status: 404 });
  }

  async alarm() {
    console.log("Operator wake up for game ", this.gameAddress);
    
    // Check if WebSocket is connected, if not try to reconnect
    if (!this.websocket || this.websocket.readyState !== WebSocket.OPEN) {
      try {
        console.log("WebSocket not connected, attempting to reconnect");
        await this.connect();
      } catch (error) {
        console.error("Failed to reconnect WebSocket", error);
      }
    }

    if (!await this.checkAndAdvanceTurn()) {
      // Game is over or we don't need to continue, clean up resources
      await this.state.storage.deleteAll();
      console.log("Operator resources released - game ended or no longer needed");
    }
  }
}

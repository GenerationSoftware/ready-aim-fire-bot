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

  private async checkAndAdvanceTurn() {
    if (!this.gameAddress) return;

    const publicClient = createPublicClient({
      chain: arbitrum,
      transport: http(this.env.ETH_RPC_URL)
    });

    try {
      // Check if turn has ended
      const isTurnOver = await publicClient.readContract({
        address: this.gameAddress as `0x${string}`,
        abi: ReadyAimFireABI,
        functionName: 'isTurnOver'
      });

      if (isTurnOver) {
        console.log("Turn has ended, advancing to next turn");
        
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

        console.log("Calling nextTurn for game ", this.gameAddress);

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
          return;
        }

        console.log("Next turn transaction forwarded:", hash);

        // Wait for transaction receipt only if we have a valid hash
        if (hash) {
          try {
            const receipt = await publicClient.waitForTransactionReceipt({ hash });
            console.log("Next turn transaction confirmed:", receipt);
          } catch (error) {
            console.error("Error waiting for transaction receipt:", error);
            // Schedule another check in 1 second
            await this.state.storage.setAlarm(Date.now() + 1000);
            return;
          }
        } else {
          console.error("No transaction hash received from forwardTransaction");
          // Schedule another check in 1 second
          await this.state.storage.setAlarm(Date.now() + 1000);
          return;
        }

        // Get the new turn end time
        const currentTurnEndsAt = await publicClient.readContract({
          address: this.gameAddress as `0x${string}`,
          abi: ReadyAimFireABI,
          functionName: 'currentTurnEndsAt'
        });

        // Schedule next check at turn end time
        await this.state.storage.setAlarm(Number(currentTurnEndsAt) * 1000);
      } else {
        // Check again in 1 second
        await this.state.storage.setAlarm(Date.now() + 1000);
      }
    } catch (error) {
      console.error("Error in checkAndAdvanceTurn:", error);
      // On error, try again in 1 second
      await this.state.storage.setAlarm(Date.now() + 1000);
    }
  }

  private async connect() {
    if (this.websocket) return;

    // Convert HTTP URL to WebSocket URL
    const wsUrl = this.env.ETH_RPC_URL.replace('http://', 'ws://').replace('https://', 'wss://');
    console.log("Connecting to WebSocket", wsUrl);

    const ws = new WebSocket(wsUrl) as WebSocket & WebSocketEventHandlers;

    ws.onopen = () => {
      console.log("✅ WebSocket connected");

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

      console.log("Subscribing with payload:", JSON.stringify(subscribePayload));
      ws.send(JSON.stringify(subscribePayload));
    };

    ws.onmessage = async (event: MessageEvent) => {
      try {
        const data = JSON.parse(event.data as string);
        if (data.method === "eth_subscription") {
          console.log("📦 EndedTurnEvent received");
          await this.checkAndAdvanceTurn();
        }
      } catch (err) {
        console.error("⚠️ Failed to parse log message", err);
      }
    };

    ws.onclose = () => {
      console.log("🔁 WebSocket closed, retrying...");
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

    await this.checkAndAdvanceTurn();
  }
}

import { DurableObject } from "cloudflare:workers";
import { Env } from "./Env";
import { ReadyAimFireABI } from "./abis/ReadyAimFireABI";
import { MinterABI } from "./abis/MinterABI";
import { encodeEventTopics, createPublicClient, createWalletClient, http, parseEther, encodeFunctionData, type Hash, decodeEventLog } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { arbitrum } from "viem/chains";
import { forwardTransaction } from "./forwarder/forwardTransaction";
import { keccak256, toBytes } from "viem";

// WebSocket interface to match Cloudflare Workers WebSocket API
interface WebSocketEventHandlers {
  onopen: (event: Event) => void;
  onmessage: (event: MessageEvent) => void;
  onclose: (event: CloseEvent) => void;
  onerror: (event: Event) => void;
}

export class EventListener {
    state: DurableObjectState;
    websocket: WebSocket & WebSocketEventHandlers | null = null;
    env: Env;
  
    constructor(state: DurableObjectState, env: Env) {
      this.state = state;
      this.env = env;
    }

    private async checkMint(address: string): Promise<boolean> {
      try {
        // Create public client for reading contract state
        const publicClient = createPublicClient({
          chain: arbitrum,
          transport: http(this.env.ETH_RPC_URL)
        });

        console.log("Checking mint status for address:", address);
        console.log("Using Minter contract at:", this.env.MINTER_ADDRESS);

        // Check if player has already minted
        const hasMinted = await publicClient.readContract({
          address: this.env.MINTER_ADDRESS as `0x${string}`,
          abi: MinterABI,
          functionName: 'playerMinted',
          args: [address as `0x${string}`]
        }).catch(error => {
          console.error("Error reading playerMinted:", error);
          throw error;
        });

        console.log("Mint status:", hasMinted);

        if (hasMinted) {
          console.log("Player has already minted");
          return true;
        }

        console.log("Player has not minted, proceeding with mint transaction");

        // Create wallet client for sending transactions
        const account = privateKeyToAccount(this.env.PRIVATE_KEY as `0x${string}`);
        const walletClient = createWalletClient({
          account,
          chain: arbitrum,
          transport: http(this.env.ETH_RPC_URL)
        });

        // Encode the mintCollection function call
        const data = encodeFunctionData({
          abi: MinterABI,
          functionName: 'mintCollection',
          args: [address as `0x${string}`]
        });

        console.log("Encoded mintCollection data:", data);

        // Forward the transaction using the forwarder
        const hash = await forwardTransaction(
          {
            to: this.env.MINTER_ADDRESS as `0x${string}`,
            data: data,
            rpcUrl: this.env.ETH_RPC_URL,
            relayerUrl: this.env.RELAYER_URL
          },
          walletClient,
          this.env.ERC2771_FORWARDER_ADDRESS as `0x${string}`
        );

        console.log("Mint transaction forwarded:", hash);
        return false;
      } catch (error) {
        console.error("Error in checkMint:", error);
        throw error;
      }
    }

    private async checkHistoryAndStart() {
      try {
        // Create a public client for reading contract state
        const publicClient = createPublicClient({
          chain: arbitrum,
          transport: http(this.env.ETH_RPC_URL)
        });

        // Get logs from the last 1000 blocks
        const currentBlock = await publicClient.getBlockNumber();

        const playerJoinedEvent = ReadyAimFireABI.find(item => item.type === 'event' && item.name === 'PlayerJoinedEvent');
        if (!playerJoinedEvent) {
          throw new Error('PlayerJoinedEvent not found in ABI');
        }

        const logs = await publicClient.getLogs({
          event: playerJoinedEvent,
          fromBlock: 0n,
          toBlock: currentBlock,
          args: {
            owner: this.env.ADDRESS as `0x${string}`
          }
        });

        console.log(logs);

        // No need to filter logs since we're already filtering by owner in the query
        const ourLogs = logs;

        // Check game state for each game
        for (const log of ourLogs) {
          const gameState = await publicClient.readContract({
            address: log.address,
            abi: ReadyAimFireABI,
            functionName: 'getGameState'
          });

          if (gameState <= 2) {
            console.log("READY TO PLAY");
            // Create a new Bot instance using playerId
            const args = log.args as { owner: `0x${string}`, playerId: bigint, locationX: bigint };
            const isTeamA = args.locationX === 0n;
            const id = this.env.BOT.idFromName(args.playerId.toString());
            const bot = this.env.BOT.get(id);
            await bot.fetch(new Request(`http://bot/start?gameAddress=${log.address}&playerId=${args.playerId}&teamA=${isTeamA}`));
            break;
          } else {
            console.log("NOT READY TO PLAY", gameState);
          }
        }
      } catch (error) {
        console.error("Error in checkHistoryAndStart:", error);
      }
    }
  
    async connect() {
      if (this.websocket) return;
  
      console.log("Connecting to WebSocket", this.env.ETH_WS_RPC_URL);

      const ws = new WebSocket(this.env.ETH_WS_RPC_URL) as WebSocket & WebSocketEventHandlers;
  
      ws.onopen = () => {
        console.log("✅ WebSocket connected");
  
        /*

        Process:

        Listens for PlayerJoinedGame with its address.
        Allocates a new durable object for the player id

        Durable object:
        - listens for GameStarted event
        - polls every 2 seconds to see if its the bot turn
        - if timeout, then kill the bot.

        */

        // Get the PlayerJoinedEvent from the ABI
        const playerJoinedEvent = ReadyAimFireABI.find(
          (item) => item.type === "event" && item.name === "PlayerJoinedEvent"
        );

        if (!playerJoinedEvent) {
          throw new Error("PlayerJoinedEvent not found in ABI");
        }

        // Generate topics using Viem
        const topics = encodeEventTopics({
          abi: [playerJoinedEvent],
          eventName: "PlayerJoinedEvent",
          args: {
            owner: this.env.ADDRESS as `0x${string}`
          }
        });

        const subscribePayload = {
          jsonrpc: '2.0',
          id: 1,
          method: "eth_subscribe",
          params: [
            "logs",
            {
              topics: topics
            }
          ]
        };

        console.log("Subscribing with payload:", JSON.stringify(subscribePayload));
        ws.send(JSON.stringify(subscribePayload));
      };
  
      ws.onmessage = async(event: MessageEvent) => {
        try {
          const data = JSON.parse(event.data as string);
          console.log("ONMESSAGE !!!!!!!!!!!! ", data);
          if (data.method === "eth_subscription") {
            const log = data.params.result;
            console.log("📦 Event received", log);
          
            // Get the PlayerJoinedEvent from the ABI
            const playerJoinedEvent = ReadyAimFireABI.find(
              (item) => item.type === "event" && item.name === "PlayerJoinedEvent"
            );

            if (!playerJoinedEvent) {
              throw new Error("PlayerJoinedEvent not found in ABI");
            }

            // Decode the log data using the ABI
            const decodedLog = decodeEventLog({
              abi: [playerJoinedEvent],
              data: log.data,
              topics: log.topics,
              strict: false
            });

            console.log("Decoded log:", decodedLog);

            if (!decodedLog.args.playerId) {
              throw new Error("PlayerId not found in decoded log");
            }

            const isTeamA = decodedLog.args.locationX === 0n;
            const id = this.env.BOT.idFromName(decodedLog.args.playerId.toString());
            const bot = this.env.BOT.get(id);
            await bot.fetch(new Request(`http://bot/start?gameAddress=${log.address}&playerId=${decodedLog.args.playerId}&teamA=${isTeamA}`));
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
      console.log("EventListener Fetching", url.pathname);
  
      if (url.pathname === "/start") {
        console.log("MATCH");
        try {
          await this.checkMint(this.env.ADDRESS);
          console.log("Mint check completed");
          await this.checkHistoryAndStart();
          await this.connect();
          return new Response("WebSocket connection started and mint check completed.");
        } catch (error: unknown) {
          console.error("Error in /start:", error);
          const errorMessage = error instanceof Error ? error.message : "Unknown error occurred";
          return new Response(`Error: ${errorMessage}`, { status: 500 });
        }
      } else {
        console.log("NO MATCH");
      }
  
      return new Response("Not found", { status: 404 });
    }
  }

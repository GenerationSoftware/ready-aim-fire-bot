import { Env } from "../Env";
import { OperatorManager as NodeOperatorManager, type OperatorManagerConfig } from "../node/OperatorManager";

export class OperatorManager {
  private state: DurableObjectState;
  private env: Env;
  private nodeManager?: NodeOperatorManager;
  private config?: OperatorManagerConfig;

  constructor(state: DurableObjectState, env: Env) {
    this.state = state;
    this.env = env;
  }

  private getConfig(): OperatorManagerConfig {
    if (!this.config) {
      this.config = {
        ethRpcUrl: this.env.ETH_RPC_URL,
        ethWsRpcUrl: this.env.ETH_WS_RPC_URL || this.env.ETH_RPC_URL.replace('http', 'ws'),
        graphqlUrl: this.env.GRAPHQL_URL,
        operatorAddress: this.env.OPERATOR_ADDRESS,
        operatorPrivateKey: this.env.OPERATOR_PRIVATE_KEY,
        relayerUrl: this.env.RELAYER_URL,
        erc2771ForwarderAddress: this.env.ERC2771_FORWARDER_ADDRESS
      };
    }
    return this.config;
  }

  private getNodeManager(): NodeOperatorManager {
    if (!this.nodeManager) {
      this.nodeManager = new NodeOperatorManager(this.getConfig());
    }
    return this.nodeManager;
  }

  async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);

    if (url.pathname === "/start") {
      await this.state.storage.deleteAlarm();
      await this.state.storage.deleteAll();
      
      try {
        const manager = this.getNodeManager();
        await manager.start();
        await this.state.storage.put("started", true);
        await this.state.storage.setAlarm(Date.now() + 5000);
        return new Response("Operator Manager started");
      } catch (error: unknown) {
        console.error("Error in /start:", error);
        const errorMessage = error instanceof Error ? error.message : "Unknown error occurred";
        await this.state.storage.setAlarm(Date.now() + 5000);
        return new Response(`Error starting bot: ${errorMessage}. Re-trying in 5 seconds`, { status: 500 });
      }
    } else if (url.pathname === "/reset") {
      await this.state.storage.deleteAlarm();
      await this.state.storage.deleteAll();
      
      if (this.nodeManager) {
        await this.nodeManager.stop();
        this.nodeManager = undefined;
      }
      
      return new Response("Reset listener");
    } else if (url.pathname === "/status") {
      const manager = this.getNodeManager();
      const status = manager.getStatus();
      return new Response(JSON.stringify(status), {
        headers: { "Content-Type": "application/json" }
      });
    }

    return new Response("Not found", { status: 404 });
  }

  async alarm() {
    console.log("OperatorManager alarm triggered");
    
    const started = await this.state.storage.get("started");
    if (!started) {
      console.log("OperatorManager not started, skipping alarm");
      return;
    }

    // The Node.js OperatorManager handles its own periodic checks
    // Just ensure it's still running
    const manager = this.getNodeManager();
    if (!manager.getStatus().running) {
      console.log("Node.js OperatorManager not running, restarting...");
      await manager.start();
    }

    // Schedule next alarm
    await this.state.storage.setAlarm(Date.now() + 30000); // Check every 30 seconds
  }
}
import { DurableObject } from "cloudflare:workers";
import { Env } from "./Env";
import { createPublicClient, webSocket, type Abi } from "viem";
import { arbitrum } from "viem/chains";

export interface EventSubscription {
  eventName: string;
  abi: any[];
  onEvent: (logs: any[]) => Promise<void>;
}

export abstract class Operator {
  protected state: DurableObjectState;
  protected env: Env;
  protected operatorId: string | null = null;
  protected wsClient: any = null;
  protected wsUnwatch: (() => void) | null = null;

  constructor(state: DurableObjectState, env: Env) {
    this.state = state;
    this.env = env;
    
    // Restore connection if it was previously established
    this.restoreConnection();
  }

  // Abstract methods that subclasses must implement
  protected abstract getOperatorIdKey(): string; // e.g., "gameAddress" or "zigguratAddress"
  protected abstract getEventSubscriptions(): EventSubscription[];
  protected abstract performPeriodicCheck(): Promise<number>; // Returns next alarm time, 0 = shutdown

  // Logging methods that subclasses can override
  protected log(...args: any[]): void {
    console.log({
      origin: this.constructor.name.toUpperCase(),
      operatorId: this.operatorId,
      ...args
    });
  }

  protected error(...args: any[]): void {
    console.error({
      origin: this.constructor.name.toUpperCase(),
      operatorId: this.operatorId,
      ...args
    });
  }

  private async restoreConnection(): Promise<void> {
    try {
      this.operatorId = await this.state.storage.get(this.getOperatorIdKey()) as string;
      if (this.operatorId && !this.wsClient) {
        this.log("Restoring WebSocket connection for:", this.operatorId);
        await this.setupWebSocketConnection();
      }
    } catch (error) {
      this.error("Error restoring WebSocket connection:", error);
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
      this.error("Error cleaning up WebSocket connection:", error);
    }
  }

  private async setupWebSocketConnection(): Promise<void> {
    if (!this.operatorId) {
      this.error("Cannot setup WebSocket without operatorId");
      return;
    }

    try {
      const subscriptions = this.getEventSubscriptions();
      
      if (subscriptions.length === 0) {
        this.log("No event subscriptions defined, skipping WebSocket setup");
        return;
      }

      // Create WebSocket client
      this.wsClient = createPublicClient({
        chain: arbitrum,
        transport: webSocket(this.env.ETH_RPC_URL)
      });

      // Set up event listeners for each subscription
      const unwatchFunctions: (() => void)[] = [];

      for (const subscription of subscriptions) {
        // Find the event in the ABI
        const eventDef = subscription.abi.find(
          item => item.type === 'event' && item.name === subscription.eventName
        );

        if (!eventDef) {
          throw new Error(`${subscription.eventName} not found in provided ABI`);
        }

        this.log(`Found ${subscription.eventName} in ABI:`, eventDef);

        // Listen for events from this specific contract
        const unwatch = this.wsClient.watchEvent({
          address: this.operatorId as `0x${string}`,
          event: eventDef,
          onLogs: (logs: any[]) => {
            this.log(`${subscription.eventName} received:`, logs.length, "events");
            subscription.onEvent(logs);
          }
        });

        unwatchFunctions.push(unwatch);
      }

      // Store a combined unwatch function
      this.wsUnwatch = () => {
        unwatchFunctions.forEach(unwatch => unwatch());
      };
      
      this.log("WebSocket connection established with", subscriptions.length, "event subscriptions");
      
    } catch (error) {
      this.error("Error setting up WebSocket connection:", error);
      throw error; // Re-throw to prevent silent failures
    }
  }

  async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);

    if (url.pathname === "/start") {
      const paramName = this.getOperatorIdKey() === "gameAddress" ? "gameAddress" : "zigguratAddress";
      const requestedOperatorId = url.searchParams.get(paramName);

      if (!requestedOperatorId) {
        return new Response(`Missing ${paramName}`, { status: 400 });
      }

      // Set up new connection
      this.operatorId = requestedOperatorId;
      await this.state.storage.put(this.getOperatorIdKey(), this.operatorId);

      let hasError = false;
      let errorMessage = "";

      // Setup WebSocket connection if not already connected
      if (!this.wsClient) {
        try {
          // Clean up any existing connection
          await this.cleanupWebSocketConnection();
          
          // Setup WebSocket connection
          await this.setupWebSocketConnection();
          this.log("WebSocket connection established");
        } catch (error) {
          this.error("Failed to setup WebSocket connection:", error);
          hasError = true;
          errorMessage += `WebSocket error: ${error}; `;
        }
      } else {
        this.log("WebSocket connection already exists");
      }

      // Setup alarm if none exists or if existing alarm is in the past
      try {
        const currentAlarm = await this.state.storage.getAlarm();
        const currentTime = Date.now();
        
        if (currentAlarm === null || currentAlarm < currentTime) {
          this.state.storage.setAlarm(currentTime + 5000);
          this.log("Alarm scheduled for periodic checks");
        } else {
          this.log("Alarm already scheduled");
        }
      } catch (error) {
        this.error("Failed to setup alarm:", error);
        hasError = true;
        errorMessage += `Alarm error: ${error}; `;
      }

      if (hasError) {
        return new Response(`${this.constructor.name} started with errors: ${errorMessage}`, { status: 207 });
      }
      
      return new Response(`${this.constructor.name} started`);
    }

    return new Response("Not found", { status: 404 });
  }

  async alarm(): Promise<void> {
    try {
      this.log(`${this.constructor.name} alarm triggered`);
      
      // Perform the subclass-specific periodic check
      const nextAlarmTime = await this.performPeriodicCheck();
      
      if (nextAlarmTime === 0) {
        // Operation is complete, clean up resources
        await this.cleanupWebSocketConnection();
        await this.state.storage.deleteAll();
        this.log("Operator resources released - operation completed");
      } else {
        // Schedule the next alarm
        this.state.storage.setAlarm(nextAlarmTime);
        this.log(`Next alarm scheduled for: ${new Date(nextAlarmTime).toISOString()}`);
      }
    } catch (error) {
      this.error("Error in alarm:", error);
      // Continue with next alarm even on error - fallback to 5-second interval
      this.state.storage.setAlarm(Date.now() + 5000);
    }
  }
}
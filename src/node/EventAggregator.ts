import { createPublicClient } from "viem";
import { arbitrum } from "viem/chains";
import { createAuthenticatedWebSocketTransport } from "../utils/rpc";
import { createLogger } from "../utils/logger";
import type { Logger } from "pino";

export interface EventSubscription {
  eventName: string;
  abi: any[];
  address?: string;
  onEvent: (logs: any[]) => void | Promise<void>;
}

interface EventRegistration {
  subscriptionId: string;
  eventName: string;
  address?: string;
  abi: any[];
  onEvent: (logs: any[]) => void | Promise<void>;
}

export interface EventAggregatorConfig {
  ethRpcUrl: string;
  ethWsRpcUrl: string;
}

export class EventAggregator {
  private config: EventAggregatorConfig;
  private wsClient: any;
  private registrations: Map<string, EventRegistration> = new Map();
  private unwatchFunctions: Map<string, () => void> = new Map();
  private isRunning: boolean = false;
  private lastHealthCheck: number = 0;
  private isReconnecting: boolean = false;
  private websocketErrors: number = 0;
  private healthCheckInterval?: NodeJS.Timeout;
  private logger: Logger;

  constructor(config: EventAggregatorConfig) {
    this.config = config;
    this.logger = createLogger({ operator: 'EventAggregator' });
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

  async start() {
    if (this.isRunning) {
      this.log("Already running");
      return;
    }

    this.isRunning = true;
    this.log("Starting...");

    // Don't setup WebSocket connection immediately - wait for subscriptions
    // Start health checks every 30 seconds
    this.healthCheckInterval = setInterval(() => {
      this.performHealthCheck();
    }, 30000);
  }

  async stop() {
    if (!this.isRunning) {
      this.log("Not running");
      return;
    }

    this.log("Stopping...");
    this.isRunning = false;

    // Clear health check interval
    if (this.healthCheckInterval) {
      clearInterval(this.healthCheckInterval);
      this.healthCheckInterval = undefined;
    }

    // Unsubscribe all events
    for (const unwatch of this.unwatchFunctions.values()) {
      try {
        unwatch();
      } catch (error) {
        this.error("Error unwatching event:", error);
      }
    }
    this.unwatchFunctions.clear();
    this.registrations.clear();

    // Close WebSocket
    if (this.wsClient) {
      this.wsClient = null;
    }
  }

  isAlive(): boolean {
    return this.isRunning;
  }

  subscribe(subscription: EventSubscription): () => void {
    const subscriptionId = `${subscription.eventName}-${subscription.address || 'global'}-${Date.now()}`;
    
    this.log(`Subscribing to ${subscription.eventName} on ${subscription.address || 'all addresses'}`);

    // Store registration
    this.registrations.set(subscriptionId, {
      subscriptionId,
      ...subscription
    });

    // Setup WebSocket connection if this is the first subscription
    if (!this.wsClient && this.registrations.size === 1) {
      this.log("First subscription, setting up WebSocket connection");
      this.setupWebSocketConnection().catch(error => {
        this.error("Failed to setup WebSocket connection:", error);
      });
    } else if (this.wsClient) {
      // If WebSocket is already connected, setup the subscription immediately
      this.setupSingleSubscription(subscriptionId, {
        subscriptionId,
        ...subscription
      });
    }

    // Return unsubscribe function
    return () => {
      this.log(`Unsubscribing from ${subscriptionId}`);
      this.registrations.delete(subscriptionId);
      
      const unwatch = this.unwatchFunctions.get(subscriptionId);
      if (unwatch) {
        unwatch();
        this.unwatchFunctions.delete(subscriptionId);
      }

      // If no more subscriptions, close WebSocket
      if (this.registrations.size === 0 && this.wsClient) {
        this.log("No more subscriptions, closing WebSocket connection");
        this.wsClient = null;
        for (const unwatch of this.unwatchFunctions.values()) {
          try {
            unwatch();
          } catch (error) {
            this.error("Error unwatching event:", error);
          }
        }
        this.unwatchFunctions.clear();
      }
    };
  }

  private async setupWebSocketConnection() {
    if (this.wsClient) {
      this.log("WebSocket connection already exists");
      return;
    }

    try {
      this.log("Setting up WebSocket connection");
      
      const transport = createAuthenticatedWebSocketTransport(this.config.ethWsRpcUrl, { ETH_RPC_URL: this.config.ethRpcUrl }, {
        keepAlive: true,
        reconnect: {
          auto: true,
          delay: 1000,
          maxAttempts: 5,
        },
        onConnect: () => {
          this.log("WebSocket connected!");
        },
        onDisconnect: () => {
          this.log("WebSocket disconnected!");
        },
        onError: (error: any) => {
          // Only log non-ErrorEvent errors (ErrorEvent is just a connection error)
          if (error && error.constructor.name !== 'ErrorEvent') {
            this.error("WebSocket error:", error);
          }
          this.handleWebSocketError();
        }
      });

      this.wsClient = createPublicClient({
        chain: arbitrum,
        transport
      });

      // Test the connection
      try {
        const blockNumber = await this.wsClient.getBlockNumber();
        this.log("WebSocket test - current block:", blockNumber);
      } catch (error) {
        this.error("WebSocket test failed:", error);
        // Don't throw here, let the health check handle reconnection
      }

      // Subscribe to all registered events
      await this.subscribeToAllEvents();
      
      this.log("WebSocket connection established");
    } catch (error) {
      this.error("Error setting up WebSocket:", error);
      throw error;
    }
  }

  private async subscribeToAllEvents() {
    // Clear existing subscriptions
    for (const unwatch of this.unwatchFunctions.values()) {
      unwatch();
    }
    this.unwatchFunctions.clear();

    // Setup each subscription
    for (const [subscriptionId, registration] of this.registrations) {
      this.setupSingleSubscription(subscriptionId, registration);
    }
  }

  private setupSingleSubscription(subscriptionId: string, registration: EventRegistration) {
    try {
      // Find the event definition in the ABI
      const eventDef = registration.abi.find((item: any) => 
        item.type === 'event' && item.name === registration.eventName
      );
      
      if (!eventDef) {
        this.error(`Event ${registration.eventName} not found in ABI`);
        return;
      }

      this.log(`Setting up watchEvent for ${registration.eventName}:`, {
        address: registration.address,
        hasAddress: !!registration.address
      });

      const unwatch = this.wsClient.watchEvent({
        event: eventDef,
        address: registration.address as `0x${string}` | undefined,
        onLogs: (logs: any[]) => {
          this.log(`Received ${logs.length} logs for ${registration.eventName}`);
          registration.onEvent(logs);
        },
        onError: (error: any) => {
          this.error(`Error watching ${registration.eventName}:`, error);
          // If WebSocket error, trigger reconnection
          if (error.name === 'SocketClosedError' || error.name === 'WebSocketRequestError') {
            this.error(`WebSocket error detected for ${registration.eventName}, triggering reconnection`);
            this.handleWebSocketError();
          }
        }
      } as any);
      
      this.unwatchFunctions.set(subscriptionId, unwatch);
    } catch (error) {
      this.error(`Error setting up subscription ${subscriptionId}:`, error);
    }
  }

  private async performHealthCheck() {
    // Only perform health check if we have active subscriptions
    if (this.registrations.size === 0) {
      return;
    }

    this.log("Performing health check");
    
    try {
      const isHealthy = await this.checkWebSocketHealth();
      
      if (!isHealthy) {
        this.log("WebSocket connection unhealthy, attempting to restore");
        await this.restoreWebSocketConnection();
      } else {
        this.log("WebSocket connection healthy");
      }

      this.lastHealthCheck = Date.now();
      
      // Reset error counter if connection is healthy
      if (isHealthy) {
        this.websocketErrors = 0;
      }
    } catch (error) {
      this.error("Error in health check:", error);
    }
  }

  private async checkWebSocketHealth(): Promise<boolean> {
    if (!this.wsClient) {
      this.log("No WebSocket client exists");
      return false;
    }

    try {
      // Try to get the current block number as a health check
      const blockNumber = await Promise.race([
        this.wsClient.getBlockNumber(),
        new Promise((_, reject) => 
          setTimeout(() => reject(new Error("WebSocket health check timeout")), 5000)
        )
      ]);
      
      this.log("WebSocket health check successful, block:", blockNumber);
      return true;
    } catch (error) {
      this.error("WebSocket health check failed:", error);
      return false;
    }
  }

  private async restoreWebSocketConnection() {
    try {
      this.log("Attempting to restore WebSocket connection");
      
      // Clean up existing connection
      if (this.wsClient) {
        // Unsubscribe all events
        for (const unwatch of this.unwatchFunctions.values()) {
          try {
            unwatch();
          } catch (error) {
            this.error("Error unwatching event:", error);
          }
        }
        this.unwatchFunctions.clear();
        this.wsClient = null;
      }

      // Re-establish connection
      await this.setupWebSocketConnection();
      
      this.log("WebSocket connection restored successfully");
    } catch (error) {
      this.error("Failed to restore WebSocket connection:", error);
    }
  }

  private async handleWebSocketError() {
    this.websocketErrors++;
    
    // Avoid multiple simultaneous reconnection attempts
    if (this.isReconnecting) {
      this.log("Already attempting to reconnect, skipping");
      return;
    }

    // If we've had multiple errors in a short time, trigger immediate reconnection
    if (this.websocketErrors >= 3) {
      this.log(`Multiple WebSocket errors (${this.websocketErrors}), triggering immediate reconnection`);
      this.isReconnecting = true;
      this.websocketErrors = 0;
      
      try {
        await this.restoreWebSocketConnection();
      } finally {
        this.isReconnecting = false;
      }
    }
  }

  getStatus() {
    return {
      isRunning: this.isRunning,
      hasWebSocket: !!this.wsClient,
      registrationCount: this.registrations.size,
      activeSubscriptions: this.unwatchFunctions.size,
      lastHealthCheck: this.lastHealthCheck,
      timeSinceLastHealthCheck: Date.now() - this.lastHealthCheck,
      subscriptions: Array.from(this.registrations.values()).map(reg => ({
        eventName: reg.eventName,
        address: reg.address
      }))
    };
  }
}
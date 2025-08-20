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





  async start() {
    if (this.isRunning) {
      this.logger.info("Already running");
      return;
    }

    this.isRunning = true;
    this.logger.info("Starting...");

    // Don't setup WebSocket connection immediately - wait for subscriptions
    // Start health checks every 30 seconds
    this.healthCheckInterval = setInterval(() => {
      this.performHealthCheck();
    }, 30000);
  }

  async stop() {
    if (!this.isRunning) {
      this.logger.info("Not running");
      return;
    }

    this.logger.info("Stopping...");
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
      } catch (error: any) {
        this.logger.error({ error: error?.message || error, stack: error?.stack }, "Error unwatching event:");
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
    
    this.logger.info(`Subscribing to ${subscription.eventName} on ${subscription.address || 'all addresses'}`);

    // Store registration
    this.registrations.set(subscriptionId, {
      subscriptionId,
      ...subscription
    });

    // Setup WebSocket connection if this is the first subscription
    if (!this.wsClient && this.registrations.size === 1) {
      this.logger.info("First subscription, setting up WebSocket connection");
      this.setupWebSocketConnection().catch(error => {
        this.logger.error({ error: error?.message || error, stack: error?.stack }, "Failed to setup WebSocket connection:");
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
      this.logger.info(`Unsubscribing from ${subscriptionId}`);
      this.registrations.delete(subscriptionId);
      
      const unwatch = this.unwatchFunctions.get(subscriptionId);
      if (unwatch) {
        unwatch();
        this.unwatchFunctions.delete(subscriptionId);
      }

      // If no more subscriptions, close WebSocket
      if (this.registrations.size === 0 && this.wsClient) {
        this.logger.info("No more subscriptions, closing WebSocket connection");
        this.wsClient = null;
        for (const unwatch of this.unwatchFunctions.values()) {
          try {
            unwatch();
          } catch (error: any) {
            this.logger.error({ error: error?.message || error, stack: error?.stack }, "Error unwatching event:");
          }
        }
        this.unwatchFunctions.clear();
      }
    };
  }

  private async setupWebSocketConnection() {
    if (this.wsClient) {
      this.logger.info("WebSocket connection already exists");
      return;
    }

    try {
      this.logger.info("Setting up WebSocket connection");
      
      const transport = createAuthenticatedWebSocketTransport(this.config.ethWsRpcUrl, { ETH_RPC_URL: this.config.ethRpcUrl }, {
        keepAlive: true,
        reconnect: {
          auto: true,
          delay: 1000,
          maxAttempts: 5,
        },
        onConnect: () => {
          this.logger.info("WebSocket connected!");
        },
        onDisconnect: () => {
          this.logger.info("WebSocket disconnected!");
        },
        onError: (error: any) => {
          // Only log non-ErrorEvent errors (ErrorEvent is just a connection error)
          if (error && error.constructor.name !== 'ErrorEvent') {
            this.logger.error({ error: error?.message || error, stack: error?.stack }, "WebSocket error:");
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
        this.logger.info({ blockNumber }, "WebSocket test - current block:");
      } catch (error: any) {
        this.logger.error({ error: error?.message || error, stack: error?.stack }, "WebSocket test failed:");
        // Don't throw here, let the health check handle reconnection
      }

      // Subscribe to all registered events
      await this.subscribeToAllEvents();
      
      this.logger.info("WebSocket connection established");
    } catch (error: any) {
      this.logger.error({ error: error?.message || error, stack: error?.stack }, "Error setting up WebSocket:");
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
        this.logger.error(`Event ${registration.eventName} not found in ABI`);
        return;
      }

      this.logger.info({
        address: registration.address,
        hasAddress: !!registration.address
      }, `Setting up watchEvent for ${registration.eventName}:`);

      const unwatch = this.wsClient.watchEvent({
        event: eventDef,
        address: registration.address as `0x${string}` | undefined,
        onLogs: (logs: any[]) => {
          this.logger.info(`Received ${logs.length} logs for ${registration.eventName}`);
          registration.onEvent(logs);
        },
        onError: (error: any) => {
          this.logger.error({ error: error?.message || error, stack: error?.stack }, `Error watching ${registration.eventName}:`);
          // If WebSocket error, trigger reconnection
          if (error.name === 'SocketClosedError' || error.name === 'WebSocketRequestError') {
            this.logger.error(`WebSocket error detected for ${registration.eventName}, triggering reconnection`);
            this.handleWebSocketError();
          }
        }
      } as any);
      
      this.unwatchFunctions.set(subscriptionId, unwatch);
    } catch (error: any) {
      this.logger.error({ error: error?.message || error, stack: error?.stack }, `Error setting up subscription ${subscriptionId}:`);
    }
  }

  private async performHealthCheck() {
    // Only perform health check if we have active subscriptions
    if (this.registrations.size === 0) {
      return;
    }

    this.logger.info("Performing health check");
    
    try {
      const isHealthy = await this.checkWebSocketHealth();
      
      if (!isHealthy) {
        this.logger.info("WebSocket connection unhealthy, attempting to restore");
        await this.restoreWebSocketConnection();
      } else {
        this.logger.info("WebSocket connection healthy");
      }

      this.lastHealthCheck = Date.now();
      
      // Reset error counter if connection is healthy
      if (isHealthy) {
        this.websocketErrors = 0;
      }
    } catch (error: any) {
      this.logger.error({ error: error?.message || error, stack: error?.stack }, "Error in health check:");
    }
  }

  private async checkWebSocketHealth(): Promise<boolean> {
    if (!this.wsClient) {
      this.logger.info("No WebSocket client exists");
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
      
      this.logger.info({ blockNumber }, "WebSocket health check successful, block:");
      return true;
    } catch (error: any) {
      this.logger.error({ error: error?.message || error, stack: error?.stack }, "WebSocket health check failed:");
      return false;
    }
  }

  private async restoreWebSocketConnection() {
    try {
      this.logger.info("Attempting to restore WebSocket connection");
      
      // Clean up existing connection
      if (this.wsClient) {
        // Unsubscribe all events
        for (const unwatch of this.unwatchFunctions.values()) {
          try {
            unwatch();
          } catch (error: any) {
            this.logger.error({ error: error?.message || error, stack: error?.stack }, "Error unwatching event:");
          }
        }
        this.unwatchFunctions.clear();
        this.wsClient = null;
      }

      // Re-establish connection
      await this.setupWebSocketConnection();
      
      this.logger.info("WebSocket connection restored successfully");
    } catch (error: any) {
      this.logger.error({ error: error?.message || error, stack: error?.stack }, "Failed to restore WebSocket connection:");
    }
  }

  private async handleWebSocketError() {
    this.websocketErrors++;
    
    // Avoid multiple simultaneous reconnection attempts
    if (this.isReconnecting) {
      this.logger.info("Already attempting to reconnect, skipping");
      return;
    }

    // If we've had multiple errors in a short time, trigger immediate reconnection
    if (this.websocketErrors >= 3) {
      this.logger.info(`Multiple WebSocket errors (${this.websocketErrors}), triggering immediate reconnection`);
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
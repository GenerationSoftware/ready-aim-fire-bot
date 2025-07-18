import { Env } from "./Env";
import { createPublicClient } from "viem";
import { arbitrum } from "viem/chains";
import { createAuthenticatedWebSocketTransport } from "./utils/rpc";

interface EventRegistration {
  operatorId: string;
  eventName: string;
  address?: string;
  abi: any[];
}

interface RegisteredOperator {
  operatorId: string;
  namespace: string;  // Durable Object namespace name  
  instanceId: string; // Instance ID within the namespace
}

export class EventAggregator {
  private state: DurableObjectState;
  private env: Env;
  private wsClient: any;
  private registrations: Map<string, EventRegistration[]> = new Map();
  private operators: Map<string, RegisteredOperator> = new Map();
  private unwatchFunctions: Map<string, () => void> = new Map();
  private lastHealthCheck: number = 0;
  private isReconnecting: boolean = false;
  private websocketErrors: number = 0;

  constructor(state: DurableObjectState, env: Env) {
    this.state = state;
    this.env = env;
    this.restoreState();
    this.scheduleHealthCheck();
  }

  private async restoreState() {
    try {
      const storedRegistrations = await this.state.storage.get("registrations");
      const storedOperators = await this.state.storage.get("operators");
      
      if (storedRegistrations) {
        this.registrations = new Map(storedRegistrations as any);
      }
      if (storedOperators) {
        const operatorsData = new Map(storedOperators as any);
        
        // Check if we need to migrate old data format
        let needsMigration = false;
        for (const [id, op] of operatorsData) {
          if (!op.namespace && op.callbackUrl) {
            needsMigration = true;
            break;
          }
        }
        
        if (needsMigration) {
          console.log("EventAggregator: Clearing old registration format");
          // Clear old format data
          this.operators.clear();
          this.registrations.clear();
          await this.state.storage.delete("operators");
          await this.state.storage.delete("registrations");
        } else {
          this.operators = operatorsData;
        }
      }

      // If we have registrations, restore the WebSocket connection
      if (this.registrations.size > 0) {
        await this.setupWebSocketConnection();
      }
    } catch (error) {
      console.error("Error restoring EventAggregator state:", error);
    }
  }

  private async saveState() {
    await this.state.storage.put("registrations", Array.from(this.registrations.entries()));
    await this.state.storage.put("operators", Array.from(this.operators.entries()));
  }

  private async setupWebSocketConnection() {
    if (this.wsClient) {
      console.log("WebSocket connection already exists");
      return;
    }

    try {
      console.log("Setting up EventAggregator WebSocket connection");
      
      const transport = createAuthenticatedWebSocketTransport(this.env.ETH_RPC_URL, this.env, {
        keepAlive: true,
        reconnect: {
          auto: true,
          delay: 1000,
          maxAttempts: 5,
        },
        onConnect: () => {
          console.log("EventAggregator WebSocket connected!");
        },
        onDisconnect: () => {
          console.log("EventAggregator WebSocket disconnected!");
        },
        onError: (error: any) => {
          console.error("EventAggregator WebSocket error:", error);
        }
      });

      this.wsClient = createPublicClient({
        chain: arbitrum,
        transport
      });

      // Test the connection
      try {
        const blockNumber = await this.wsClient.getBlockNumber();
        console.log("EventAggregator WebSocket test - current block:", blockNumber);
      } catch (error) {
        console.error("EventAggregator WebSocket test failed:", error);
      }

      // Subscribe to all registered events
      await this.subscribeToAllEvents();
      
      console.log("EventAggregator WebSocket connection established");
    } catch (error) {
      console.error("Error setting up EventAggregator WebSocket:", error);
      throw error;
    }
  }

  private async subscribeToAllEvents() {
    // Clear existing subscriptions
    for (const unwatch of this.unwatchFunctions.values()) {
      unwatch();
    }
    this.unwatchFunctions.clear();

    // Group registrations by event signature
    const eventGroups = new Map<string, { abi: any, addresses: Set<string> }>();
    
    console.log("EVENT AGGREGATOR SUBSCRIBE TO ALL EVENTS", this.registrations);

    for (const [key, regs] of this.registrations) {
      for (const reg of regs) {
        const eventKey = `${reg.eventName}`;
        if (!eventGroups.has(eventKey)) {
          // Find the event definition in the ABI
          const eventDef = reg.abi.find((item: any) => 
            item.type === 'event' && item.name === reg.eventName
          );
          
          if (eventDef) {
            eventGroups.set(eventKey, {
              abi: eventDef,
              addresses: new Set()
            });
          }
        }
        
        if (reg.address && eventGroups.has(eventKey)) {
          eventGroups.get(eventKey)!.addresses.add(reg.address);
        }
      }
    }

    // Subscribe to each unique event
    for (const [eventKey, { abi, addresses }] of eventGroups) {
      const addressArray = Array.from(addresses);
      
      console.log(`Subscribing to ${eventKey} on ${addressArray.length} addresses`);
      
      console.log(`Setting up watchEvent for ${eventKey}:`, {
        event: abi,
        addresses: addressArray,
        hasAddresses: addressArray.length > 0
      });

      // For single address, pass as string instead of array
      const addressParam = addressArray.length === 1 
        ? addressArray[0] as `0x${string}`
        : addressArray.length > 1 
          ? addressArray as `0x${string}`[]
          : undefined;

      const unwatch = this.wsClient.watchEvent({
        event: abi,
        address: addressParam,
        onLogs: (logs: any[]) => {
          console.log(`EVENT AGGREGATOR!!!!!!! ??????? Received ${logs.length} logs for ${eventKey}`);
          this.handleEvents(eventKey, logs);
        },
        onError: (error: any) => {
          console.error(`Error watching ${eventKey}:`, error);
          // If WebSocket error, trigger reconnection
          if (error.name === 'SocketClosedError' || error.name === 'WebSocketRequestError') {
            console.error(`WebSocket error detected for ${eventKey}, triggering reconnection`);
            this.handleWebSocketError();
          }
        }
      } as any);
      
      this.unwatchFunctions.set(eventKey, unwatch);
    }
  }

  private async handleEvents(eventName: string, logs: any[]) {
    console.log(`EventAggregator received ${logs.length} ${eventName} events`);
    
    // Find all operators interested in these events
    for (const [operatorId, registrations] of this.registrations) {
      for (const reg of registrations) {
        if (reg.eventName === eventName) {
          // Filter logs for this specific registration
          const relevantLogs = reg.address 
            ? logs.filter(log => log.address.toLowerCase() === reg.address!.toLowerCase())
            : logs;
          
          console.log(`Operator ${operatorId} is interested in ${eventName}, found ${relevantLogs.length} relevant logs`);
          
          if (relevantLogs.length > 0) {
            await this.forwardEventsToOperator(reg.operatorId, eventName, relevantLogs);
          }
        }
      }
    }
  }

  private async forwardEventsToOperator(operatorId: string, eventName: string, logs: any[]) {
    try {
      const operator = this.operators.get(operatorId);
      if (!operator) {
        console.error(`Operator ${operatorId} not found in registry`);
        return;
      }

      console.log(`Forwarding events to operator ${operatorId}:`, {
        namespace: operator.namespace,
        instanceId: operator.instanceId,
        hasNamespace: !!operator.namespace
      });

      // Convert BigInt values to strings for JSON serialization
      const serializedLogs = logs.map(log => ({
        ...log,
        args: Object.fromEntries(
          Object.entries(log.args || {}).map(([key, value]) => [
            key,
            typeof value === 'bigint' ? value.toString() : value
          ])
        ),
        blockNumber: typeof log.blockNumber === 'bigint' ? log.blockNumber.toString() : log.blockNumber,
        transactionIndex: typeof log.transactionIndex === 'bigint' ? log.transactionIndex.toString() : log.transactionIndex,
        logIndex: typeof log.logIndex === 'bigint' ? log.logIndex.toString() : log.logIndex
      }));

      // Skip operators without namespace (old format)
      if (!operator.namespace) {
        console.error(`Operator ${operatorId} has no namespace (old format), skipping`);
        // Clean up this old registration
        this.operators.delete(operatorId);
        this.registrations.delete(operatorId);
        this.saveState();
        return;
      }

      // Get the Durable Object namespace and forward events
      const namespaceBinding = (this.env as any)[operator.namespace];
      if (!namespaceBinding) {
        console.error(`Namespace ${operator.namespace} not found`);
        return;
      }

      const durableObjectId = namespaceBinding.idFromName(operator.instanceId);
      const durableObject = namespaceBinding.get(durableObjectId);
      
      const response = await durableObject.fetch(
        new Request('http://operator/events', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ eventName, logs: serializedLogs })
        })
      );

      if (!response.ok) {
        console.error(`Failed to forward events to ${operatorId}: ${response.status}`);
      }
    } catch (error) {
      console.error(`Error forwarding events to ${operatorId}:`, error);
    }
  }

  async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);

    if (url.pathname === "/register" && request.method === "POST") {
      try {
        const body = await request.json() as {
          operatorId: string;
          namespace: string;    // Durable Object namespace (e.g., "CHARACTER_OPERATOR")
          instanceId: string;   // Instance ID within the namespace
          events: Array<{
            eventName: string;
            address?: string;
            abi: any[];
          }>;
        };

        // Log registration details
        console.log("EventAggregator registering operator:", {
          operatorId: body.operatorId,
          namespace: body.namespace,
          instanceId: body.instanceId
        });

        // Store operator info
        this.operators.set(body.operatorId, {
          operatorId: body.operatorId,
          namespace: body.namespace,
          instanceId: body.instanceId
        });

        // Store event registrations
        const registrations: EventRegistration[] = body.events.map(event => ({
          operatorId: body.operatorId,
          eventName: event.eventName,
          address: event.address,
          abi: event.abi
        }));

        this.registrations.set(body.operatorId, registrations);
        await this.saveState();

        // Setup WebSocket if not already connected
        if (!this.wsClient) {
          await this.setupWebSocketConnection();
        } else {
          // Update subscriptions with new registrations
          await this.subscribeToAllEvents();
        }

        return new Response("Registered successfully", { status: 200 });
      } catch (error) {
        console.error("Error in /register:", error);
        return new Response(`Registration failed: ${error}`, { status: 500 });
      }
    }

    if (url.pathname === "/unregister" && request.method === "POST") {
      try {
        const body = await request.json() as { operatorId: string };
        
        this.registrations.delete(body.operatorId);
        this.operators.delete(body.operatorId);
        await this.saveState();

        // If no more registrations, close WebSocket
        if (this.registrations.size === 0 && this.wsClient) {
          for (const unwatch of this.unwatchFunctions.values()) {
            unwatch();
          }
          this.unwatchFunctions.clear();
          this.wsClient = null;
        } else {
          // Update subscriptions
          await this.subscribeToAllEvents();
        }

        return new Response("Unregistered successfully", { status: 200 });
      } catch (error) {
        console.error("Error in /unregister:", error);
        return new Response(`Unregistration failed: ${error}`, { status: 500 });
      }
    }

    if (url.pathname === "/status") {
      // Check for and clean up any old format operators
      const operators = Array.from(this.operators.entries());
      const oldFormatOperators = operators.filter(([id, op]) => !op.namespace);
      
      if (oldFormatOperators.length > 0) {
        console.log(`Cleaning up ${oldFormatOperators.length} old format operators`);
        for (const [id, _] of oldFormatOperators) {
          this.operators.delete(id);
          this.registrations.delete(id);
        }
        await this.saveState();
        await this.subscribeToAllEvents(); // Re-subscribe with cleaned data
      }
      
      return new Response(JSON.stringify({
        hasWebSocket: !!this.wsClient,
        registrationCount: this.registrations.size,
        operatorCount: this.operators.size,
        activeSubscriptions: this.unwatchFunctions.size,
        lastHealthCheck: this.lastHealthCheck,
        timeSinceLastHealthCheck: Date.now() - this.lastHealthCheck,
        operators: Array.from(this.operators.entries()).map(([id, op]) => ({
          id,
          namespace: op.namespace,
          instanceId: op.instanceId
        }))
      }), {
        headers: { "Content-Type": "application/json" }
      });
    }

    return new Response("Not found", { status: 404 });
  }

  private async scheduleHealthCheck() {
    // Schedule health check every 30 seconds
    await this.state.storage.setAlarm(Date.now() + 30000);
  }

  async alarm() {
    console.log("EventAggregator health check alarm triggered");
    
    try {
      // Check if we have any registrations
      if (this.registrations.size === 0) {
        console.log("No registrations, skipping health check");
        await this.scheduleHealthCheck();
        return;
      }

      // Check WebSocket connection health
      const isHealthy = await this.checkWebSocketHealth();
      
      if (!isHealthy) {
        console.log("WebSocket connection unhealthy, attempting to restore");
        await this.restoreWebSocketConnection();
      } else {
        console.log("WebSocket connection healthy");
      }

      // Update last health check time
      this.lastHealthCheck = Date.now();
      
      // Reset error counter if connection is healthy
      if (isHealthy) {
        this.websocketErrors = 0;
      }
      
      // Schedule next health check
      await this.scheduleHealthCheck();
    } catch (error) {
      console.error("Error in EventAggregator health check:", error);
      // Schedule next check even on error
      await this.scheduleHealthCheck();
    }
  }

  private async checkWebSocketHealth(): Promise<boolean> {
    if (!this.wsClient) {
      console.log("No WebSocket client exists");
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
      
      console.log("WebSocket health check successful, block:", blockNumber);
      return true;
    } catch (error) {
      console.error("WebSocket health check failed:", error);
      return false;
    }
  }

  private async restoreWebSocketConnection() {
    try {
      console.log("Attempting to restore WebSocket connection");
      
      // Clean up existing connection
      if (this.wsClient) {
        // Unsubscribe all events
        for (const unwatch of this.unwatchFunctions.values()) {
          try {
            unwatch();
          } catch (error) {
            console.error("Error unwatching event:", error);
          }
        }
        this.unwatchFunctions.clear();
        this.wsClient = null;
      }

      // Re-establish connection
      await this.setupWebSocketConnection();
      
      console.log("WebSocket connection restored successfully");
    } catch (error) {
      console.error("Failed to restore WebSocket connection:", error);
      // Will retry on next health check
    }
  }

  private async handleWebSocketError() {
    this.websocketErrors++;
    
    // Avoid multiple simultaneous reconnection attempts
    if (this.isReconnecting) {
      console.log("Already attempting to reconnect, skipping");
      return;
    }

    // If we've had multiple errors in a short time, trigger immediate reconnection
    if (this.websocketErrors >= 3) {
      console.log(`Multiple WebSocket errors (${this.websocketErrors}), triggering immediate reconnection`);
      this.isReconnecting = true;
      this.websocketErrors = 0;
      
      try {
        await this.restoreWebSocketConnection();
      } finally {
        this.isReconnecting = false;
      }
    }
  }
}
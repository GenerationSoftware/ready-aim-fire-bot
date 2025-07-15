import { DurableObject } from "cloudflare:workers";
import { Env } from "./Env";

export interface EventSubscription {
  eventName: string;
  abi: any[];
  address?: string; // Optional contract address for the subscription
  onEvent: (logs: any[]) => Promise<void>;
}

export abstract class Operator {
  protected state: DurableObjectState;
  protected env: Env;
  private eventHandlers: Map<string, (logs: any[]) => Promise<void>> = new Map();
  private isRegisteredWithAggregator: boolean = false;

  constructor(state: DurableObjectState, env: Env) {
    this.state = state;
    this.env = env;
    
    // Register with EventAggregator if needed
    this.restoreEventRegistration();
  }

  // Abstract methods that subclasses must implement
  protected abstract getEventSubscriptions(): Promise<EventSubscription[]>;
  protected abstract performPeriodicCheck(): Promise<number>; // Returns next alarm time, 0 = shutdown

  /**
   * Optional method for subclasses to validate start parameters
   * @returns Error message if validation fails, null if valid
   */
  protected async validateStartParameters(params: URLSearchParams): Promise<string | null> {
    return null; // Default implementation accepts all parameters
  }

  // Logging methods that subclasses can override
  protected log(...args: any[]): void {
    console.log({
      origin: this.constructor.name.toUpperCase(),
      ...args
    });
  }

  protected error(...args: any[]): void {
    console.error({
      origin: this.constructor.name.toUpperCase(),
      ...args
    });
  }

  private async restoreEventRegistration(): Promise<void> {
    try {
      // Check if we have any stored parameters (indicates active operator)
      const storedKeys = await this.state.storage.list();
      const hasStoredParams = storedKeys.size > 0;
      
      if (hasStoredParams && !this.isRegisteredWithAggregator) {
        this.log("Restoring event registration with EventAggregator");
        await this.registerWithEventAggregator();
      }
    } catch (error) {
      this.error("Error restoring event registration:", error);
    }
  }

  private async registerWithEventAggregator(): Promise<void> {
    try {
      const subscriptions = await this.getEventSubscriptions();
      
      if (subscriptions.length === 0) {
        this.log("No event subscriptions defined, skipping EventAggregator registration");
        return;
      }

      // Store event handlers
      this.eventHandlers.clear();
      for (const subscription of subscriptions) {
        const key = `${subscription.eventName}-${subscription.address || 'all'}`;
        this.eventHandlers.set(key, subscription.onEvent);
      }

      // Get operator ID based on stored parameters
      const operatorId = await this.getOperatorId();
      if (!operatorId) {
        this.error("Cannot register with EventAggregator: no operator ID");
        return;
      }

      // Check if EVENT_AGGREGATOR binding exists
      if (!this.env.EVENT_AGGREGATOR) {
        this.error("EVENT_AGGREGATOR binding not found in environment");
        return;
      }

      // Register with EventAggregator
      const aggregator = this.env.EVENT_AGGREGATOR.get(
        this.env.EVENT_AGGREGATOR.idFromName("global")
      );

      const registration = {
        operatorId,
        namespace: this.getDurableObjectNamespace(),
        instanceId: operatorId, // The operatorId is used as the instance ID
        events: subscriptions.map(sub => ({
          eventName: sub.eventName,
          address: sub.address,
          abi: sub.abi
        }))
      };

      const response = await aggregator.fetch(
        new Request('http://aggregator/register', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(registration)
        })
      );

      if (response.ok) {
        this.isRegisteredWithAggregator = true;
        this.log("Successfully registered with EventAggregator");
      } else {
        const error = await response.text();
        this.error("Failed to register with EventAggregator:", error);
      }
    } catch (error) {
      this.error("Error registering with EventAggregator:", error);
      throw error;
    }
  }

  private async unregisterFromEventAggregator(): Promise<void> {
    try {
      if (!this.isRegisteredWithAggregator) {
        return;
      }

      const operatorId = await this.getOperatorId();
      if (!operatorId) {
        return;
      }

      // Check if EVENT_AGGREGATOR binding exists
      if (!this.env.EVENT_AGGREGATOR) {
        return;
      }

      const aggregator = this.env.EVENT_AGGREGATOR.get(
        this.env.EVENT_AGGREGATOR.idFromName("global")
      );

      await aggregator.fetch(
        new Request('http://aggregator/unregister', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ operatorId })
        })
      );

      this.isRegisteredWithAggregator = false;
      this.eventHandlers.clear();
      this.log("Unregistered from EventAggregator");
    } catch (error) {
      this.error("Error unregistering from EventAggregator:", error);
    }
  }

  // Get a unique ID for this operator instance
  protected async getOperatorId(): Promise<string | null> {
    // Default implementation - subclasses should override for better IDs
    const params = await this.state.storage.list();
    const values: string[] = [];
    for (const [key, value] of params) {
      if (typeof value === 'string') {
        values.push(value);
      }
    }
    return values.length > 0 ? values.join('-') : null;
  }

  // Get the Durable Object namespace name
  protected getDurableObjectNamespace(): string {
    // Subclasses should override this
    return this.constructor.name.toUpperCase();
  }

  async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);

    if (url.pathname === "/start") {
      // Store all search parameters as individual key-value pairs
      const searchParams = Array.from(url.searchParams.entries());
      
      if (searchParams.length === 0) {
        return new Response("Missing search parameters", { status: 400 });
      }

      // Allow subclasses to validate parameters
      const validationError = await this.validateStartParameters(url.searchParams);
      if (validationError) {
        return new Response(validationError, { status: 400 });
      }

      // Store all parameters in storage
      for (const [key, value] of searchParams) {
        await this.state.storage.put(key, value);
      }

      let hasError = false;
      let errorMessage = "";

      // Setup EventAggregator registration if not already registered
      if (!this.isRegisteredWithAggregator) {
        try {
          await this.registerWithEventAggregator();
          this.log("Event registration established");
        } catch (error) {
          this.error("Failed to register with EventAggregator:", error);
          hasError = true;
          errorMessage += `Event registration error: ${error}; `;
        }
      } else {
        this.log("Already registered with EventAggregator");
      }

      // Always ensure we have a future alarm scheduled
      try {
        const currentAlarm = await this.state.storage.getAlarm();
        const currentTime = Date.now();
        const lastCheckTime = await this.state.storage.get("lastCheckTime") as number || 0;
        const timeSinceLastCheck = currentTime - lastCheckTime;
        
        // If no alarm or alarm is in the past or operator hasn't run recently, schedule new alarm
        if (currentAlarm === null || currentAlarm < currentTime || timeSinceLastCheck > 30000) {
          await this.state.storage.setAlarm(currentTime + 5000);
          this.log(`Alarm scheduled for periodic checks (was dead for ${timeSinceLastCheck}ms)`);
        } else {
          this.log(`Alarm already scheduled for ${new Date(currentAlarm).toISOString()}`);
        }
      } catch (error) {
        this.error("Failed to setup alarm:", error);
        hasError = true;
        errorMessage += `Alarm error: ${error}; `;
      }

      if (hasError) {
        return new Response(`${this.constructor.name} started with errors: ${errorMessage}`, { status: 207 });
      }
      
      return new Response(`${this.constructor.name} started with parameters: ${searchParams.map(([k,v]) => `${k}=${v}`).join(', ')}`);
    }

    if (url.pathname === "/events" && request.method === "POST") {
      try {
        const { eventName, logs } = await request.json() as { eventName: string; logs: any[] };
        
        // Find matching handlers
        for (const [key, handler] of this.eventHandlers) {
          if (key.startsWith(eventName)) {
            await handler(logs);
          }
        }
        
        return new Response("Events processed", { status: 200 });
      } catch (error) {
        this.error("Error processing events:", error);
        return new Response("Error processing events", { status: 500 });
      }
    }

    if (url.pathname === "/status") {
      // Get all stored parameters
      const storedParams: Record<string, any> = {};
      const allKeys = await this.state.storage.list();
      
      for (const [key, value] of allKeys) {
        storedParams[key] = value;
      }
      
      // Check if operator is running
      const hasEventRegistration = this.isRegisteredWithAggregator;
      const alarm = await this.state.storage.getAlarm();
      const hasAlarm = alarm !== null && alarm > Date.now();
      const lastCheckTime = storedParams.lastCheckTime || 0;
      const timeSinceLastCheck = Date.now() - lastCheckTime;
      
      // Consider operator dead if it hasn't run in over 30 seconds
      const isAlive = timeSinceLastCheck < 30000;
      
      return new Response(JSON.stringify({
        running: hasEventRegistration && hasAlarm && isAlive,
        alive: isAlive,
        operatorType: this.constructor.name,
        hasEventRegistration,
        hasAlarm,
        alarm,
        alarmInMs: alarm ? alarm - Date.now() : null,
        lastCheckTime,
        timeSinceLastCheck,
        parameters: storedParams
      }), {
        headers: { "Content-Type": "application/json" }
      });
    }

    if (url.pathname === "/wake") {
      // Force the operator to run its alarm immediately
      try {
        this.log("Manually waking operator");
        await this.alarm();
        return new Response("Operator woken successfully");
      } catch (error) {
        this.error("Error waking operator:", error);
        return new Response(`Error waking operator: ${error}`, { status: 500 });
      }
    }

    return new Response("Not found", { status: 404 });
  }

  async alarm(): Promise<void> {
    try {
      this.log(`${this.constructor.name} alarm triggered`);
      
      // Store last check time
      await this.state.storage.put("lastCheckTime", Date.now());
      
      // Perform the subclass-specific periodic check
      const nextAlarmTime = await this.performPeriodicCheck();
      
      if (nextAlarmTime === 0) {
        // Operation is complete, clean up resources
        await this.unregisterFromEventAggregator();
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
import pino from 'pino';
import pinoPretty from 'pino-pretty';

// Logger configuration from environment variables
const LOG_LEVEL = process.env.LOG_LEVEL || 'info';
const LOG_PRETTY = process.env.LOG_PRETTY !== 'false'; // Default to pretty logging
const ENABLED_OPERATORS = process.env.LOG_OPERATORS?.split(',').map(s => s.trim().toLowerCase()) || [];
const DISABLED_OPERATORS = process.env.LOG_DISABLED_OPERATORS?.split(',').map(s => s.trim().toLowerCase()) || [];

// Create the base logger with pretty printing
const baseLogger = pino({
  level: LOG_LEVEL,
  ...(LOG_PRETTY && {
    transport: {
      target: 'pino-pretty',
      options: {
        colorize: true,
        translateTime: 'HH:MM:ss.l',
        ignore: 'pid,hostname',
        messageFormat: '{operator} | {msg}',
        errorLikeObjectKeys: ['err', 'error'],
      }
    }
  })
});

export type OperatorType = 
  | 'OperatorManager'
  | 'CharacterOperator'
  | 'BattleOperator'
  | 'ActOperator'
  | 'EventAggregator'
  | 'GraphQL'
  | 'RPC'
  | 'Forwarder';

export interface LoggerContext {
  operator: OperatorType;
  gameAddress?: string;
  playerId?: string;
  actAddress?: string;
  battleAddress?: string;
}

export function createLogger(context: LoggerContext): pino.Logger {
  const operatorKey = context.operator.toLowerCase();
  
  // Check if this operator's logs are disabled
  if (DISABLED_OPERATORS.length > 0 && DISABLED_OPERATORS.includes(operatorKey)) {
    // Return a silent logger
    return pino({ level: 'silent' });
  }
  
  // Check if we're filtering to specific operators
  if (ENABLED_OPERATORS.length > 0 && !ENABLED_OPERATORS.includes(operatorKey)) {
    // Return a silent logger
    return pino({ level: 'silent' });
  }
  
  // Create child logger with context
  const childLogger = baseLogger.child({
    operator: context.operator,
    ...(context.gameAddress && { gameAddress: context.gameAddress }),
    ...(context.playerId && { playerId: context.playerId }),
    ...(context.actAddress && { actAddress: context.actAddress }),
    ...(context.battleAddress && { battleAddress: context.battleAddress }),
  });
  
  return childLogger;
}

// Helper function to get log level for a specific operator
export function getOperatorLogLevel(operator: OperatorType): string {
  const envVar = `LOG_LEVEL_${operator.toUpperCase()}`;
  return process.env[envVar] || LOG_LEVEL;
}

// Export a function to log environment configuration
export function logConfiguration() {
  console.log('Logger Configuration:');
  console.log(`  LOG_LEVEL: ${LOG_LEVEL}`);
  console.log(`  LOG_PRETTY: ${LOG_PRETTY}`);
  console.log(`  LOG_OPERATORS: ${ENABLED_OPERATORS.length > 0 ? ENABLED_OPERATORS.join(', ') : 'all'}`);
  console.log(`  LOG_DISABLED_OPERATORS: ${DISABLED_OPERATORS.length > 0 ? DISABLED_OPERATORS.join(', ') : 'none'}`);
}
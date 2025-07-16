#!/usr/bin/env node

import { program } from 'commander';
import { OperatorManager, type OperatorManagerConfig } from './node/OperatorManager';
import { getDeployments } from './utils/deployments';
import { logConfiguration, createLogger } from './utils/logger';
import * as dotenv from 'dotenv';
import * as path from 'path';
import * as fs from 'fs';

// Load environment variables
dotenv.config();

// Create main logger
const logger = createLogger({ operator: 'OperatorManager' });

// Get deployment addresses
const deployments = getDeployments();

function loadConfig(): OperatorManagerConfig {
  // Check for required environment variables
  const requiredEnvVars = [
    'ETH_RPC_URL',
    'GRAPHQL_URL',
    'OPERATOR_ADDRESS',
    'OPERATOR_PRIVATE_KEY',
    'RELAYER_URL',
    'ERC2771_FORWARDER_ADDRESS'
  ];

  const missingVars = requiredEnvVars.filter(varName => !process.env[varName]);
  if (missingVars.length > 0) {
    logger.error({ missingVars }, 'Missing required environment variables');
    logger.error('Please create a .env file with the following variables:');
    logger.error(requiredEnvVars.join('\n'));
    process.exit(1);
  }

  return {
    ethRpcUrl: process.env.ETH_RPC_URL!,
    ethWsRpcUrl: process.env.ETH_RPC_URL!,
    graphqlUrl: process.env.GRAPHQL_URL!,
    operatorAddress: process.env.OPERATOR_ADDRESS!,
    operatorPrivateKey: process.env.OPERATOR_PRIVATE_KEY!,
    relayerUrl: process.env.RELAYER_URL!,
    erc2771ForwarderAddress: process.env.ERC2771_FORWARDER_ADDRESS!
  };
}

let operatorManager: OperatorManager | null = null;

async function startOperator() {
  logger.info('Starting Battle Bot Operator...');
  
  // Show logger configuration
  logConfiguration();
  
  logger.info({ deployments }, 'Contract deployments loaded');
  
  const config = loadConfig();
  logger.info({
    ethRpcUrl: config.ethRpcUrl,
    graphqlUrl: config.graphqlUrl,
    operatorAddress: config.operatorAddress,
    relayerUrl: config.relayerUrl,
    forwarderAddress: config.erc2771ForwarderAddress
  }, 'Configuration loaded');
  
  operatorManager = new OperatorManager(config);
  
  // Handle graceful shutdown
  process.on('SIGINT', async () => {
    logger.info('Received SIGINT, shutting down gracefully...');
    if (operatorManager) {
      await operatorManager.stop();
    }
    process.exit(0);
  });

  process.on('SIGTERM', async () => {
    logger.info('Received SIGTERM, shutting down gracefully...');
    if (operatorManager) {
      await operatorManager.stop();
    }
    process.exit(0);
  });

  try {
    await operatorManager.start();
    logger.info('Operator Manager started successfully');
    logger.info('Press Ctrl+C to stop');
  } catch (error) {
    logger.error({ error }, 'Failed to start Operator Manager');
    process.exit(1);
  }
}

async function getStatus() {
  const config = loadConfig();
  const manager = new OperatorManager(config);
  
  // Start temporarily to get status
  await manager.start();
  const status = manager.getStatus();
  await manager.stop();
  
  console.log('Operator Status:');
  console.log(JSON.stringify(status, null, 2));
}

// Set up CLI commands
program
  .name('battle-bot')
  .description('Battle Bot Operator - Automated game playing bot')
  .version('1.0.0');

program
  .command('start')
  .description('Start the operator manager')
  .action(startOperator);

program
  .command('status')
  .description('Get the current status of operators')
  .action(getStatus);

program
  .command('init')
  .description('Initialize configuration file')
  .action(() => {
    const envExample = `# Battle Bot Configuration

# Ethereum RPC endpoints
ETH_RPC_URL=https://arb1.arbitrum.io/rpc
ETH_WS_RPC_URL=wss://arb1.arbitrum.io/ws

# GraphQL indexer endpoint
GRAPHQL_URL=http://localhost:42069/graphql

# Operator wallet credentials
OPERATOR_ADDRESS=0x...
OPERATOR_PRIVATE_KEY=0x...

# Meta-transaction infrastructure
RELAYER_URL=https://your-relayer-url
ERC2771_FORWARDER_ADDRESS=0x...
`;

    const envPath = path.join(process.cwd(), '.env.example');
    fs.writeFileSync(envPath, envExample);
    console.log('Created .env.example file');
    console.log('Copy it to .env and fill in your configuration values');
  });

// Parse command line arguments
program.parse();

// Show help if no command specified
if (!process.argv.slice(2).length) {
  program.outputHelp();
}
# Battle Bot - Node.js CLI

This bot can now run as a standalone Node.js application without Cloudflare Workers.

## Setup

1. Install dependencies:
```bash
npm install
```

2. Create a `.env` file with your configuration:
```bash
npm run cli init  # Creates .env.example
cp .env.example .env
# Edit .env with your values
```

## Running the Bot

Start the operator manager directly (no build required):
```bash
npm start
# or
npm run cli start
```

Check status:
```bash
npm run cli status
```

## Configuration

The following environment variables are required in your `.env` file:

- `ETH_RPC_URL` - Ethereum RPC endpoint (supports WebSocket upgrade, e.g., https://arb1.arbitrum.io/rpc)
- `GRAPHQL_URL` - GraphQL indexer endpoint
- `OPERATOR_ADDRESS` - Bot wallet address
- `OPERATOR_PRIVATE_KEY` - Bot wallet private key
- `RELAYER_URL` - Meta-transaction relayer URL
- `ERC2771_FORWARDER_ADDRESS` - ERC2771 forwarder contract address

### Logging Configuration

The following optional environment variables control logging:

- `LOG_LEVEL` - Overall log level (trace, debug, info, warn, error, fatal). Default: info
- `LOG_PRETTY` - Enable pretty logging with colors. Default: true, set to "false" to disable
- `LOG_OPERATORS` - Comma-separated list of operators to show logs for (e.g., "CharacterOperator,BattleOperator")
- `LOG_DISABLED_OPERATORS` - Comma-separated list of operators to hide logs for
- `LOG_LEVEL_<OPERATOR>` - Set log level for specific operator (e.g., LOG_LEVEL_CHARACTEROPERATOR=debug)

Examples:
```bash
# Show only CharacterOperator and BattleOperator logs
LOG_OPERATORS=CharacterOperator,BattleOperator npm start

# Hide EventAggregator logs
LOG_DISABLED_OPERATORS=EventAggregator npm start

# Set debug level for CharacterOperator only
LOG_LEVEL_CHARACTEROPERATOR=debug npm start

# Disable pretty printing (useful for log aggregation)
LOG_PRETTY=false npm start
```

## Architecture

The refactored application separates Cloudflare-specific code from the core business logic:

- `src/node/` - Pure Node.js implementations of all operators
- `src/cloudflare/` - Cloudflare Workers wrappers (for backward compatibility)
- `src/index.ts` - CLI entry point for Node.js

The Node.js version uses:
- Standard Node.js timers instead of Cloudflare alarms
- In-memory state instead of Durable Object storage
- Direct WebSocket connections for event monitoring

## Development

The application runs directly with ts-node, so there's no build step required. Just run:
```bash
npm start
```

If you need to build for production deployment:
```bash
npm run build
```

Run tests:
```bash
npm test
```

## Cloudflare Workers Compatibility

The original Cloudflare Workers deployment still works:
```bash
npm run deploy  # Deploy to Cloudflare Workers
npm run dev     # Run Cloudflare Workers locally
```
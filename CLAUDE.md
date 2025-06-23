# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Development Commands

- `npm run dev` or `npm start` - Start development server with Wrangler on port 8888
- `npm run deploy` - Deploy to Cloudflare Workers
- `npm test` - Run tests with Vitest
- `npm run cf-typegen` - Generate CloudFlare Worker types

## Architecture Overview

This is a Cloudflare Workers-based gaming bot system for the "Ready Aim Fire" blockchain game. The system uses three Durable Objects to manage game automation:

### Core Components

**EventListener** (`src/EventListener.ts`) - The main orchestrator that:
- Monitors blockchain events for new games and player joins
- Manages bot wallet minting via the Minter contract
- Spawns Bot and Operator instances for active games
- Runs on a 5-second alarm cycle to check for new events

**Bot** (`src/Bot.ts`) - Game-playing agent that:
- Joins games when the bot's address appears in PlayerJoinedEvent logs
- Executes automated gameplay (playing cards, attacking enemies, ending turns)
- Uses energy-based action system with random card selection
- Self-destructs after 10 minutes of inactivity or when game ends

**Operator** (`src/Operator.ts`) - Turn advancement manager that:
- Monitors games for turn completion via WebSocket connections
- Automatically calls `nextTurn()` when turns expire
- Handles turn timing and game state transitions

### Key Dependencies

- **viem** - Ethereum client for blockchain interactions
- **Cloudflare Workers** - Runtime platform with Durable Objects for state management
- **ERC2771 Meta-transactions** - Gasless transactions via forwarder pattern

### Blockchain Integration

The system interacts with several smart contracts:
- **ReadyAimFire** - Main game contract
- **ReadyAimFireFactory** - Game creation factory
- **BasicDeck** - Card collection contract  
- **Minter** - Handles card minting for new players
- **ERC2771Forwarder** - Meta-transaction relayer

All transactions are forwarded through the ERC2771 pattern for gasless execution.

### Environment Configuration

Critical environment variables defined in `src/Env.ts`:
- RPC endpoints, contract addresses, private keys
- Durable Object bindings for EVENT_LISTENER, BOT, OPERATOR

### Entry Points

- `/start` - Initializes the EventListener to begin monitoring
- `/reset` - Clears all stored state and stops monitoring
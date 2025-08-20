# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Development Commands

- `npm run dev` or `npm start` - Start development server with Wrangler on port 8888
- `npm run deploy` - Deploy to Cloudflare Workers
- `npm test` - Run tests with Vitest
- `npm run cf-typegen` - Generate CloudFlare Worker types

## Architecture Overview

This is a Cloudflare Workers-based gaming bot system for the "Battle" blockchain game. The system uses four Durable Objects to manage game automation:

### Core Components

**OperatorManager** (`src/OperatorManager.ts`) - The main orchestrator that:
- Discovers battles, characters, and parties using GraphQL indexer data exclusively
- Manages bot wallet operations
- Spawns CharacterOperator, BattleOperator, and ZigguratOperator instances for active games
- Runs on a 5-second alarm cycle using only GraphQL queries
- Uses GraphQL queries to efficiently find operator involvement in games

**CharacterOperator** (`src/CharacterOperator.ts`) - Game-playing agent that:
- Uses GraphQL to discover battle players and game state
- Executes automated gameplay (playing cards, attacking enemies, ending turns)
- Uses energy-based action system with random card selection
- Self-destructs after 10 minutes of inactivity or when game ends
- Falls back to event scanning if GraphQL is unavailable
- Smart hand management: Checks `lastTurnHandDrawn` field from GraphQL to determine if a new hand needs to be drawn
  - If `lastTurnHandDrawn` !== `currentTurn`: Calls `PlayerDeckManager.computeDiscardAndDrawHand()` with turn random seed
  - If `lastTurnHandDrawn` === `currentTurn`: Uses existing hand via `PlayerDeckManager.getPileState()`

**BattleOperator** (`src/BattleOperator.ts`) - Turn advancement manager that:
- Uses GraphQL to check battle state and turn history
- Monitors games for turn completion via WebSocket connections
- Automatically calls `nextTurn()` when turns expire
- Handles turn timing and game state transitions
- Combines GraphQL metadata with real-time contract calls

**ActOperator** (`src/ActOperator.ts`) - Act dungeon manager that:
- Uses GraphQL to discover active parties and room revelation status
- Monitors party progress through dungeon rooms
- Automatically calls `enterDoor()` when parties are ready to advance
- Manages room completion detection and party state transitions
- Efficiently queries room state from indexed data

### Key Dependencies

- **viem** - Ethereum client for blockchain interactions
- **Cloudflare Workers** - Runtime platform with Durable Objects for state management
- **ERC2771 Meta-transactions** - Gasless transactions via forwarder pattern
- **GraphQL Indexer** - Blockchain data indexing service for efficient data discovery

### GraphQL Integration

The system primarily uses a GraphQL indexer at `GRAPHQL_URL` for efficient blockchain data discovery:

**GraphQL Client** (`src/utils/graphql.ts`) provides:
- Typed GraphQL client with error handling
- Pre-defined queries for battles, parties, characters, and rooms
- TypeScript interfaces for all GraphQL response types
- Centralized query management for all operators

**Data Sources Strategy:**
- **Primary**: GraphQL indexer for historical/static data (battles, parties, players, rooms)
- **Secondary**: Direct contract calls for real-time state (turn timers, energy, completion status)
- **No Fallback**: OperatorManager now relies exclusively on GraphQL for discovery

**Key GraphQL Queries:**
- `getBattlesWithOperator` - Find battles where address is operator
- `getMonsters` - Find battle players where address is character
- `getPartiesByActWithStateDoorChosen` - Find active parties in act dungeons
- `getActRooms` - Get room revelation status and structure
- `getBattlePlayers` - Get players in specific battles
- `getBattleTurns` - Get turn history and metadata

**Benefits:**
- Reduced RPC calls and improved performance
- Consistent data structure vs. raw event parsing
- Efficient filtering and relationship queries
- Simplified architecture with single data source for discovery

### Blockchain Integration

The system interacts with several smart contracts:
- **Battle** - Main game contract
- **BattleFactory** - Game creation factory
- **Act** - Dungeon exploration contract
- **StandardDeck** - Card collection contract  
- **Season** - Manages series of Acts with current and historical tracking
- **RoomRewards** - Handles rewards for dungeon room completion
- **ERC2771Forwarder** - Meta-transaction relayer

All transactions are forwarded through the ERC2771 pattern for gasless execution.

### Environment Configuration

Critical environment variables defined in `src/Env.ts`:
- **ETH_RPC_URL** / **ETH_WS_RPC_URL** - Blockchain RPC endpoints
- **GRAPHQL_URL** - GraphQL indexer endpoint (e.g., http://localhost:42069/graphql)
- **OPERATOR_ADDRESS** / **OPERATOR_PRIVATE_KEY** - Bot wallet credentials
- **ERC2771_FORWARDER_ADDRESS** / **RELAYER_URL** - Meta-transaction infrastructure
- Durable Object bindings for OPERATOR_MANAGER, CHARACTER_OPERATOR, BATTLE_OPERATOR, ACT_OPERATOR
- Contract addresses are loaded from `src/contracts/deployments.json` and `../core-contracts/deployments.json`

### Entry Points

- `/start` - Initializes the OperatorManager to begin monitoring
- `/reset` - Clears all stored state and stops monitoring

## Development Notes

### Data Sources and Debugging

The system uses a hybrid approach for blockchain data:

1. **Primary Data Source**: GraphQL indexer at `GRAPHQL_URL`
   - Used for discovering battles, parties, characters, and rooms
   - Provides efficient filtering and relationship queries
   - Check GraphQL endpoint health with: `curl -X POST -H "Content-Type: application/json" -d '{"query":"query { _meta { status } }"}' $GRAPHQL_URL`

2. **Real-time Data**: Direct contract calls via RPC
   - Used for frequently changing state (turn timers, energy, room completion)
   - Always up-to-date but more expensive than GraphQL

3. **No Fallback**: GraphQL-only approach
   - OperatorManager requires GraphQL indexer to be available
   - Individual operators (Character/Battle/Ziggurat) maintain event scanning fallbacks
   - Simplified architecture with single discovery mechanism

### GraphQL Schema Reference

The GraphQL indexer at `GRAPHQL_URL` provides the following main entity types:

**Important Note**: All list queries return results wrapped in `{ items: [...], pageInfo: {...}, totalCount: N }` structure with cursor-based pagination.

**Core Entities:**

**Season & Act Management:**
- `season` - Season container (address, name, currentActIndex, owner, operator, trustedForwarder, createdAt)
- `seasonAct` - Links seasons to acts (id, seasonAddress, actIndex, actAddress, createdAt)
- `act` - Dungeon instance (address, startingRoomId, battleFactory, deckConfiguration, monsterRegistry, playerDeckManager, maxDepth, turnDuration, isClosed, owner, operator, trustedForwarder, rngSeed, createdAt)
  - Note: `rootRoomId` has been renamed to `startingRoomId`

**Party System:**
- `party` - Player group (id, actAddress, partyId, leader, roomId, state, isPublic, inviter, createdTxHash, createdAt, startedAt, endedAt)
  - States: CREATED(0), ROOM_CHOSEN(1), IN_ROOM(2), ESCAPED(3), CANCELLED(4)
  - Note: `battleAddress` removed, now uses `roomBattles` relationship
- `partyMember` - Character in party (id, partyId, characterId, joinedAt)
- `partyRoomBattle` - Links parties to battles in specific rooms (id, partyId, battleAddress, roomId, createdAt)

**Room System:**
- `actRoom` - Dungeon room (id, actAddress, roomId, roomType, roomData, revealedAt)
- `battleRoomData` - Battle room details (id, actAddress, partyId, roomId, monsterIndex1, battleAddress, createdAt, startedAt)
- `actRoomConnection` - Room connections (id, actAddress, fromRoomId, toRoomId, slotIndex)

**Character & Monster:**
- `character` - Player character (id, owner, operator, name, createdAt)
- `monster` - Monster character (id, characterAddress, index, health, registeredAt)
- `monsterCard` - Monster's cards (id, characterAddress, cardIndex, deck, actionTypes, registeredAt)
- `characterCard` - Character's cards (id, characterAddress, cardId, deck, tokenId, activatedAt, deactivatedAt, isActive)

**Battle System:**
- `battle` - Battle instance (id, owner, operator, joinDeadlineAt, turnDuration, turnTimerEnabled, deckConfiguration, playerStatsStorage, enforceAdjacency, currentTurn, teamAStarts, teamACount, teamBCount, teamAEliminated, teamBEliminated, winner, gameStartedAt, gameEndedAt, createdAt, currentTurnStartedAt, currentTurnDuration, currentTurnEndTurnCount, currentTurnRandomNumber)
- `battlePlayer` - Player in battle (id, battleAddress, playerId, character, deckId, locationX, locationY, teamA, joinedAt, eliminated, eliminatedAt, lastEndedTurn, statsLastUpdatedTurn, statsData, lastTurnHandDrawn)
  - Note: `lastTurnHandDrawn` tracks the turn number when the player's hand was last drawn - used to determine if `discardAndDrawHand` is needed
- `playerAction` - Battle actions (id, battleAddress, playerId, turn, cardIndex, cardActionParams, actionedAt)

**Deck & Card System:**
- `playerDeck` - Player deck (id, playerDeckManagerAddress, deckId, owner, createdAt, destroyedAt, isActive)
- `playerDeckCard` - Cards in player deck (id, playerDeckId, deckAddress, cardIndex, actionType, location, addedAt, updatedAt)
- `standardDeckCard` - Card ownership (id, deckAddress, tokenId, owner, actionType, mintedAt, transferredAt)

**Stats & Configuration:**
- `playerStatsStorage` - Player stats storage (id, trustedForwarder, storageAddress, owner, createdAt)
- `deckConfiguration` - Deck configurations (id, name, senderOwner, operator, trustedForwarder, standardDeckLogic, playerDeckManager, createdAt)

**Action System:**
- `actionDefinition` - Action definitions (id, deckLogicAddress, actionType, energy, createdAt)
- `actionEffect` - Action effects (id, actionDefinitionId, effectType, amount, createdAt)

**Query Patterns:**
- All list queries follow the naming pattern: singular for single item (e.g., `party`), plural with 's' for lists (e.g., `partys`)
- All list queries return: `{ items: [...], pageInfo: {...}, totalCount: N }`
- Pagination: Use `limit`, `after`, `before` (cursor-based, not offset)
- Filtering: Use `where` with exact matches or operators (`_gt`, `_starts_with`, etc.)
- Ordering: Use `orderBy` and `orderDirection` parameters
- Relationships are navigable (e.g., `party { members { character { name } } }`)

### Common Issues

- **GraphQL Connection Issues**: OperatorManager will fail without GraphQL indexer
- **Missing Contract ABIs**: Check that `src/contracts/abis/` contains current ABIs
- **Deployment Address Mismatches**: Verify `deployments.json` files are current
- **Operator Not Starting**: Check that OPERATOR_ADDRESS has sufficient permissions in contracts

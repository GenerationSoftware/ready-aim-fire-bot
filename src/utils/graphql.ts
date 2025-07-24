import { createLogger } from './logger';

interface GraphQLConfig {
  GRAPHQL_URL: string;
  BASIC_AUTH_USER?: string;
  BASIC_AUTH_PASSWORD?: string;
}

const logger = createLogger({ operator: 'GraphQL' });

export interface GraphQLClient {
  query<T = any>(query: string, variables?: Record<string, any>): Promise<T>;
}

// Utility function to create basic auth header
function createBasicAuthHeader(username: string, password: string): string {
  const credentials = btoa(`${username}:${password}`);
  return `Basic ${credentials}`;
}

// Utility function to build request headers
function buildGraphQLHeaders(config: GraphQLConfig): Record<string, string> {
  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
  };

  // Add basic auth if credentials are provided
  if (config.BASIC_AUTH_USER && config.BASIC_AUTH_PASSWORD) {
    headers['Authorization'] = createBasicAuthHeader(config.BASIC_AUTH_USER, config.BASIC_AUTH_PASSWORD);
  }

  return headers;
}

export function createGraphQLClient(config: GraphQLConfig): GraphQLClient {
  return {
    async query<T = any>(query: string, variables?: Record<string, any>): Promise<T> {
      try {
        const response = await fetch(config.GRAPHQL_URL, {
          method: 'POST',
          headers: buildGraphQLHeaders(config),
          body: JSON.stringify({
            query,
            variables,
          }),
        });

        if (!response.ok) {
          const responseText = await response.text();
          logger.error({ status: response.status, statusText: response.statusText, responseText }, 'GraphQL HTTP Error');
          throw new Error(`GraphQL request failed: ${response.status} ${response.statusText}`);
        }

        const result = await response.json() as { data?: T; errors?: any[] };
        
        if (result.errors) {
          logger.error({ errors: result.errors }, 'GraphQL Query Errors');
          throw new Error(`GraphQL query error: ${JSON.stringify(result.errors)}`);
        }

        return result.data as T;
      } catch (error: any) {
        if (error.cause?.code === 'ECONNREFUSED') {
          logger.error({ url: config.GRAPHQL_URL }, 'GraphQL endpoint unavailable');
          throw new Error(`GraphQL endpoint unavailable: ${config.GRAPHQL_URL}`);
        }
        throw error;
      }
    },
  };
}

// Pagination utility for queries that return lists
// Uses cursor-based pagination with 'after' parameter
export async function queryAllPages<T extends { items: any[] }>(
  client: GraphQLClient,
  query: string,
  variables: Record<string, any> = {},
  pageSize: number = 100
): Promise<T['items']> {
  const allItems: T['items'] = [];
  let afterCursor: string | undefined = undefined;
  let hasMore = true;
  let totalFetched = 0;

  while (hasMore) {
    // Add pagination variables
    const paginatedVariables: Record<string, any> = {
      ...variables,
      limit: pageSize,
      ...(afterCursor ? { after: afterCursor } : {})
    };

    const result: { [key: string]: T } = await client.query<{ [key: string]: T }>(query, paginatedVariables);
    
    // Find the first result that has an items array
    const resultKey = Object.keys(result).find(key => 
      result[key] && Array.isArray((result[key] as any).items)
    );
    
    if (!resultKey) {
      logger.error({ result }, 'No items array found in query result');
      break;
    }

    const items: T['items'] = (result[resultKey] as T).items;
    allItems.push(...items);
    totalFetched += items.length;

    // Check if we got less than a full page
    hasMore = items.length === pageSize;
    
    // Get the last item's ID as the cursor for the next page
    if (hasMore && items.length > 0) {
      const lastItem: any = items[items.length - 1];
      afterCursor = lastItem.id || lastItem.address || JSON.stringify(lastItem);
    }

    // Safety check to prevent infinite loops
    if (totalFetched > 10000) {
      logger.warn('Pagination safety limit reached (10000 items)');
      break;
    }
  }

  return allItems;
}

// GraphQL types based on schema introspection
export enum PartyState {
  CREATED,
  DOOR_CHOSEN,
  IN_ROOM,
  ESCAPED,
  CANCELLED
}

export interface Party {
  id: string;
  zigguratAddress: string;
  partyId: string;
  leader: string;
  isPublic: boolean;
  inviter: string;
  roomHash: string;
  chosenDoor: string;
  state: PartyState;
  createdAt: string;
  startedAt: string | null;
  endedAt: string | null;
}

export interface ZigguratRoom {
  id: string;
  zigguratAddress: string;
  roomHash: string;
  parentRoomHash: string | null;
  parentDoorIndex: string | null;
  revealedAt: string | null;
}

export interface Battle {
  id: string;
  gameStartedAt: string | null;
  currentTurn: string;
  teamAStarts: boolean;
  turnDuration: string;
  winner?: string | null;
}

export interface BattlePlayer {
  id: string;
  playerId: string;
  character: Character;
  teamA: boolean;
  eliminated: boolean;
  battle: Battle;
}

export interface BattleTurn {
  id: string;
  turn: string;
  startedAt: string;
  duration: string;
  endTurnCount: string;
}

export interface Character {
  id: string;
  name: string;
  owner: string;
  operator: string;
  battlePlayers?: {
    items: BattlePlayer[];
  };
}

export interface Ziggurat {
  address: string;
}

// Query helpers
// NOTE: All queries that return lists use cursor-based pagination with $limit and $after parameters
// Use the queryAllPages utility function when you need to fetch all results
export const GraphQLQueries = {
  // Ziggurat queries
  getPartiesByZigguratWithStateDoorChosen: `
    query GetPartiesByZiggurat($zigguratAddress: String!, $limit: Int, $after: String) {
      partys(where: { zigguratAddress: $zigguratAddress, state: "1" }, limit: $limit, after: $after) {
        items {
          id
          zigguratAddress
          partyId
          leader
          isPublic
          inviter
          roomHash
          chosenDoor
          state
          createdAt
          startedAt
          endedAt
        }
      }
    }
  `,

  getZigguratRooms: `
    query GetZigguratRooms($zigguratAddress: String!) {
      zigguratRooms(where: { zigguratAddress: $zigguratAddress }) {
        items {
          id
          zigguratAddress
          roomHash
          parentRoomHash
          parentDoorIndex
          revealedAt
        }
      }
    }
  `,

  getSpecificZigguratRoom: `
    query GetSpecificZigguratRoom($zigguratAddress: String!, $parentRoomHash: String!, $parentDoorIndex: BigInt!) {
      zigguratRooms(where: { 
        zigguratAddress: $zigguratAddress, 
        parentRoomHash: $parentRoomHash, 
        parentDoorIndex: $parentDoorIndex 
      }) {
        items {
          id
          zigguratAddress
          roomHash
          parentRoomHash
          parentDoorIndex
          revealedAt
        }
      }
    }
  `,

  getPartiesWaitingForRoom: `
    query GetPartiesWaitingForRoom($zigguratAddress: String!, $roomHash: String!, $doorIndex: BigInt!) {
      partys(where: { 
        zigguratAddress: $zigguratAddress, 
        roomHash: $roomHash, 
        chosenDoor: $doorIndex, 
        state: "1",
        endedAt: "0"
      }) {
        items {
          id
          zigguratAddress
          partyId
          leader
          isPublic
          inviter
          roomHash
          chosenDoor
          state
          createdAt
          startedAt
          endedAt
        }
      }
    }
  `,

  getSpecificPartyByZiggurat: `
    query GetSpecificPartyByZiggurat($zigguratAddress: String!, $partyId: String!) {
      partys(where: { zigguratAddress: $zigguratAddress, partyId: $partyId}) {
        items {
          id
          zigguratAddress
          partyId
          leader
          isPublic
          inviter
          roomHash
          chosenDoor
          state
          createdAt
          startedAt
          endedAt
        }
      }
    }
  `,

  // Battle queries
  getBattlesByGameState: `
    query GetBattlesByGameState {
      battles(where: { gameStartedAt_not: null, winner: null }) {
        items {
          id
          gameStartedAt
          currentTurn
          teamAStarts
          turnDuration
        }
      }
    }
  `,

  getBattleById: `
    query GetBattleById($battleId: String!) {
      battle(id: $battleId) {
        id
        gameStartedAt
        currentTurn
        teamAStarts
        turnDuration
        winner
      }
    }
  `,

  getBattlePlayers: `
    query GetBattlePlayers($battleId: String!, $limit: Int = 100, $after: String) {
      battlePlayers(where: { id_starts_with: $battleId }, limit: $limit, after: $after) {
        items {
          id
          playerId
          teamA
          eliminated
          character {
            id
            name
            owner
            operator
          }
        }
      }
    }
  `,

  getActiveEnemyPlayers: `
    query GetActiveEnemyPlayers($battleId: String!, $isTeamA: Boolean!) {
      battlePlayers(where: { id_starts_with: $battleId, teamA_not: $isTeamA, eliminated: false }) {
        items {
          id
          playerId
          teamA
          eliminated
          character {
            id
            name
          }
        }
      }
    }
  `,

  getBattleTurns: `
    query GetBattleTurns($battleId: String!) {
      battleTurns(where: { id_starts_with: $battleId }, orderBy: "turn", orderDirection: "desc", limit: 1) {
        items {
          id
          turn
          startedAt
          duration
          endTurnCount
        }
      }
    }
  `,

  // OperatorManager queries
  getBattlesWithOperator: `
    query GetBattlesWithOperator($operator: String!, $limit: Int = 100, $after: String) {
      battles(where: { operator: $operator, winner: null }, limit: $limit, after: $after) {
        items {
          id
          operator
          gameStartedAt
          currentTurn
          teamAStarts
          turnDuration
          winner
        }
      }
    }
  `,

  getActiveBattlesWithPlayers: `
    query GetActiveBattlesWithPlayers {
      battles(where: { gameStartedAt_not: null, winner: null }, limit: 100) {
        items {
          id
          gameStartedAt
          currentTurn
          winner
          players {
            items {
              id
              playerId
              teamA
              eliminated
              character {
                id
                name
                owner
                operator
              }
            }
          }
        }
      }
    }
  `,

  getCharactersByOwner: `
    query GetCharactersByOwner($owner: String!, $limit: Int = 100, $after: String) {
      characters(where: { owner: $owner }, limit: $limit, after: $after) {
        items {
          id
          name
          owner
          operator
        }
      }
    }
  `,

  getActiveBattlesForCharacters: `
    query GetActiveBattlesForCharacters($characterIds: [String!]!) {
      battles(where: { gameStartedAt_not: null, gameEndedAt: null }, limit: 100) {
        items {
          id
          gameStartedAt
          currentTurn
          winner
          players(where: { character_in: $characterIds }) {
            items {
              id
              playerId
              teamA
              eliminated
              character {
                id
                name
                owner
                operator
              }
            }
          }
        }
      }
    }
  `,

  // Alternative query to find all active battles (for debugging)
  getAllActiveBattles: `
    query GetAllActiveBattles {
      battles(where: { gameStartedAt_not: null, currentTurn_gt: "0" }, limit: 10) {
        items {
          id
          operator
          gameStartedAt
          currentTurn
          teamAStarts
          turnDuration
        }
      }
    }
  `,

  getMonsters: `
    query GetMonsters($owner: String!) {
      characters(where: { owner: $owner }) {
        items {
          id
          name
          owner
          operator
          battlePlayers {
            items {
              id
              playerId
              teamA
              eliminated
              battle {
                id
                gameStartedAt
                currentTurn
                teamAStarts
                turnDuration
                winner
              }
            }
          }
        }
      }
    }
  `,

  getAllOpenZigguratsWithOperator: `
    query GetAllOpenZiggurats($operator: String!) {
      ziggurats(where: { isClosed: false, operator: $operator }) {
        items {
          address
        }
      }
    }
  `,
};
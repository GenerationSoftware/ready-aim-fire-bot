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
export const GraphQLQueries = {
  // Ziggurat queries
  getPartiesByZigguratWithStateDoorChosen: `
    query GetPartiesByZiggurat($zigguratAddress: String!) {
      partys(where: { zigguratAddress: $zigguratAddress, state: "1" }) {
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

  getBattlePlayers: `
    query GetBattlePlayers($battleId: String!) {
      battlePlayers(where: { id_starts_with: $battleId }) {
        items {
          id
          playerId
          teamA
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
    query GetBattlesWithOperator($operator: String!) {
      battles(where: { operator: $operator }, limit: 1000) {
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
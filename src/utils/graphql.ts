import { Env } from "../Env";

export interface GraphQLClient {
  query<T = any>(query: string, variables?: Record<string, any>): Promise<T>;
}

export function createGraphQLClient(env: Env): GraphQLClient {
  return {
    async query<T = any>(query: string, variables?: Record<string, any>): Promise<T> {
      const response = await fetch(env.GRAPHQL_URL, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          query,
          variables,
        }),
      });

      if (!response.ok) {
        throw new Error(`GraphQL request failed: ${response.status} ${response.statusText}`);
      }

      const result = await response.json();
      
      if (result.errors) {
        throw new Error(`GraphQL query error: ${JSON.stringify(result.errors)}`);
      }

      return result.data;
    },
  };
}

// GraphQL types based on schema introspection
export interface Party {
  id: string;
  zigguratAddress: string;
  partyId: string;
  character: string;
  isPublic: boolean;
  isStarted: boolean;
  isEnded: boolean;
  createdAt: string;
  startedAt: string;
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
}

export interface BattlePlayer {
  id: string;
  playerId: string;
  character: string;
  teamA: boolean;
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
  playerId: string;
  teamA: boolean;
  battle: Battle;
}

export interface Ziggurat {
  address: string;
}

// Query helpers
export const GraphQLQueries = {
  // Ziggurat queries
  getPartiesByZiggurat: `
    query GetPartiesByZiggurat($zigguratAddress: String!) {
      partys(where: { zigguratAddress: $zigguratAddress, isEnded: false }) {
        items {
          id
          zigguratAddress
          partyId
          character
          isPublic
          isStarted
          isEnded
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

  // Battle queries
  getBattlesByGameState: `
    query GetBattlesByGameState {
      battles(where: { gameStartedAt_not: null }) {
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
          character
          teamA
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
      battles(where: { operator: $operator, currentTurn_gt: "0" }) {
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
    query GetMonsters($owner: String!, $operator: String!) {
      characters(where: { owner: $owner, operator: $operator }) {
        items {
          id
          name
          owner
          operator
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
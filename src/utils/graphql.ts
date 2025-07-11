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
        const responseText = await response.text();
        console.error(`❌ GraphQL HTTP Error: ${response.status} ${response.statusText}`);
        console.error(`❌ Response body:`, responseText);
        throw new Error(`GraphQL request failed: ${response.status} ${response.statusText}`);
      }

      const result = await response.json() as { data?: T; errors?: any[] };
      
      if (result.errors) {
        console.error(`❌ GraphQL Query Errors:`, JSON.stringify(result.errors));
        throw new Error(`GraphQL query error: ${JSON.stringify(result.errors)}`);
      }

      return result.data as T;
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

  getSpecificPartyByZiggurat: `
    query GetSpecificPartyByZiggurat($zigguratAddress: String!, $partyId: String!) {
      partys(where: { zigguratAddress: $zigguratAddress, partyId: $partyId, state: "1" }) {
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
    query GetMonsters($operator: String!) {
      characters(where: { operator: $operator }) {
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
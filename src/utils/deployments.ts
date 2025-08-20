import deployments from '../contracts/deployments.json';

export function getContractAddress(contractName: string): string {
  const deployment = deployments.find(d => d.contractName === contractName);
  if (!deployment) {
    throw new Error(`Contract ${contractName} not found in deployments`);
  }
  return deployment.contractAddress;
}

export const CONTRACT_ADDRESSES = {
  BATTLE: getContractAddress('Battle'),
  STANDARD_DECK: getContractAddress('StandardDeck'),
  STANDARD_DECK_LOGIC: getContractAddress('StandardDeckLogic'),
  BATTLE_FACTORY: getContractAddress('BattleFactory'),
  MONSTER_REGISTRY: getContractAddress('MonsterRegistry'),
  CHARACTER_FACTORY: getContractAddress('CharacterFactory'),
  DECK_CONFIGURATION: getContractAddress('DeckConfiguration'),
  SEASON: getContractAddress('Season'),
  ACT: getContractAddress('Act'),
  ROOM_REWARDS: getContractAddress('RoomRewards'),
} as const;

export function getDeployments() {
  return CONTRACT_ADDRESSES;
}
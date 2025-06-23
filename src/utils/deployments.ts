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
  BASIC_DECK: getContractAddress('BasicDeck'),
  BASIC_DECK_LOGIC: getContractAddress('BasicDeckLogic'),
  MINTER: getContractAddress('Minter'),
  BATTLE_FACTORY: getContractAddress('BattleFactory'),
  MONSTER_REGISTRY: getContractAddress('MonsterRegistry'),
  CHARACTER_FACTORY: getContractAddress('CharacterFactory'),
  DECK_CONFIGURATION: getContractAddress('DeckConfiguration'),
  ZIGGURAT_SINGLETON: getContractAddress('ZigguratSingleton'),
  ZIGGURAT: getContractAddress('Ziggurat'),
} as const;
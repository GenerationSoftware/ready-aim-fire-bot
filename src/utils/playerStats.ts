/**
 * PlayerStatType enum indices
 */
export enum PlayerStatType {
  HEALTH = 0,
  ENERGY = 1,
  BLOCK = 2,
  VULNERABLE = 3,
  WEAK = 4,
  STRENGTH = 5
}

/**
 * Decodes a bytes30 packed array of uint8 player stats
 * @param statsBytes - The bytes30 hex string (e.g., "0x00001e030000...")
 * @returns Array of 30 bigint values representing the stats
 */
export function decodePlayerStats(statsBytes: string): bigint[] {
  if (!statsBytes || !statsBytes.startsWith('0x')) {
    throw new Error('Invalid stats bytes: must be a hex string starting with 0x');
  }

  const stats: bigint[] = [];
  
  // Remove '0x' prefix and ensure we have exactly 60 hex characters (30 bytes)
  const hexData = statsBytes.slice(2).padEnd(60, '0');
  
  // Skip the front padding and extract the actual stats
  // 0x00001e030000... has padding at front: 0000, then stats: 1e, 03, 00, 00...
  // So index 0 = 1e (30), index 1 = 03 (3), etc.
  
  for (let i = 0; i < 30; i++) {
    // Skip first 4 hex chars (2 bytes of padding), then read normally
    const byteIndex = 4 + (i * 2);
    
    if (byteIndex + 1 < hexData.length) {
      const byteHex = hexData.slice(byteIndex, byteIndex + 2);
      stats.push(BigInt('0x' + byteHex));
    } else {
      stats.push(0n);
    }
  }
  
  return stats;
}

/**
 * Gets a specific player stat by type
 * @param statsBytes - The bytes30 hex string
 * @param statType - The PlayerStatType to retrieve
 * @returns The stat value as bigint
 */
export function getPlayerStat(statsBytes: string, statType: PlayerStatType): bigint {
  const stats = decodePlayerStats(statsBytes);
  return stats[statType];
}

/**
 * Gets the player's energy from their stats
 * @param statsBytes - The bytes30 hex string
 * @returns The energy value as bigint
 */
export function getPlayerEnergy(statsBytes: string): bigint {
  return getPlayerStat(statsBytes, PlayerStatType.ENERGY);
}



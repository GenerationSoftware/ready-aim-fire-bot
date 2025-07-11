/**
 * Utility functions for working with card pile states (bytes32 bitflags)
 */

/**
 * Converts a bytes32 bitflag into an array of card indices
 * @param cardPileBits - The bytes32 value representing which cards are in the pile
 * @returns Array of card indices (0-255) that are set in the bitflag
 */
export function cardPileBitsToArray(cardPileBits: bigint): number[] {
  const cards: number[] = [];
  for (let i = 0; i < 256; i++) {
    if ((cardPileBits & (1n << BigInt(i))) !== 0n) {
      cards.push(i);
    }
  }
  return cards;
}

/**
 * Converts an array of card indices back to a bytes32 bitflag
 * @param cardIndices - Array of card indices to set
 * @returns The bytes32 bitflag representation
 */
export function cardArrayToBits(cardIndices: number[]): bigint {
  let bits = 0n;
  for (const index of cardIndices) {
    bits |= (1n << BigInt(index));
  }
  return bits;
}

/**
 * Removes a card from a hand array
 * @param handCards - Current hand array
 * @param cardIndex - The card index to remove
 * @returns New hand array with the card removed
 */
export function removeCardFromHand(handCards: number[], cardIndex: number): number[] {
  return handCards.filter(card => card !== cardIndex);
}
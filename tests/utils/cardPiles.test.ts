import { describe, it, expect } from 'vitest'
import { 
  cardPileBitsToArray, 
  cardArrayToBits, 
  removeCardFromHand 
} from '../../src/utils/cardPiles'

describe('Card Pile Utilities', () => {
  describe('cardPileBitsToArray', () => {
    it('should convert empty bits to empty array', () => {
      const result = cardPileBitsToArray(0n)
      expect(result).toEqual([])
    })

    it('should convert single bit to single card', () => {
      const result = cardPileBitsToArray(1n) // bit 0 set
      expect(result).toEqual([0])
    })

    it('should convert multiple bits to card array', () => {
      const bits = (1n << 0n) | (1n << 3n) | (1n << 7n) // bits 0, 3, 7 set
      const result = cardPileBitsToArray(bits)
      expect(result).toEqual([0, 3, 7])
    })

    it('should handle high card indices', () => {
      const bits = (1n << 255n) | (1n << 100n) | (1n << 50n) // bits 50, 100, 255 set
      const result = cardPileBitsToArray(bits)
      expect(result).toEqual([50, 100, 255])
    })

    it('should handle typical hand with 5 cards', () => {
      // Cards 0, 1, 2, 3, 4 in hand
      const bits = (1n << 0n) | (1n << 1n) | (1n << 2n) | (1n << 3n) | (1n << 4n)
      const result = cardPileBitsToArray(bits)
      expect(result).toEqual([0, 1, 2, 3, 4])
    })
  })

  describe('cardArrayToBits', () => {
    it('should convert empty array to zero bits', () => {
      const result = cardArrayToBits([])
      expect(result).toBe(0n)
    })

    it('should convert single card to single bit', () => {
      const result = cardArrayToBits([0])
      expect(result).toBe(1n)
    })

    it('should convert multiple cards to correct bits', () => {
      const result = cardArrayToBits([0, 3, 7])
      const expected = (1n << 0n) | (1n << 3n) | (1n << 7n)
      expect(result).toBe(expected)
    })

    it('should handle high card indices', () => {
      const result = cardArrayToBits([50, 100, 255])
      const expected = (1n << 50n) | (1n << 100n) | (1n << 255n)
      expect(result).toBe(expected)
    })
  })

  describe('removeCardFromHand', () => {
    it('should remove card from hand', () => {
      const hand = [0, 1, 2, 3, 4]
      const result = removeCardFromHand(hand, 2)
      expect(result).toEqual([0, 1, 3, 4])
    })

    it('should handle removing first card', () => {
      const hand = [0, 1, 2, 3, 4]
      const result = removeCardFromHand(hand, 0)
      expect(result).toEqual([1, 2, 3, 4])
    })

    it('should handle removing last card', () => {
      const hand = [0, 1, 2, 3, 4]
      const result = removeCardFromHand(hand, 4)
      expect(result).toEqual([0, 1, 2, 3])
    })

    it('should handle removing non-existent card', () => {
      const hand = [0, 1, 2, 3, 4]
      const result = removeCardFromHand(hand, 99)
      expect(result).toEqual([0, 1, 2, 3, 4])
    })

    it('should handle empty hand', () => {
      const hand: number[] = []
      const result = removeCardFromHand(hand, 0)
      expect(result).toEqual([])
    })

    it('should handle single card hand', () => {
      const hand = [5]
      const result = removeCardFromHand(hand, 5)
      expect(result).toEqual([])
    })
  })

  describe('Round trip conversions', () => {
    it('should maintain integrity through array->bits->array conversion', () => {
      const originalCards = [0, 5, 12, 25, 100, 255]
      const bits = cardArrayToBits(originalCards)
      const resultCards = cardPileBitsToArray(bits)
      expect(resultCards).toEqual(originalCards)
    })

    it('should maintain integrity through bits->array->bits conversion', () => {
      const originalBits = (1n << 0n) | (1n << 7n) | (1n << 15n) | (1n << 31n)
      const cards = cardPileBitsToArray(originalBits)
      const resultBits = cardArrayToBits(cards)
      expect(resultBits).toBe(originalBits)
    })
  })
})
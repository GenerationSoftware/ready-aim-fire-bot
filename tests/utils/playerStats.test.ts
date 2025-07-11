import { describe, it, expect } from 'vitest'
import { 
  decodePlayerStats, 
  getPlayerStat, 
  getPlayerEnergy, 
  PlayerStatType 
} from '../../src/utils/playerStats'

describe('PlayerStats Utilities', () => {
  describe('decodePlayerStats', () => {
    it('should decode real game data correctly', () => {
      const testStats = '0x00001e030000000000000000000000000000000000000000000000000000'
      const decoded = decodePlayerStats(testStats)
      
      expect(decoded).toHaveLength(30)
      expect(decoded[0]).toBe(30n) // HEALTH
      expect(decoded[1]).toBe(3n)  // ENERGY  
      expect(decoded[2]).toBe(0n)  // BLOCK
      expect(decoded[3]).toBe(0n)  // VULNERABLE
      expect(decoded[4]).toBe(0n)  // WEAK
      expect(decoded[5]).toBe(0n)  // STRENGTH
    })

    it('should handle different stat values', () => {
      const testStats = '0x0000050a0307ff00000000000000000000000000000000000000000000000'
      const decoded = decodePlayerStats(testStats)
      
      expect(decoded[0]).toBe(5n)   // HEALTH = 5
      expect(decoded[1]).toBe(10n)  // ENERGY = 10
      expect(decoded[2]).toBe(3n)   // BLOCK = 3
      expect(decoded[3]).toBe(7n)   // VULNERABLE = 7
      expect(decoded[4]).toBe(255n) // WEAK = 255
    })

    it('should pad with zeros for short data', () => {
      const testStats = '0x00000503'
      const decoded = decodePlayerStats(testStats)
      
      expect(decoded).toHaveLength(30)
      expect(decoded[0]).toBe(5n)
      expect(decoded[1]).toBe(3n)
      expect(decoded[2]).toBe(0n)
      // All remaining should be 0
      for (let i = 3; i < 30; i++) {
        expect(decoded[i]).toBe(0n)
      }
    })

    it('should handle edge case with minimal data', () => {
      const testStats = '0x0000'
      const decoded = decodePlayerStats(testStats)
      
      expect(decoded).toHaveLength(30)
      // All should be 0 since we only have padding
      for (let i = 0; i < 30; i++) {
        expect(decoded[i]).toBe(0n)
      }
    })

    it('should throw error for invalid input', () => {
      expect(() => decodePlayerStats('invalid')).toThrow('Invalid stats bytes')
      expect(() => decodePlayerStats('')).toThrow('Invalid stats bytes')
      expect(() => decodePlayerStats('1234')).toThrow('Invalid stats bytes')
    })
  })

  describe('getPlayerStat', () => {
    const testStats = '0x00001e0f0a050301000000000000000000000000000000000000000000000'

    it('should get HEALTH correctly', () => {
      expect(getPlayerStat(testStats, PlayerStatType.HEALTH)).toBe(30n)
    })

    it('should get ENERGY correctly', () => {
      expect(getPlayerStat(testStats, PlayerStatType.ENERGY)).toBe(15n)
    })

    it('should get BLOCK correctly', () => {
      expect(getPlayerStat(testStats, PlayerStatType.BLOCK)).toBe(10n)
    })

    it('should get VULNERABLE correctly', () => {
      expect(getPlayerStat(testStats, PlayerStatType.VULNERABLE)).toBe(5n)
    })

    it('should get WEAK correctly', () => {
      expect(getPlayerStat(testStats, PlayerStatType.WEAK)).toBe(3n)
    })

    it('should get STRENGTH correctly', () => {
      expect(getPlayerStat(testStats, PlayerStatType.STRENGTH)).toBe(1n)
    })
  })

  describe('getPlayerEnergy', () => {
    it('should extract energy from real game data', () => {
      const testStats = '0x00001e030000000000000000000000000000000000000000000000000000'
      expect(getPlayerEnergy(testStats)).toBe(3n)
    })

    it('should handle different energy values', () => {
      // Format: 0x0000[HEALTH][ENERGY][rest...]
      const testStats1 = '0x00000a05000000000000000000000000000000000000000000000000000'
      expect(getPlayerEnergy(testStats1)).toBe(5n) // ENERGY at index 1

      const testStats2 = '0x000014ff000000000000000000000000000000000000000000000000000'
      expect(getPlayerEnergy(testStats2)).toBe(255n) // ENERGY at index 1
    })

    it('should handle zero energy', () => {
      const testStats = '0x00001e000000000000000000000000000000000000000000000000000000'
      expect(getPlayerEnergy(testStats)).toBe(0n)
    })
  })

  describe('PlayerStatType enum', () => {
    it('should have correct enum values', () => {
      expect(PlayerStatType.HEALTH).toBe(0)
      expect(PlayerStatType.ENERGY).toBe(1)
      expect(PlayerStatType.BLOCK).toBe(2)
      expect(PlayerStatType.VULNERABLE).toBe(3)
      expect(PlayerStatType.WEAK).toBe(4)
      expect(PlayerStatType.STRENGTH).toBe(5)
    })
  })

  describe('Integration tests', () => {
    it('should work with the exact data from production logs', () => {
      // This is the exact hex string from the production logs
      const productionStats = '0x00001e030000000000000000000000000000000000000000000000000000'
      
      const decoded = decodePlayerStats(productionStats)
      expect(decoded[PlayerStatType.HEALTH]).toBe(30n)
      expect(decoded[PlayerStatType.ENERGY]).toBe(3n)
      expect(decoded[PlayerStatType.BLOCK]).toBe(0n)
      expect(decoded[PlayerStatType.VULNERABLE]).toBe(0n)
      expect(decoded[PlayerStatType.WEAK]).toBe(0n)
      expect(decoded[PlayerStatType.STRENGTH]).toBe(0n)
      
      // Test the convenience function
      expect(getPlayerEnergy(productionStats)).toBe(3n)
      
      // Test the generic function
      expect(getPlayerStat(productionStats, PlayerStatType.HEALTH)).toBe(30n)
      expect(getPlayerStat(productionStats, PlayerStatType.ENERGY)).toBe(3n)
    })
  })
})
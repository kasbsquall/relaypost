import { describe, expect, it } from 'vitest'
import { parseRateLimit } from '../src/buffer/graphql'

describe('parseRateLimit', () => {
  it('reads the header exactly as the live API sent it on 3 Nov 2026', () => {
    const header = '"15m"; r=96; t=839, "24h"; r=496; t=86339, "30d"; r=14996; t=2591939'
    expect(parseRateLimit(header)).toEqual([
      { policy: '15m', remaining: 96, resetSeconds: 839 },
      { policy: '24h', remaining: 496, resetSeconds: 86339 },
      { policy: '30d', remaining: 14996, resetSeconds: 2591939 },
    ])
  })

  it('still reads the compact form shown in the docs', () => {
    expect(parseRateLimit('"150-in-15min";r=98;t=897')).toEqual([
      { policy: '150-in-15min', remaining: 98, resetSeconds: 897 },
    ])
  })

  it('adds each window limit from RateLimit-Policy', () => {
    const header = '"15m"; r=96; t=839, "24h"; r=496; t=86339'
    const policy = '"15m"; q=100; w=900, "24h"; q=500; w=86400, "30d"; q=15000; w=2592000'
    expect(parseRateLimit(header, policy)).toEqual([
      { policy: '15m', remaining: 96, resetSeconds: 839, limit: 100 },
      { policy: '24h', remaining: 496, resetSeconds: 86339, limit: 500 },
    ])
  })

  it('returns no windows when the header is missing', () => {
    expect(parseRateLimit(null)).toEqual([])
  })
})

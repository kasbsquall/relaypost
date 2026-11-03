import { describe, expect, it } from 'vitest'
import { pkceChallenge, seal, sign, unseal, verify } from '../src/lib/crypto'

const KEY = btoa(String.fromCharCode(...new Uint8Array(32).map((_, i) => i)))

describe('crypto', () => {
  it('round-trips a sealed value in the same context', async () => {
    expect(await unseal(await seal('secret', KEY, 'tokens'), KEY, 'tokens')).toBe('secret')
  })

  it('refuses to open a value sealed for another purpose', async () => {
    const sealed = await seal('secret', KEY, 'oauth')
    await expect(unseal(sealed, KEY, 'tokens')).rejects.toThrow()
  })

  it('verifies only untampered signatures', async () => {
    const sig = await sign('acct.123', 'x'.repeat(32))
    expect(await verify('acct.123', sig, 'x'.repeat(32))).toBe(true)
    expect(await verify('acct.124', sig, 'x'.repeat(32))).toBe(false)
    expect(await verify('acct.123', 'not-base64!', 'x'.repeat(32))).toBe(false)
  })

  it('matches the RFC 7636 PKCE example', async () => {
    expect(await pkceChallenge('dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk')).toBe('E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM')
  })
})

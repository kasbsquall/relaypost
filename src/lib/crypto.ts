// Small Web Crypto helpers. Everything here runs on Workers and on Node 22.

const encoder = new TextEncoder()
const decoder = new TextDecoder()

export function toBase64Url(bytes: Uint8Array): string {
  let binary = ''
  for (const b of bytes) binary += String.fromCharCode(b)
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
}

export function fromBase64Url(text: string): Uint8Array {
  const padded = text.replace(/-/g, '+').replace(/_/g, '/') + '==='.slice((text.length + 3) % 4)
  const binary = atob(padded)
  return Uint8Array.from(binary, (c) => c.charCodeAt(0))
}

function fromBase64(text: string): Uint8Array {
  return Uint8Array.from(atob(text), (c) => c.charCodeAt(0))
}

export function randomToken(byteLength = 32): string {
  return toBase64Url(crypto.getRandomValues(new Uint8Array(byteLength)))
}

// PKCE: the verifier never leaves our server until the token exchange; Buffer
// only sees its SHA-256 hash during the authorize redirect.
export async function pkceChallenge(verifier: string): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', encoder.encode(verifier))
  return toBase64Url(new Uint8Array(digest))
}

async function hmacKey(secret: string): Promise<CryptoKey> {
  return crypto.subtle.importKey('raw', encoder.encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign', 'verify'])
}

export async function sign(value: string, secret: string): Promise<string> {
  const mac = await crypto.subtle.sign('HMAC', await hmacKey(secret), encoder.encode(value))
  return toBase64Url(new Uint8Array(mac))
}

export async function verify(value: string, signature: string, secret: string): Promise<boolean> {
  let mac: Uint8Array
  try {
    mac = fromBase64Url(signature)
  } catch {
    return false
  }
  return crypto.subtle.verify('HMAC', await hmacKey(secret), mac, encoder.encode(value))
}

// AES-GCM with a fresh 12-byte IV per message. Output: base64url(iv || ciphertext).
// `context` is bound as additional data, so a value sealed for one purpose
// (oauth cookie, tokens, a destination) cannot be opened as another.
export type SealContext = 'oauth' | 'tokens' | 'destination'
async function aesKey(base64Key: string): Promise<CryptoKey> {
  const raw = fromBase64(base64Key)
  if (raw.length !== 32) throw new Error('TOKEN_KEY must be 32 bytes, base64-encoded')
  return crypto.subtle.importKey('raw', raw, 'AES-GCM', false, ['encrypt', 'decrypt'])
}

export async function seal(plaintext: string, base64Key: string, context: SealContext): Promise<string> {
  const iv = crypto.getRandomValues(new Uint8Array(12))
  const cipher = await crypto.subtle.encrypt({ name: 'AES-GCM', iv, additionalData: encoder.encode(context) }, await aesKey(base64Key), encoder.encode(plaintext))
  const out = new Uint8Array(iv.length + cipher.byteLength)
  out.set(iv)
  out.set(new Uint8Array(cipher), iv.length)
  return toBase64Url(out)
}

export async function unseal(sealed: string, base64Key: string, context: SealContext): Promise<string> {
  const bytes = fromBase64Url(sealed)
  const iv = bytes.slice(0, 12)
  const plain = await crypto.subtle.decrypt({ name: 'AES-GCM', iv, additionalData: encoder.encode(context) }, await aesKey(base64Key), bytes.slice(12))
  return decoder.decode(plain)
}


const encoder = new TextEncoder()
const decoder = new TextDecoder()
const toB64 = (bytes: Uint8Array) => btoa(String.fromCharCode(...bytes))
const fromB64 = (value: string) => {
  const normalized = value.replaceAll('-', '+').replaceAll('_', '/')
  const padded = normalized + '='.repeat((4 - normalized.length % 4) % 4)
  return Uint8Array.from(atob(padded), c => c.charCodeAt(0))
}
const random = (size: number) => crypto.getRandomValues(new Uint8Array(size))

async function derive(passphrase: string, salt: Uint8Array) {
  const { argon2id } = await import('hash-wasm')
  const raw = await argon2id({ password: passphrase, salt, parallelism: 1, iterations: 3, memorySize: 65536, hashLength: 32, outputType: 'binary' })
  return crypto.subtle.importKey('raw', raw, 'AES-GCM', false, ['encrypt', 'decrypt'])
}

async function encrypt(key: CryptoKey, bytes: Uint8Array) {
  const iv = random(12)
  const data = await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, key, bytes)
  return { iv: toB64(iv), data: toB64(new Uint8Array(data)) }
}

async function decrypt(key: CryptoKey, box: { iv: string; data: string }) {
  return new Uint8Array(await crypto.subtle.decrypt({ name: 'AES-GCM', iv: fromB64(box.iv) }, key, fromB64(box.data)))
}

export async function createVaultKey(passphrase: string) {
  const salt = random(16)
  const wrappingKey = await derive(passphrase, salt)
  const rawKey = random(32)
  const vaultKey = await crypto.subtle.importKey('raw', rawKey, 'AES-GCM', true, ['encrypt', 'decrypt'])
  const wrappedKey = await encrypt(wrappingKey, rawKey)
  rawKey.fill(0)
  return { vaultKey, salt: toB64(salt), wrappedKey }
}

export async function unlockVaultKey(passphrase: string, salt: string, wrappedKey: { iv: string; data: string }) {
  const wrappingKey = await derive(passphrase, fromB64(salt))
  const raw = await decrypt(wrappingKey, wrappedKey)
  return crypto.subtle.importKey('raw', raw, 'AES-GCM', true, ['encrypt', 'decrypt'])
}

export async function seal<T>(key: CryptoKey, value: T) { return encrypt(key, encoder.encode(JSON.stringify(value))) }
export async function unseal<T>(key: CryptoKey, box: { iv: string; data: string }): Promise<T> { return JSON.parse(decoder.decode(await decrypt(key, box))) as T }
export function createInviteSecret() { return toB64(random(32)).replaceAll('+', '-').replaceAll('/', '_').replaceAll('=', '') }
export async function inviteEnvelope(vaultKey: CryptoKey, inviteSecret: string) {
  const secret = fromB64(inviteSecret)
  const key = await crypto.subtle.importKey('raw', secret, 'AES-GCM', false, ['encrypt'])
  const raw = new Uint8Array(await crypto.subtle.exportKey('raw', vaultKey))
  const box = await encrypt(key, raw)
  raw.fill(0)
  return box
}
export async function acceptInvite(passphrase: string, inviteSecret: string, box: { iv: string; data: string }) {
  const rawSecret = fromB64(inviteSecret)
  const inviteKey = await crypto.subtle.importKey('raw', rawSecret, 'AES-GCM', false, ['decrypt'])
  const vaultRaw = await decrypt(inviteKey, box)
  const vaultKey = await crypto.subtle.importKey('raw', vaultRaw, 'AES-GCM', true, ['encrypt', 'decrypt'])
  const wrappingSalt = random(16)
  const wrappingKey = await derive(passphrase, wrappingSalt)
  const wrappedKey = await encrypt(wrappingKey, vaultRaw)
  vaultRaw.fill(0)
  return { vaultKey, salt: toB64(wrappingSalt), wrappedKey }
}

import assert from 'node:assert/strict'
import test from 'node:test'
import { createClient } from '@supabase/supabase-js'
import { createInviteSecret, createVaultKey, inviteEnvelope, seal, unseal, unlockVaultKey } from '../src/crypto.ts'
import { joinVaultInvitation } from '../src/invitations.ts'

// Use the real crypto and Supabase client against an in-memory HTTP boundary.
// This models the member-only vault read; it does not execute Postgres RLS.
const owner = await createVaultKey('owner test passphrase')
const code = createInviteSecret()
const envelope = await inviteEnvelope(owner.vaultKey, code)
const entry = { name: 'Test login', password: 'synthetic-password-only' }
const encryptedEntry = await seal(owner.vaultKey, entry)
const invitation = {
  id: '00000000-0000-4000-8000-000000000001',
  vault_id: '00000000-0000-4000-8000-000000000002',
  email: 'partner@example.com',
  iv: envelope.iv,
  ciphertext: envelope.data,
}
const vault = { id: invitation.vault_id, owner_id: 'owner-user', name: 'Our shared vault' }
const options = {
  invitationId: invitation.id,
  email: 'PARTNER@example.com',
  code,
  passphrase: 'partner test passphrase',
}
type Accepted = Parameters<Parameters<typeof joinVaultInvitation>[2]>[0]
type Behavior = { rpcError?: string; metadataFailure?: boolean; connectionLostAfterCommit?: boolean }

function backend(behavior: Behavior = {}) {
  const events: string[] = []
  const bodies: string[] = []
  let member = false
  let accepted: Accepted | null = null
  let savedEnvelope: { p_salt: string; p_wrapped_key: { iv: string; data: string } } | null = null

  const client = createClient('https://test.supabase.invalid', 'test-public-key', {
    auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false },
    global: {
      fetch: async (input, init) => {
        const url = new URL(input instanceof Request ? input.url : input.toString())
        const table = url.pathname.replace('/rest/v1/', '')
        events.push(table)
        if (table === 'vault_invitations') {
          assert.equal(url.searchParams.get('id'), `eq.${invitation.id}`)
          return Response.json(invitation)
        }
        if (table === 'rpc/accept_vault_invitation') {
          assert.equal(init?.method, 'POST')
          const body = String(init?.body)
          bodies.push(body)
          const payload = JSON.parse(body)
          assert.equal(payload.p_invitation_id, invitation.id)
          assert.deepEqual(Object.keys(payload).sort(), ['p_invitation_id', 'p_salt', 'p_wrapped_key'])
          if (behavior.rpcError) return Response.json({ message: behavior.rpcError }, { status: 400 })
          member = true
          savedEnvelope = payload
          if (behavior.connectionLostAfterCommit) throw new TypeError('Simulated connection loss')
          return new Response(null, { status: 204 })
        }
        if (table === 'vaults') {
          assert.equal(url.searchParams.get('id'), `eq.${invitation.vault_id}`)
          if (!member) return Response.json({ message: 'Vault is restricted to members' }, { status: 403 })
          assert.ok(accepted, 'Client must retain the joined state before requesting metadata')
          if (behavior.metadataFailure) return Response.json({ message: 'Metadata temporarily unavailable' }, { status: 403 })
          return Response.json(vault)
        }
        throw new Error(`Unexpected test request: ${table}`)
      },
    },
  })

  return {
    client,
    events,
    bodies,
    get accepted() { return accepted },
    get member() { return member },
    get savedEnvelope() { return savedEnvelope },
    onAccepted(joined: Accepted) {
      events.push('client-joined')
      accepted = joined
    },
  }
}

test('joins before reading the protected vault and preserves access to existing entries', async () => {
  const api = backend()
  const result = await joinVaultInvitation(api.client, options, api.onAccepted)

  assert.deepEqual(api.events, ['vault_invitations', 'rpc/accept_vault_invitation', 'client-joined', 'vaults'])
  assert.deepEqual(result.vault, vault)
  assert.equal(result.notice, '')
  assert.ok(api.accepted)
  assert.equal(api.accepted.vaultId, invitation.vault_id)
  assert.deepEqual(await unseal(api.accepted.vaultKey, encryptedEntry), entry)

  // Simulate a later unlock using the recipient's stored, independently wrapped key.
  assert.ok(api.savedEnvelope)
  const keyAfterReload = await unlockVaultKey(options.passphrase, api.savedEnvelope.p_salt, api.savedEnvelope.p_wrapped_key)
  assert.deepEqual(await unseal(keyAfterReload, encryptedEntry), entry)
  for (const body of api.bodies) {
    assert.equal(body.includes(code), false, 'Vault code must remain in the browser')
    assert.equal(body.includes(options.passphrase), false, 'Unlock passphrase must remain in the browser')
    assert.equal(body.includes(entry.password), false, 'Entry plaintext must remain in the browser')
  }
})

test('a wrong vault code cannot consume the invitation or read the vault', async () => {
  const api = backend()
  await assert.rejects(
    joinVaultInvitation(api.client, { ...options, code: createInviteSecret() }, api.onAccepted),
    /vault code could not unlock/,
  )
  assert.deepEqual(api.events, ['vault_invitations'])
  assert.equal(api.member, false)
  assert.equal(api.accepted, null)
})

test('a different signed-in email cannot join or read the protected vault', async () => {
  const api = backend()
  await assert.rejects(
    joinVaultInvitation(api.client, { ...options, email: 'someone-else@example.com' }, api.onAccepted),
    /Sign in with the email address/,
  )
  assert.deepEqual(api.events, ['vault_invitations'])
  assert.equal(api.accepted, null)
})

test('a rejected acceptance never marks the client joined or requests vault metadata', async () => {
  const api = backend({ rpcError: 'This vault already has two members' })
  await assert.rejects(joinVaultInvitation(api.client, options, api.onAccepted), /already has two members/)
  assert.deepEqual(api.events, ['vault_invitations', 'rpc/accept_vault_invitation'])
  assert.equal(api.member, false)
  assert.equal(api.accepted, null)
})

test('metadata failure after acceptance retains membership and the working vault key', async () => {
  const api = backend({ metadataFailure: true })
  const result = await joinVaultInvitation(api.client, options, api.onAccepted)

  assert.equal(result.vault, null)
  assert.match(result.notice, /Your membership is saved/)
  assert.deepEqual(api.events, ['vault_invitations', 'rpc/accept_vault_invitation', 'client-joined', 'vaults'])
  assert.equal(api.member, true)
  assert.ok(api.accepted)
  assert.deepEqual(await unseal(api.accepted.vaultKey, encryptedEntry), entry)
})

test('an ambiguous acceptance connection failure advises refresh instead of assuming a failed join', async () => {
  const api = backend({ connectionLostAfterCommit: true })
  await assert.rejects(joinVaultInvitation(api.client, options, api.onAccepted), /Refresh the page to check/)
  assert.equal(api.member, true)
  assert.equal(api.accepted, null)
  assert.equal(api.events.includes('vaults'), false)
})

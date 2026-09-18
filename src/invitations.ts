import type { SupabaseClient } from '@supabase/supabase-js'
import { acceptInvite } from './crypto.ts'

type Vault = { id: string; owner_id: string; name: string }
type JoinedInvitation = Awaited<ReturnType<typeof acceptInvite>> & { vaultId: string }
type JoinOptions = { invitationId: string; email: string; code: string; passphrase: string }

const metadataNotice = 'You joined the vault, but its details could not be loaded. Your membership is saved; refresh the page if needed.'

export async function joinVaultInvitation(
  client: SupabaseClient,
  options: JoinOptions,
  onAccepted: (joined: JoinedInvitation) => void,
): Promise<{ vault: Vault | null; notice: string }> {
  if (options.passphrase.length < 12) {
    throw new Error('Choose an unlock passphrase with at least 12 characters.')
  }

  const { data: invitation, error: invitationError } = await client
    .from('vault_invitations')
    .select('id,vault_id,email,iv,ciphertext')
    .eq('id', options.invitationId)
    .single()
  if (invitationError) throw new Error(invitationError.message)
  if (!invitation) throw new Error('This invitation is unavailable. Ask your partner for a new invitation.')
  if (invitation.email.toLowerCase() !== options.email.toLowerCase()) {
    throw new Error('Sign in with the email address this invitation was sent to.')
  }

  let result: Awaited<ReturnType<typeof acceptInvite>>
  try {
    result = await acceptInvite(options.passphrase, options.code.trim(), {
      iv: invitation.iv,
      data: invitation.ciphertext,
    })
  } catch {
    throw new Error('That vault code could not unlock this invitation. Use the code that belongs to this invite.')
  }

  const { error: memberError, status } = await client.rpc('accept_vault_invitation', {
    p_invitation_id: options.invitationId,
    p_salt: result.salt,
    p_wrapped_key: result.wrappedKey,
  })
  if (memberError) {
    if (status === 0) {
      throw new Error('Could not confirm whether you joined the vault. Refresh the page to check before trying again.')
    }
    throw new Error(memberError.message)
  }

  // The RPC consumes the invitation. Commit the joined state before any optional
  // metadata request, so a later network failure cannot strand a joined member.
  onAccepted({ ...result, vaultId: invitation.vault_id })

  // RLS permits this read only after the acceptance RPC creates membership.
  try {
    const { data: vault, error: vaultError } = await client
      .from('vaults')
      .select('id,owner_id,name')
      .eq('id', invitation.vault_id)
      .single()
    if (vaultError || !vault) return { vault: null, notice: metadataNotice }
    return { vault: vault as Vault, notice: '' }
  } catch {
    return { vault: null, notice: metadataNotice }
  }
}

import { createClient } from 'https://esm.sh/@supabase/supabase-js@2'

const cors = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
}

Deno.serve(async (request: Request) => {
  if (request.method === 'OPTIONS') return new Response('ok', { headers: cors })
  if (request.method !== 'POST') return Response.json({ error: 'Method not allowed' }, { status: 405, headers: cors })
  const url = Deno.env.get('SUPABASE_URL')!
  const publishableKeys = JSON.parse(Deno.env.get('SUPABASE_PUBLISHABLE_KEYS')!) as Record<string, string>
  const secretKeys = JSON.parse(Deno.env.get('SUPABASE_SECRET_KEYS')!) as Record<string, string>
  const siteUrl = Deno.env.get('SITE_URL')
  if (!siteUrl) return Response.json({ error: 'SITE_URL is not configured.' }, { status: 500, headers: cors })
  const authHeader = request.headers.get('Authorization')
  if (!authHeader) return Response.json({ error: 'Sign in first.' }, { status: 401, headers: cors })

  const userClient = createClient(url, publishableKeys.default, { global: { headers: { Authorization: authHeader } }, auth: { persistSession: false } })
  const adminClient = createClient(url, secretKeys.default, { auth: { persistSession: false } })
  const { data: { user }, error: authError } = await userClient.auth.getUser()
  if (authError || !user) return Response.json({ error: 'Your session is not valid.' }, { status: 401, headers: cors })

  let body: { email?: string; vault_id?: string; iv?: string; ciphertext?: string }
  try { body = await request.json() } catch { return Response.json({ error: 'Invalid request.' }, { status: 400, headers: cors }) }
  const email = body.email?.trim().toLowerCase()
  if (!email || !body.vault_id || !body.iv || !body.ciphertext) {
    return Response.json({ error: 'Invitation details are incomplete.' }, { status: 400, headers: cors })
  }

  const { data: invitationId, error: insertError } = await userClient.rpc('create_vault_invitation', {
    p_vault_id: body.vault_id,
    p_email: email,
    p_iv: body.iv,
    p_ciphertext: body.ciphertext,
  })
  if (insertError || !invitationId) return Response.json({ error: insertError?.message ?? 'Could not create invitation.' }, { status: 400, headers: cors })

  // The URL carries only a non-secret invitation id. The one-time code is transferred separately.
  const redirectTo = `${siteUrl.replace(/\/$/, '')}/?invite=${invitationId}`
  const { error: emailError } = await adminClient.auth.admin.inviteUserByEmail(email, { redirectTo })
  if (emailError) {
    return Response.json({ invitation_id: invitationId, email_sent: false, email_error: emailError.message }, { headers: cors })
  }
  return Response.json({ invitation_id: invitationId, email_sent: true }, { headers: cors })
})

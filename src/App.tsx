import { useEffect, useMemo, useState } from 'react'
import type { FormEvent } from 'react'
import { ArrowDown, ArrowLeft, ArrowRight, Check, Copy, Eye, EyeOff, KeyRound, LockKeyhole, LogOut, Plus, Search, ShieldCheck, Trash2, X } from 'lucide-react'
import type { Session } from '@supabase/supabase-js'
import { acceptInvite, createInviteSecret, createVaultKey, inviteEnvelope, seal, unseal, unlockVaultKey } from './crypto'
import { configured, supabase } from './supabase'

type Entry = { id: string; name: string; username: string; password: string; email: string; description: string }
type Box = { iv: string; data: string }
type Membership = { vault_id: string; salt: string; wrapped_key: Box; is_owner: boolean }
type Vault = { id: string; owner_id: string; name: string }
const empty = { name: '', username: '', password: '', email: '', description: '' }
const messageFor = (error: unknown) => error instanceof Error ? error.message : 'Something went wrong. Please try again.'

export default function App() {
  const [session, setSession] = useState<Session | null>(null)
  const [loading, setLoading] = useState(true)
  const [membership, setMembership] = useState<Membership | null>(null)
  const [vault, setVault] = useState<Vault | null>(null)
  const [key, setKey] = useState<CryptoKey | null>(null)
  const [entries, setEntries] = useState<Entry[]>([])
  const [authMode, setAuthMode] = useState<'signin' | 'signup'>('signup')
  const [authEmail, setAuthEmail] = useState('')
  const [authPassword, setAuthPassword] = useState('')
  const [passphrase, setPassphrase] = useState('')
  const [search, setSearch] = useState('')
  const [selected, setSelected] = useState<Entry | null>(null)
  const [editing, setEditing] = useState(false)
  const [draft, setDraft] = useState(empty)
  const [error, setError] = useState('')
  const [notice, setNotice] = useState('')
  const [busy, setBusy] = useState(false)
  const [inviteEmail, setInviteEmail] = useState('')
  const [inviteLink, setInviteLink] = useState('')
  const [inviteCode, setInviteCode] = useState('')
  const [reveal, setReveal] = useState(false)
  const [tab, setTab] = useState<'all' | 'favorites'>('all')
  const [favorites, setFavorites] = useState<string[]>([])

  useEffect(() => {
    if (!supabase) { setLoading(false); return }
    void supabase.auth.getSession().then(({ data }) => { setSession(data.session); setLoading(false) })
    const { data: listener } = supabase.auth.onAuthStateChange((event, next) => {
      setSession(next)
      if (event === 'SIGNED_OUT') { setKey(null); setEntries([]); setSelected(null); setEditing(false); setDraft(empty); setPassphrase(''); setInviteCode(''); setFavorites([]) }
    })
    return () => listener.subscription.unsubscribe()
  }, [])

  useEffect(() => {
    if (!supabase || !session) { setMembership(null); setVault(null); return }
    let active = true
    void (async () => {
      const { data, error: queryError } = await supabase.from('vault_members').select('vault_id,salt,wrapped_key,is_owner').eq('user_id', session.user.id).maybeSingle()
      if (!active) return
      if (queryError) { setError(queryError.message); return }
      if (data) {
        setMembership(data as Membership)
        const { data: v, error: vError } = await supabase.from('vaults').select('id,owner_id,name').eq('id', data.vault_id).single()
        if (!active) return
        if (vError) setError(vError.message); else setVault(v as Vault)
      } else { setMembership(null); setVault(null) }
    })()
    return () => { active = false }
  }, [session])

  useEffect(() => {
    if (!supabase || !membership || !key) return
    const client = supabase
    let active = true
    void (async () => {
      const { data, error: fetchError } = await supabase.from('vault_entries').select('id,iv,ciphertext,updated_at').eq('vault_id', membership.vault_id).order('updated_at', { ascending: false })
      if (!active) return
      if (fetchError) { setError(fetchError.message); return }
      try {
        const result = await Promise.all((data ?? []).map(async row => ({ id: row.id as string, ...await unseal<Omit<Entry, 'id'>>(key, { iv: row.iv, data: row.ciphertext }) })))
        if (active) setEntries(result)
      } catch { setError('Could not decrypt vault data. Check your unlock passphrase.') }
    })()
    const channel = supabase.channel(`vault-${membership.vault_id}`).on('postgres_changes', { event: '*', schema: 'public', table: 'vault_entries', filter: `vault_id=eq.${membership.vault_id}` }, () => {
      void client.from('vault_entries').select('id,iv,ciphertext,updated_at').eq('vault_id', membership.vault_id).order('updated_at', { ascending: false }).then(async ({ data }) => {
        if (!active || !data) return
        try { setEntries(await Promise.all(data.map(async row => ({ id: row.id as string, ...await unseal<Omit<Entry, 'id'>>(key, { iv: row.iv, data: row.ciphertext }) })))) } catch { setError('A vault update could not be decrypted.') }
      })
    }).subscribe()
    return () => { active = false; void client.removeChannel(channel) }
  }, [membership, key])

  useEffect(() => {
    const lock = () => { setKey(null); setEntries([]); setSelected(null); setEditing(false); setDraft(empty); setPassphrase('') }
    const onVisibility = () => { if (document.hidden) lock() }
    document.addEventListener('visibilitychange', onVisibility)
    return () => document.removeEventListener('visibilitychange', onVisibility)
  }, [])

  const filtered = useMemo(() => entries.filter(e => (tab === 'all' || favorites.includes(e.id)) && `${e.name} ${e.username} ${e.email} ${e.description}`.toLowerCase().includes(search.toLowerCase())), [entries, search, tab, favorites])

  async function authenticate(event: FormEvent) {
    event.preventDefault(); setError(''); setBusy(true)
    try {
      if (!supabase) throw new Error('Supabase is not configured yet. Add the project URL and publishable key to .env.local.')
      const inviteId = new URLSearchParams(location.search).get('invite')
      const result = authMode === 'signup' ? await supabase.auth.signUp({ email: authEmail, password: authPassword, options: inviteId ? { emailRedirectTo: `${location.origin}/?invite=${inviteId}` } : undefined }) : await supabase.auth.signInWithPassword({ email: authEmail, password: authPassword })
      if (result.error) throw result.error
      if (authMode === 'signup' && !result.data.session) setNotice('Check your email to confirm your account, then sign in.')
    } catch (e) { setError(messageFor(e)) } finally { setBusy(false) }
  }

  async function makeVault(event: FormEvent) {
    event.preventDefault(); setError(''); setBusy(true)
    try {
      if (!supabase || !session) throw new Error('Please sign in again.')
      if (passphrase.length < 12) throw new Error('Choose an unlock passphrase with at least 12 characters.')
      const result = await createVaultKey(passphrase)
      const { data: vaultId, error: vError } = await supabase.rpc('create_vault', { p_name: 'Our shared vault', p_salt: result.salt, p_wrapped_key: result.wrappedKey })
      if (vError) throw vError
      const v = { id: vaultId as string, owner_id: session.user.id, name: 'Our shared vault' }
      setVault(v as Vault); setMembership({ vault_id: v.id, salt: result.salt, wrapped_key: result.wrappedKey, is_owner: true }); setKey(result.vaultKey); setPassphrase('')
    } catch (e) { setError(messageFor(e)) } finally { setBusy(false) }
  }

  async function unlock(event: FormEvent) {
    event.preventDefault(); setError(''); setBusy(true)
    try {
      if (!membership) throw new Error('No vault membership found.')
      const vaultKey = await unlockVaultKey(passphrase, membership.salt, membership.wrapped_key)
      setKey(vaultKey); setPassphrase('')
    } catch { setError('That passphrase did not unlock the vault. Try again.') } finally { setBusy(false) }
  }

  async function saveEntry(event: FormEvent) {
    event.preventDefault(); setError('')
    if (!supabase || !membership || !key || !draft.name.trim()) return
    setBusy(true)
    try {
      const box = await seal(key, { ...draft, name: draft.name.trim() })
      if (selected && editing) {
        const { error: updateError } = await supabase.from('vault_entries').update({ iv: box.iv, ciphertext: box.data }).eq('id', selected.id).eq('vault_id', membership.vault_id)
        if (updateError) throw updateError
      } else {
        const { error: insertError } = await supabase.from('vault_entries').insert({ vault_id: membership.vault_id, iv: box.iv, ciphertext: box.data })
        if (insertError) throw insertError
      }
      setSelected(null); setEditing(false); setDraft(empty)
      const { data } = await supabase.from('vault_entries').select('id,iv,ciphertext').eq('vault_id', membership.vault_id)
      if (data) setEntries(await Promise.all(data.map(async row => ({ id: row.id as string, ...await unseal<Omit<Entry, 'id'>>(key, { iv: row.iv, data: row.ciphertext }) }))))
    } catch (e) { setError(messageFor(e)) } finally { setBusy(false) }
  }

  async function deleteEntry(entry: Entry) {
    if (!supabase || !membership || !window.confirm(`Delete ${entry.name}? This cannot be undone.`)) return
    const { error: deleteError } = await supabase.from('vault_entries').delete().eq('id', entry.id).eq('vault_id', membership.vault_id)
    if (deleteError) setError(deleteError.message); else { setEntries(items => items.filter(i => i.id !== entry.id)); setSelected(null) }
  }

  async function invite(event: FormEvent) {
    event.preventDefault(); setError(''); setBusy(true)
    try {
      if (!supabase || !session || !vault || !key) throw new Error('Unlock your vault first.')
      const secret = createInviteSecret()
      const box = await inviteEnvelope(key, secret)
      const { data: sent, error: sendError } = await supabase.functions.invoke('invite-partner', { body: { vault_id: vault.id, email: inviteEmail.trim().toLowerCase(), iv: box.iv, ciphertext: box.data } })
      if (sendError) throw sendError
      const link = `${location.origin}/?invite=${sent.invitation_id}`
      setInviteLink(link); setInviteCode(secret); setNotice(sent.email_sent ? `An invitation email was sent to ${inviteEmail.trim()}. Send the one-time vault code separately.` : `Email delivery did not complete. Share the account invite link and one-time vault code directly with ${inviteEmail.trim()}.`)
    } catch (e) { setError(messageFor(e)) } finally { setBusy(false) }
  }

  async function claimInvite() {
    const token = new URLSearchParams(location.search).get('invite')
    if (!token || !supabase || !session) return
    const [id, urlSecret] = token.split('.')
    const secret = urlSecret || inviteCode.trim()
    if (!id || !secret) { setError('This invitation link is invalid.'); return }
    setBusy(true); setError('')
    try {
      const { data: invitation, error: invitationError } = await supabase.from('vault_invitations').select('id,vault_id,email,iv,ciphertext').eq('id', id).single()
      if (invitationError) throw invitationError
      if (invitation.email.toLowerCase() !== session.user.email?.toLowerCase()) throw new Error('Sign in with the email address this invitation was sent to.')
      const { data: v } = await supabase.from('vaults').select('id,owner_id,name').eq('id', invitation.vault_id).single()
      if (!v) throw new Error('The invited vault is unavailable.')
      const result = await acceptInvite(passphrase, secret, { iv: invitation.iv, data: invitation.ciphertext })
      const { error: memberError } = await supabase.rpc('accept_vault_invitation', { p_invitation_id: id, p_salt: result.salt, p_wrapped_key: result.wrappedKey })
      if (memberError) throw memberError
      setMembership({ vault_id: invitation.vault_id, salt: result.salt, wrapped_key: result.wrappedKey, is_owner: false }); setVault(v as Vault); setKey(result.vaultKey); setPassphrase(''); setInviteCode(''); history.replaceState({}, '', '/')
    } catch (e) { setError(messageFor(e)) } finally { setBusy(false) }
  }

  if (loading) return <div className="loading-screen"><div className="brand-mark"><KeyRound size={19}/></div><span>Opening your vault…</span></div>
  if (!configured) return <main className="setup-screen"><div className="setup-card"><div className="brand-mark"><KeyRound size={20}/></div><p className="eyebrow">A LITTLE MORE PEACE OF MIND</p><h1>Welcome to Hearth.</h1><p className="muted">Add your Supabase project credentials to get your shared vault ready.</p><pre>VITE_SUPABASE_URL=…<br/>VITE_SUPABASE_PUBLISHABLE_KEY=…</pre><p className="muted">Add these to <code>.env.local</code> in the project root, then restart the app. An older <code>VITE_SUPABASE_ANON_KEY</code> also works.</p></div></main>
  if (!session) return <main className="auth-screen"><div className="auth-card"><Brand/><p className="eyebrow">YOUR HOME, IN SYNC</p><h1>{authMode === 'signup' ? 'A safer place for your shared logins.' : 'Welcome back.'}</h1><p className="muted">Private by design. Only you and your partner can unlock what’s inside.</p><form onSubmit={authenticate} className="stack"><label>Email<input type="email" autoComplete="email" required value={authEmail} onChange={e => setAuthEmail(e.target.value)} placeholder="you@example.com"/></label><label>Account password<input type="password" autoComplete={authMode === 'signup' ? 'new-password' : 'current-password'} required minLength={authMode === 'signup' ? 12 : undefined} value={authPassword} onChange={e => setAuthPassword(e.target.value)} placeholder="At least 12 characters"/></label><button className="primary full" disabled={busy}>{busy ? 'Please wait…' : authMode === 'signup' ? 'Create account' : 'Sign in'} <ArrowRight size={16}/></button></form><p className="switch-auth">{authMode === 'signup' ? 'Already have an account?' : 'New to Hearth?'} <button onClick={() => { setAuthMode(authMode === 'signup' ? 'signin' : 'signup'); setError('') }}>{authMode === 'signup' ? 'Sign in' : 'Create one'}</button></p><Feedback error={error} notice={notice}/><p className="footnote"><LockKeyhole size={13}/> Your account password never encrypts the vault.</p></div></main>
  if (!membership) return <main className="auth-screen"><div className="auth-card"><Brand/><p className="eyebrow">LET’S GET YOU SET UP</p><h1>{new URLSearchParams(location.search).has('invite') ? 'Join your shared vault.' : 'Create your shared vault.'}</h1><p className="muted">Pick a private unlock passphrase. Keep it somewhere safe; we can’t reset it for you.</p><form onSubmit={new URLSearchParams(location.search).has('invite') ? e => { e.preventDefault(); void claimInvite() } : makeVault} className="stack">{new URLSearchParams(location.search).has('invite') && <label>One-time vault code<input autoComplete="off" required value={inviteCode} onChange={e => setInviteCode(e.target.value)} placeholder="Paste the code your partner sent separately"/></label>}<label>Vault unlock passphrase<input type="password" autoComplete="new-password" minLength={12} required value={passphrase} onChange={e => setPassphrase(e.target.value)} placeholder="At least 12 characters"/></label><p className="field-hint">Use 12 or more characters. Your partner chooses their own passphrase when they accept your invite.</p>{new URLSearchParams(location.search).has('invite') && <p className="field-hint">Signed in as {session.user.email}. The invitation link and vault code are separate for security.</p>}<button className="primary full" disabled={busy}>{busy ? 'Preparing…' : 'Continue'} <ArrowRight size={16}/></button></form><Feedback error={error} notice={notice}/><button className="text-button" onClick={() => void supabase?.auth.signOut()}>Sign out</button></div></main>
  if (!key) return <main className="auth-screen"><div className="auth-card"><Brand/><p className="eyebrow">VAULT LOCKED</p><h1>Good to see you.</h1><p className="muted">Enter your personal vault passphrase to decrypt your shared logins on this device.</p><form onSubmit={unlock} className="stack"><label>Vault unlock passphrase<input type="password" autoFocus autoComplete="current-password" required value={passphrase} onChange={e => setPassphrase(e.target.value)} placeholder="Your vault passphrase"/></label><button className="primary full" disabled={busy}>{busy ? 'Unlocking…' : 'Unlock vault'} <ArrowRight size={16}/></button></form><Feedback error={error} notice={notice}/><button className="text-button" onClick={() => void supabase?.auth.signOut()}>Sign out</button></div></main>

  return <div className="app-shell"><aside className="sidebar"><Brand/><div className="workspace"><div className="avatar avatar-pair">{(session.user.email?.[0] ?? 'H').toUpperCase()}</div><div><strong>Our home</strong><small>Shared space</small></div><ArrowDown size={14}/></div><div className="nav-label">YOUR VAULT</div><button className={`nav-item ${tab === 'all' ? 'active' : ''}`} onClick={() => setTab('all')}><KeyRound size={17}/> All items <span>{entries.length}</span></button><button className={`nav-item ${tab === 'favorites' ? 'active' : ''}`} onClick={() => setTab('favorites')}><span className="star">✳</span> Favorites <span>{favorites.length}</span></button><div className="sidebar-bottom"><div className="security-note"><ShieldCheck size={17}/><div><strong>Encrypted here</strong><small>Only you two can read your data.</small></div></div><div className="profile"><div className="avatar">{(session.user.email?.[0] ?? 'Y').toUpperCase()}</div><div className="profile-name"><strong>{session.user.email}</strong><small>{membership.is_owner ? 'Vault owner' : 'Vault member'}</small></div><button className="icon-button" aria-label="Lock vault" title="Lock vault" onClick={() => { setKey(null); setEntries([]); setSelected(null); setEditing(false); setDraft(empty); setPassphrase('') }}><LockKeyhole size={16}/></button><button className="icon-button" aria-label="Sign out" title="Sign out" onClick={() => void supabase?.auth.signOut()}><LogOut size={16}/></button></div></div></aside>
    <main className="main"><header className="topbar"><div className="crumb">Shared space <span>/</span> <strong>{tab === 'all' ? 'All items' : 'Favorites'}</strong></div><div className="top-actions"><div className="member-stack"><div className="avatar mini">{(session.user.email?.[0] ?? 'Y').toUpperCase()}</div><div className="avatar mini second">{membership.is_owner ? '+' : '✓'}</div></div><button className="invite-button" onClick={() => document.getElementById('partner-email')?.focus()}><Plus size={15}/> Invite partner</button></div></header><section className="content"><div className="welcome-row"><div><p className="eyebrow">A LITTLE MORE PEACE OF MIND</p><h1>Our passwords</h1><p className="muted">A home for the logins you share, kept private between you two.</p></div><button className="primary add-main" onClick={() => { setSelected(null); setEditing(true); setDraft(empty) }}><Plus size={17}/> Add an item</button></div><div className="toolbar"><div className="search"><Search size={17}/><input placeholder="Search your vault…" value={search} onChange={e => setSearch(e.target.value)}/><kbd>⌘ K</kbd></div><div className="item-count">{filtered.length} {filtered.length === 1 ? 'item' : 'items'}</div></div>
      <div className="entry-list">{filtered.map(entry => <button className="entry-card" key={entry.id} onClick={() => { setSelected(entry); setDraft(entry); setEditing(false); setReveal(false) }}><div className="entry-icon">{entry.name.slice(0,1).toUpperCase()}</div><div className="entry-info"><strong>{entry.name}</strong><span>{entry.username || entry.email || 'No username added'}</span></div><span className="entry-kind">Login</span><ArrowRight className="entry-arrow" size={17}/></button>)}</div>
      {!filtered.length && <div className="empty-state"><div className="empty-illustration"><div className="empty-card one"></div><div className="empty-card two"><KeyRound size={23}/></div><div className="empty-card three"></div></div><h2>{search ? 'No matches found' : tab === 'favorites' ? 'No favorites yet' : 'Start your shared vault'}</h2><p>{search ? 'Try another search term.' : 'Add the logins you both use and keep them together in one secure place.'}</p>{!search && tab === 'all' && <button className="primary" onClick={() => { setSelected(null); setEditing(true); setDraft(empty) }}><Plus size={16}/> Add your first item</button>}</div>}
      {membership.is_owner && <div className="invite-inline"><div className="invite-icon"><ArrowRight size={18}/></div><div><strong>Sharing makes home easier.</strong><p>Invite your partner so you can both access this vault.</p></div><form onSubmit={invite}><input id="partner-email" type="email" required value={inviteEmail} onChange={e => setInviteEmail(e.target.value)} placeholder="partner@example.com"/><button className="secondary" disabled={busy}>Create invite</button></form></div>}
    </section></main>
    {(selected || editing) && <div className="modal-backdrop" onMouseDown={e => { if (e.target === e.currentTarget) { setSelected(null); setEditing(false); setDraft(empty); setReveal(false) } }}><section className="modal"><header className="modal-header"><button className="icon-button" onClick={() => { setSelected(null); setEditing(false); setDraft(empty); setReveal(false) }} aria-label="Close"><ArrowLeft size={18}/></button><div><p className="eyebrow">SHARED LOGIN</p><h2>{editing ? selected ? 'Edit item' : 'Add an item' : selected?.name}</h2></div><button className="icon-button close-button" onClick={() => { setSelected(null); setEditing(false); setDraft(empty); setReveal(false) }} aria-label="Close"><X size={18}/></button></header>{editing ? <form onSubmit={saveEntry} className="entry-form"><label>Name<input autoFocus required value={draft.name} onChange={e => setDraft({ ...draft, name: e.target.value })} placeholder="e.g. Streaming service"/></label><div className="two-fields"><label>Username<input autoComplete="off" value={draft.username} onChange={e => setDraft({ ...draft, username: e.target.value })} placeholder="Username"/></label><label>Email<input type="email" autoComplete="off" value={draft.email} onChange={e => setDraft({ ...draft, email: e.target.value })} placeholder="Email address"/></label></div><label>Password<div className="password-wrap"><input type={reveal ? 'text' : 'password'} autoComplete="new-password" value={draft.password} onChange={e => setDraft({ ...draft, password: e.target.value })} placeholder="Password"/><button type="button" className="icon-button" onClick={() => setReveal(!reveal)} aria-label={reveal ? 'Hide password' : 'Show password'}>{reveal ? <EyeOff size={16}/> : <Eye size={16}/>}</button></div></label><label>Description <span className="optional">OPTIONAL</span><textarea rows={3} value={draft.description} onChange={e => setDraft({ ...draft, description: e.target.value })} placeholder="Add a note to help you remember"/></label><Feedback error={error} notice={notice}/><div className="form-actions"><button type="button" className="secondary" onClick={() => { setSelected(null); setEditing(false); setDraft(empty); setReveal(false) }}>Cancel</button><button className="primary" disabled={busy}>{busy ? 'Saving…' : <><Check size={16}/> Save item</>}</button></div></form> : <div className="detail-content"><div className="detail-logo">{selected?.name.slice(0,1).toUpperCase()}</div><div className="detail-fields">{[['Username', selected?.username], ['Email', selected?.email], ['Password', reveal ? selected?.password : selected?.password ? '••••••••••••' : ''], ['Description', selected?.description]].filter(([, value]) => value) .map(([label, value]) => <div className="detail-field" key={label as string}><span>{label}</span><div><strong>{label === 'Password' && !reveal ? '••••••••••••' : value}</strong><button className="icon-button" aria-label={label === 'Password' ? 'Show password' : `Copy ${label}`} onClick={() => { if (label === 'Password') setReveal(!reveal); else if (value) void navigator.clipboard.writeText(value as string).then(() => setNotice(`${label} copied.`)) }}><Copy size={15}/></button></div></div>)}</div><div className="form-actions detail-actions"><button className="text-button danger" onClick={() => selected && void deleteEntry(selected)}><Trash2 size={15}/> Delete</button><button className="secondary" onClick={() => { if (selected) setFavorites(f => f.includes(selected.id) ? f.filter(x => x !== selected.id) : [...f, selected.id]) }}>{favorites.includes(selected?.id ?? '') ? 'Remove favorite' : 'Add to favorites'}</button><button className="primary" onClick={() => { if (selected) setDraft(selected); setEditing(true) }}>Edit item</button></div></div>}</section></div>}
    {inviteLink && <div className="modal-backdrop" onMouseDown={e => { if (e.target === e.currentTarget) { setInviteLink(''); setInviteCode('') } }}><section className="modal invite-modal"><header className="modal-header"><div><p className="eyebrow">ONE-TIME INVITE</p><h2>Finish sharing securely</h2></div><button className="icon-button" onClick={() => { setInviteLink(''); setInviteCode('') }} aria-label="Close"><X size={18}/></button></header><p className="muted">Use the account link to open the app and sign in. Send the code separately through a private channel; the server never receives it.</p><div className="invite-link"><input readOnly value={inviteLink}/><button className="secondary" onClick={() => void navigator.clipboard.writeText(inviteLink).then(() => setNotice('Account invite link copied.'))}><Copy size={15}/> Copy</button></div><label className="code-label">One-time vault code</label><div className="invite-link"><input readOnly value={inviteCode}/><button className="secondary" onClick={() => void navigator.clipboard.writeText(inviteCode).then(() => setNotice('Vault code copied. Send it separately.'))}><Copy size={15}/> Copy</button></div><button className="primary full" onClick={() => { setInviteLink(''); setInviteCode('') }}>Done</button></section></div>}
    <div className="toast-area"><Feedback error={error} notice={notice}/></div>
  </div>
}

function Brand() { return <div className="brand"><div className="brand-mark"><KeyRound size={18}/></div><span>hearth</span></div> }
function Feedback({ error, notice }: { error: string; notice: string }) { return <>{error && <div className="feedback error-text">{error}</div>}{notice && <div className="feedback notice-text">{notice}</div>}</> }

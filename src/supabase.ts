import { createClient } from '@supabase/supabase-js'

const url = import.meta.env.VITE_SUPABASE_URL
const publishableKey = import.meta.env.VITE_SUPABASE_PUBLISHABLE_KEY || import.meta.env.VITE_SUPABASE_ANON_KEY
export const configured = Boolean(url && publishableKey)
export const supabase = configured ? createClient(url, publishableKey, { auth: { persistSession: true, autoRefreshToken: true } }) : null

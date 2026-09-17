# Hearth

A small, client-encrypted shared password vault for two people. The browser encrypts every entry with AES-256-GCM. Each member has their own unlock passphrase; Argon2id derives a wrapping key that protects the shared vault key. Supabase stores ciphertext, encrypted key envelopes, and account metadata.

## Local setup

1. Create a Supabase project and configure Auth email delivery.
2. Copy `.env.example` to `.env` and set `VITE_SUPABASE_URL` and `VITE_SUPABASE_PUBLISHABLE_KEY` from your project's Connect dialog.
3. Apply `supabase/migrations/202609160001_shared_vault.sql` in the Supabase SQL editor (or with Supabase CLI).
4. Deploy `supabase/functions/invite-partner` and set its `SITE_URL` secret to the app origin. The function uses Supabase's default publishable and secret keys from its runtime environment; the secret key stays server-side.
5. In Supabase Auth, configure the site URL and redirect URLs for the app. Email confirmation and delivery are controlled by Supabase Auth settings.
6. Install dependencies with `npm install` and start with `npm run dev`.

Create an account and choose a separate vault unlock passphrase of at least 12 characters. Once the vault is unlocked, enter your partner's email under "Sharing makes home easier." The function emails an account invitation when Supabase email delivery is configured. The app also gives you a non-secret invite link and a one-time vault code. Send the code separately through a private channel. The code is generated and kept in the browser, so it is never sent to Supabase or included in the email link. The second person creates their own account and their own unlock passphrase.

## Security notes

- The Supabase anon key is intended to be public. Never put a service-role key in the browser or commit `.env`.
- Entry names, usernames, passwords, emails, descriptions, and the shared vault key are encrypted before database writes. Vault IDs, membership, invitation email addresses, timestamps, and encrypted envelope sizes remain visible to Supabase.
- If a member forgets their unlock passphrase, their wrapped vault key cannot be recovered. Member removal and re-invitation controls are not part of this first version.
- The one-time vault code is a bearer secret. Send it separately to the intended recipient; the email invite link alone cannot decrypt the vault key.
- Deploy only over HTTPS. Add a restrictive Content Security Policy at the hosting layer before production; do not enable third-party analytics on decrypted vault screens.

## Current limitations

The invitation row and database constraints enforce one vault per account and at most two members. Account password reset does not reset the separate vault passphrase. Automatic clipboard clearing and trusted-device persistence are not implemented.

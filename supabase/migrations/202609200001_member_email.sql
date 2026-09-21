alter table public.vault_members add column if not exists email text;

update public.vault_members m
set email = u.email
from auth.users u
where m.user_id = u.id and m.email is null;

create or replace function public.create_vault(p_name text, p_salt text, p_wrapped_key jsonb)
returns uuid language plpgsql security definer set search_path = '' as $$
declare new_id uuid;
begin
  if auth.uid() is null then raise exception 'Authentication required'; end if;
  if exists(select 1 from public.vault_members where user_id = auth.uid()) then raise exception 'Account already belongs to a vault'; end if;
  insert into public.vaults(owner_id, name) values(auth.uid(), coalesce(nullif(p_name, ''), 'Our shared vault')) returning id into new_id;
  insert into public.vault_members(vault_id, user_id, email, salt, wrapped_key, is_owner) values(new_id, auth.uid(), lower(auth.jwt() ->> 'email'), p_salt, p_wrapped_key, true);
  return new_id;
end
$$;

create or replace function public.accept_vault_invitation(p_invitation_id uuid, p_salt text, p_wrapped_key jsonb)
returns void language plpgsql security definer set search_path = '' as $$
declare invite public.vault_invitations%rowtype; current_email text;
begin
  if auth.uid() is null then raise exception 'Authentication required'; end if;
  current_email := lower(coalesce(auth.jwt() ->> 'email', ''));
  select * into invite from public.vault_invitations where id = p_invitation_id;
  if invite.id is null then raise exception 'Invitation is invalid or expired'; end if;
  if invite.expires_at <= now() then delete from public.vault_invitations where id = invite.id; raise exception 'Invitation has expired'; end if;
  if lower(invite.email) <> current_email then raise exception 'Sign in with the invited email address'; end if;
  perform 1 from public.vaults where id = invite.vault_id for update;
  select * into invite from public.vault_invitations where id = p_invitation_id for update;
  if invite.id is null or invite.expires_at <= now() then raise exception 'Invitation is invalid or expired'; end if;
  if exists(select 1 from public.vault_members where user_id = auth.uid()) then raise exception 'Account already belongs to a vault'; end if;
  if (select count(*) from public.vault_members where vault_id = invite.vault_id) >= 2 then raise exception 'This vault already has two members'; end if;
  insert into public.vault_members(vault_id, user_id, email, salt, wrapped_key, is_owner) values(invite.vault_id, auth.uid(), current_email, p_salt, p_wrapped_key, false);
  delete from public.vault_invitations where id = invite.id;
end
$$;

do $$ begin
  if not exists (select 1 from pg_publication_tables where pubname = 'supabase_realtime' and schemaname = 'public' and tablename = 'vault_members') then
    alter publication supabase_realtime add table public.vault_members;
  end if;
end $$;

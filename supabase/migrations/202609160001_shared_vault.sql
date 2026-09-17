create extension if not exists pgcrypto;

create table public.vaults (
  id uuid primary key default gen_random_uuid(),
  owner_id uuid not null references auth.users(id) on delete cascade,
  name text not null default 'Our shared vault',
  created_at timestamptz not null default now()
);

create table public.vault_members (
  vault_id uuid not null references public.vaults(id) on delete cascade,
  user_id uuid not null references auth.users(id) on delete cascade,
  salt text not null,
  wrapped_key jsonb not null,
  is_owner boolean not null default false,
  created_at timestamptz not null default now(),
  primary key (vault_id, user_id),
  unique (user_id)
);

create table public.vault_entries (
  id uuid primary key default gen_random_uuid(),
  vault_id uuid not null references public.vaults(id) on delete cascade,
  iv text not null,
  ciphertext text not null,
  updated_at timestamptz not null default now()
);

create index vault_entries_vault_updated on public.vault_entries(vault_id, updated_at desc);

create table public.vault_invitations (
  id uuid primary key default gen_random_uuid(),
  vault_id uuid not null references public.vaults(id) on delete cascade,
  inviter_id uuid not null references auth.users(id) on delete cascade,
  email text not null,
  iv text not null,
  ciphertext text not null,
  created_at timestamptz not null default now(),
  expires_at timestamptz not null default (now() + interval '7 days'),
  unique (vault_id)
);

create or replace function public.is_vault_member(p_vault_id uuid)
returns boolean language sql stable security definer set search_path = '' as $$
  select exists (select 1 from public.vault_members m where m.vault_id = p_vault_id and m.user_id = (select auth.uid()))
$$;

create or replace function public.enforce_two_members()
returns trigger language plpgsql security definer set search_path = '' as $$
begin
  perform 1 from public.vaults where id = new.vault_id for update;
  if (select count(*) from public.vault_members where vault_id = new.vault_id) >= 2 then
    raise exception 'This vault already has two members';
  end if;
  return new;
end
$$;
create trigger vault_member_limit before insert on public.vault_members for each row execute function public.enforce_two_members();

create or replace function public.create_vault(p_name text, p_salt text, p_wrapped_key jsonb)
returns uuid language plpgsql security definer set search_path = '' as $$
declare new_id uuid;
begin
  if auth.uid() is null then raise exception 'Authentication required'; end if;
  if exists(select 1 from public.vault_members where user_id = auth.uid()) then raise exception 'Account already belongs to a vault'; end if;
  insert into public.vaults(owner_id, name) values(auth.uid(), coalesce(nullif(p_name, ''), 'Our shared vault')) returning id into new_id;
  insert into public.vault_members(vault_id, user_id, salt, wrapped_key, is_owner) values(new_id, auth.uid(), p_salt, p_wrapped_key, true);
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
  insert into public.vault_members(vault_id, user_id, salt, wrapped_key, is_owner) values(invite.vault_id, auth.uid(), p_salt, p_wrapped_key, false);
  delete from public.vault_invitations where id = invite.id;
end
$$;

create or replace function public.create_vault_invitation(p_vault_id uuid, p_email text, p_iv text, p_ciphertext text)
returns uuid language plpgsql security definer set search_path = '' as $$
declare new_id uuid;
begin
  if auth.uid() is null then raise exception 'Authentication required'; end if;
  if lower(trim(p_email)) = lower(coalesce(auth.jwt() ->> 'email', '')) then raise exception 'You cannot invite your own account'; end if;
  perform 1 from public.vaults where id = p_vault_id for update;
  if not exists(select 1 from public.vault_members where vault_id = p_vault_id and user_id = auth.uid() and is_owner) then raise exception 'Only the vault owner can invite a member'; end if;
  if (select count(*) from public.vault_members where vault_id = p_vault_id) <> 1 then raise exception 'This vault already has two members'; end if;
  delete from public.vault_invitations where vault_id = p_vault_id;
  insert into public.vault_invitations(vault_id, inviter_id, email, iv, ciphertext)
  values(p_vault_id, auth.uid(), lower(trim(p_email)), p_iv, p_ciphertext) returning id into new_id;
  return new_id;
end
$$;

alter table public.vaults enable row level security;
alter table public.vault_members enable row level security;
alter table public.vault_entries enable row level security;
alter table public.vault_invitations enable row level security;

grant usage on schema public to authenticated;
grant select on public.vaults, public.vault_members, public.vault_invitations to authenticated;
grant select, insert, update, delete on public.vault_entries to authenticated;
grant insert, delete on public.vault_invitations to authenticated;

create policy "Members can read their vault" on public.vaults for select to authenticated using (public.is_vault_member(id));
create policy "Members can read membership metadata" on public.vault_members for select to authenticated using (public.is_vault_member(vault_id));
create policy "Members can read encrypted entries" on public.vault_entries for select to authenticated using (public.is_vault_member(vault_id));
create policy "Members can add encrypted entries" on public.vault_entries for insert to authenticated with check (public.is_vault_member(vault_id));
create policy "Members can update encrypted entries" on public.vault_entries for update to authenticated using (public.is_vault_member(vault_id)) with check (public.is_vault_member(vault_id));
create policy "Members can delete encrypted entries" on public.vault_entries for delete to authenticated using (public.is_vault_member(vault_id));
create policy "Vault owner can create invitation" on public.vault_invitations for insert to authenticated with check (inviter_id = auth.uid() and public.is_vault_member(vault_id) and exists(select 1 from public.vault_members where vault_id = vault_invitations.vault_id and user_id = auth.uid() and is_owner));
create policy "Invitee or owner can read invitation" on public.vault_invitations for select to authenticated using (lower(email) = lower(coalesce(auth.jwt() ->> 'email', '')) or (inviter_id = auth.uid() and public.is_vault_member(vault_id)));
create policy "Owner can delete invitation" on public.vault_invitations for delete to authenticated using (inviter_id = auth.uid());

revoke all on function public.is_vault_member(uuid) from public;
grant execute on function public.is_vault_member(uuid) to authenticated;
revoke all on function public.create_vault(text, text, jsonb) from public;
grant execute on function public.create_vault(text, text, jsonb) to authenticated;
revoke all on function public.accept_vault_invitation(uuid, text, jsonb) from public;
grant execute on function public.accept_vault_invitation(uuid, text, jsonb) to authenticated;
revoke all on function public.create_vault_invitation(uuid, text, text, text) from public;
grant execute on function public.create_vault_invitation(uuid, text, text, text) to authenticated;

create or replace function public.touch_vault_entry()
returns trigger language plpgsql set search_path = '' as $$ begin new.updated_at = now(); return new; end $$;
create trigger vault_entry_touch before update on public.vault_entries for each row execute function public.touch_vault_entry();

do $$ begin
  if not exists (select 1 from pg_publication_tables where pubname = 'supabase_realtime' and schemaname = 'public' and tablename = 'vault_entries') then
    alter publication supabase_realtime add table public.vault_entries;
  end if;
end $$;

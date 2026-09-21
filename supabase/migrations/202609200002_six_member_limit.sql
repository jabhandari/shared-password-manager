create or replace function public.enforce_two_members()
returns trigger language plpgsql security definer set search_path = '' as $$
begin
  perform 1 from public.vaults where id = new.vault_id for update;
  if (select count(*) from public.vault_members where vault_id = new.vault_id) >= 6 then
    raise exception 'This vault already has six members';
  end if;
  return new;
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
  if (select count(*) from public.vault_members where vault_id = invite.vault_id) >= 6 then raise exception 'This vault already has six members'; end if;
  insert into public.vault_members(vault_id, user_id, email, salt, wrapped_key, is_owner) values(invite.vault_id, auth.uid(), current_email, p_salt, p_wrapped_key, false);
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
  if (select count(*) from public.vault_members where vault_id = p_vault_id) >= 6 then raise exception 'This vault already has six members'; end if;
  delete from public.vault_invitations where vault_id = p_vault_id;
  insert into public.vault_invitations(vault_id, inviter_id, email, iv, ciphertext)
  values(p_vault_id, auth.uid(), lower(trim(p_email)), p_iv, p_ciphertext) returning id into new_id;
  return new_id;
end
$$;

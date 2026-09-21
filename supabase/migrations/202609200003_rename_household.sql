create or replace function public.rename_vault(p_vault_id uuid, p_name text)
returns void language plpgsql security definer set search_path = '' as $$
begin
  if auth.uid() is null then raise exception 'Authentication required'; end if;
  if nullif(trim(p_name), '') is null then raise exception 'Household name cannot be empty'; end if;
  if length(trim(p_name)) > 60 then raise exception 'Household name is too long'; end if;
  if not exists(select 1 from public.vault_members where vault_id = p_vault_id and user_id = auth.uid() and is_owner) then
    raise exception 'Only the vault owner can rename the household';
  end if;
  update public.vaults set name = trim(p_name) where id = p_vault_id;
end
$$;

revoke all on function public.rename_vault(uuid, text) from public;
grant execute on function public.rename_vault(uuid, text) to authenticated;

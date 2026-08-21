-- The server constructs manifest upload paths too, for the same reason it
-- constructs evidence paths: a client-supplied path is a write-anywhere
-- primitive, and a storage policy alone is a weaker guarantee than never
-- accepting one.
create or replace function public.create_manifest_upload_path(
  p_yard_id        uuid,
  p_operating_date date,
  p_file_sha256    text,
  p_extension      text
)
returns text
language plpgsql
security definer
set search_path = ''
as $$
declare
  mgr public.profiles := app.require_manager();
begin
  if p_file_sha256 !~ '^[0-9a-f]{64}$' then
    raise exception 'file hash must be a hex sha256' using errcode = 'check_violation';
  end if;
  if lower(p_extension) not in ('csv', 'xlsx', 'xls') then
    raise exception 'unsupported file type %', p_extension using errcode = 'check_violation';
  end if;
  if not app.user_has_yard(mgr.id, p_yard_id) then
    raise exception 'yard is outside your scope' using errcode = 'insufficient_privilege';
  end if;

  return format('%s/%s/%s/%s.%s',
                mgr.org_id, p_yard_id, to_char(p_operating_date, 'YYYY-MM-DD'),
                p_file_sha256, lower(p_extension));
end;
$$;

revoke all on function public.create_manifest_upload_path(uuid, date, text, text) from public;
grant execute on function public.create_manifest_upload_path(uuid, date, text, text)
  to authenticated;

-- ---------------------------------------------------------------------------
-- Development seed.
--
-- Creates an organisation, two yards, settings and a ready-to-publish manifest
-- import carrying the build plan's worked example.
--
-- Users are NOT created here. Create them through Supabase Auth first (the
-- dashboard, or `supabase auth admin create-user`), then insert the matching
-- profiles below with the ids Auth assigned. Seeding auth.users directly
-- produces accounts that cannot sign in.
-- ---------------------------------------------------------------------------

insert into organizations (id, name)
values ('00000000-0000-0000-0000-0000000000a1', 'DP Logistics')
on conflict do nothing;

insert into yards (id, org_id, code, name) values
  ('00000000-0000-0000-0000-0000000000b1', '00000000-0000-0000-0000-0000000000a1', 'NSA', 'Nhava Sheva'),
  ('00000000-0000-0000-0000-0000000000b2', '00000000-0000-0000-0000-0000000000a1', 'MUN', 'Mundra')
on conflict do nothing;

insert into org_settings (org_id)
values ('00000000-0000-0000-0000-0000000000a1')
on conflict do nothing;

-- After creating auth users, uncomment and fill in their ids:
--
-- insert into profiles (id, org_id, role, full_name) values
--   ('<admin-auth-uid>',   '00000000-0000-0000-0000-0000000000a1', 'ADMIN',   'Asha Admin'),
--   ('<manager-auth-uid>', '00000000-0000-0000-0000-0000000000a1', 'MANAGER', 'Manoj Manager'),
--   ('<driver-auth-uid>',  '00000000-0000-0000-0000-0000000000a1', 'DRIVER',  'Dev Driver');
--
-- insert into user_yards (user_id, yard_id) values
--   ('<manager-auth-uid>', '00000000-0000-0000-0000-0000000000b1'),
--   ('<driver-auth-uid>',  '00000000-0000-0000-0000-0000000000b1');
--
-- Then publish the sample manifest as the manager:
--   select publish_manifest_from_import('00000000-0000-0000-0000-0000000000e1', 'SEED-001');

insert into manifest_imports (
  id, org_id, yard_id, operating_date, file_name, file_path, file_sha256, file_bytes,
  status, row_count, valid_count, rejected_count, uploaded_by, parsed_rows
)
select
  '00000000-0000-0000-0000-0000000000e1',
  '00000000-0000-0000-0000-0000000000a1',
  '00000000-0000-0000-0000-0000000000b1',
  current_date, 'seed-manifest.csv',
  '00000000-0000-0000-0000-0000000000a1/00000000-0000-0000-0000-0000000000b1/seed/seed.csv',
  repeat('0', 64), 256, 'READY', 4, 4, 0,
  p.id,
  '[
    {"row_no":1,"container_no":"CULVNSA2601795","chassis_no":"MAT752389T7R19810","sequence_no":1},
    {"row_no":2,"container_no":"CULVNSA2601795","chassis_no":"MAT464844TSR09249","sequence_no":2},
    {"row_no":3,"container_no":"CULVNSA2601796","chassis_no":"MAT111222A1B00001","sequence_no":1},
    {"row_no":4,"container_no":"CULVNSA2601796","chassis_no":"MAT111222A1B00002","sequence_no":2}
  ]'::jsonb
from profiles p
where p.org_id = '00000000-0000-0000-0000-0000000000a1' and p.role in ('MANAGER','ADMIN')
limit 1
on conflict do nothing;

-- ---------------------------------------------------------------------------
-- Development seed.
--
-- Creates an organisation, two yards, settings and a ready-to-publish manifest
-- import carrying the acceptance scenario, taken from the real pickup list:
--
--   TRHU8755445  <- MAT752389T7R20588 (slot 1), MAT464844TSR09113 (slot 2)
--   CAIU4330430  <- MAT752389T7R18439 (slot 1), MAT464844TSR09257 (slot 2)
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
    {"row_no":1,"container_no":"TRHU8755445","chassis_no":"MAT752389T7R20588","sequence_no":1},
    {"row_no":2,"container_no":"TRHU8755445","chassis_no":"MAT464844TSR09113","sequence_no":2},
    {"row_no":3,"container_no":"CAIU4330430","chassis_no":"MAT752389T7R18439","sequence_no":1},
    {"row_no":4,"container_no":"CAIU4330430","chassis_no":"MAT464844TSR09257","sequence_no":2}
  ]'::jsonb
from profiles p
where p.org_id = '00000000-0000-0000-0000-0000000000a1' and p.role in ('MANAGER','ADMIN')
limit 1
on conflict do nothing;

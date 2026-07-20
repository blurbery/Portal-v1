-- Portal PostgreSQL schema
-- The application stores installation-specific records as JSONB so the
-- compatibility data layer can preserve the existing provider-neutral API
-- contract while avoiding a hosted database dependency.

create table if not exists portal_records (
  id bigserial primary key,
  data jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

-- Keep the public table names explicit and isolated. Each table has the same
-- storage shape; db.js exposes normal row objects to server.js.
do $$
declare table_name text;
begin
  foreach table_name in array array[
    'portal_settings',
    'portal_issue_reports',
    'announcements',
    'push_subscriptions',
    'emby_accounts',
    'silo_accounts',
    'library_requests',
    'my_books',
    'shelfmark_downloads',
    'reading_progress',
    'discord_bot_memberships'
  ] loop
    execute format('create table if not exists %I (like portal_records including all)', table_name);
  end loop;
end $$;

create table if not exists public.announcements (
  id text primary key,
  channel_id text not null,
  channel_name text,
  author text,
  content text,
  embed_title text,
  embed_desc text,
  role_mention text,
  posted_at timestamptz not null default now(),
  created_at timestamptz not null default now()
);
create index if not exists idx_announcements_channel_posted on public.announcements(channel_id, posted_at desc);
alter table public.announcements enable row level security;

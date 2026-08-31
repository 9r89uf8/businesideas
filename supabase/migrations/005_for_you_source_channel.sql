begin;

alter table public.run_posts
  drop constraint if exists run_posts_source_channel_check;

alter table public.run_posts
  add constraint run_posts_source_channel_check
  check (source_channel in ('followed', 'topic', 'for_you'));

commit;

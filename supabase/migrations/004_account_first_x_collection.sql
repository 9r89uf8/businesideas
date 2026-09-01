begin;

-- Keep discovery bounded even when older settings were saved under the former
-- 200-candidate application limit.
update public.settings
set candidate_limit = least(candidate_limit, 100),
    ai_input_limit = least(ai_input_limit, 100),
    updated_at = now()
where candidate_limit > 100
   or ai_input_limit > 100;

alter table public.settings
  alter column candidate_limit set default 100;

alter table public.settings
  drop constraint if exists settings_candidate_limit_check;

alter table public.settings
  add constraint settings_candidate_limit_check
  check (candidate_limit between 50 and 100);

alter table public.settings
  drop constraint if exists settings_ai_input_limit_check;

alter table public.settings
  add constraint settings_ai_input_limit_check
  check (ai_input_limit between 25 and 100);

alter table public.settings
  drop constraint if exists settings_followed_x_usernames_limit;

alter table public.settings
  add constraint settings_followed_x_usernames_limit
  check (cardinality(followed_x_usernames) <= 50);

commit;

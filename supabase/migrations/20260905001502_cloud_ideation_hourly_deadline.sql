begin;

-- ChatGPT Work schedules run at most hourly. A fresh chat handles one job, so
-- shortlisting, up to eight posts, and research need a full-day comparison window.
-- Existing immutable deadlines and the production API pipeline remain unchanged.
alter table public.cloud_ideation_runs
  alter column deadline_at set default (now() + interval '24 hours');

commit;

-- Квест Мелиссы: схема и функции. Можно запускать повторно.
-- Таблицы закрыты от прямого доступа (RLS без политик). Всё идёт через функции mq_*,
-- которые требуют семейный код, а действия взрослых ещё и PIN.
create schema if not exists extensions;
create extension if not exists pgcrypto with schema extensions;

create table if not exists mq_family(
  id uuid primary key default gen_random_uuid(),
  code text unique not null,
  child_name text not null default 'Мелисса',
  goal_title text not null default 'Свой телефон',
  target int not null default 250,
  start_date date not null default current_date,
  days int not null default 30,
  season int not null default 1,
  avatar text not null default 'cat',
  theme text not null default 'glass',
  mom_pin text, dad_pin text,
  created_at timestamptz not null default now());
create table if not exists mq_task(
  id uuid primary key default gen_random_uuid(),
  family_id uuid not null references mq_family on delete cascade,
  title text not null, icon text not null default '⭐', points int not null default 1,
  kind text not null check (kind in ('day','week','care')),
  timer boolean not null default false, active boolean not null default true,
  sort int not null default 100, created_at timestamptz not null default now());
create table if not exists mq_done(
  id uuid primary key default gen_random_uuid(),
  family_id uuid not null references mq_family on delete cascade,
  task_id uuid not null references mq_task on delete cascade,
  day date not null, status text not null check (status in ('pending','approved','rejected')),
  points int not null default 0, season int not null default 1, decided_by text,
  created_at timestamptz not null default now(), decided_at timestamptz,
  unique(task_id, day));
create table if not exists mq_msg(
  id uuid primary key default gen_random_uuid(),
  family_id uuid not null references mq_family on delete cascade,
  from_role text not null, body text not null, sys boolean not null default false,
  created_at timestamptz not null default now());

alter table mq_family enable row level security;
alter table mq_task enable row level security;
alter table mq_done enable row level security;
alter table mq_msg enable row level security;

create or replace function mq_fam(p_code text) returns mq_family
language plpgsql security definer set search_path = public, extensions as $fn$
declare f mq_family;
begin
  select * into f from mq_family where code = upper(trim(p_code));
  if not found then perform pg_sleep(0.3); raise exception 'bad_code'; end if;
  return f;
end $fn$;

create or replace function mq_adult(p_family uuid, p_role text, p_pin text) returns void
language plpgsql security definer set search_path = public, extensions as $fn$
declare h text;
begin
  select case p_role when 'mom' then mom_pin when 'dad' then dad_pin end into h from mq_family where id = p_family;
  if h is null or p_pin is null or h <> crypt(p_pin, h) then perform pg_sleep(0.3); raise exception 'bad_pin'; end if;
end $fn$;

create or replace function mq_state(p_code text) returns jsonb
language plpgsql security definer set search_path = public, extensions as $fn$
declare f mq_family;
begin
  f := mq_fam(p_code);
  return jsonb_build_object(
    'family', jsonb_build_object('child_name', f.child_name, 'goal_title', f.goal_title, 'target', f.target,
      'start_date', f.start_date, 'days', f.days, 'season', f.season, 'avatar', f.avatar, 'theme', f.theme,
      'mom_has_pin', f.mom_pin is not null, 'dad_has_pin', f.dad_pin is not null),
    'tasks', coalesce((select jsonb_agg(jsonb_build_object('id', t.id, 'title', t.title, 'icon', t.icon,
        'points', t.points, 'kind', t.kind, 'timer', t.timer) order by t.sort, t.created_at)
      from mq_task t where t.family_id = f.id and t.active), '[]'::jsonb),
    'done', coalesce((select jsonb_agg(jsonb_build_object('id', d.id, 'task_id', d.task_id, 'day', d.day,
        'status', d.status, 'points', d.points, 'by', d.decided_by, 'title', t.title, 'icon', t.icon,
        'tp', t.points, 'kind', t.kind) order by d.created_at)
      from mq_done d join mq_task t on t.id = d.task_id
      where d.family_id = f.id and d.season = f.season and d.day >= current_date - 60), '[]'::jsonb),
    'msgs', coalesce((select jsonb_agg(q.x order by q.c desc) from (
        select jsonb_build_object('id', m.id, 'from', m.from_role, 'body', m.body, 'sys', m.sys, 'at', m.created_at) x, m.created_at c
        from mq_msg m where m.family_id = f.id order by m.created_at desc limit 40) q), '[]'::jsonb),
    'points', coalesce((select sum(d.points) from mq_done d where d.family_id = f.id and d.season = f.season and d.status = 'approved'), 0));
end $fn$;

create or replace function mq_set_pin(p_code text, p_role text, p_pin text) returns jsonb
language plpgsql security definer set search_path = public, extensions as $fn$
declare f mq_family;
begin
  f := mq_fam(p_code);
  if p_role not in ('mom','dad') then raise exception 'bad_role'; end if;
  if p_pin is null or p_pin !~ '^[0-9]{4}$' then raise exception 'pin_format'; end if;
  if (p_role = 'mom' and f.mom_pin is not null) or (p_role = 'dad' and f.dad_pin is not null) then raise exception 'pin_exists'; end if;
  if p_role = 'mom' then update mq_family set mom_pin = crypt(p_pin, gen_salt('bf')) where id = f.id;
  else update mq_family set dad_pin = crypt(p_pin, gen_salt('bf')) where id = f.id; end if;
  return mq_state(p_code);
end $fn$;

create or replace function mq_check_pin(p_code text, p_role text, p_pin text) returns boolean
language plpgsql security definer set search_path = public, extensions as $fn$
declare f mq_family;
begin
  f := mq_fam(p_code); perform mq_adult(f.id, p_role, p_pin); return true;
end $fn$;

create or replace function mq_mark(p_code text, p_task uuid, p_day date) returns jsonb
language plpgsql security definer set search_path = public, extensions as $fn$
declare f mq_family; t mq_task;
begin
  f := mq_fam(p_code);
  select * into t from mq_task where id = p_task and family_id = f.id and active;
  if not found then raise exception 'bad_task'; end if;
  if abs(p_day - current_date) > 1 then raise exception 'bad_day'; end if;
  insert into mq_done(family_id, task_id, day, status, season)
    values (f.id, t.id, p_day, case when t.kind = 'care' then 'approved' else 'pending' end, f.season)
  on conflict (task_id, day) do update set status = 'pending', decided_by = null, decided_at = null
    where mq_done.status = 'rejected';
  return mq_state(p_code);
end $fn$;

create or replace function mq_decide(p_code text, p_role text, p_pin text, p_done uuid, p_ok boolean) returns jsonb
language plpgsql security definer set search_path = public, extensions as $fn$
declare f mq_family; t mq_task; n int;
begin
  f := mq_fam(p_code); perform mq_adult(f.id, p_role, p_pin);
  select t2.* into t from mq_done d join mq_task t2 on t2.id = d.task_id
    where d.id = p_done and d.family_id = f.id and d.status = 'pending';
  if not found then return mq_state(p_code); end if;
  update mq_done set status = case when p_ok then 'approved' else 'rejected' end,
    points = case when p_ok then t.points else 0 end, decided_by = p_role, decided_at = now() where id = p_done;
  get diagnostics n = row_count;
  if p_ok then
    insert into mq_msg(family_id, from_role, body, sys) values (f.id, p_role,
      (case p_role when 'mom' then 'Мама подтвердила: ' else 'Папа подтвердил: ' end) || t.title || '. +' || t.points, true);
  else
    insert into mq_msg(family_id, from_role, body) values (f.id, p_role, 'Давай доделаем: ' || t.title);
  end if;
  return mq_state(p_code);
end $fn$;

create or replace function mq_task_add(p_code text, p_role text, p_pin text, p_title text, p_icon text, p_points int, p_kind text) returns jsonb
language plpgsql security definer set search_path = public, extensions as $fn$
declare f mq_family;
begin
  f := mq_fam(p_code); perform mq_adult(f.id, p_role, p_pin);
  if p_kind not in ('day','week','care') or length(trim(p_title)) = 0 then raise exception 'bad_task'; end if;
  insert into mq_task(family_id, title, icon, points, kind)
    values (f.id, left(trim(p_title), 60), left(coalesce(nullif(p_icon, ''), '⭐'), 8),
      case when p_kind = 'care' then 0 else greatest(1, least(10, p_points)) end, p_kind);
  return mq_state(p_code);
end $fn$;

create or replace function mq_task_hide(p_code text, p_role text, p_pin text, p_task uuid) returns jsonb
language plpgsql security definer set search_path = public, extensions as $fn$
declare f mq_family;
begin
  f := mq_fam(p_code); perform mq_adult(f.id, p_role, p_pin);
  update mq_task set active = false where id = p_task and family_id = f.id;
  return mq_state(p_code);
end $fn$;

create or replace function mq_say(p_code text, p_role text, p_pin text, p_body text) returns jsonb
language plpgsql security definer set search_path = public, extensions as $fn$
declare f mq_family;
begin
  f := mq_fam(p_code);
  if p_role = 'child' then null; else perform mq_adult(f.id, p_role, p_pin); end if;
  if length(trim(coalesce(p_body, ''))) = 0 then raise exception 'empty'; end if;
  insert into mq_msg(family_id, from_role, body) values (f.id, p_role, left(trim(p_body), 200));
  return mq_state(p_code);
end $fn$;

create or replace function mq_profile(p_code text, p_avatar text, p_theme text) returns jsonb
language plpgsql security definer set search_path = public, extensions as $fn$
declare f mq_family;
begin
  f := mq_fam(p_code);
  update mq_family set
    avatar = case when p_avatar in ('cat','fox','bunny','robot') then p_avatar else avatar end,
    theme = case when p_theme in ('pixel','glass') then p_theme else theme end where id = f.id;
  return mq_state(p_code);
end $fn$;

create or replace function mq_settings(p_code text, p_role text, p_pin text, p_goal text, p_target int, p_days int, p_start date) returns jsonb
language plpgsql security definer set search_path = public, extensions as $fn$
declare f mq_family;
begin
  f := mq_fam(p_code); perform mq_adult(f.id, p_role, p_pin);
  update mq_family set goal_title = left(coalesce(nullif(trim(p_goal), ''), goal_title), 40),
    target = greatest(10, least(5000, coalesce(p_target, target))),
    days = greatest(1, least(365, coalesce(p_days, days))),
    start_date = coalesce(p_start, start_date) where id = f.id;
  return mq_state(p_code);
end $fn$;

revoke execute on function mq_fam(text) from public;
revoke execute on function mq_adult(uuid, text, text) from public;
do $do$
begin
  if exists (select 1 from pg_roles where rolname = 'anon') then
    revoke all on mq_family, mq_task, mq_done, mq_msg from anon, authenticated;
    revoke execute on function mq_fam(text) from anon, authenticated;
    revoke execute on function mq_adult(uuid, text, text) from anon, authenticated;
    grant execute on function mq_state(text), mq_set_pin(text,text,text), mq_check_pin(text,text,text),
      mq_mark(text,uuid,date), mq_decide(text,text,text,uuid,boolean),
      mq_task_add(text,text,text,text,text,int,text), mq_task_hide(text,text,text,uuid),
      mq_say(text,text,text,text), mq_profile(text,text,text),
      mq_settings(text,text,text,text,int,int,date) to anon, authenticated;
  end if;
end $do$;

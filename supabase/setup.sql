-- ════════════════════════════════════════════════════════════════════
--  נוכחות אנשי מכירות · התקנה מלאה
--  מריצים פעם אחת ב-Supabase → SQL Editor → New query → Run
--  בסוף ההרצה תופיע טבלה עם הקישורים האישיים של כולם.
-- ════════════════════════════════════════════════════════════════════

create extension if not exists pg_cron;
create extension if not exists pg_net with schema extensions;

-- ─── טבלאות ──────────────────────────────────────────────────────────

-- כל מי שמשתתף: אנשי מכירות (rep), צופים (viewer) ומנהלים (admin).
-- token הוא החלק הסודי בקישור האישי. אין סיסמאות.
create table if not exists public.people (
  id          uuid primary key default gen_random_uuid(),
  name        text not null,
  phone       text,
  role        text not null default 'rep' check (role in ('rep', 'viewer', 'admin')),
  token       text not null unique default replace(gen_random_uuid()::text, '-', ''),
  active      boolean not null default true,
  created_at  timestamptz not null default now()
);

-- יום עבודה אחד של איש מכירות אחד.
create table if not exists public.workdays (
  person_id          uuid not null references public.people(id) on delete cascade,
  day                date not null,
  started_at         timestamptz,
  followups_planned  int check (followups_planned >= 0),
  ended_at           timestamptz,
  calls              int check (calls >= 0),
  premium            int not null default 0 check (premium >= 0),
  subscriptions      int not null default 0 check (subscriptions >= 0),
  trials             int not null default 0 check (trials >= 0),
  personal           int not null default 0 check (personal >= 0),
  revenue            numeric(12, 2) check (revenue >= 0),
  note               text,
  day_off            boolean not null default false,
  updated_at         timestamptz not null default now(),
  primary key (person_id, day)
);

create table if not exists public.settings (
  key    text primary key,
  value  text not null default ''
);

insert into public.settings (key, value) values
  ('timezone',          'Asia/Jerusalem'),
  ('work_days',         '0,1,2,3,4'),                 -- 0=ראשון … 6=שבת
  ('app_url',           ''),                          -- כתובת האתר, למשל https://getselano.github.io/sales/
  ('greenapi_url',      'https://api.green-api.com'),
  ('greenapi_instance', ''),
  ('greenapi_token',    '')
on conflict (key) do nothing;

-- מתי נשלחת כל הודעה. {name} ו-{link} מוחלפים אוטומטית.
--   not_started  → רק למי שעוד לא סימן התחלה
--   not_ended    → רק למי שעוד לא סגר את היום
--   weekly       → לכולם, ביום העבודה האחרון בשבוע
--   monthly      → לכולם, ב-1 לחודש (על החודש הקודם)
create table if not exists public.reminders (
  kind      text primary key,
  at_time   time not null,
  audience  text not null check (audience in ('not_started', 'not_ended', 'weekly', 'monthly')),
  message   text not null default '',
  enabled   boolean not null default true
);

insert into public.reminders (kind, at_time, audience, message) values
  ('morning_1', '11:00', 'not_started',
   E'בוקר טוב {name} ☀️\nזמן לסמן התחלת יום ולהזין כמה פולואפים מתוכננים היום:\n{link}'),
  ('morning_2', '12:00', 'not_started',
   E'{name}, עוד לא סימנת התחלת יום 🙂\n{link}\n\nלא עובד היום? אפשר לסמן את זה באותו קישור.'),
  ('morning_3', '13:00', 'not_started',
   E'{name}, תזכורת אחרונה לסימון התחלת יום:\n{link}'),
  ('evening_1', '18:00', 'not_ended',
   E'ערב טוב {name} 🌙\nזמן לסגור את היום: שעת סיום, סגירות וכמה נכנס.\n{link}'),
  ('evening_2', '19:00', 'not_ended',
   E'{name}, עוד לא סגרת את היום. לוקח דקה:\n{link}'),
  ('weekly',    '20:00', 'weekly',  ''),
  ('monthly',   '10:00', 'monthly', '')
on conflict (kind) do nothing;

-- כל הודעה שנשלחה. המפתח הייחודי מונע שליחה כפולה.
create table if not exists public.message_log (
  id          bigserial primary key,
  kind        text not null,
  day         date not null,
  person_id   uuid references public.people(id) on delete cascade,
  phone       text,
  message     text,
  request_id  bigint,
  created_at  timestamptz not null default now(),
  unique (kind, day, person_id)
);

-- אף אחד לא ניגש לטבלאות ישירות. הכול עובר דרך הפונקציות למטה.
alter table public.people      enable row level security;
alter table public.workdays    enable row level security;
alter table public.settings    enable row level security;
alter table public.reminders   enable row level security;
alter table public.message_log enable row level security;
revoke all on public.people, public.workdays, public.settings, public.reminders, public.message_log
  from anon, authenticated;

-- ─── עזרים ───────────────────────────────────────────────────────────

create or replace function public.setting(p_key text) returns text
language sql stable security definer set search_path = public as $$
  select coalesce((select value from settings where key = p_key), '')
$$;

create or replace function public.local_now() returns timestamp
language sql stable security definer set search_path = public as $$
  select now() at time zone coalesce(nullif(setting('timezone'), ''), 'Asia/Jerusalem')
$$;

create or replace function public.local_today() returns date
language sql stable security definer set search_path = public as $$
  select local_now()::date
$$;

create or replace function public.person_by_token(p_token text) returns public.people
language plpgsql stable security definer set search_path = public as $$
declare v people;
begin
  select * into v from people where token = p_token and active;
  if not found then raise exception 'invalid_link'; end if;
  return v;
end $$;

create or replace function public.require_admin(p_token text) returns public.people
language plpgsql stable security definer set search_path = public as $$
declare v people := person_by_token(p_token);
begin
  if v.role <> 'admin' then raise exception 'not_admin'; end if;
  return v;
end $$;

-- 050-1234567 → 972501234567
create or replace function public.norm_phone(p text) returns text
language sql immutable as $$
  select case
    when d = '' then null
    when d like '0%' then '972' || substr(d, 2)
    else d
  end
  from (select regexp_replace(coalesce(p, ''), '\D', '', 'g') as d) x
$$;

create or replace function public.person_link(p_token text) returns text
language sql stable security definer set search_path = public as $$
  select rtrim(split_part(setting('app_url'), '?', 1), '/') || '/?t=' || p_token
$$;

create or replace function public.send_whatsapp(p_phone text, p_message text) returns bigint
language plpgsql security definer set search_path = public, extensions as $$
declare
  v_inst  text := setting('greenapi_instance');
  v_tok   text := setting('greenapi_token');
  v_phone text := norm_phone(p_phone);
begin
  if v_inst = '' or v_tok = '' or v_phone is null then return null; end if;
  return net.http_post(
    url     := rtrim(setting('greenapi_url'), '/') || '/waInstance' || v_inst || '/sendMessage/' || v_tok,
    body    := jsonb_build_object('chatId', v_phone || '@c.us', 'message', p_message),
    headers := '{"Content-Type": "application/json"}'::jsonb
  );
end $$;

-- שולח רק אם ההודעה הזו עוד לא נשלחה לאדם הזה היום.
create or replace function public.queue_message(p_kind text, p_day date, p_person public.people, p_message text)
returns void
language plpgsql security definer set search_path = public as $$
declare v_id bigint;
begin
  insert into message_log (kind, day, person_id, phone, message)
  values (p_kind, p_day, p_person.id, p_person.phone, p_message)
  on conflict (kind, day, person_id) do nothing
  returning id into v_id;
  if v_id is not null then
    update message_log set request_id = send_whatsapp(p_person.phone, p_message) where id = v_id;
  end if;
end $$;

create or replace function public.fmt_num(n numeric) returns text
language sql immutable as $$
  select to_char(coalesce(n, 0), 'FM999,999,990')
$$;

-- טקסט הסיכום השבועי/חודשי (בלי הקישור, שמתווסף לכל נמען בנפרד).
create or replace function public.summary_text(p_title text, p_from date, p_to date) returns text
language plpgsql stable security definer set search_path = public as $$
declare
  r record;
  v text := '📊 *' || p_title || '* · ' || to_char(p_from, 'DD.MM') || '–' || to_char(p_to, 'DD.MM.YYYY');
begin
  for r in
    select p.name,
           count(w.*) filter (where w.started_at is not null or w.ended_at is not null) as days,
           coalesce(sum(extract(epoch from (w.ended_at - w.started_at))) / 3600.0, 0) as hours,
           sum(w.followups_planned) as followups,
           sum(w.calls) as calls,
           coalesce(sum(w.premium), 0) as premium,
           coalesce(sum(w.subscriptions), 0) as subscriptions,
           coalesce(sum(w.trials), 0) as trials,
           coalesce(sum(w.personal), 0) as personal,
           coalesce(sum(w.revenue), 0) as revenue,
           0 as ord
    from people p
    left join workdays w on w.person_id = p.id and w.day between p_from and p_to and not w.day_off
    where p.role = 'rep' and (p.active or w.person_id is not null)
    group by p.id, p.name
    union all
    select 'סה״כ צוות',
           count(*) filter (where w.started_at is not null or w.ended_at is not null),
           coalesce(sum(extract(epoch from (w.ended_at - w.started_at))) / 3600.0, 0),
           sum(w.followups_planned), sum(w.calls),
           coalesce(sum(w.premium), 0), coalesce(sum(w.subscriptions), 0),
           coalesce(sum(w.trials), 0), coalesce(sum(w.personal), 0),
           coalesce(sum(w.revenue), 0),
           1
    from workdays w join people p on p.id = w.person_id
    where p.role = 'rep' and w.day between p_from and p_to and not w.day_off
    order by ord, name
  loop
    v := v || E'\n\n*' || r.name || E'*\n'
      || 'ימי עבודה: ' || r.days || ' · שעות: ' || to_char(r.hours, 'FM9990.0') || E'\n'
      || 'פולואפים מתוכננים: ' || coalesce(r.followups::text, '0') || E'\n'
      || 'שיחות: ' || coalesce(r.calls::text, '—') || E'\n'
      || 'פרימיום ' || r.premium || ' · מנויים ' || r.subscriptions
      || ' · ניסיון ' || r.trials || ' · אישיים ' || r.personal || E'\n'
      || 'הכנסות: ₪' || fmt_num(r.revenue);
  end loop;
  return v;
end $$;

-- ─── השעון: רץ כל 5 דקות ושולח את מה שצריך ──────────────────────────

create or replace function public.tick() returns void
language plpgsql security definer set search_path = public as $$
declare
  v_now      timestamp := local_now();
  v_day      date := v_now::date;
  v_time     time := v_now::time;
  v_dow      int := extract(dow from v_now)::int;
  v_workdays int[] := string_to_array(nullif(setting('work_days'), ''), ',')::int[];
  v_body     text;
  r          record;
  p          people;
begin
  for r in
    select * from reminders
    where enabled and v_time >= at_time and v_time < at_time + interval '55 minutes'
  loop
    if r.audience in ('not_started', 'not_ended') then
      continue when not (v_dow = any (coalesce(v_workdays, '{}')));
      for p in
        select pe.* from people pe
        left join workdays w on w.person_id = pe.id and w.day = v_day
        where pe.active and pe.role = 'rep' and pe.phone is not null
          and not coalesce(w.day_off, false)
          and w.ended_at is null
          and (r.audience = 'not_ended' or w.started_at is null)
      loop
        perform queue_message(r.kind, v_day, p,
          replace(replace(r.message, '{name}', p.name), '{link}', person_link(p.token)));
      end loop;

    else
      if r.audience = 'weekly' then
        continue when v_dow <> (select max(x) from unnest(coalesce(v_workdays, '{4}')) x);
        v_body := summary_text('סיכום שבועי', v_day - v_dow, v_day);
      else
        continue when extract(day from v_day) <> 1;
        v_body := summary_text('סיכום חודשי',
          date_trunc('month', v_day - 1)::date, v_day - 1);
      end if;
      for p in select * from people where active and phone is not null loop
        perform queue_message(r.kind, v_day, p,
          v_body || E'\n\nלוח הצוות: ' || person_link(p.token));
      end loop;
    end if;
  end loop;
end $$;

select cron.unschedule(jobid) from cron.job where jobname = 'sales-tick';
select cron.schedule('sales-tick', '*/5 * * * *', 'select public.tick()');

-- ─── פונקציות שהאתר קורא להן ────────────────────────────────────────

create or replace function public.app_me(p_token text) returns json
language plpgsql security definer set search_path = public as $$
declare v people := person_by_token(p_token);
begin
  return json_build_object(
    'person',  json_build_object('id', v.id, 'name', v.name, 'role', v.role),
    'today',   local_today(),
    'workday', (select row_to_json(w) from workdays w where w.person_id = v.id and w.day = local_today())
  );
end $$;

create or replace function public.app_check_in(p_token text, p_followups int) returns json
language plpgsql security definer set search_path = public as $$
declare v people := person_by_token(p_token);
begin
  insert into workdays (person_id, day, started_at, followups_planned)
  values (v.id, local_today(), now(), greatest(coalesce(p_followups, 0), 0))
  on conflict (person_id, day) do update
    set started_at        = coalesce(workdays.started_at, now()),
        followups_planned = excluded.followups_planned,
        day_off           = false,
        updated_at        = now();
  return app_me(p_token);
end $$;

create or replace function public.app_check_out(
  p_token text, p_calls int, p_premium int, p_subscriptions int,
  p_trials int, p_personal int, p_revenue numeric, p_note text
) returns json
language plpgsql security definer set search_path = public as $$
declare v people := person_by_token(p_token);
begin
  insert into workdays (person_id, day, ended_at, calls, premium, subscriptions, trials, personal, revenue, note)
  values (v.id, local_today(), now(), p_calls,
          coalesce(p_premium, 0), coalesce(p_subscriptions, 0),
          coalesce(p_trials, 0), coalesce(p_personal, 0),
          p_revenue, nullif(trim(p_note), ''))
  on conflict (person_id, day) do update
    set ended_at      = coalesce(workdays.ended_at, now()),
        calls         = excluded.calls,
        premium       = excluded.premium,
        subscriptions = excluded.subscriptions,
        trials        = excluded.trials,
        personal      = excluded.personal,
        revenue       = excluded.revenue,
        note          = excluded.note,
        day_off       = false,
        updated_at    = now();
  return app_me(p_token);
end $$;

create or replace function public.app_day_off(p_token text, p_off boolean) returns json
language plpgsql security definer set search_path = public as $$
declare v people := person_by_token(p_token);
begin
  insert into workdays (person_id, day, day_off) values (v.id, local_today(), p_off)
  on conflict (person_id, day) do update set day_off = excluded.day_off, updated_at = now();
  return app_me(p_token);
end $$;

-- כל מי שיש לו קישור רואה את כל הצוות.
create or replace function public.app_board(p_token text, p_from date, p_to date) returns json
language plpgsql security definer set search_path = public as $$
begin
  perform person_by_token(p_token);
  return json_build_object(
    'today',  local_today(),
    'people', coalesce((
      select json_agg(json_build_object('id', p.id, 'name', p.name) order by p.name)
      from people p
      where p.role = 'rep'
        and (p.active or exists (select 1 from workdays w
                                 where w.person_id = p.id and w.day between p_from and p_to))
    ), '[]'),
    'days', coalesce((
      select json_agg(row_to_json(w) order by w.day)
      from workdays w where w.day between p_from and p_to
    ), '[]')
  );
end $$;

-- ─── ניהול (רק למנהלים) ──────────────────────────────────────────────

create or replace function public.app_admin(p_token text) returns json
language plpgsql security definer set search_path = public, extensions as $$
begin
  perform require_admin(p_token);
  return json_build_object(
    'people', coalesce((
      select json_agg(json_build_object(
        'id', id, 'name', name, 'phone', phone, 'role', role, 'active', active,
        'link', person_link(token)) order by active desc, role desc, name)
      from people), '[]'),
    'settings', (select json_object_agg(key, value) from settings),
    'reminders', (select json_agg(r order by at_time) from reminders r),
    'log', coalesce((
      select json_agg(x) from (
        select l.created_at, l.kind, coalesce(p.name, l.message) as name, l.phone,
               r.status_code, left(coalesce(r.error_msg, r.content::text), 200) as response
        from message_log l
        left join people p on p.id = l.person_id
        left join net._http_response r on r.id = l.request_id
        order by l.created_at desc limit 40
      ) x), '[]')
  );
end $$;

create or replace function public.app_admin_save_person(
  p_token text, p_id uuid, p_name text, p_phone text, p_role text, p_active boolean
) returns json
language plpgsql security definer set search_path = public as $$
begin
  perform require_admin(p_token);
  if coalesce(trim(p_name), '') = '' then raise exception 'name_required'; end if;
  if p_id is null then
    insert into people (name, phone, role, active)
    values (trim(p_name), nullif(trim(p_phone), ''), p_role, coalesce(p_active, true));
  else
    update people set name = trim(p_name), phone = nullif(trim(p_phone), ''),
                      role = p_role, active = coalesce(p_active, true)
    where id = p_id;
  end if;
  return app_admin(p_token);
end $$;

create or replace function public.app_admin_new_link(p_token text, p_id uuid) returns json
language plpgsql security definer set search_path = public as $$
begin
  perform require_admin(p_token);
  update people set token = replace(gen_random_uuid()::text, '-', '')
  where id = p_id and token <> p_token;
  return app_admin(p_token);
end $$;

create or replace function public.app_admin_save_settings(p_token text, p_values json) returns json
language plpgsql security definer set search_path = public as $$
declare k text;
begin
  perform require_admin(p_token);
  for k in select json_object_keys(p_values) loop
    if k in ('work_days', 'app_url', 'greenapi_url', 'greenapi_instance', 'greenapi_token', 'timezone') then
      insert into settings (key, value) values (k, coalesce(trim(p_values ->> k), ''))
      on conflict (key) do update set value = excluded.value;
    end if;
  end loop;
  return app_admin(p_token);
end $$;

create or replace function public.app_admin_save_reminder(
  p_token text, p_kind text, p_at time, p_message text, p_enabled boolean
) returns json
language plpgsql security definer set search_path = public as $$
begin
  perform require_admin(p_token);
  update reminders set at_time = p_at, message = coalesce(p_message, message), enabled = p_enabled
  where kind = p_kind;
  return app_admin(p_token);
end $$;

create or replace function public.app_admin_test(p_token text, p_id uuid) returns json
language plpgsql security definer set search_path = public as $$
declare p people;
begin
  perform require_admin(p_token);
  select * into p from people where id = p_id;
  if p.phone is null then raise exception 'no_phone'; end if;
  insert into message_log (kind, day, person_id, phone, message, request_id)
  values ('test', local_today(), null, p.phone, p.name,
          send_whatsapp(p.phone, 'הודעת בדיקה ממערכת הנוכחות ✅' || E'\n' || person_link(p.token)));
  return app_admin(p_token);
end $$;

-- ההרשאות: האתר (anon) יכול רק לקרוא לפונקציות app_*.
revoke execute on all functions in schema public from public, anon, authenticated;
grant execute on function
  public.app_me(text),
  public.app_check_in(text, int),
  public.app_check_out(text, int, int, int, int, int, numeric, text),
  public.app_day_off(text, boolean),
  public.app_board(text, date, date),
  public.app_admin(text),
  public.app_admin_save_person(text, uuid, text, text, text, boolean),
  public.app_admin_new_link(text, uuid),
  public.app_admin_save_settings(text, json),
  public.app_admin_save_reminder(text, text, time, text, boolean),
  public.app_admin_test(text, uuid)
to anon, authenticated;

-- ─── אנשים התחלתיים ─────────────────────────────────────────────────

insert into public.people (name, role)
select * from (values ('מנהל', 'admin'), ('יפתח בדש', 'rep'), ('גל רז', 'rep')) v(name, role)
where not exists (select 1 from public.people);

-- הקישורים האישיים (אחרי שמגדירים app_url במסך הניהול הם יוצגו גם שם).
select name, role, token from public.people order by role, name;

-- Optional private planner sync. Never exposes planner rows through site_admins.
-- Apply only after review; this migration does not modify existing site data.
begin;

create table if not exists public.planner_sync_heads (
  user_id uuid primary key references auth.users(id) on delete cascade,
  revision bigint not null default 0 check (revision between 0 and 9007199254740991)
);
create table if not exists public.planner_sync_items (
  user_id uuid not null references auth.users(id) on delete cascade,
  kind text not null check (kind in ('events','todos','projects','categories','goalRecords','goalDays')),
  id text not null check (length(btrim(id)) between 1 and 512),
  revision bigint not null check (revision between 1 and 9007199254740991),
  data jsonb,
  updated_at timestamptz not null default now(),
  primary key (user_id,kind,id)
);
create index if not exists planner_sync_items_cursor on public.planner_sync_items(user_id,revision);
create table if not exists public.planner_sync_receipts (
  user_id uuid not null references auth.users(id) on delete cascade,
  op_id uuid not null,
  fingerprint jsonb not null,
  result jsonb not null,
  created_at timestamptz not null default now(),
  primary key (user_id,op_id)
);
create table if not exists public.planner_sync_conflicts (
  conflict_id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  device_id uuid not null,
  kind text not null,
  id text not null,
  base_revision bigint not null,
  current_revision bigint not null,
  current_data jsonb,
  incoming_data jsonb,
  created_at timestamptz not null default now()
);
create index if not exists planner_sync_conflicts_owner on public.planner_sync_conflicts(user_id,created_at desc,conflict_id);

alter table public.planner_sync_heads enable row level security;
alter table public.planner_sync_items enable row level security;
alter table public.planner_sync_receipts enable row level security;
alter table public.planner_sync_conflicts enable row level security;
revoke all on public.planner_sync_heads,public.planner_sync_items,public.planner_sync_receipts,public.planner_sync_conflicts from public,anon,authenticated;
-- All changes go through the authenticated transaction below. Conflicts are
-- independently readable by their owner so both revisions remain recoverable.
drop policy if exists planner_conflicts_owner_read on public.planner_sync_conflicts;
create policy planner_conflicts_owner_read on public.planner_sync_conflicts for select to authenticated
  using (user_id = (select auth.uid()));
grant select on public.planner_sync_conflicts to authenticated;

create or replace function public.planner_sync_valid_date(p_value text)
returns boolean language plpgsql immutable set search_path='' as $$
declare d date;
begin
  if p_value is null or p_value !~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}$' then return false; end if;
  begin d:=p_value::date; exception when others then return false; end;
  return d::text=p_value;
end $$;
revoke all on function public.planner_sync_valid_date(text) from public,anon,authenticated;

create or replace function public.planner_sync_validate_item(p_kind text,p_id text,p_data jsonb)
returns void language plpgsql set search_path='' as $$
declare d date; field text;
begin
  if p_kind is null or p_kind not in ('events','todos','projects','categories','goalRecords','goalDays')
     or p_id is null or length(btrim(p_id)) not between 1 and 512 then
    raise invalid_parameter_value using message='planner_invalid_item_key';
  end if;
  if p_data is null or p_data='null'::jsonb then return; end if;
  if jsonb_typeof(p_data)<>'object' or octet_length(p_data::text)>200000 then
    raise invalid_parameter_value using message='planner_invalid_item_data';
  end if;
  if p_kind='goalDays' then
    if jsonb_typeof(p_data->'goalId') is distinct from 'string' or length(btrim(p_data->>'goalId'))=0
       or p_data->>'status' is distinct from 'missed'
       or p_id is distinct from (p_data->>'goalId')||'|'||(p_data->>'date') then
      raise invalid_parameter_value using message='planner_invalid_missed_day';
    end if;
  elsif jsonb_typeof(p_data->'id') is distinct from 'string' or p_data->>'id' is distinct from p_id then
    raise invalid_parameter_value using message='planner_item_id_mismatch';
  end if;
  foreach field in array array['title','memo'] loop
    if p_data ? field and jsonb_typeof(p_data->field) is distinct from 'string' then
      raise invalid_parameter_value using message='planner_invalid_text_field';
    end if;
  end loop;
  foreach field in array array['due','repeatUntil'] loop
    if p_data ? field and p_data->field<>'null'::jsonb and p_data->>field<>''
       and not public.planner_sync_valid_date(p_data->>field) then
      raise invalid_parameter_value using message='planner_invalid_date_field';
    end if;
  end loop;
  if p_kind='events' then
    if jsonb_typeof(p_data->'start') is distinct from 'string'
       or (p_data->>'start') !~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}(T([01][0-9]|2[0-3]):[0-5][0-9])?$'
       or not public.planner_sync_valid_date(left(p_data->>'start',10)) then
      raise invalid_parameter_value using message='planner_invalid_event_time';
    end if;
    if p_data ? 'end' and (jsonb_typeof(p_data->'end') is distinct from 'string'
       or (p_data->>'end') !~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}(T([01][0-9]|2[0-3]):[0-5][0-9])?$'
       or not public.planner_sync_valid_date(left(p_data->>'end',10))
       or length(p_data->>'end')<>length(p_data->>'start')) then
      raise invalid_parameter_value using message='planner_invalid_event_time';
    end if;
    if p_data ? 'end' and ((p_data->>'end')<(p_data->>'start') or (p_data->>'timeType'='point' and (p_data->>'end')<>(p_data->>'start'))) then
      raise invalid_parameter_value using message='planner_invalid_event_time';
    end if;
    if (p_data ? 'repeat' and (p_data->>'repeat' is null or p_data->>'repeat' not in ('none','daily','weekly','monthly','yearly')))
       or (p_data ? 'allDay' and jsonb_typeof(p_data->'allDay') is distinct from 'boolean') then
      raise invalid_parameter_value using message='planner_invalid_event_fields';
    end if;
    if p_data ? 'exceptions' then
      if jsonb_typeof(p_data->'exceptions') is distinct from 'array' then
        raise invalid_parameter_value using message='planner_invalid_event_exceptions';
      end if;
      if exists(select 1 from jsonb_array_elements(p_data->'exceptions') x where jsonb_typeof(x)<>'string' or not public.planner_sync_valid_date(x#>>'{}')) then
        raise invalid_parameter_value using message='planner_invalid_event_exceptions';
      end if;
    end if;
  end if;
  if p_kind='todos' and p_data ? 'done' and jsonb_typeof(p_data->'done') is distinct from 'boolean' then
    raise invalid_parameter_value using message='planner_invalid_task_fields';
  end if;
  if p_kind='categories' and (jsonb_typeof(p_data->'name') is distinct from 'string'
     or (p_data ? 'color' and (jsonb_typeof(p_data->'color') is distinct from 'string' or (p_data->>'color') !~* '^#[0-9a-f]{3,8}$'))) then
    raise invalid_parameter_value using message='planner_invalid_category_fields';
  end if;
  if p_kind='goalRecords' and (jsonb_typeof(p_data->'activityId') is distinct from 'string' or length(btrim(p_data->>'activityId'))=0) then
    raise invalid_parameter_value using message='planner_invalid_activity';
  end if;
  if p_kind in ('goalRecords','goalDays') then
    if jsonb_typeof(p_data->'date') is distinct from 'string' or (p_data->>'date') !~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}$' then
      raise invalid_parameter_value using message='planner_invalid_record_date';
    end if;
    begin d := (p_data->>'date')::date;
    exception when others then raise invalid_parameter_value using message='planner_invalid_record_date'; end;
    if d::text is distinct from p_data->>'date' then raise invalid_parameter_value using message='planner_invalid_record_date'; end if;
  end if;
end $$;
revoke all on function public.planner_sync_validate_item(text,text,jsonb) from public,anon,authenticated;

create or replace function public.planner_sync(p_device_id uuid,p_cursor bigint,p_ops jsonb,p_limit integer default 100)
returns jsonb language plpgsql security definer set search_path='' as $$
declare
  actor uuid := auth.uid(); head bigint; op jsonb; v_op_id uuid; base_revision bigint;
  item public.planner_sync_items; receipt public.planner_sync_receipts;
  payload jsonb; fingerprint jsonb; ack jsonb; acks jsonb := '[]'::jsonb;
  conflict_id uuid; seen uuid[] := '{}'::uuid[]; changes jsonb; next_cursor bigint; more boolean; conflict_count bigint;
begin
  if actor is null then raise insufficient_privilege using message='planner_login_required'; end if;
  if p_device_id is null or p_cursor is null or p_cursor<0 or p_cursor>9007199254740991
     or p_limit is null or p_limit not between 1 and 500 or p_ops is null
     or jsonb_typeof(p_ops)<>'array' or jsonb_array_length(p_ops)>100 or octet_length(p_ops::text)>20000000 then
    raise invalid_parameter_value using message='planner_invalid_request';
  end if;
  insert into public.planner_sync_heads(user_id) values(actor) on conflict(user_id) do nothing;
  select revision into head from public.planner_sync_heads where user_id=actor for update;
  if p_cursor>head then raise invalid_parameter_value using message='planner_cursor_ahead'; end if;
  for op in select value from jsonb_array_elements(p_ops) loop
    if jsonb_typeof(op)<>'object' or jsonb_typeof(op->'opId') is distinct from 'string'
       or jsonb_typeof(op->'kind') is distinct from 'string' or jsonb_typeof(op->'id') is distinct from 'string'
       or (op->>'opId') !~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
       or jsonb_typeof(op->'baseRevision') is distinct from 'number' or (op->>'baseRevision') !~ '^[0-9]{1,16}$'
       or not (op ? 'data') then raise invalid_parameter_value using message='planner_invalid_operation'; end if;
    v_op_id := (op->>'opId')::uuid; base_revision := (op->>'baseRevision')::bigint;
    if base_revision>9007199254740991 or v_op_id=any(seen) then raise invalid_parameter_value using message='planner_invalid_operation'; end if;
    seen := array_append(seen,v_op_id);
    payload := nullif(op->'data','null'::jsonb);
    perform public.planner_sync_validate_item(op->>'kind',op->>'id',payload);
    fingerprint := jsonb_build_object('deviceId',p_device_id,'kind',op->>'kind','id',op->>'id','baseRevision',base_revision,'data',payload);
    select * into receipt from public.planner_sync_receipts where user_id=actor and planner_sync_receipts.op_id=v_op_id;
    if found then
      if receipt.fingerprint is distinct from fingerprint then raise invalid_parameter_value using message='planner_operation_reused'; end if;
      acks := acks || jsonb_build_array(receipt.result);
      continue;
    end if;
    select * into item from public.planner_sync_items where user_id=actor and kind=op->>'kind' and id=op->>'id';
    if not found then item.revision := 0; item.data := null; end if;
    conflict_id := null;
    if base_revision is distinct from item.revision and payload is distinct from item.data then
      insert into public.planner_sync_conflicts(user_id,device_id,kind,id,base_revision,current_revision,current_data,incoming_data)
      values(actor,p_device_id,op->>'kind',op->>'id',base_revision,item.revision,item.data,payload)
      returning planner_sync_conflicts.conflict_id into conflict_id;
    end if;
    if head=9007199254740991 then raise program_limit_exceeded using message='planner_revision_limit'; end if;
    head := head+1;
    insert into public.planner_sync_items(user_id,kind,id,revision,data)
    values(actor,op->>'kind',op->>'id',head,payload)
    on conflict(user_id,kind,id) do update set revision=excluded.revision,data=excluded.data,updated_at=now();
    ack := jsonb_build_object('opId',v_op_id,'kind',op->>'kind','id',op->>'id','revision',head,'conflictId',conflict_id);
    insert into public.planner_sync_receipts(user_id,op_id,fingerprint,result) values(actor,v_op_id,fingerprint,ack);
    acks := acks || jsonb_build_array(ack);
  end loop;
  update public.planner_sync_heads set revision=head where user_id=actor;
  with candidates as (
    select revision,jsonb_build_object('kind',kind,'id',id,'revision',revision,'data',data) as row
    from public.planner_sync_items where user_id=actor and revision>p_cursor order by revision limit p_limit
  ), bounded as (
    select revision,row,sum(octet_length(row::text)+2) over(order by revision) as bytes from candidates
  )
  select coalesce(jsonb_agg(row order by revision),'[]'::jsonb),coalesce(max(revision),p_cursor)
  into changes,next_cursor from bounded where bytes<=3145728;
  select exists(select 1 from public.planner_sync_items where user_id=actor and revision>next_cursor) into more;
  select least(count(*),9007199254740991) into conflict_count from public.planner_sync_conflicts where user_id=actor;
  return jsonb_build_object('acks',acks,'changes',changes,'cursor',next_cursor,'hasMore',more,'conflictCount',conflict_count);
end $$;
revoke all on function public.planner_sync(uuid,bigint,jsonb,integer) from public,anon,authenticated;
grant execute on function public.planner_sync(uuid,bigint,jsonb,integer) to authenticated;

-- Read only: retained conflicts can be inspected without granting item writes.
create or replace function public.planner_sync_list_conflicts(p_limit integer default 100)
returns jsonb language plpgsql security definer set search_path='' as $$
declare actor uuid := auth.uid(); result jsonb;
begin
  if actor is null then raise insufficient_privilege using message='planner_login_required'; end if;
  if p_limit is null or p_limit not between 1 and 500 then raise invalid_parameter_value using message='planner_invalid_limit'; end if;
  with candidates as (
    select conflict_id,device_id,kind,id,base_revision,current_revision,current_data,incoming_data,created_at
    from public.planner_sync_conflicts where user_id=actor order by created_at desc,conflict_id limit p_limit
  ), bounded as (
    select c.*,sum(octet_length(to_jsonb(c)::text)+2) over(order by created_at desc,conflict_id) as bytes from candidates c
  )
  select coalesce(jsonb_agg(to_jsonb(c)-'bytes' order by c.created_at desc,c.conflict_id),'[]'::jsonb) into result
  from bounded c where bytes<=3145728;
  return result;
end $$;
revoke all on function public.planner_sync_list_conflicts(integer) from public,anon,authenticated;
grant execute on function public.planner_sync_list_conflicts(integer) to authenticated;

commit;

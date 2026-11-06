-- 기존 프로젝트·기록을 보존하며 작업실 기능을 확장합니다. 한 번 실행 후 재실행도 안전합니다.
begin;
create table if not exists public.workspace_items (
  kind text not null check(kind in ('project','entry','idea')),
  id text not null check(id ~ '^[a-z0-9][a-z0-9-]{0,59}$'),
  revision integer not null default 1,
  draft jsonb,
  published jsonb,
  deleted_at timestamptz,
  updated_at timestamptz not null default now(),
  primary key(kind,id)
);
create table if not exists public.workspace_history (
  event_id bigint generated always as identity primary key,
  kind text not null, id text not null, revision integer not null,
  snapshot jsonb not null, action text not null, saved_at timestamptz not null default now()
);
create index if not exists workspace_history_item on public.workspace_history(kind,id,event_id desc);
create table if not exists public.workspace_requests (
  actor uuid not null, request_id uuid not null, payload jsonb not null, result jsonb not null,
  primary key(actor,request_id)
);
alter table public.workspace_items enable row level security;
alter table public.workspace_history enable row level security;
alter table public.workspace_requests enable row level security;
-- 데이터는 아래 제한된 함수로만 읽고 수정합니다. 관리자 명단과 로그인 설정은 변경하지 않습니다.
revoke all on public.workspace_items,public.workspace_history,public.workspace_requests from anon,authenticated;

insert into public.workspace_items(kind,id,draft,published)
select 'project', id,
 case when not is_published then jsonb_build_object('name',name,'category',category,'description',description,'status',status,'tags',tags,'note',note,'url',url,'imageUrl',image_url,'showInProjects',show_in_projects,'sortOrder',sort_order) end,
 case when is_published then jsonb_build_object('name',name,'category',category,'description',description,'status',status,'tags',tags,'note',note,'url',url,'imageUrl',image_url,'showInProjects',show_in_projects,'sortOrder',sort_order) end
from public.projects on conflict(kind,id) do nothing;
insert into public.workspace_items(kind,id,draft,published)
select 'entry', id::text,
 case when not is_published then jsonb_build_object('projectId',project_id,'date',date,'title',title,'summary',summary,'body',body,'images','[]'::jsonb) end,
 case when is_published then jsonb_build_object('projectId',project_id,'date',date,'title',title,'summary',summary,'body',body,'images','[]'::jsonb) end
from public.journal_entries on conflict(kind,id) do nothing;

create or replace function public.workspace_version() returns integer language sql stable as $$ select 2 $$;
create or replace function public.workspace_require_admin() returns void language plpgsql security definer set search_path='' as $$
begin
 if not exists(select 1 from public.site_admins where user_id=auth.uid()) then raise insufficient_privilege using message='workspace_admin_required'; end if;
end $$;
create or replace function public.workspace_validate(p_kind text,p_data jsonb) returns void language plpgsql security definer set search_path='' as $$
declare t text; media jsonb;
begin
 if p_data is null or jsonb_typeof(p_data)<>'object' or octet_length(p_data::text)>200000 then raise invalid_parameter_value using message='workspace_invalid_data'; end if;
 if p_kind='project' then
  if length(btrim(coalesce(p_data->>'name',''))) not between 1 and 100 or length(btrim(coalesce(p_data->>'description',''))) not between 1 and 500
    or coalesce(p_data->>'status','') not in ('building','live') or length(coalesce(p_data->>'category',''))>50 or length(coalesce(p_data->>'note',''))>10000 or jsonb_typeof(p_data->'showInProjects') is distinct from 'boolean' then raise invalid_parameter_value using message='workspace_invalid_project'; end if;
  if jsonb_typeof(p_data->'tags') is distinct from 'array' then raise invalid_parameter_value using message='workspace_invalid_tags'; end if;
  if jsonb_array_length(p_data->'tags')>10 or exists(select 1 from jsonb_array_elements(p_data->'tags') x where jsonb_typeof(x)<>'string' or length(x#>>'{}')>50) then raise invalid_parameter_value using message='workspace_invalid_tags'; end if;
  if coalesce(p_data->>'sortOrder','0') !~ '^[0-9]{1,4}$' then raise invalid_parameter_value using message='workspace_invalid_order'; end if;
  if coalesce(p_data->>'url','')<>'' and (p_data->>'url') !~ '^https://[^[:space:]]+$' then raise invalid_parameter_value using message='workspace_invalid_url'; end if;
 elsif p_kind='entry' then
  if length(btrim(coalesce(p_data->>'title',''))) not between 1 and 200 or length(btrim(coalesce(p_data->>'summary',''))) not between 1 and 1000 or length(btrim(coalesce(p_data->>'body',''))) not between 1 and 50000 then raise invalid_parameter_value using message='workspace_invalid_entry'; end if;
  perform (p_data->>'date')::date;
  if p_data->>'date' is null or not exists(select 1 from public.workspace_items where kind='project' and id=p_data->>'projectId' and deleted_at is null) then raise invalid_parameter_value using message='workspace_invalid_parent'; end if;
 elsif p_kind='idea' then
  if length(btrim(coalesce(p_data->>'title',''))) not between 1 and 200 or length(btrim(coalesce(p_data->>'summary',''))) not between 1 and 1000 or coalesce(p_data->>'stage','') not in ('idea','exploring','planned') then raise invalid_parameter_value using message='workspace_invalid_idea'; end if;
 else raise invalid_parameter_value using message='workspace_invalid_kind';
 end if;
 media:=coalesce(p_data->'images','[]'::jsonb);
 if jsonb_typeof(media)<>'array' or jsonb_array_length(media)>10 then raise invalid_parameter_value using message='workspace_invalid_images'; end if;
 for t in select jsonb_array_elements_text(media) union all select coalesce(p_data->>'imageUrl','') loop
  if t<>'' and t !~ '^https://[^[:space:]]+$' and t !~ '^storage:uploads/[a-zA-Z0-9_-]+\.(png|jpg|jpeg|webp|gif)$' then raise invalid_parameter_value using message='workspace_invalid_image'; end if;
 end loop;
end $$;

create or replace function public.workspace_save(p_kind text,p_id text,p_expected_revision integer,p_data jsonb,p_publish boolean,p_request_id uuid)
returns jsonb language plpgsql security definer set search_path='' as $$
declare old public.workspace_items; result jsonb; fingerprint jsonb; receipt public.workspace_requests;
begin
 perform public.workspace_require_admin();
 if p_request_id is null or p_expected_revision is null or p_expected_revision<0 or p_publish is null or p_id is null or p_id !~ '^[a-z0-9][a-z0-9-]{0,59}$' then raise invalid_parameter_value using message='workspace_invalid_id'; end if;
 fingerprint:=jsonb_build_object('op','save','kind',p_kind,'id',p_id,'revision',p_expected_revision,'data',p_data,'publish',p_publish);
 perform pg_advisory_xact_lock(hashtextextended(auth.uid()::text||p_request_id::text,0));
 select * into receipt from public.workspace_requests where actor=auth.uid() and request_id=p_request_id;
 if found then
  if receipt.payload<>fingerprint then raise sqlstate 'PT409' using message='workspace_request_reused'; end if;
  return receipt.result;
 end if;
 perform public.workspace_validate(p_kind,p_data);
 -- 같은 항목을 동시에 처음 생성하는 요청도 직렬화합니다.
 perform pg_advisory_xact_lock(hashtextextended(p_kind||':'||p_id,0));
 select * into old from public.workspace_items where kind=p_kind and id=p_id for update;
 if found then
  if old.revision<>p_expected_revision or old.deleted_at is not null then raise sqlstate 'PT409' using message='workspace_conflict'; end if;
  insert into public.workspace_history(kind,id,revision,snapshot,action) values(p_kind,p_id,old.revision,to_jsonb(old),case when p_publish then 'publish' else 'draft' end);
  update public.workspace_items set revision=revision+1,draft=case when p_publish then null else p_data end,published=case when p_publish then p_data else published end,updated_at=now() where kind=p_kind and id=p_id returning to_jsonb(workspace_items) into result;
 else
  if p_expected_revision<>0 then raise sqlstate 'PT409' using message='workspace_conflict'; end if;
  insert into public.workspace_items(kind,id,draft,published) values(p_kind,p_id,case when not p_publish then p_data end,case when p_publish then p_data end) returning to_jsonb(workspace_items) into result;
 end if;
 insert into public.workspace_requests values(auth.uid(),p_request_id,fingerprint,result);
 return result;
end $$;

create or replace function public.workspace_action(p_kind text,p_id text,p_revision integer,p_action text,p_request_id uuid,p_history_id bigint default null)
returns jsonb language plpgsql security definer set search_path='' as $$
declare old public.workspace_items; result jsonb; fingerprint jsonb; receipt public.workspace_requests; previous jsonb;
begin
 perform public.workspace_require_admin();
 if p_request_id is null or p_revision is null then raise invalid_parameter_value; end if;
 fingerprint:=jsonb_build_object('op',p_action,'kind',p_kind,'id',p_id,'revision',p_revision,'history',p_history_id);
 perform pg_advisory_xact_lock(hashtextextended(auth.uid()::text||p_request_id::text,0));
 select * into receipt from public.workspace_requests where actor=auth.uid() and request_id=p_request_id;
 if found then if receipt.payload<>fingerprint then raise sqlstate 'PT409' using message='workspace_request_reused'; end if; return receipt.result; end if;
 select * into old from public.workspace_items where kind=p_kind and id=p_id for update;
 if not found or old.revision<>p_revision then raise sqlstate 'PT409' using message='workspace_conflict'; end if;
 if p_action not in ('trash','restore','unpublish','discard-draft','history') then raise invalid_parameter_value; end if;
 if old.deleted_at is not null and p_action<>'restore' then raise invalid_parameter_value using message='workspace_in_trash'; end if;
 if p_action='discard-draft' and old.published is null then raise invalid_parameter_value using message='workspace_no_public_version'; end if;
 if p_action='history' then
  select snapshot into previous from public.workspace_history where event_id=p_history_id and kind=p_kind and id=p_id;
  if not found then raise invalid_parameter_value; end if;
 end if;
 insert into public.workspace_history(kind,id,revision,snapshot,action) values(p_kind,p_id,old.revision,to_jsonb(old),p_action);
 update public.workspace_items set
  deleted_at=case when p_action='trash' then now() when p_action='restore' then null else deleted_at end,
  draft=case when p_action='history' then coalesce(nullif(previous->'draft','null'::jsonb),nullif(previous->'published','null'::jsonb)) when p_action='discard-draft' then null when p_action='unpublish' then coalesce(draft,published) when p_action='restore' then coalesce(draft,published) else draft end,
  published=case when p_action in ('unpublish','restore') then null else published end,
  revision=revision+1,updated_at=now()
 where kind=p_kind and id=p_id returning to_jsonb(workspace_items) into result;
 insert into public.workspace_requests values(auth.uid(),p_request_id,fingerprint,result);
 return result;
end $$;

create or replace function public.workspace_admin_list(p_offset integer default 0,p_limit integer default 100)
returns jsonb language plpgsql stable security definer set search_path='' as $$
begin
 perform public.workspace_require_admin();
 return jsonb_build_object('total',(select count(*) from public.workspace_items),'items',coalesce((select jsonb_agg(to_jsonb(t)) from (select * from public.workspace_items order by kind,id limit least(greatest(p_limit,1),100) offset greatest(p_offset,0)) t),'[]'::jsonb));
end $$;
create or replace function public.workspace_item_history(p_kind text,p_id text,p_offset integer default 0)
returns jsonb language plpgsql stable security definer set search_path='' as $$
begin perform public.workspace_require_admin();
 return coalesce((select jsonb_agg(to_jsonb(t)) from (select * from public.workspace_history where kind=p_kind and id=p_id order by event_id desc limit 25 offset greatest(p_offset,0)) t),'[]'::jsonb);
end $$;

create or replace function public.workspace_is_public(p_kind text,p_data jsonb) returns boolean language sql stable security definer set search_path='' as $$
 select p_data is not null and (p_kind<>'entry' or exists(select 1 from public.workspace_items where kind='project' and id=p_data->>'projectId' and deleted_at is null and published is not null))
$$;
create or replace function public.workspace_public_list(p_kind text,p_offset integer default 0,p_limit integer default 12,p_project_id text default null,p_status text default null)
returns jsonb language sql stable security definer set search_path='' as $$
 with visible as (
  select i.id,i.kind,i.published as data from public.workspace_items i where i.kind=p_kind and i.deleted_at is null and public.workspace_is_public(i.kind,i.published)
  and (p_kind<>'project' or coalesce((i.published->>'showInProjects')::boolean,true))
  and (p_project_id is null or i.published->>'projectId'=p_project_id)
  and (p_status is null or i.published->>'status'=p_status)
 ), paged as (
  select *,case when p_kind='entry' then data->>'date' else '' end as date_order from visible
  order by case when p_kind='project' then coalesce((data->>'sortOrder')::integer,0) else 0 end,date_order desc,id
  limit least(greatest(p_limit,1),50) offset greatest(p_offset,0)
 )
 select jsonb_build_object('total',(select count(*) from visible),'items',coalesce((select jsonb_agg(jsonb_build_object('id',p.id,'kind',p.kind,'data',(p.data-'body'-'note')||case when p.kind='entry' then jsonb_build_object('projectName',(select published->>'name' from public.workspace_items where kind='project' and id=p.data->>'projectId')) else '{}'::jsonb end)) from paged p),'[]'::jsonb))
$$;
create or replace function public.workspace_public_detail(p_kind text,p_id text) returns jsonb language sql stable security definer set search_path='' as $$
 select jsonb_build_object('id',id,'kind',kind,'data',published) from public.workspace_items where kind=p_kind and id=p_id and deleted_at is null and public.workspace_is_public(kind,published)
$$;
create or replace function public.workspace_catalog() returns jsonb language sql stable security definer set search_path='' as $$
 select coalesce(jsonb_agg(jsonb_build_object('id',id,'name',published->>'name','status',published->>'status','showInProjects',coalesce((published->>'showInProjects')::boolean,true)) order by id),'[]'::jsonb)
 from public.workspace_items where kind='project' and deleted_at is null and published is not null
$$;
create or replace function public.workspace_export() returns jsonb language plpgsql stable security definer set search_path='' as $$
begin perform public.workspace_require_admin(); return jsonb_build_object('format','wanderer-workspace','version',2,'exportedAt',now(),'items',(select coalesce(jsonb_agg(to_jsonb(i)),'[]'::jsonb) from public.workspace_items i),'history',(select coalesce(jsonb_agg(to_jsonb(h)),'[]'::jsonb) from public.workspace_history h)); end $$;

create or replace function public.workspace_import(p_backup jsonb,p_request_id uuid) returns jsonb language plpgsql security definer set search_path='' as $$
declare receipt public.workspace_requests; item jsonb; data jsonb; mapping jsonb:='{}'; new_id text; parent_id text; total integer:=0; fingerprint jsonb;
begin
 perform public.workspace_require_admin();
 if p_request_id is null or (p_backup->>'format') is distinct from 'wanderer-workspace' or (p_backup->>'version') is distinct from '2' or jsonb_typeof(p_backup->'items') is distinct from 'array' then raise invalid_parameter_value using message='workspace_invalid_backup'; end if;
 if jsonb_array_length(p_backup->'items')>10000 or octet_length(p_backup::text)>50000000 then raise invalid_parameter_value; end if;
 fingerprint:=p_backup;
 perform pg_advisory_xact_lock(hashtextextended(auth.uid()::text||p_request_id::text,0));
 select * into receipt from public.workspace_requests where actor=auth.uid() and request_id=p_request_id;
 if found then if receipt.payload<>fingerprint then raise sqlstate 'PT409'; end if; return receipt.result; end if;
 for item in select value from jsonb_array_elements(p_backup->'items') where value->>'kind'='project' and (value->>'deleted_at') is null loop
  data:=coalesce(nullif(item->'draft','null'::jsonb),nullif(item->'published','null'::jsonb)); if data is null then continue; end if;
  perform public.workspace_validate('project',data);
  new_id:='project-'||gen_random_uuid()::text; mapping:=mapping||jsonb_build_object(item->>'id',new_id);
  insert into public.workspace_items(kind,id,draft) values('project',new_id,data); total:=total+1;
 end loop;
 for item in select value from jsonb_array_elements(p_backup->'items') where value->>'kind' in ('entry','idea') and (value->>'deleted_at') is null loop
  data:=coalesce(nullif(item->'draft','null'::jsonb),nullif(item->'published','null'::jsonb)); if data is null then continue; end if;
  if item->>'kind'='entry' then parent_id:=mapping->>(data->>'projectId'); if parent_id is null then continue; end if; data:=jsonb_set(data,'{projectId}',to_jsonb(parent_id)); end if;
  perform public.workspace_validate(item->>'kind',data);
  new_id:=item->>'kind'||'-'||gen_random_uuid()::text;
  insert into public.workspace_items(kind,id,draft) values(item->>'kind',new_id,data); total:=total+1;
 end loop;
 insert into public.workspace_requests values(auth.uid(),p_request_id,fingerprint,jsonb_build_object('restored',total));
 return jsonb_build_object('restored',total);
end $$;

-- 예전 API가 공개 중지한 자료를 노출하거나 예전 테이블에만 저장하지 못하도록 접근을 막습니다.
revoke all on public.projects,public.journal_entries from anon,authenticated;
revoke all on function public.workspace_require_admin(),public.workspace_validate(text,jsonb),public.workspace_is_public(text,jsonb) from public,anon,authenticated;
revoke all on function public.workspace_save(text,text,integer,jsonb,boolean,uuid),public.workspace_action(text,text,integer,text,uuid,bigint),public.workspace_admin_list(integer,integer),public.workspace_item_history(text,text,integer),public.workspace_export(),public.workspace_import(jsonb,uuid) from public,anon;
grant execute on function public.workspace_save(text,text,integer,jsonb,boolean,uuid),public.workspace_action(text,text,integer,text,uuid,bigint),public.workspace_admin_list(integer,integer),public.workspace_item_history(text,text,integer),public.workspace_export(),public.workspace_import(jsonb,uuid) to authenticated;
grant execute on function public.workspace_version(),public.workspace_public_list(text,integer,integer,text,text),public.workspace_public_detail(text,text),public.workspace_catalog() to anon,authenticated;
-- Supabase Storage가 있는 실제 서비스에서 이미지 저장소도 준비합니다.
create or replace function public.workspace_media_access(p_name text,p_write boolean default false) returns boolean language sql stable security definer set search_path='' as $$
 select exists(select 1 from public.site_admins where user_id=auth.uid()) or (not p_write and exists(
  select 1 from public.workspace_items i where deleted_at is null and public.workspace_is_public(i.kind,i.published)
  and (i.published->>'imageUrl'='storage:'||p_name or coalesce(i.published->'images','[]'::jsonb) ? ('storage:'||p_name))
 ))
$$;
revoke all on function public.workspace_media_access(text,boolean) from public;
grant execute on function public.workspace_media_access(text,boolean) to anon,authenticated;
do $$ begin
 if to_regclass('storage.buckets') is not null then
  execute $q$insert into storage.buckets(id,name,public,file_size_limit,allowed_mime_types) values('workspace-media','workspace-media',false,5242880,array['image/png','image/jpeg','image/webp','image/gif']) on conflict(id) do nothing$q$;
  execute 'drop policy if exists workspace_media_read on storage.objects';
  execute 'create policy workspace_media_read on storage.objects for select to anon,authenticated using(bucket_id=''workspace-media'' and public.workspace_media_access(name,false))';
  execute 'drop policy if exists workspace_media_upload on storage.objects';
  execute 'create policy workspace_media_upload on storage.objects for insert to authenticated with check(bucket_id=''workspace-media'' and public.workspace_media_access(name,true))';
 end if;
end $$;
notify pgrst, 'reload schema';
commit;

-- 002 실행 이후 적용합니다. 기존 자료는 변경하지 않고 새 저장/백업 가져오기를 검증합니다.
begin;
create or replace function public.workspace_validate(p_kind text,p_data jsonb)
returns void language plpgsql security definer set search_path='' as $$
declare
 field text;
 media jsonb;
 value jsonb;
 image text;
 required_fields text[];
begin
 if p_data is null or jsonb_typeof(p_data)<>'object' or octet_length(p_data::text)>200000 then
  raise invalid_parameter_value using message='workspace_invalid_data';
 end if;
 -- ->> converts objects and numbers into text, so check types before lengths/casts.
 required_fields:=case p_kind
  when 'project' then array['name','description','status']
  when 'entry' then array['projectId','date','title','summary','body']
  when 'idea' then array['title','summary','stage']
  else null end;
 if required_fields is null then raise invalid_parameter_value using message='workspace_invalid_kind'; end if;
 foreach field in array required_fields loop
  if jsonb_typeof(p_data->field) is distinct from 'string' then
   raise invalid_parameter_value using message='workspace_invalid_field_type';
  end if;
 end loop;
 foreach field in array array['name','category','description','status','note','url','imageUrl','projectId','date','title','summary','body','stage','downloadUrl','downloadPlatform','downloadVersion','downloadRequirements'] loop
  if p_data ? field and jsonb_typeof(p_data->field) is distinct from 'string' then
   raise invalid_parameter_value using message='workspace_invalid_field_type';
  end if;
 end loop;
 foreach field in array array['showInProjects','mobilePlanned'] loop
  if p_data ? field and jsonb_typeof(p_data->field) is distinct from 'boolean' then
   raise invalid_parameter_value using message='workspace_invalid_field_type';
  end if;
 end loop;
 if p_data ? 'sortOrder' and (jsonb_typeof(p_data->'sortOrder') is distinct from 'number' or p_data->>'sortOrder' !~ '^[0-9]{1,4}$') then
  raise invalid_parameter_value using message='workspace_invalid_order';
 end if;
 if p_kind='project' then
  if length(btrim(p_data->>'name')) not between 1 and 100 or length(btrim(p_data->>'description')) not between 1 and 500
   or p_data->>'status' not in ('building','live') or length(coalesce(p_data->>'category',''))>50
   or length(coalesce(p_data->>'note',''))>10000 or jsonb_typeof(p_data->'showInProjects') is distinct from 'boolean' then
   raise invalid_parameter_value using message='workspace_invalid_project';
  end if;
  if jsonb_typeof(p_data->'tags') is distinct from 'array' then raise invalid_parameter_value using message='workspace_invalid_tags'; end if;
  if jsonb_array_length(p_data->'tags')>10 or exists(select 1 from jsonb_array_elements(p_data->'tags') x where jsonb_typeof(x)<>'string' or length(x#>>'{}')>50) then
   raise invalid_parameter_value using message='workspace_invalid_tags';
  end if;
 elsif p_kind='entry' then
  if length(btrim(p_data->>'title')) not between 1 and 200 or length(btrim(p_data->>'summary')) not between 1 and 1000 or length(btrim(p_data->>'body')) not between 1 and 50000 then
   raise invalid_parameter_value using message='workspace_invalid_entry';
  end if;
  -- The public renderer and ordering both require a canonical YYYY-MM-DD string.
  if p_data->>'date' !~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}$' then raise invalid_parameter_value using message='workspace_invalid_date'; end if;
  perform (p_data->>'date')::date;
  if not exists(select 1 from public.workspace_items where kind='project' and id=p_data->>'projectId' and deleted_at is null) then
   raise invalid_parameter_value using message='workspace_invalid_parent';
  end if;
 elsif p_kind='idea' then
  if length(btrim(p_data->>'title')) not between 1 and 200 or length(btrim(p_data->>'summary')) not between 1 and 1000 or p_data->>'stage' not in ('idea','exploring','planned') then
   raise invalid_parameter_value using message='workspace_invalid_idea';
  end if;
 end if;
 foreach field in array array['url','downloadUrl'] loop
  image:=coalesce(p_data->>field,'');
  if image<>'' and image !~ '^https://[^/?#@[:space:]]+([/?#][^[:space:]]*)?$' then
   raise invalid_parameter_value using message='workspace_invalid_url';
  end if;
 end loop;
 if length(coalesce(p_data->>'downloadUrl',''))>2000 or length(coalesce(p_data->>'downloadVersion',''))>40 or length(coalesce(p_data->>'downloadRequirements',''))>300
  or (p_data ? 'downloadPlatform' and p_data->>'downloadPlatform' not in ('pc','windows','macos','linux')) then
  raise invalid_parameter_value using message='workspace_invalid_download';
 end if;
 media:=coalesce(p_data->'images','[]'::jsonb);
 if jsonb_typeof(media)<>'array' or jsonb_array_length(media)>10 then raise invalid_parameter_value using message='workspace_invalid_images'; end if;
 for value in select jsonb_array_elements(media) loop
  if jsonb_typeof(value)<>'string' then raise invalid_parameter_value using message='workspace_invalid_images'; end if;
 end loop;
 for image in select jsonb_array_elements_text(media) union all select coalesce(p_data->>'imageUrl','') loop
  if image<>'' and image !~ '^https://[^/?#@[:space:]]+([/?#][^[:space:]]*)?$' and image !~ '^storage:uploads/[a-zA-Z0-9_-]+\.(png|jpg|jpeg|webp|gif)$' then
   raise invalid_parameter_value using message='workspace_invalid_image';
  end if;
 end loop;
end $$;
-- Internal helper stays callable only through the authorized security-definer RPCs.
revoke all on function public.workspace_validate(text,jsonb) from public,anon,authenticated;
notify pgrst, 'reload schema';
commit;

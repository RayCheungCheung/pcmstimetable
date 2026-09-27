-- ============================================================
-- 開發者模式 —— 伺服器端三級權限驗證
-- ============================================================
-- 為什麼驗證一定要放呢度：
--   本專案前端只有 Publishable key（見 auth-config.js），寫喺前端 JS
--   嘅密碼即係已公開。舊版 devtools.js 嘅 DEV_PASSWORD 就係因此被判定
--   「不可修補」而連 DOM／樣式／腳本一併刪除（見 service-worker.js 3.15.0）。
--   所以本檔把「密碼比對」同「角色指派」全部搬入 PostgreSQL：
--     前端只送密碼、收角色，永遠唔會持有判斷邏輯；
--     角色只可以由 security definer 函式寫入。
--
-- ⚠ 執行：Supabase Dashboard → SQL Editor → 貼全文 → Run（可重複執行）
-- ⚠ 絕對唔可以把 service_role key 放進前端。
-- ============================================================

-- ---------- 0. 必要擴充 ----------
create extension if not exists pgcrypto with schema extensions;

-- ---------- 1. 角色型別（enum：打錯字會即刻報錯，唔會靜靜寫入錯值） ----------
do $$
begin
    if not exists (select 1 from pg_type where typname = 'dev_role') then
        create type public.dev_role as enum ('maintainer', 'mod', 'super_admin');
    end if;
end $$;

-- ---------- 2. 憑證表（只存 bcrypt 雜湊，永不存明文） ----------
-- prefix_with_name = true → 密碼 = [profiles.name] + 本表儲存嘅後綴
-- ⚠ 開呢個旗標「唔會」提升安全性：profiles.name 係使用者自己改得嘅欄位，
--   前綴等於由攻擊者提供，真正保密嘅只有後綴。保留只為符合需求規格。
create table if not exists public.dev_credentials (
    role             public.dev_role primary key,
    pw_hash          text        not null,
    prefix_with_name boolean     not null default false,
    updated_at       timestamptz not null default now()
);

-- ---------- 3. 超級管理員白名單（用 Supabase UUID） ----------
-- ⚠ 一定要用 auth.users.id，唔可以用舊版 acc_xxxxxxxxxxxx：
--   嗰種 id 只存在瀏覽器 localStorage，使用者改一下 localStorage 就可冒充
--   （見 auth.js authNormalizeAccount），而且首次雲端登入後會被換成 uuid。
--   伺服器端用 auth.uid() 取值，前端無法偽造。
create table if not exists public.dev_super_admins (
    user_id    uuid primary key references auth.users(id) on delete cascade,
    label      text        not null default '',
    created_at timestamptz not null default now()
);

-- ---------- 4. 目前角色指派 ----------
create table if not exists public.user_roles (
    user_id    uuid primary key references auth.users(id) on delete cascade,
    role       public.dev_role not null,
    granted_at timestamptz not null default now(),
    expires_at timestamptz
);

-- ---------- 5. 稽核日誌 ----------
create table if not exists public.dev_auth_log (
    id           bigserial primary key,
    user_id      uuid,
    attempted_at timestamptz not null default now(),
    ok           boolean not null,
    granted_role public.dev_role
);

create index if not exists dev_auth_log_user_time_idx
    on public.dev_auth_log (user_id, attempted_at desc);

-- ---------- 6. RLS 與 table 權限 ----------
alter table public.dev_credentials  enable row level security;
alter table public.dev_super_admins enable row level security;
alter table public.user_roles       enable row level security;
alter table public.dev_auth_log     enable row level security;

-- 憑證表／白名單／日誌：前端任何角色都唔可以讀寫。
-- 刻意唔建立任何 policy —— RLS 預設 deny，只有 security definer
-- 函式（以 owner 身分執行）同 Dashboard 睇得到。
revoke all on public.dev_credentials  from anon, authenticated;
revoke all on public.dev_super_admins from anon, authenticated;
revoke all on public.dev_auth_log     from anon, authenticated;

-- 角色表：登入者只可以讀自己嗰一列。
-- 關鍵係「冇建立任何 INSERT／UPDATE／DELETE policy」——
-- 就算前端被改到直接打 PostgREST，都寫唔入角色。
drop policy if exists user_roles_select_own on public.user_roles;
create policy user_roles_select_own on public.user_roles
    for select to authenticated
    using (user_id = auth.uid());

revoke all on public.user_roles from anon;
grant select on public.user_roles to authenticated;

-- ---------- 7. 驗證函式（核心） ----------
-- ⚠ security definer 一定要配 set search_path：否則呼叫者可以喺自己 schema
--   放同名嘅 crypt()／表嚟劫持函式（search_path injection）。
create or replace function public.dev_verify_password(p_password text)
returns table (granted_role text)
language plpgsql
security definer
set search_path = public, extensions
as $$
declare
    v_uid      uuid := auth.uid();
    v_role     public.dev_role;
    v_is_super boolean := false;
    v_name     text := '';
begin
    -- 未登入者一律拒絕：開發者模式係「已登入使用者嘅提權」，
    -- 唔係一個獨立登入入口。
    if v_uid is null then
        raise exception 'not_authenticated' using errcode = '28000';
    end if;

    if coalesce(p_password, '') = '' then
        insert into public.dev_auth_log (user_id, ok, granted_role)
        values (v_uid, false, null);
        return;
    end if;

    -- 白名單：決定呢個使用者「有冇資格」拎 super_admin
    select exists (select 1 from public.dev_super_admins s where s.user_id = v_uid)
      into v_is_super;

    -- 目前顯示名稱（供 prefix_with_name 用）
    select coalesce(p.name, '') into v_name from public.profiles p where p.id = v_uid;

    -- ① super_admin：必須「同時」(a) UUID 在白名單 (b) 密碼正確。
    --    知道密碼但唔喺白名單，一樣拎唔到。
    if v_is_super then
        select c.role into v_role
          from public.dev_credentials c
         where c.role = 'super_admin'
           and c.pw_hash = crypt(
                   case when c.prefix_with_name then v_name || p_password
                        else p_password end,
                   c.pw_hash)
         limit 1;
    end if;

    -- ② mod：只可改課表
    if v_role is null then
        select c.role into v_role
          from public.dev_credentials c
         where c.role = 'mod'
           and c.pw_hash = crypt(p_password, c.pw_hash)
         limit 1;
    end if;

    -- ③ maintainer：基礎維護
    if v_role is null then
        select c.role into v_role
          from public.dev_credentials c
         where c.role = 'maintainer'
           and c.pw_hash = crypt(p_password, c.pw_hash)
         limit 1;
    end if;

    -- 不論成敗都留一筆稽核
    insert into public.dev_auth_log (user_id, ok, granted_role)
    values (v_uid, v_role is not null, v_role);

    -- 驗證失敗：回傳空結果（唔 raise exception —— 唔應該用錯誤碼
    -- 區分「密碼錯」同「唔喺白名單」，避免洩漏帳號是否為管理員）
    if v_role is null then
        return;
    end if;

    insert into public.user_roles (user_id, role, granted_at, expires_at)
    values (v_uid, v_role, now(), null)
    on conflict (user_id) do update
        set role = excluded.role, granted_at = now(), expires_at = null;

    return query select v_role::text;
end;
$$;

revoke all on function public.dev_verify_password(text) from public, anon;
grant execute on function public.dev_verify_password(text) to authenticated;

-- ---------- 8. 讀取自己的角色（前端開機時用） ----------
create or replace function public.dev_my_role()
returns table (granted_role text)
language sql
security definer
set search_path = public
as $$
    select r.role::text
      from public.user_roles r
     where r.user_id = auth.uid()
       and (r.expires_at is null or r.expires_at > now());
$$;

revoke all on function public.dev_my_role() from public, anon;
grant execute on function public.dev_my_role() to authenticated;

-- ---------- 9. 撤銷自己的角色（登出開發者模式） ----------
create or replace function public.dev_revoke_role()
returns void
language plpgsql
security definer
set search_path = public
as $$
begin
    if auth.uid() is null then
        raise exception 'not_authenticated' using errcode = '28000';
    end if;
    delete from public.user_roles where user_id = auth.uid();
end;
$$;

revoke all on function public.dev_revoke_role() from public, anon;
grant execute on function public.dev_revoke_role() to authenticated;

-- ============================================================
-- 10. 初始資料
-- ============================================================
-- ⚠⚠ 下面兩段含有明文密碼。呢個檔案一旦 push 上公開 repo 就等於公開咗。
--     建議喺 SQL Editor 執行完之後，即刻把明文換成 placeholder，
--     或者把呢個檔案加入 .gitignore。
-- ============================================================

-- 10-1. 三組憑證（執行時即場 bcrypt，資料庫只會儲存雜湊）
insert into public.dev_credentials (role, pw_hash, prefix_with_name)
values
    ('super_admin', crypt('J#kq/mnG3$VGb-x', gen_salt('bf', 12)), true),
    ('mod',         crypt('C5J4nVVSr0ahOBuR', gen_salt('bf', 12)), false),
    ('maintainer',  crypt('ty76qz3CCeKInPQf', gen_salt('bf', 12)), false)
on conflict (role) do update
    set pw_hash = excluded.pw_hash,
        prefix_with_name = excluded.prefix_with_name,
        updated_at = now();

-- 10-2. 超級管理員白名單
-- ⚠ 下面兩個 UUID 係佔位值，一定要換成真正嘅 auth.users.id。
--   查法（喺 SQL Editor 執行）：
--     select u.id, u.email, p.name
--       from auth.users u
--       left join public.profiles p on p.id = u.id
--      order by u.created_at;
insert into public.dev_super_admins (user_id, label)
values
    ('00000000-0000-0000-0000-000000000001', 'Ray Cheung'),
    ('00000000-0000-0000-0000-000000000002', 'fucku')
on conflict (user_id) do nothing;

-- ---------- 11. 自我檢查 ----------
do $$
begin
    if not exists (select 1 from pg_extension where extname = 'pgcrypto') then
        raise exception '❌ pgcrypto 未安裝，crypt() 無法使用。';
    end if;
    if (select count(*) from public.dev_credentials) < 3 then
        raise exception '❌ dev_credentials 不足 3 筆，第 10-1 節可能未執行。';
    end if;
    if (select count(*) from public.dev_super_admins
         where user_id::text like '00000000-0000-0000-0000-0000000000%') > 0 then
        raise warning '⚠ dev_super_admins 仍然係佔位 UUID，超級管理員驗證唔會成功。';
    end if;
end $$;

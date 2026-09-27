-- ============================================================================
--  我的課表 · Supabase 資料庫初始化腳本（取代原本的 Google Sheets）
-- ----------------------------------------------------------------------------
--  使用方式：
--    1. 開 Supabase 專案 → 左側「SQL Editor」→ New query
--    2. 把本檔全部內容貼上 → Run
--    3. 到 Authentication → Providers → Email：
--         · 想維持舊版「註冊完即刻可用」的行為 → 關閉 "Confirm email"
--         · 保留開啟亦可：前端會顯示「請到信箱點擊確認連結」而不會卡住
--    4. 把 Project URL 與 Publishable(anon) Key 貼到
--       scripts/config/auth-config.js 的 supabase 區塊
--
--  ⚠ 安全性設計（回應舊版 Google Sheets「權限過寬」的問題）：
--     · 前端只用 Publishable / anon key，永遠唔會出現 service_role secret。
--     · profiles 表啟用 Row Level Security，且 anon 角色被明確 REVOKE，
--       所以「未登入」的人連一行都讀唔到；已登入者亦只可以存取自己那一行
--       （政策條件 auth.uid() = id）。
--     · 密碼由 Supabase Auth 以 bcrypt 儲存於 auth.users，
--       前端唔再計算、亦唔再持有任何密碼雜湊或鹽值。
-- ============================================================================

-- ============================================================================
--  1. profiles：auth.users 的應用層鏡像（班級、頭像、課表綁定…）
-- ============================================================================

create table if not exists public.profiles (
    -- 主鍵＝auth.users.id，兩者一對一。帳號被刪除時一併清除。
    id            uuid primary key references auth.users (id) on delete cascade,

    email         text        not null default '',
    name          text        not null default '',
    provider      text        not null default 'email',

    -- 班級綁定：class_id 例如 junior2-zheng / custom:初二信
    class_id      text        not null default '',
    class_name    text        not null default '',
    schedule_path text        not null default '',
    custom_class  boolean     not null default false,

    -- 頭像：dataURL(Base64) 或圖片網址。用 text 以支援 Base64。
    avatar        text        not null default '',

    created_at    timestamptz not null default now(),
    last_login_at timestamptz not null default now(),
    -- ⚠ updated_at 由伺服器寫入（見下方 trigger），前端唔可以自行指定，
    --   否則裝置時鐘不準會令「雲端版本比本機新」的判斷出錯。
    updated_at    timestamptz not null default now()
);

comment on table  public.profiles            is '帳號的應用層資料（登入憑證由 auth.users 管理）';
comment on column public.profiles.avatar     is 'dataURL(Base64) 或圖片網址';
comment on column public.profiles.updated_at is '伺服器寫入的最後更新時間，用於跨裝置版本比對';

-- 跨裝置拉取時會用 updated_at 排序／比對
create index if not exists profiles_updated_at_idx on public.profiles (updated_at desc);

-- ============================================================================
--  1b. 結構自我修復（⚠ 呢段係關鍵，唔可以刪）
-- ----------------------------------------------------------------------------
--  為什麼需要呢段：
--    上面嘅 create table if not exists，在「profiles 已經存在、但欄位唔齊」
--    嘅情況下會靜靜地乜都唔做 —— SQL Editor 一樣顯示 Success，
--    於是之後所有 RLS 政策同 trigger 都建在一張結構唔完整嘅表上面。
--    呢種故障唔會即時報錯，要等到「註冊 / 寫入 profiles」時才爆，極難排查。
--
--    真實個案：若你曾經執行過較舊版本嘅建表腳本
--    （只有 id / name / class_* / schedule_path / custom_class / created_at /
--      updated_at），再執行本腳本時 create table if not exists 會被跳過，
--    結果缺少 email / provider / avatar / last_login_at 四欄。
--    後果：註冊時 handle_new_user() 要寫入 email 欄，
--          會直接失敗並令註冊回傳 500。
--
--    所以下面逐欄補齊，令本腳本「重複執行幾多次都會收斂到同一結構」。
-- ============================================================================

alter table public.profiles add column if not exists email         text        not null default '';
alter table public.profiles add column if not exists name          text        not null default '';
alter table public.profiles add column if not exists provider      text        not null default 'email';
alter table public.profiles add column if not exists class_id      text        not null default '';
alter table public.profiles add column if not exists class_name    text        not null default '';
alter table public.profiles add column if not exists schedule_path text        not null default '';
alter table public.profiles add column if not exists custom_class  boolean     not null default false;
alter table public.profiles add column if not exists avatar        text        not null default '';
alter table public.profiles add column if not exists created_at    timestamptz not null default now();
alter table public.profiles add column if not exists last_login_at timestamptz not null default now();
alter table public.profiles add column if not exists updated_at    timestamptz not null default now();

-- 主鍵與外鍵：由舊腳本建立嘅表可能缺少指向 auth.users 嘅外鍵。
-- 冇咗它就冇 on delete cascade —— 刪除帳號後會殘留孤兒列，
-- 而且 profiles.id 可以寫入任意 UUID。
do $$
begin
    if not exists (
        select 1 from pg_constraint
        where conrelid = 'public.profiles'::regclass and contype = 'p'
    ) then
        alter table public.profiles add constraint profiles_pkey primary key (id);
    end if;

    if not exists (
        select 1 from pg_constraint
        where conrelid  = 'public.profiles'::regclass
          and contype   = 'f'
          and confrelid = 'auth.users'::regclass
    ) then
        alter table public.profiles
            add constraint profiles_id_fkey
            foreign key (id) references auth.users (id) on delete cascade;
    end if;
end
$$;

-- ----------------------------------------------------------------------------
--  1c. 伺服器端欄位防護（CHECK 約束）
-- ----------------------------------------------------------------------------
--  為什麼要放一份在資料庫而唔止放在前端：
--    前端淨化（cloud.js 的 sbCleanField）只擋得住「正常使用路徑」。
--    任何人都可以打開 DevTools 直接對 PostgREST 發請求，或者用舊版本、
--    改過的前端推資料入嚟。唯一無法繞過嘅防線係寫在資料庫嘅約束。
--    前端那份係「即時提示」，這份係「真正嘅閘門」。
--
--  ⚠ 長度上限必須與 scripts/modules/auth/cloud.js 的 SB_FIELD_LIMITS 一致，
--    否則會出現「前端話送得出、伺服器話唔收」嘅落差。
--
--  ⚠ avatar 的 scheme 白名單同樣重要：avatar 會被前端組進 <img src="…">，
--    若放任寫入 javascript: 或帶引號嘅字串，就會變成跨裝置派發嘅 XSS 載荷
--    （寫入者自己嗰部裝置先中，跟住經同步散到佢其他裝置）。
-- ----------------------------------------------------------------------------
do $$
begin
    if not exists (
        select 1 from pg_constraint
        where conrelid = 'public.profiles'::regclass
          and conname  = 'profiles_field_guard'
    ) then
        alter table public.profiles
            add constraint profiles_field_guard check (
                char_length(name)          <= 60
            and char_length(email)         <= 254
            and char_length(provider)      <= 20
            and char_length(class_id)      <= 64
            and char_length(class_name)    <= 60
            and char_length(schedule_path) <= 200
            and char_length(avatar)        <= 400000
            and (avatar = '' or avatar ~ '^(data:image/|https://)')
            );
    end if;
end
$$;

-- ============================================================================
--  2. updated_at 自動更新
-- ============================================================================

create or replace function public.profiles_touch_updated_at()
returns trigger
language plpgsql
as $$
begin
    new.updated_at := now();
    return new;
end;
$$;

drop trigger if exists profiles_touch_updated_at on public.profiles;
create trigger profiles_touch_updated_at
    before update on public.profiles
    for each row execute function public.profiles_touch_updated_at();

-- ============================================================================
--  3. 註冊時自動建立 profiles 一列
--     ⚠ 用 trigger 而唔係前端 insert：當 Supabase 開啟了「Confirm email」時，
--       註冊後前端根本沒有 session（RLS 會擋住 insert），
--       由 trigger 建立就可以確保無論有無確認信，profiles 一定存在。
-- ============================================================================

create or replace function public.handle_new_user()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
    insert into public.profiles (id, email, name, provider)
    values (
        new.id,
        lower(coalesce(new.email, '')),
        coalesce(
            nullif(new.raw_user_meta_data ->> 'name', ''),
            split_part(coalesce(new.email, 'user'), '@', 1)
        ),
        coalesce(nullif(new.raw_user_meta_data ->> 'provider', ''), 'email')
    )
    on conflict (id) do nothing;
    return new;
end;
$$;

drop trigger if exists on_auth_user_created on auth.users;
create trigger on_auth_user_created
    after insert on auth.users
    for each row execute function public.handle_new_user();

-- ============================================================================
--  4. Row Level Security：只准存取自己那一行
-- ============================================================================

alter table public.profiles enable row level security;

-- 舊政策先移除，令本腳本可以重複執行
drop policy if exists profiles_select_own on public.profiles;
drop policy if exists profiles_insert_own on public.profiles;
drop policy if exists profiles_update_own on public.profiles;
drop policy if exists profiles_delete_own on public.profiles;

create policy profiles_select_own on public.profiles
    for select to authenticated
    using (auth.uid() = id);

create policy profiles_insert_own on public.profiles
    for insert to authenticated
    with check (auth.uid() = id);

create policy profiles_update_own on public.profiles
    for update to authenticated
    using (auth.uid() = id)
    with check (auth.uid() = id);

create policy profiles_delete_own on public.profiles
    for delete to authenticated
    using (auth.uid() = id);

-- ============================================================================
--  5. 權限：已登入者才可讀寫，未登入（anon）一律拒絕
--     ⚠ 呢段係「最小權限」的關鍵：舊版 Google Sheets 只要拿到 Web App 網址
--       就可以讀寫全部帳號，Supabase 這邊由資料庫層直接封死。
--     ⚠ revoke 要同時針對 anon 同 PUBLIC：
--       只寫其中一個，另一個殘留嘅預設授權仍然「連得成」該表。
--       （即使 RLS 會令查詢回傳 0 列，一個唔應該存在嘅存取路徑
--         本身就係攻擊面，唔可以靠 RLS 一層擋。）
-- ============================================================================

grant usage on schema public to authenticated;
grant select, insert, update, delete on public.profiles to authenticated;

revoke all on public.profiles from anon;
revoke all on public.profiles from public;

-- ============================================================================
--  6. 結構自動驗證（⚠ 唔係註解，係會真正執行嘅檢查）
-- ----------------------------------------------------------------------------
--  目的：把「建表被靜靜跳過」呢種故障，由「靜默成功」變成「大聲失敗」。
--        SQL Editor 彈一次 Success 並唔代表結構正確 —— 呢個正是本腳本
--        之前中招嘅原因。以下檢查若發現問題會直接拋出例外。
--  若你見到 ✅ 訊息，代表結構、RLS、權限三者都真正到位。
-- ============================================================================

do $$
declare
    missing_columns text;
begin
    -- ① 欄位齊全檢查
    select string_agg(required.colname, ', ' order by required.colname)
      into missing_columns
      from (values
                ('avatar'), ('class_id'), ('class_name'), ('created_at'),
                ('custom_class'), ('email'), ('id'), ('last_login_at'),
                ('name'), ('provider'), ('schedule_path'), ('updated_at')
           ) as required(colname)
     where not exists (
               select 1 from information_schema.columns c
                where c.table_schema = 'public'
                  and c.table_name   = 'profiles'
                  and c.column_name  = required.colname
           );

    if missing_columns is not null then
        raise exception '❌ profiles 缺少欄位：%。請確認上面嘅 alter table 段落有冇被跳過。', missing_columns;
    end if;

    -- ② Row Level Security 必須開啟
    if not exists (
        select 1 from pg_class
        where oid = 'public.profiles'::regclass and relrowsecurity
    ) then
        raise exception '❌ profiles 未啟用 Row Level Security。';
    end if;

    -- ③ anon 必須完全冇權限（最小權限原則）
    if exists (select 1 from pg_roles where rolname = 'anon') then
        if has_table_privilege('anon', 'public.profiles', 'select') then
            raise exception '❌ anon 角色仍然可以 SELECT profiles，最小權限未達成。';
        end if;
    end if;

    -- ④ 已登入者必須有讀寫權限（否則前端 PostgREST 會 401）
    if not has_table_privilege('authenticated', 'public.profiles', 'select') then
        raise exception '❌ authenticated 角色缺少 profiles 的 SELECT 權限，前端將無法同步。';
    end if;

    raise notice '✅ profiles 結構、RLS 與權限檢查全部通過，可以開始使用雲端同步。';
end
$$;

-- 上面嘅 DO 區塊若通過就唔會顯示任何訊息（Supabase SQL Editor 唔一定顯示 NOTICE），
-- 所以最後補一個 SELECT：結果會以表格顯示在下方，一眼睇得出是否正確。
-- 期望值：columns_found = 12、rls_enabled = true、
--         anon_can_read = false、auth_can_read = true。
select
    (select count(*) from information_schema.columns
      where table_schema = 'public' and table_name = 'profiles')          as columns_found,
    (select relrowsecurity from pg_class
      where oid = 'public.profiles'::regclass)                            as rls_enabled,
    has_table_privilege('anon', 'public.profiles', 'select')              as anon_can_read,
    has_table_privilege('authenticated', 'public.profiles', 'select')     as auth_can_read;

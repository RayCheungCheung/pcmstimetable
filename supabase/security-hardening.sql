-- ============================================================================
--  我的課表 · 欄位層級約束加固（DB Constraints Hardening）
-- ----------------------------------------------------------------------------
--  執行位置：Supabase → SQL Editor → New query → 貼上全部 → Run
--
--  前置條件：supabase/schema.sql 已執行（profiles 12 欄齊全、RLS 已啟用）。
--  本腳本可重複執行（idempotent），亦完全不會改動任何 RLS 政策。
--
--  ⚠⚠ 必須「一節一次 Run」，絕對唔可以一次過貼全部（實測證實嘅坑）：
--      第 1 次：只貼第 0 節（稽核，唯讀）         → 確認 violations 全 0
--      第 2 次：只貼第 3 節（REVOKE / GRANT）     ← 最關鍵，先做佢
--      第 3 次：只貼第 1 節（欄位約束）
--      第 4 次：只貼第 2 節（handle_new_user）
--      第 5 次：只貼第 4 節（自我驗證）
--    原因：SQL Editor 會將你貼上嘅內容當成「一條多語句字串」送出，
--    PostgreSQL 對咁樣嘅字串採用「單一隱式交易」——
--    任何一句 raise exception 或報錯，同一批之前嘅改動會全部回滾。
--
--  ⚠ 呢個就係實際中過嘅招：
--    第 1 節嘅 add constraint 只要有一列舊資料唔符合（例如 avatar 用咗
--    http:// 而唔係 https://、或者 class_name 超長），成批就會中止，
--    排喺佢後面嘅 REVOKE 永遠唔會執行。
--    而 SQL Editor 只會彈一句紅字，唔會話你「REVOKE 冇跑到」。
--    實測後果：anon 至今仍然持有 public.profiles 嘅完整 table 權限。
--
--  ⚠ 見到任何紅字 ＝ 該次 Run 全部冇入庫，唔可以當成功。
--
--  ⚠ 本腳本與「原始需求規格」有兩處刻意偏離，原因見第 1 節的註解。
--    偏離不是偷懶，而是因為照抄規格會直接弄壞 App 的既有功能。
--    若你確定要照原始規格執行，請用檔案最尾的「附錄 A」。
-- ============================================================================


-- ----------------------------------------------------------------------------
--  0. 執行前稽核（⚠ 必跑，唔可以跳）
-- ----------------------------------------------------------------------------
--  為什麼要稽核：
--    ALTER TABLE ... ADD CONSTRAINT ... CHECK 會「驗證所有既有資料列」。
--    只要有任何一列不符合新規則，整條語句就會失敗 —— 而且係原子性失敗：
--    約束唔會建立，SQL Editor 只彈一句紅字，你很容易以為「加固已完成」。
--
--    本專案已經中過一次「靜默成功」的招（見 schema.sql 第 1b 節的結構自我修復）。
--    所以先量度，後動手。
--
--  期望值：violations 全部 = 0。任何一行 > 0 就先處理資料，唔好繼續。
--
--  ⚠ 稽核必須覆蓋「第 1 節約束嘅每一條 predicate」，一條都唔可以漏。
--    舊版本只查咗 name 同 class_id 三項，結果 add constraint 可能因為
--    avatar / class_name 等冇查到嘅條件而失敗，但稽核照樣顯示全 0，
--    造成「假安心」→ 成批回滾 → REVOKE 亦一併冇跑到。
-- ----------------------------------------------------------------------------

select 'name_over_50'            as check_item, count(*) as violations
  from public.profiles where char_length(name) > 50
union all
select 'email_over_254', count(*)
  from public.profiles where char_length(email) > 254
union all
select 'provider_over_20', count(*)
  from public.profiles where char_length(provider) > 20
union all
select 'class_name_over_60', count(*)
  from public.profiles where char_length(class_name) > 60
union all
select 'schedule_path_over_200', count(*)
  from public.profiles where char_length(schedule_path) > 200
union all
select 'avatar_over_400000', count(*)
  from public.profiles where char_length(avatar) > 400000
union all
-- avatar 會被前端接進 <img src="…">，非 data:image/ 或 https:// 者一律攔。
-- （avatar 為 NULL 或 '' 時 CHECK 會通過，所以呢度亦只計非空值。）
select 'avatar_bad_scheme', count(*)
  from public.profiles
 where avatar is not null
   and avatar <> ''
   and avatar !~ '^(data:image/|https://)'
union all
select 'class_id_over_64', count(*)
  from public.profiles where char_length(class_id) > 64
union all
select 'class_id_not_whitelisted', count(*)
  from public.profiles
 where class_id <> ''
   and class_id !~ '^[a-zA-Z0-9_-]+$'
   and class_id !~ '^custom:[^:]{1,20}$';


-- ----------------------------------------------------------------------------
--  1. 重建欄位防護約束
-- ----------------------------------------------------------------------------
--  ⚠ 為什麼係「重建」而唔係「新增」：
--    schema.sql 已經有一個同名約束 profiles_field_guard（name ≤ 60、class_id ≤ 64）。
--    CHECK 約束係「疊加」的 —— 唔 drop 舊嘅就加新嘅，兩條會同時生效，
--    而 PostgreSQL 報錯時只會講「違反 check constraint "profiles_field_guard"」，
--    你根本分唔清係新嗰條定舊嗰條擋你。所以先 drop 再重建，保持單一真相。
--
--  ⚠ 偏離規格之一：class_id 唔可以只准 ^[a-zA-Z0-9_-]+$
--    auth.js 的 authSetClass()（第 774-778 行）為「自訂班級」產生嘅值係
--        classId = 'custom:' + name
--    而 name 來自使用者輸入、允許中文、並已被 slice(0, 20)。
--    所以 'custom:初二信' 係完全合法嘅既有資料。
--    若照規格用 ^[a-zA-Z0-9_-]+$，所有自訂班級用戶下次同步都會被伺服器拒絕
--    （PostgREST 回 400，前端顯示為同步失敗），而 allowCustomClass 目前係 true。
--    → 正確做法係「兩種形態」白名單：
--        正式班級 junior2-zheng        → ^[a-zA-Z0-9_-]+$
--        自訂班級 custom:初二信         → ^custom: 前綴 + 1~20 字元名稱
--
--  ⚠ 偏離規格之二：name 上限用 50（與規格相同），但必須同步改前端常數。
--    cloud.js 的 SB_FIELD_LIMITS.name 目前係 60，schema.sql 第 122-123 行明文要求
--    兩者一致，否則會出現「前端話送得出、伺服器話唔收」的落差。
--    → 本腳本同時把該常數改為 50（見 scripts/modules/auth/cloud.js）。
--    → 另外 handle_new_user() 必須加截斷，見第 2 節。
-- ----------------------------------------------------------------------------

alter table public.profiles drop constraint if exists profiles_field_guard;

alter table public.profiles
    add constraint profiles_field_guard check (
        -- 使用者名稱：最長 50 字元
        char_length(name) <= 50

        and char_length(email)         <= 254
        and char_length(provider)      <= 20
        and char_length(class_name)    <= 60
        and char_length(schedule_path) <= 200
        and char_length(avatar)        <= 400000

        -- 頭像 scheme 白名單：avatar 會被前端接進 <img src="…">，
        -- 放任 javascript: 就等於一個可經同步派發到所有裝置的 XSS 載荷。
        and (avatar = '' or avatar ~ '^(data:image/|https://)')

        -- class_id：兩種合法形態（理由見上方註解）
        and char_length(class_id) <= 64
        and (
            class_id = ''
            or class_id ~ '^[a-zA-Z0-9_-]+$'      -- ① 正式班級
            or class_id ~ '^custom:[^:]{1,20}$'   -- ② 自訂班級（可含中文）
        )
    );

comment on constraint profiles_field_guard on public.profiles is
    '欄位長度上限 + 頭像 scheme 白名單 + class_id 形態白名單（前端 SB_FIELD_LIMITS 必須一致）';


-- ----------------------------------------------------------------------------
--  2. 修正註冊 Trigger（⚠ 唔係可選，漏咗會令部分註冊直接 500）
-- ----------------------------------------------------------------------------
--  為什麼必須做：
--    handle_new_user() 用「Email @ 前嘅部分」當預設名稱：
--        split_part(coalesce(new.email, 'user'), '@', 1)
--    Email 本地部分最長可達 64 字元（例如一串學號或長拼音）。
--    只要 name 上限收緊到 50，一個 51 字元的 Email 就會令 trigger 拋出
--    約束違反 → 整個註冊請求 500。
--
--    frontend 的 sbCleanText 只截斷「應用層推送」的值，
--    攔唔到 trigger 自己喺資料庫內部寫入的值 —— 呢個缺口只有 SQL 補得到。
--
--  ⚠ left(..., 50) 係「按字元」截斷（唔係 byte），同 char_length 一致，
--    所以中文名唔會被截到半個字。
-- ----------------------------------------------------------------------------

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
        left(                                     -- ⚠ 新增：截斷至 50 字元
            coalesce(
                nullif(new.raw_user_meta_data ->> 'name', ''),
                split_part(coalesce(new.email, 'user'), '@', 1)
            ),
            50
        ),
        coalesce(nullif(new.raw_user_meta_data ->> 'provider', ''), 'email')
    )
    on conflict (id) do nothing;
    return new;
end;
$$;


-- ----------------------------------------------------------------------------
--  3. 最小權限：收回 anon / PUBLIC 的 table 權限（⚠ 必須排喺驗證之前）
-- ----------------------------------------------------------------------------
--  ⚠ 呢一節係本腳本原本嘅缺陷，今次補上：
--    舊版本只係「驗證 anon 冇權限」，但從來冇「令 anon 冇權限」。
--    真正嘅 revoke 只喺 schema.sql 第 5 節（第 246-247 行）。
--    一旦嗰節冇跑到，第 4 節就會 raise exception；
--    而 PostgreSQL simple query protocol 會將一整份多語句字串
--    當成「單一隱式交易」執行 —— 即係連第 1 節嘅約束、第 2 節嘅 trigger
--    都會一齊回滾。你見到紅字，但加固其實完全冇入到庫。
--
--  外部實測證據（用 publishable key 打 PostgREST）：
--      select=zzz_no_such_col  →  400 42703 column ... does not exist
--    收到 42703 代表 PostgREST 已經「通過 table 權限檢查、行到欄位解析」，
--    亦即 anon 仍然持有 public.profiles 嘅 table-level SELECT。
--    若 revoke 真係生效，回應會係 401 42501 permission denied for table profiles。
--
--  ⚠ 兩個角色都要 revoke，缺一不可：
--      anon   —— PostgREST 處理未登入請求時所用嘅角色；
--      PUBLIC —— 所有角色嘅隱含成員。只 revoke anon 嘅話，
--                PUBLIC 殘留嘅預設授權仍然會令 anon「連得成」該表。
--    呢點 schema.sql 第 235-240 行已經警告過，但當時冇實際執行到。
-- ----------------------------------------------------------------------------

revoke all on public.profiles from anon;
revoke all on public.profiles from public;

-- 已登入者必須保留讀寫，否則前端 PostgREST 同步會 401
-- （數值與 schema.sql 第 243-244 行一致，兩處必須同步）
grant usage on schema public to authenticated;
grant select, insert, update, delete on public.profiles to authenticated;


-- ----------------------------------------------------------------------------
--  4. 結構自動驗證（⚠ 會真正執行，唔係註解）
-- ----------------------------------------------------------------------------
--  目的：把「加固其實冇生效」由「靜默成功」變成「大聲失敗」。
--  期望值：guard_exists = 1、rls_enabled = true、policy_count = 4、
--          anon_can_read = false、auth_can_read = true
-- ----------------------------------------------------------------------------

do $$
declare
    bad_rows bigint;
begin
    -- ① 新約束必須存在
    if not exists (
        select 1 from pg_constraint
        where conrelid = 'public.profiles'::regclass
          and conname  = 'profiles_field_guard'
    ) then
        raise exception '❌ profiles_field_guard 唔存在，第 1 節有冇被跳過？';
    end if;

    -- ② RLS 必須仍然開啟（本腳本唔應該動到佢）
    if not exists (
        select 1 from pg_class
        where oid = 'public.profiles'::regclass and relrowsecurity
    ) then
        raise exception '❌ profiles 的 RLS 被關掉了，請立即重跑 schema.sql 第 4 節。';
    end if;

    -- ③ RLS 政策必須齊全（4 條：select / insert / update / delete）
    select count(*) into bad_rows
      from pg_policies
     where schemaname = 'public' and tablename = 'profiles';
    if bad_rows <> 4 then
        raise exception '❌ profiles 的 RLS 政策數目係 %，預期係 4（權限隔離被破壞）。', bad_rows;
    end if;

    -- ④ anon 必須完全冇權限
    --    ⚠ select 同 insert 係「獨立授權」，必須分開查。
    --      只查 select 會漏掉「讀唔到但寫得入」呢種更危險嘅中間狀態。
    if exists (select 1 from pg_roles where rolname = 'anon') then
        if has_table_privilege('anon', 'public.profiles', 'select') then
            raise exception '❌ anon 仍然可以 SELECT profiles —— 第 3 節嘅 revoke 冇生效。';
        end if;
        if has_table_privilege('anon', 'public.profiles', 'insert') then
            raise exception '❌ anon 仍然可以 INSERT profiles —— 第 3 節嘅 revoke 冇生效。';
        end if;
    end if;

    -- ⑤ 已登入者必須仍有讀寫權限，否則前端 PostgREST 會 401
    if not has_table_privilege('authenticated', 'public.profiles', 'select') then
        raise exception '❌ authenticated 缺少 SELECT 權限，前端將無法同步。';
    end if;

    raise notice '✅ 欄位約束、RLS 與權限檢查全部通過。';
end
$$;

-- 同一個結果再以表格顯示一次（Supabase SQL Editor 唔一定顯示 NOTICE）
select
    (select count(*) from pg_constraint
      where conrelid = 'public.profiles'::regclass
        and conname  = 'profiles_field_guard')                   as guard_exists,
    (select pg_get_constraintdef(oid) from pg_constraint
      where conrelid = 'public.profiles'::regclass
        and conname  = 'profiles_field_guard')                   as guard_def,
    (select relrowsecurity from pg_class
      where oid = 'public.profiles'::regclass)                   as rls_enabled,
    (select count(*) from pg_policies
      where schemaname = 'public' and tablename = 'profiles')    as policy_count,
    has_table_privilege('anon',   'public.profiles', 'select')   as anon_can_read,
    has_table_privilege('anon',   'public.profiles', 'insert')   as anon_can_insert,
    has_table_privilege('authenticated', 'public.profiles', 'select') as auth_can_read,
    has_table_privilege('authenticated', 'public.profiles', 'insert') as auth_can_insert,
    -- ⚠ 必須限定 pronamespace：同名函式若存在於其他 schema，
    --    子查詢會拋 "more than one row returned"，令整份報告查詢失敗。
    (select pg_get_functiondef(oid) ~ 'left\('
       from pg_proc
      where proname = 'handle_new_user'
        and pronamespace = 'public'::regnamespace)               as trigger_truncates,
    (select count(*) from pg_trigger
      where tgrelid = 'auth.users'::regclass
        and tgname  = 'on_auth_user_created')                    as signup_trigger;


-- ============================================================================
--  附錄 A：完全照原始規格（name ≤ 50、class_id ≤ 20 且只准英數 _ -）
-- ----------------------------------------------------------------------------
--  ⚠ 不要直接執行。以下每一條都會弄壞現有功能：
--
--    1. class_id <= 20
--       自訂班級的值係 'custom:' + 名稱（custom: 本身已佔 7 字元），
--       一個叫「初二信」的自訂班級 = 'custom:初二信' = 10 字元（可以過），
--       但 14 字元以上的自訂名稱就會違反。上限 20 實質等於
--       「自訂名稱最長 13 字元」，同前端 slice(0, 20) 唔一致。
--
--    2. class_id ~ '^[a-zA-Z0-9_-]+$'
--       任何 custom: 開頭的值（含中文或冒號）一律唔符合，
--       即係「自訂班級」功能整體失效。
--
--    3. name <= 50 而未改 handle_new_user()
--       長 Email 註冊會 500（見第 2 節）。
--
--  如果你接受上述代價（例如打算一併關閉 allowCustomClass），用呢段：
--
--  alter table public.profiles drop constraint if exists profiles_field_guard;
--  alter table public.profiles
--      add constraint profiles_field_guard check (
--          char_length(name) <= 50
--          and char_length(email) <= 254
--          and char_length(provider) <= 20
--          and char_length(class_name) <= 60
--          and char_length(schedule_path) <= 200
--          and char_length(avatar) <= 400000
--          and (avatar = '' or avatar ~ '^(data:image/|https://)')
--          and char_length(class_id) <= 20
--          and class_id ~ '^[a-zA-Z0-9_-]*$'
--      );
--  -- 並且必須一併執行第 2 節的 handle_new_user() 截斷，
--  -- 以及在 scripts/config/auth-config.js 把 allowCustomClass 改為 false。
-- ============================================================================

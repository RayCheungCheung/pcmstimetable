-- ============================================================================
--  我的課表 · 拖堂紀錄雲端表（overtime_records）
-- ----------------------------------------------------------------------------
--  執行位置：Supabase → SQL Editor → New query → 貼上全部 → Run
--  前置條件：supabase/schema.sql 已執行（profiles 存在、auth 已可用）。
--  本腳本可重複執行（idempotent），重複 Run 只會收斂到同一結構。
--
--  【為什麼要開新表而唔係塞入 profiles】
--    profiles 係「一人一列」嘅帳號鏡像（RLS 政策係 auth.uid() = id），
--    拖堂紀錄係「一個帳號多筆、而且全部人要互相睇到」嘅共享資料。
--    兩者嘅存取模型相反，硬塞入 profiles 就要為每一列改政策，權限一定越搞越鬆。
--
--  【同 schema.sql 一樣嘅三個慣例，本檔照跟】
--    ① 建表後立即「逐欄自我修復」（add column if not exists）：
--       create table if not exists 遇到「表已存在但欄位唔齊」會靜靜乜都唔做。
--    ② 前端淨化擋唔住 DevTools 直接打 PostgREST，所以長度／範圍約束要放一份
--       喺資料庫（overtime_records_field_guard）。
--    ③ 結尾有「會真正執行」嘅結構驗證，見到 ✅ 才代表全部到位。
--
--  ⚠ 本檔與需求規格有一處刻意增補：user_id 用 uuid（而唔係 text），並且
--    預設 auth.uid()、外鍵指向 auth.users。原因見第 1 節註解 —— 用 text 就
--    冇任何東西阻止人亂填別人嘅 id，而 uuid + 外鍵令「提交者身分」由資料庫
--    保證。前端送嘅仍然係同一個帳號 id，介面上完全冇分別。
-- ============================================================================


-- ----------------------------------------------------------------------------
--  1. overtime_records：每次拖堂一筆原始紀錄（只新增，永不改寫）
-- ----------------------------------------------------------------------------
--  ⚠ teacher_name 存「課表原字串」，唔預先拆協同教學（"徐梓駿/蕭沛強"）：
--    紀錄係課表嘅忠實副本，拆名係統計階段嘅事（見 overtime_leaderboard()）。
--    一旦喺寫入時拆開，"邊一筆屬於邊一堂課" 就永遠查唔返。
--  ⚠ user_id 唔可以俾前端自由指定：RLS 會用 auth.uid() = user_id 把關，
--    所以欄位型別必須係 uuid 而唔係 text（text 的話 '唔係uuid' 一樣寫得入）。
--    on delete set null：帳號被刪除時紀錄要保留（排行榜係共享數據，
--    刪一個帳號唔應該令其他班嘅歷史數字無故縮水）。
-- ----------------------------------------------------------------------------

create table if not exists public.overtime_records (
    id               uuid        primary key default gen_random_uuid(),
    -- created_at 由伺服器寫入，前端唔可以自行指定：裝置時鐘不準就會排錯次序
    created_at       timestamptz not null default now(),
    teacher_name     text        not null default '',
    subject          text        not null default '',
    class_name       text        not null default '',
    duration_seconds integer     not null default 0,
    -- 提交者（正班帳號）。省略時由資料庫直接填 auth.uid()，前端一樣會明送。
    user_id          uuid        default auth.uid() references auth.users (id) on delete set null
);

comment on table  public.overtime_records                  is '拖堂原始紀錄（每次拖堂一筆，只新增不改寫）';
comment on column public.overtime_records.teacher_name     is '課表上的老師原字串，協同教學形如 "徐梓駿/蕭沛強"，唔拆開';
comment on column public.overtime_records.duration_seconds is '拖堂秒數，1 ~ 14400（4 小時，超過當作忘記停止）';
comment on column public.overtime_records.user_id          is '提交者帳號（auth.uid()），帳號刪除後置 NULL 但紀錄保留';

-- 排行榜係「依老師聚合」，呢條索引令 group by 唔使全表掃描
create index if not exists overtime_records_teacher_idx
    on public.overtime_records (teacher_name);
-- 稽核／除錯用：睇最近提交
create index if not exists overtime_records_created_at_idx
    on public.overtime_records (created_at desc);


-- ----------------------------------------------------------------------------
--  1b. 結構自我修復（⚠ create table if not exists 會靜靜跳過，唔可以只靠上面）
-- ----------------------------------------------------------------------------
--  真實個案（同 schema.sql 中過嘅招一樣）：若你執行過早期版本嘅建表腳本
--  （例如只有 id / teacher_name / duration_seconds），再執行本檔時
--  create table if not exists 會被跳過，SQL Editor 照樣顯示 Success，
--  結果 subject / class_name / user_id 三欄永遠唔存在，
--  要等到「學生第一次停止計時」才爆 400，極難排查。
-- ----------------------------------------------------------------------------

alter table public.overtime_records add column if not exists created_at       timestamptz not null default now();
alter table public.overtime_records add column if not exists teacher_name     text        not null default '';
alter table public.overtime_records add column if not exists subject          text        not null default '';
alter table public.overtime_records add column if not exists class_name       text        not null default '';
alter table public.overtime_records add column if not exists duration_seconds integer     not null default 0;
alter table public.overtime_records add column if not exists user_id          uuid        default auth.uid();

-- 主鍵與外鍵：由舊腳本建立嘅表可能兩者都缺
do $$
begin
    if not exists (
        select 1 from pg_constraint
        where conrelid = 'public.overtime_records'::regclass and contype = 'p'
    ) then
        alter table public.overtime_records add constraint overtime_records_pkey primary key (id);
    end if;

    if not exists (
        select 1 from pg_constraint
        where conrelid  = 'public.overtime_records'::regclass
          and contype   = 'f'
          and confrelid = 'auth.users'::regclass
    ) then
        alter table public.overtime_records
            add constraint overtime_records_user_id_fkey
            foreign key (user_id) references auth.users (id) on delete set null;
    end if;
end
$$;


-- ----------------------------------------------------------------------------
--  1c. 加固前稽核（⚠ 刻意排喺 1b 之後，唔可以搬到最前面）
-- ----------------------------------------------------------------------------
--  為什麼需要稽核：下面 1d 嘅 ALTER TABLE ... ADD CONSTRAINT ... CHECK 會
--  驗證「所有既有列」。只要有一列唔符合，整條語句就會原子性失敗 ——
--  約束唔會建立，SQL Editor 只彈一句紅字，好容易誤以為「加固已完成」。
--  所以先量度，後動手（同 security-hardening.sql 嘅做法一致）。
--
--  ⚠ 呢段刻意放喺建表之後而唔係最前面：稽核要引用 overtime_records，
--    若排喺第 1 節之前，首次執行（表仲未存在）就會整個 batch 報
--    "relation does not exist"，連建表都一齊回滾，SQL Editor 亦唔會
--    話你「其實只係稽核跑得太早」。
--
--  期望值：violations 全部 = 0。首次建表時（表係空）必然全 0；
--  若然喺已有資料嘅表上重複執行本檔，請先單獨跑呢段，確認全 0 才繼續。
-- ----------------------------------------------------------------------------

select 'teacher_name_empty'   as check_item, count(*) as violations
  from public.overtime_records where btrim(coalesce(teacher_name, '')) = ''
union all
select 'duration_out_of_range', count(*)
  from public.overtime_records
 where duration_seconds is null or duration_seconds < 1 or duration_seconds > 14400
union all
select 'teacher_name_over_120', count(*)
  from public.overtime_records where char_length(coalesce(teacher_name, '')) > 120
union all
select 'subject_over_60', count(*)
  from public.overtime_records where char_length(coalesce(subject, '')) > 60
union all
select 'class_name_over_60', count(*)
  from public.overtime_records where char_length(coalesce(class_name, '')) > 60
union all
select 'user_id_orphan', count(*)
  from public.overtime_records r
 where r.user_id is not null
   and not exists (select 1 from auth.users u where u.id = r.user_id);


-- ----------------------------------------------------------------------------
--  1d. 伺服器端欄位防護（CHECK 約束）
-- ----------------------------------------------------------------------------
--  前端（overtime.js）嘅守門員只擋得住正常使用路徑。任何人都可以打開
--  DevTools 直接對 PostgREST 發請求，或者用改過嘅前端推資料入嚟。
--  唯一無法繞過嘅防線係寫在資料庫嘅約束。
--
--  ⚠ 秒數範圍必須同 overtime.js 嘅 OVERTIME_MAX_SECONDS（4 * 60 * 60）一致，
--    否則會出現「前端話送得出、伺服器話唔收」嘅落差。
--  ⚠ teacher_name 唔可以係空：冇老師＝冇得歸帳，呢種列會變成排行榜上
--    一個永遠排第一嘅空白名字。
-- ----------------------------------------------------------------------------

do $$
begin
    if not exists (
        select 1 from pg_constraint
        where conrelid = 'public.overtime_records'::regclass
          and conname  = 'overtime_records_field_guard'
    ) then
        alter table public.overtime_records
            add constraint overtime_records_field_guard check (
                btrim(teacher_name) <> ''
            and char_length(teacher_name) <= 120
            and char_length(subject)      <= 60
            and char_length(class_name)   <= 60
            and duration_seconds between 1 and 14400
            );
    end if;
end
$$;


-- ----------------------------------------------------------------------------
--  2. Row Level Security：共享排行榜（全體可讀）、只可寫自己嗰筆
-- ----------------------------------------------------------------------------
--  ⚠ 呢度嘅 SELECT 政策刻意係 using (true) 而唔係 auth.uid() = user_id：
--    需求本身就要「即時統計正班全體同學提交之拖堂數據」，排行榜一定要
--    睇得到別人嘅紀錄。所以本表嘅私隱設計係：
--      · 讀 ＝ 所有已登入者（共享排行榜），未登入（anon）一律讀唔到；
--      · 寫 ＝ 只可以 INSERT，而且 user_id 必須等於自己（偽造唔到提交者）；
--      · 改／刪 ＝ 完全冇政策，即係冇人可以改寫或刪除別人嘅歷史紀錄。
--    若日後要收窄（例如只顯示同班），改嘅係呢條政策，前端唔需要動。
-- ----------------------------------------------------------------------------

alter table public.overtime_records enable row level security;

-- 舊政策先移除，令本腳本可以重複執行
drop policy if exists overtime_records_select_shared on public.overtime_records;
drop policy if exists overtime_records_insert_own    on public.overtime_records;
drop policy if exists overtime_records_delete_own    on public.overtime_records;
drop policy if exists overtime_records_update_own    on public.overtime_records;

create policy overtime_records_select_shared on public.overtime_records
    for select to authenticated
    using (true);

create policy overtime_records_insert_own on public.overtime_records
    for insert to authenticated
    with check (auth.uid() = user_id);

-- ⚠ 刻意冇 update / delete 政策：紀錄係「只新增」嘅歷史數據。


-- ----------------------------------------------------------------------------
--  3. 權限：已登入者才可讀寫，未登入（anon）一律拒絕
-- ----------------------------------------------------------------------------
--  ⚠ revoke 要同時針對 anon 同 PUBLIC：只寫其中一個，另一個殘留嘅預設授權
--    仍然「連得成」該表（即使 RLS 會令查詢回傳 0 列）。
--  ⚠ update / delete 亦要明確 revoke：本表設計上 append-only，
--    多一條不必要嘅存取路徑就係多一個攻擊面。
-- ----------------------------------------------------------------------------

grant usage on schema public to authenticated;
grant select, insert on public.overtime_records to authenticated;

revoke update, delete on public.overtime_records from authenticated;
revoke all on public.overtime_records from anon;
revoke all on public.overtime_records from public;


-- ----------------------------------------------------------------------------
--  4. 排行榜聚合函數：SUM(duration_seconds) + COUNT(*) GROUP BY teacher_name
-- ----------------------------------------------------------------------------
--  【為什麼放喺資料庫而唔係前端自己 group by】
--    ① 免傳輸：全班累積落去係幾千筆，前端只需收 10 行；
--    ② 一致：任何客戶端（舊版前端、DevTools）睇到嘅數字都係同一個計算，
--       唔會出現「兩個裝置排行榜唔同」；
--    ③ 拆協同教學嘅規則只有一份（見下方 regexp_split_to_table）。
--
--  ⚠ 協同教學（"徐梓駿/蕭沛強"）拆成兩位老師，各記全額秒數，唔對半分：
--     同一堂課確實係兩位老師一齊拖。對半分（各 30 秒）係一個冇人驗證得到
--     嘅數字，而且對半之後兩位都排唔上頭，個榜就失去意義。
--     ⇒ 因此「各人之和」會大於「課堂總拖堂時數」，係刻意嘅，唔係計錯數。
--  ⚠ 拆名規則必須同 overtime.js 嘅 OVERTIME_TEACHER_SPLIT 完全一致
--     （/ 、 , ， & 五者），否則同一批資料喺雲端榜同本機榜會出兩個名。
--  ⚠ security invoker（而唔係 definer）：函數以呼叫者身分執行，
--     RLS 照樣生效。用 definer 就等於開一個繞過 RLS 嘅後門。
--  ⚠ search_path 必須寫死：Supabase 上 public schema 可以被搜尋路徑偏移，
--     唔寫死就有機會被誘導去讀 attacker 自建嘅同名物件。
-- ----------------------------------------------------------------------------

create or replace function public.overtime_leaderboard(max_rows integer default 10)
returns table (
    teacher_name  text,
    total_seconds bigint,
    record_count  bigint,
    subjects      text[],
    classes       text[]
)
language sql
stable
security invoker
set search_path = public
as $$
    with expanded as (
        -- 一筆紀錄有幾位老師就展開成幾行，之後才 group by 名字
        -- ⚠ 一定要寫明欄位別名 t(part)：函數直接寫 AS t 係「整個別名當一欄」，
        --   日後若要改寫成多欄函數就會靜靜壞掉。
        select
            btrim(t.part)       as teacher_name,
            r.subject           as subject,
            r.class_name        as class_name,
            r.duration_seconds  as duration_seconds
          from public.overtime_records r
          cross join lateral regexp_split_to_table(r.teacher_name, '[/、,，&]') as t(part)
         where btrim(t.part) <> ''
    )
    select
        e.teacher_name,
        sum(e.duration_seconds)::bigint                             as total_seconds,
        count(*)::bigint                                            as record_count,
        -- 科目／班級：前端頒獎台同 4~10 名列表都要顯示，所以在伺服器一次過
        -- 聚好（array_agg(distinct …) 已經去重，空格者唔收）。
        -- ⚠ array_agg 一定要寫 order by：唔寫嘅話同一次查詢兩次嘅排序可以
        --   唔同，頒獎台上顯示嘅科目／班級就會每次重畫都跳一下。
        coalesce(array_agg(distinct e.subject    order by e.subject)    filter (where e.subject    <> ''), '{}') as subjects,
        coalesce(array_agg(distinct e.class_name order by e.class_name) filter (where e.class_name <> ''), '{}') as classes
      from expanded e
     group by e.teacher_name
     -- 同分以姓名排，令榜單重繪時唔會跳位（同 overtime.js 嘅排序一致）
     -- ⚠ 呢度刻意重寫一次 sum(...) 而唔寫輸出欄名 total_seconds：
     --   returns table 嘅 OUT 參數就叫 total_seconds，ORDER BY 用同名會撞到
     --   參數而變成 "column reference is ambiguous"（要等到呼叫時才爆）。
     order by sum(e.duration_seconds) desc, e.teacher_name asc
     -- 上限夾在 1 ~ 50：前端只會送 10，但 PostgREST 可以被直接呼叫
     limit greatest(1, least(coalesce(max_rows, 10), 50));
$$;

comment on function public.overtime_leaderboard(integer) is
    '老師拖堂排行榜：依老師聚合 SUM(duration_seconds) + COUNT(*)，協同教學拆名各記全額';

grant execute on function public.overtime_leaderboard(integer) to authenticated;
revoke all on function public.overtime_leaderboard(integer) from anon;
revoke all on function public.overtime_leaderboard(integer) from public;


-- ----------------------------------------------------------------------------
--  5. 結構自動驗證（⚠ 唔係註解，係會真正執行嘅檢查）
-- ----------------------------------------------------------------------------
--  目的：把「建表被靜靜跳過」呢種故障，由「靜默成功」變成「大聲失敗」。
--  見到 ✅ 就代表結構、RLS、權限、函數四者都真正到位。
-- ----------------------------------------------------------------------------

do $$
declare
    missing_columns text;
begin
    -- ① 欄位齊全檢查（7 欄，對應需求規格）
    select string_agg(required.colname, ', ' order by required.colname)
      into missing_columns
      from (values
                ('id'), ('created_at'), ('teacher_name'), ('subject'),
                ('class_name'), ('duration_seconds'), ('user_id')
           ) as required(colname)
     where not exists (
               select 1 from information_schema.columns c
                where c.table_schema = 'public'
                  and c.table_name   = 'overtime_records'
                  and c.column_name  = required.colname
           );

    if missing_columns is not null then
        raise exception '❌ overtime_records 缺少欄位：%。請確認第 1b 節嘅 alter table 有冇被跳過。', missing_columns;
    end if;

    -- ② Row Level Security 必須開啟
    if not exists (
        select 1 from pg_class
        where oid = 'public.overtime_records'::regclass and relrowsecurity
    ) then
        raise exception '❌ overtime_records 未啟用 Row Level Security。';
    end if;

    -- ③ 兩條必要政策都要在（讀共享、寫自己）
    if not exists (
        select 1 from pg_policies
        where schemaname = 'public' and tablename = 'overtime_records'
          and policyname = 'overtime_records_select_shared'
    ) then
        raise exception '❌ 缺少 overtime_records_select_shared 政策，排行榜會讀唔到任何資料。';
    end if;
    if not exists (
        select 1 from pg_policies
        where schemaname = 'public' and tablename = 'overtime_records'
          and policyname = 'overtime_records_insert_own'
    ) then
        raise exception '❌ 缺少 overtime_records_insert_own 政策，學生會提交唔到紀錄。';
    end if;

    -- ④ anon 必須完全冇權限（最小權限原則）
    if exists (select 1 from pg_roles where rolname = 'anon') then
        if has_table_privilege('anon', 'public.overtime_records', 'select') then
            raise exception '❌ anon 角色仍然可以 SELECT overtime_records，最小權限未達成。';
        end if;
    end if;

    -- ⑤ 已登入者必須有讀寫權限（否則前端 PostgREST 會 401）
    if not has_table_privilege('authenticated', 'public.overtime_records', 'select') then
        raise exception '❌ authenticated 缺少 overtime_records 的 SELECT 權限，排行榜將無法載入。';
    end if;
    if not has_table_privilege('authenticated', 'public.overtime_records', 'insert') then
        raise exception '❌ authenticated 缺少 overtime_records 的 INSERT 權限，前端將無法提交紀錄。';
    end if;

    -- ⑥ 聚合函數必須存在而且已授權
    if to_regprocedure('public.overtime_leaderboard(integer)') is null then
        raise exception '❌ 找不到 public.overtime_leaderboard(integer)，第 4 節有冇跑到？';
    end if;
    if not has_function_privilege('authenticated', 'public.overtime_leaderboard(integer)', 'execute') then
        raise exception '❌ authenticated 冇 execute 權限，排行榜 RPC 會回 401。';
    end if;

    -- ⑦ 真正執行一次：函數「存在」唔代表「跑得起」。
    --    最常見嘅失敗係 SQL 函數入面嘅欄名歧義（OUT 參數同欄位同名），
    --    呢種錯要等到第一次呼叫才會爆 —— 而第一次呼叫就係學生開排行榜嗰刻。
    --    喺度先跑一次，把故障提早到安裝階段。
    perform * from public.overtime_leaderboard(1);

    raise notice '✅ overtime_records 結構、RLS、權限與聚合函數檢查全部通過。';
end
$$;

-- 上面嘅 DO 區塊若通過就唔會顯示任何訊息（Supabase SQL Editor 唔一定顯示 NOTICE），
-- 所以最後補一個 SELECT：結果會以表格顯示在下方，一眼睇得出是否正確。
-- 期望值：columns_found = 7、rls_enabled = true、
--         anon_can_read = false、auth_can_read = true、auth_can_insert = true。
select
    (select count(*) from information_schema.columns
      where table_schema = 'public' and table_name = 'overtime_records')        as columns_found,
    (select relrowsecurity from pg_class
      where oid = 'public.overtime_records'::regclass)                          as rls_enabled,
    has_table_privilege('anon', 'public.overtime_records', 'select')            as anon_can_read,
    has_table_privilege('authenticated', 'public.overtime_records', 'select')   as auth_can_read,
    has_table_privilege('authenticated', 'public.overtime_records', 'insert')   as auth_can_insert,
    to_regprocedure('public.overtime_leaderboard(integer)') is not null         as leaderboard_rpc_ready;

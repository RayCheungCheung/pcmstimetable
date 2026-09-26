// ============================================================================
//  我的課表 · 雲端帳號 API（Google Apps Script + Google Sheets）
// ----------------------------------------------------------------------------
//  部署步驟：
//   1. 開一個 Google 試算表 →「擴充功能」→「Apps Script」
//   2. 把本檔全部內容貼進 Code.gs（覆蓋原本內容）→ 儲存
//   3. 右上「部署」→「新增部署作業」→ 類型選「網頁應用程式」
//        · 執行身分：我
//        · 可存取權：任何人（Anyone）
//   4. 複製產生的 /exec 網址，貼到本專案的 scripts/config/auth-config.js
//        的 cloud.endpoint 欄位
//
//  ⚠ 一定要選「任何人」：否則瀏覽器 fetch 會被 Google 的登入頁攔截，
//    回應會是 HTML 登入頁而唔係 JSON，前端會直接當成連線失敗。
//
//  ⚠ 關於 CORS：Apps Script 的 ContentService **無法**自訂回應標頭，
//    所以下面唔會（亦無法）手動加 Access-Control-Allow-Origin。
//    真正令 CORS 通過的做法係「唔觸發 preflight」：
//      · 前端用 Content-Type: text/plain;charset=utf-8 發 POST
//        （簡單請求 → 瀏覽器唔會先送 OPTIONS）
//      · /exec 部署本身會回應 Access-Control-Allow-Origin: *
//    如果前端改用 application/json，瀏覽器會先送 OPTIONS，
//    而 Apps Script 唔會處理 OPTIONS，請求會直接失敗。
//    doGet 另外支援 ?callback=xxx 的 JSONP 後備通道（極舊環境用）。
//
//  API 一覽（POST 內文 JSON；GET 用 query string，參數相同）：
//    {action:'ping'}                              連線測試
//    {action:'salt',  email}                      取得密碼鹽（登入第一步）
//    {action:'login', email, passwordHash}         登入驗證
//    {action:'register', account:{...}}            註冊
//    {action:'update', id, patch:{...}}            更新個人資料
//    {action:'get',   id | email}                  讀取單一帳號（已遮蔽密碼）
//    {action:'list'}                               讀取全部帳號（已遮蔽密碼）
//    {action:'bulkUpsert', accounts:[...]}         離線佇列批次補送
//    {action:'delete', id}                         刪除帳號
//
//  回傳格式一律為：
//    {status:'success', ...}  或  {status:'error', code:'...', message:'...'}
// ============================================================================

/* ======================= 設定 ======================= */

var SHEET_NAME = 'Accounts';        // 儲存帳號的工作表名稱（不存在會自動建立）

// 工作表欄位（同時是自動建立時的標頭順序）。
// 讀取時係按「實際標頭名稱」對應，所以你可以任意調換欄位次序、
// 甚至加自己的備註欄，都唔會讀錯資料。
var HEADERS = [
    'id',
    'email',          // 登入帳號（正規化為小寫）
    'username',       // 顯示用名稱（與 name 同步，方便你在 Sheet 直接睇）
    'name',
    'passwordHash',   // 雜湊值，格式 "sha256:<hex>"，嚴禁明碼
    'salt',
    'classId',        // 例如 junior2-xin / custom:初二信 / S2C
    'className',      // 中文班名，例如 初二信
    'schedulePath',   // 課表檔案路徑（可空）
    'customClass',    // TRUE / FALSE
    'provider',       // email / local
    'avatar',         // dataURL (Base64) 或圖片網址
    'createdAt',
    'lastLoginAt',
    'updatedAt'       // 最後更新時間（ISO 8601，由伺服器寫入）
];

var SCRIPT_VERSION = '1.0.0';

/* ======================= 進入點 ======================= */

function doGet(e) {
    return handleRequest(e, 'GET');
}

function doPost(e) {
    return handleRequest(e, 'POST');
}

/**
 * 統一入口：解析參數 → 分派 action → 輸出 JSON。
 * @param {Object} e       Apps Script 事件物件
 * @param {string} method  'GET' | 'POST'
 */
function handleRequest(e, method) {
    var params = (e && e.parameter) || {};
    var callback = params.callback || '';       // JSONP 後備通道

    try {
        var payload = {};

        if (method === 'POST' && e && e.postData && e.postData.contents) {
            try {
                payload = JSON.parse(e.postData.contents) || {};
            } catch (parseError) {
                // 有些環境會把 JSON 塞在 parameter 而唔係 postData
                payload = params;
            }
        } else {
            payload = params;
        }

        var action = String(payload.action || params.action || '').trim();
        if (!action) {
            return jsonOut({ status: 'error', code: 'NO_ACTION', message: '缺少 action 參數' }, callback);
        }

        return jsonOut(dispatch(action, payload), callback);

    } catch (error) {
        return jsonOut({
            status: 'error',
            code: 'SERVER_ERROR',
            message: String((error && error.message) || error)
        }, callback);
    }
}

/** 動作分派表 */
function dispatch(action, payload) {
    switch (action) {
        case 'ping':       return actionPing();
        case 'salt':       return actionSalt(payload);
        case 'login':      return actionLogin(payload);
        case 'register':   return actionRegister(payload);
        case 'update':     return actionUpdate(payload);
        case 'get':        return actionGet(payload);
        case 'list':       return actionList();
        case 'bulkUpsert': return actionBulkUpsert(payload);
        case 'delete':     return actionDelete(payload);
        default:
            return { status: 'error', code: 'UNKNOWN_ACTION', message: '不支援的 action：' + action };
    }
}

/* ======================= 各項動作 ======================= */

function actionPing() {
    var sheet = getSheet();
    return {
        status: 'success',
        version: SCRIPT_VERSION,
        sheet: sheet.getName(),
        rows: Math.max(0, sheet.getLastRow() - 1),
        serverTime: new Date().toISOString()
    };
}

/**
 * 登入第一步：用 email 取得 salt。
 * salt 唔係秘密（它的作用只是令相同密碼產生唔同雜湊），可以安全傳回前端；
 * passwordHash 則絕對唔會在這一步回傳。
 */
function actionSalt(payload) {
    var email = normalizeEmail(payload.email);
    if (!email) return { status: 'error', code: 'BAD_REQUEST', message: '缺少 email' };

    var record = findByEmail(email);
    if (!record) return { status: 'error', code: 'NO_ACCOUNT', message: '找不到這個 Email 的帳號' };

    return { status: 'success', salt: String(record.salt || '') };
}

/**
 * 登入驗證：前端已用 salt 計好 passwordHash 才送過來，
 * 明碼密碼永遠唔會離開裝置。
 * 驗證成功才回傳完整記錄（含 salt / passwordHash），
 * 因為前端要把這份記錄快取到 localStorage 做「離線登入」。
 */
function actionLogin(payload) {
    var email = normalizeEmail(payload.email);
    var passwordHash = String(payload.passwordHash || '');

    if (!email || !passwordHash) {
        return { status: 'error', code: 'BAD_REQUEST', message: '缺少 email 或 passwordHash' };
    }

    var sheet = getSheet();
    var record = findByEmail(email);

    if (!record) return { status: 'error', code: 'NO_ACCOUNT', message: '找不到這個 Email 的帳號' };
    if (!record.passwordHash) {
        return { status: 'error', code: 'NO_PASSWORD', message: '這個帳號不是用密碼登入的' };
    }
    if (String(record.passwordHash) !== passwordHash) {
        return { status: 'error', code: 'BAD_PASSWORD', message: '密碼不正確' };
    }

    // 更新最後登入時間（唯一一個「登入時就會寫入」的欄位）
    var now = new Date().toISOString();
    sheet.getRange(record.__row, headerIndexMap(sheet)['lastLoginAt'] + 1).setValue(now);
    record.lastLoginAt = now;

    return { status: 'success', account: toClientAccount(record, true) };
}

/**
 * 註冊。email 已存在 → EMAIL_EXISTS，前端會提示改用登入。
 */
function actionRegister(payload) {
    var account = payload.account || payload;
    var email = normalizeEmail(account.email);
    var id = String(account.id || '').trim();

    if (!email) return { status: 'error', code: 'BAD_REQUEST', message: '缺少 email' };
    if (!id) id = 'acc_' + Utilities.getUuid().replace(/-/g, '').slice(0, 12);
    if (!account.passwordHash || !account.salt) {
        return { status: 'error', code: 'BAD_REQUEST', message: '缺少 passwordHash 或 salt' };
    }

    var lock = LockService.getScriptLock();
    lock.waitLock(15000);                       // 防兩個裝置同時註冊同一個 email
    try {
        if (findByEmail(email)) {
            return { status: 'error', code: 'EMAIL_EXISTS', message: '這個 Email 已經註冊過了' };
        }
        if (findById(id)) {
            return { status: 'error', code: 'ID_EXISTS', message: '帳號識別碼重複' };
        }

        var now = new Date().toISOString();
        var record = {
            id: id,
            email: email,
            username: String(account.name || ''),
            name: String(account.name || ''),
            passwordHash: String(account.passwordHash || ''),
            salt: String(account.salt || ''),
            classId: String(account.classId || ''),
            className: String(account.className || ''),
            schedulePath: String(account.schedulePath || ''),
            customClass: account.customClass ? 'TRUE' : 'FALSE',
            provider: String(account.provider || 'email'),
            avatar: String(account.avatar || ''),
            createdAt: account.createdAt ? toIso(account.createdAt) : now,
            lastLoginAt: now,
            updatedAt: now
        };

        appendRecord(record);
        return { status: 'success', account: toClientAccount(record, true) };
    } finally {
        lock.releaseLock();
    }
}

/**
 * 更新個人資料（更換班級、頭像、密碼…）。
 * patch 只可以包含白名單欄位，避免前端誤改 id / createdAt。
 */
function actionUpdate(payload) {
    var id = String(payload.id || '').trim();
    var patch = payload.patch || {};

    if (!id) return { status: 'error', code: 'BAD_REQUEST', message: '缺少 id' };

    var allowed = ['name', 'username', 'email', 'passwordHash', 'salt', 'classId',
                   'className', 'schedulePath', 'customClass', 'provider', 'avatar'];

    var lock = LockService.getScriptLock();
    lock.waitLock(15000);
    try {
        var sheet = getSheet();
        var record = findById(id);
        if (!record) return { status: 'error', code: 'NO_ACCOUNT', message: '找不到這個帳號' };

        var map = headerIndexMap(sheet);
        var now = new Date().toISOString();
        var touched = false;

        allowed.forEach(function (key) {
            if (!Object.prototype.hasOwnProperty.call(patch, key)) return;
            if (map[key] === undefined) return;

            var value = patch[key];
            if (key === 'email') value = normalizeEmail(value);
            if (key === 'customClass') value = value ? 'TRUE' : 'FALSE';
            if (value === null || value === undefined) value = '';

            sheet.getRange(record.__row, map[key] + 1).setValue(value);
            record[key] = value;
            touched = true;
        });

        if (!touched) {
            return { status: 'error', code: 'NOTHING_TO_UPDATE', message: '沒有可更新的欄位' };
        }

        if (map['updatedAt'] !== undefined) {
            sheet.getRange(record.__row, map['updatedAt'] + 1).setValue(now);
            record.updatedAt = now;
        }

        return { status: 'success', account: toClientAccount(record, true) };
    } finally {
        lock.releaseLock();
    }
}

/** 讀取單一帳號（不含密碼欄位） */
function actionGet(payload) {
    var id = String(payload.id || '').trim();
    var email = normalizeEmail(payload.email);
    if (!id && !email) {
        return { status: 'error', code: 'BAD_REQUEST', message: '缺少 id 或 email' };
    }

    var record = id ? findById(id) : findByEmail(email);
    if (!record) return { status: 'error', code: 'NO_ACCOUNT', message: '找不到這個帳號' };

    return { status: 'success', account: toClientAccount(record, false) };
}

/** 讀取全部帳號（不含密碼欄位；純本機帳號清單同步用） */
function actionList() {
    return {
        status: 'success',
        accounts: readAll().map(function (record) {
            return toClientAccount(record, false);
        })
    };
}

/**
 * 批次新增／更新。前端離線期間累積的寫入會用這個 action 一次補送，
 * 避免逐筆往返（Apps Script 每次請求約需 0.5~1.5 秒）。
 */
function actionBulkUpsert(payload) {
    var list = payload.accounts;
    if (!Array.isArray(list) || !list.length) {
        return { status: 'error', code: 'BAD_REQUEST', message: '缺少 accounts 陣列' };
    }

    var lock = LockService.getScriptLock();
    lock.waitLock(30000);
    try {
        var sheet = getSheet();
        var map = headerIndexMap(sheet);
        var now = new Date().toISOString();
        var applied = 0;

        list.forEach(function (account) {
            if (!account || !account.id) return;
            var email = normalizeEmail(account.email);

            var record = findById(account.id);
            if (!record && email) record = findByEmail(email);

            if (record) {
                // 更新：只覆寫前端送來的欄位
                var fields = {};
                Object.keys(account).forEach(function (key) {
                    if (map[key] !== undefined && key !== 'id' && key !== 'createdAt') {
                        fields[key] = account[key];
                    }
                });
                fields.updatedAt = now;
                var row = record.__row;
                Object.keys(fields).forEach(function (key) {
                    var value = fields[key];
                    if (key === 'customClass') value = value ? 'TRUE' : 'FALSE';
                    if (value === null || value === undefined) value = '';
                    sheet.getRange(row, map[key] + 1).setValue(value);
                });
            } else {
                appendRecord({
                    id: String(account.id),
                    email: email,
                    username: String(account.name || ''),
                    name: String(account.name || ''),
                    passwordHash: String(account.passwordHash || ''),
                    salt: String(account.salt || ''),
                    classId: String(account.classId || ''),
                    className: String(account.className || ''),
                    schedulePath: String(account.schedulePath || ''),
                    customClass: account.customClass ? 'TRUE' : 'FALSE',
                    provider: String(account.provider || 'email'),
                    avatar: String(account.avatar || ''),
                    createdAt: account.createdAt ? toIso(account.createdAt) : now,
                    lastLoginAt: account.lastLoginAt ? toIso(account.lastLoginAt) : now,
                    updatedAt: now
                });
            }
            applied += 1;
        });

        return { status: 'success', applied: applied, serverTime: now };
    } finally {
        lock.releaseLock();
    }
}

/** 刪除帳號（清掉整列） */
function actionDelete(payload) {
    var id = String(payload.id || '').trim();
    if (!id) return { status: 'error', code: 'BAD_REQUEST', message: '缺少 id' };

    var lock = LockService.getScriptLock();
    lock.waitLock(15000);
    try {
        var sheet = getSheet();
        var record = findById(id);
        if (!record) return { status: 'error', code: 'NO_ACCOUNT', message: '找不到這個帳號' };

        sheet.deleteRow(record.__row);
        return { status: 'success', deleted: id };
    } finally {
        lock.releaseLock();
    }
}

/* ======================= 工作表存取 ======================= */

function getSheet() {
    var book = SpreadsheetApp.getActiveSpreadsheet();
    var sheet = book.getSheetByName(SHEET_NAME);

    if (!sheet) {
        sheet = book.insertSheet(SHEET_NAME);
    }

    // 空白或未有標頭 → 補上標準欄位（唔會覆蓋已有資料）
    if (sheet.getLastRow() === 0 || String(sheet.getRange(1, 1).getValue()).trim() === '') {
        sheet.getRange(1, 1, 1, HEADERS.length).setValues([HEADERS]);
        sheet.setFrozenRows(1);
        sheet.getRange(1, 1, 1, HEADERS.length).setFontWeight('bold');
    }

    return sheet;
}

/** 讀出實際標頭列，回傳 { 欄位名: 欄索引(0-based) } */
function headerIndexMap(sheet) {
    var lastCol = Math.max(1, sheet.getLastColumn());
    var headers = sheet.getRange(1, 1, 1, lastCol).getValues()[0];
    var map = {};
    headers.forEach(function (header, index) {
        var key = String(header).trim();
        if (key && map[key] === undefined) map[key] = index;
    });
    return map;
}

/** 讀取整張表為物件陣列；每筆都帶 __row（實際列號，寫入時用） */
function readAll() {
    var sheet = getSheet();
    var lastRow = sheet.getLastRow();
    var lastCol = sheet.getLastColumn();
    if (lastRow < 2 || lastCol < 1) return [];

    var values = sheet.getRange(1, 1, lastRow, lastCol).getValues();
    var headers = values.shift().map(function (header) { return String(header).trim(); });

    return values.map(function (row, index) {
        var record = {};
        headers.forEach(function (header, column) {
            if (header) record[header] = row[column];
        });
        record.__row = index + 2;
        return record;
    }).filter(function (record) {
        return String(record.id || '').trim() !== '';   // 忽略空白列
    });
}

function findByEmail(email) {
    if (!email) return null;
    var list = readAll();
    for (var i = 0; i < list.length; i += 1) {
        if (normalizeEmail(list[i].email) === email) return list[i];
    }
    return null;
}

function findById(id) {
    if (!id) return null;
    var list = readAll();
    for (var i = 0; i < list.length; i += 1) {
        if (String(list[i].id || '').trim() === id) return list[i];
    }
    return null;
}

/** 依 HEADERS 順序把一筆記錄寫進新列 */
function appendRecord(record) {
    var sheet = getSheet();
    var row = HEADERS.map(function (key) {
        return record[key] === undefined || record[key] === null ? '' : record[key];
    });
    sheet.appendRow(row);
}

/* ======================= 輸出 ======================= */

/**
 * 把 Sheet 記錄轉成前端用的帳號物件。
 * @param {Object} record       Sheet 記錄
 * @param {boolean} withSecret  true 才附帶 salt / passwordHash（只限登入／註冊回應）
 */
function toClientAccount(record, withSecret) {
    var account = {
        id: String(record.id || ''),
        name: String(record.name || record.username || ''),
        email: normalizeEmail(record.email),
        provider: String(record.provider || 'email'),
        classId: String(record.classId || ''),
        className: String(record.className || ''),
        schedulePath: String(record.schedulePath || ''),
        customClass: String(record.customClass).toUpperCase() === 'TRUE',
        avatar: String(record.avatar || ''),
        createdAt: toMillis(record.createdAt),
        lastLoginAt: toMillis(record.lastLoginAt),
        updatedAt: toMillis(record.updatedAt)
    };

    if (withSecret) {
        account.salt = String(record.salt || '');
        account.passwordHash = String(record.passwordHash || '');
    }

    return account;
}

/**
 * CORS 說明：Access-Control-Allow-Origin 由 Apps Script 的 /exec 部署自動加上
 * （值為 *），呢度無法亦無需要手動設定。callback 有值時輸出 JSONP，
 * 方便極舊瀏覽器／沙盒環境繞過 CORS。
 */
function jsonOut(data, callback) {
    var json = JSON.stringify(data);

    if (callback) {
        return ContentService
            .createTextOutput(String(callback) + '(' + json + ');')
            .setMimeType(ContentService.MimeType.JAVASCRIPT);
    }

    return ContentService
        .createTextOutput(json)
        .setMimeType(ContentService.MimeType.JSON);
}

/* ======================= 小工具 ======================= */

function normalizeEmail(email) {
    return String(email == null ? '' : email).trim().toLowerCase();
}

/** 毫秒時間戳 / 日期字串 / Date → ISO 8601 */
function toIso(value) {
    if (!value) return new Date().toISOString();
    if (value instanceof Date) return value.toISOString();

    var num = Number(value);
    if (!isNaN(num) && num > 0) return new Date(num).toISOString();

    var parsed = new Date(value);
    return isNaN(parsed.getTime()) ? new Date().toISOString() : parsed.toISOString();
}

/** 任何時間表示 → 毫秒時間戳（前端統一用 number 比較新舊） */
function toMillis(value) {
    if (!value) return 0;
    if (value instanceof Date) return value.getTime();

    var num = Number(value);
    if (!isNaN(num) && num > 0) return num;

    var parsed = new Date(value);
    return isNaN(parsed.getTime()) ? 0 : parsed.getTime();
}

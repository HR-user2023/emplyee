/**
 * ============================================================
 *  員工特休假管理系統 - 後端程式碼 (Google Apps Script)
 *  資料庫：本 Sheet 本身（請從 Sheet 內「擴充功能 > Apps Script」開啟本專案）
 *  唯一識別：以「身份證字號」作為員工的主要識別欄位（取代原本系統自動產生的員工編號）
 * ============================================================
 */

const SHEET_EMPLOYEES = '員工資料';
const SHEET_LEAVE      = '請假紀錄';
const SHEET_CONFIG     = '系統設定';
const SHEET_PENDING_HIRE = '新進員工待審核';
const SHEET_LINE_BINDING = 'LINE綁定';
const SHEET_SCHEDULE_QUOTA = '排休設定';
const SHEET_SCHEDULE_REQUEST = '排休申請';

// 店點固定公休設定：對眼店每週一公休，其他店沒有固定公休日
// getDay() 回傳 0=週日,1=週一,...,6=週六
const STORE_CLOSURE_WEEKDAY = {
  '皮卡對眼店': 1
};

// LINE 官方帳號設定：到 LINE Developers Console 的 Messaging API 頁籤取得
// Channel Access Token；LINE_OA_ID 是官方帳號的 Basic ID（@開頭那組，用於產生加好友連結）
const LINE_CHANNEL_ACCESS_TOKEN = 'PASTE_YOUR_LINE_CHANNEL_ACCESS_TOKEN_HERE';
const LINE_OA_ID = 'PASTE_YOUR_LINE_OA_BASIC_ID_HERE'; // 例如 @123abcde
const TZ = Session.getScriptTimeZone() || 'Asia/Taipei';
const ID_FIELD = '身份證字號'; // 唯一識別欄位

// 假別設定：mode 'annual_scaling' 是特休（依年資級距遞增，到期不遞延）、
// 'annual_fixed' 是每年固定天數（事假/病假，用到職日週年制，但天數固定不隨年資變化）、
// 'event' 是一次性事件假（婚假/喪假/產假），不做自動額度檢查，天數僅供參考，交由主管人工判斷合理性。
// 天數可依貴公司實際規定調整下面的數字。
const LEAVE_TYPES = {
  '特休': { mode: 'annual_scaling' },
  '事假': { mode: 'annual_fixed', annualDays: 14 },
  '病假': { mode: 'annual_fixed', annualDays: 30 },
  '婚假': { mode: 'event', defaultDays: 8 },
  '喪假': { mode: 'event', defaultDays: 8 },
  '產假': { mode: 'event', defaultDays: 56 }
};

// 員工資料欄位定義：key 是程式內部使用的名稱，header 是 Sheet 上實際顯示的中文欄位名稱
// 如果之後要增減欄位，只需要調整這個陣列，不用改其他程式碼
// 注意：新增欄位請加在陣列「最後面」，這樣既有的試算表只需要在最後補一欄，不會打亂原本欄位的對應關係
const EMPLOYEE_FIELDS = [
  { key: 'branch',              header: '店點' },
  { key: 'employeeType',        header: '員工類型' },
  { key: 'position',            header: '職位' },
  { key: 'name',                header: '姓名' },
  { key: 'nickname',            header: '暱稱' },
  { key: 'hireDate',            header: '到職日' },
  { key: 'nationalId',          header: '身份證字號' },
  { key: 'birthDate',           header: '出生年月日' },
  { key: 'gender',              header: '性別' },
  { key: 'householdAddress',    header: '戶籍地址' },
  { key: 'mailingAddress',      header: '通訊地址' },
  { key: 'homePhone',           header: '家用電話' },
  { key: 'mobilePhone',         header: '個人手機' },
  { key: 'education',           header: '學歷' },
  { key: 'hometown',            header: '籍貫' },
  { key: 'insuranceDate',       header: '投保日期' },
  { key: 'salary',              header: '薪資' },
  { key: 'emergencyContact',    header: '緊急聯絡人' },
  { key: 'emergencyRelation',   header: '關係' },
  { key: 'emergencyPhone',      header: '緊急聯絡人手機' },
  { key: 'note',                header: '備注' },
  { key: 'ig',                  header: 'IG' },
  { key: 'lineId',              header: 'LINE ID' },
  { key: 'resignDate',          header: '離職日期' },
  { key: 'account',             header: '銀行帳號' },
  { key: 'email',               header: 'Email' }
];

// ---------- 網頁進入點 / JSON API ----------
// 這個 doGet 身兼兩個角色：
// 1. 沒有帶 action 參數 → 當作一般網頁請求，回傳 Apps Script 內嵌版的 UI（Index.html）
// 2. 有帶 action 參數 → 當作外部前端（例如 GitHub Pages 上的 PWA 版本）呼叫的 JSON API
//
// 為什麼 API 用 GET 而不是 POST？
// Google Apps Script 對 POST 請求固定會回傳 302 轉址，瀏覽器 fetch() 在自動跟隨這個轉址時，
// 有時會把原本的 POST 請求降級成 GET，導致請求資料遺失、改成呼叫到 doGet 回傳 HTML 而非 JSON。
// GET 請求在這個轉址過程中不會被降級，是 Google 官方文件示範中唯一穩定可靠的模式，所以我們的
// 自訂 API 統一改用 GET（payload 用網址參數帶過去），避免這個平台本身的已知問題。
function doGet(e) {
  if (e && e.parameter && e.parameter.action) {
    return handleApiRequest_(e.parameter.action, e.parameter.payload);
  }
  return HtmlService.createHtmlOutputFromFile('Index')
    .setTitle('特休假管理系統')
    .addMetaTag('viewport', 'width=device-width, initial-scale=1')
    .setXFrameOptionsMode(HtmlService.XFrameOptionsMode.ALLOWALL);
}

const API_ACTIONS_ = {
  findEmployee: function(p) { return findEmployee(p); },
  getLeaveSummary: function(p) { return getLeaveSummary(p.nationalId); },
  getLeaveQuota: function(p) { return getLeaveQuota(p.nationalId, p.leaveType); },
  submitLeaveRequest: function(p) { return submitLeaveRequest(p); },
  getMyLeaveRequests: function(p) { return getMyLeaveRequests(p.nationalId); },
  submitNewHireForm: function(p) { return submitNewHireForm(p); },
  adminLogin: function(p) { return adminLogin(p.email); },
  getAllEmployeesForAdmin: function(p) { return getAllEmployeesForAdmin(p.token); },
  addEmployee: function(p) { return addEmployee(p); },
  getPendingRequests: function(p) { return getPendingRequests(p.token); },
  reviewLeaveRequest: function(p) { return reviewLeaveRequest(p); },
  getPendingNewHires: function(p) { return getPendingNewHires(p.token); },
  approveNewHire: function(p) { return approveNewHire(p); },
  rejectNewHire: function(p) { return rejectNewHire(p); },
  getEmployeeDetail: function(p) { return getEmployeeDetail(p.token, p.nationalId); },
  updateEmployee: function(p) { return updateEmployee(p); },
  generateLineLinkCode: function(p) { return generateLineLinkCode(p); },
  syncAllLeaveStats: function(p) { return syncAllLeaveStats(p.token); },
  submitDayOffRequest: function(p) { return submitDayOffRequest(p); },
  getMyDayOffRequests: function(p) { return getMyDayOffRequests(p); },
  cancelDayOffRequest: function(p) { return cancelDayOffRequest(p); },
  getStoreScheduleForMonth: function(p) { return getStoreScheduleForMonth(p); },
  reviewDayOffRequest: function(p) { return reviewDayOffRequest(p); }
};

function handleApiRequest_(action, payloadStr) {
  let responseObj;
  try {
    const payload = payloadStr ? JSON.parse(payloadStr) : {};
    const fn = API_ACTIONS_[action];
    if (!fn) throw new Error('未知的操作：' + action);
    const data = fn(payload);
    responseObj = { success: true, data: data };
  } catch (err) {
    responseObj = { success: false, error: err.message };
  }
  return ContentService.createTextOutput(JSON.stringify(responseObj))
    .setMimeType(ContentService.MimeType.JSON);
}

// doPost 現在只留給 LINE Webhook 使用（LINE 平台固定送 POST，我們沒有選擇權）
function doPost(e) {
  try {
    if (e && e.postData && e.postData.contents) {
      const req = JSON.parse(e.postData.contents);
      if (req.events) {
        handleLineWebhook_(req.events);
      }
    }
  } catch (err) {
    console.error('doPost 處理失敗：' + err);
  }
  return ContentService.createTextOutput(JSON.stringify({ success: true }))
    .setMimeType(ContentService.MimeType.JSON);
}

// ---------- 試算表選單（方便初始化） ----------
function onOpen() {
  SpreadsheetApp.getUi()
    .createMenu('特休系統')
    .addItem('初始化 / 檢查資料表結構', 'setupSheets')
    .addItem('建立每日自動同步特休數據排程', 'createDailySyncTrigger')
    .addItem('顯示目前部署網址', 'showWebAppUrl')
    .addToUi();
}

function setupSheets() {
  const ss = SpreadsheetApp.getActiveSpreadsheet();

  let emp = ss.getSheetByName(SHEET_EMPLOYEES);
  if (!emp) emp = ss.insertSheet(SHEET_EMPLOYEES);
  if (emp.getLastRow() === 0) {
    const headers = EMPLOYEE_FIELDS.map(f => f.header).concat(['建立時間', '特休天數(本期)', '已用天數(本期)', '剩餘天數(本期)', '特休更新時間']);
    emp.appendRow(headers);
  }

  let leave = ss.getSheetByName(SHEET_LEAVE);
  if (!leave) leave = ss.insertSheet(SHEET_LEAVE);
  if (leave.getLastRow() === 0) {
    leave.appendRow(['申請編號', ID_FIELD, '姓名', '起始日', '結束日', '天數', '事由', '狀態', '申請時間', '審核人', '審核時間', '拒絕原因', '假別']);
  }

  let config = ss.getSheetByName(SHEET_CONFIG);
  if (!config) config = ss.insertSheet(SHEET_CONFIG);
  if (config.getLastRow() === 0) {
    config.appendRow(['管理者白名單 Email（可新增員工、審核假單）', '姓名（會記錄在請假紀錄的審核人欄位）']);
    config.appendRow(['請把這一列換成您自己的 Email', '您的姓名']);
  }

  let pending = ss.getSheetByName(SHEET_PENDING_HIRE);
  if (!pending) pending = ss.insertSheet(SHEET_PENDING_HIRE);
  if (pending.getLastRow() === 0) {
    const pendingHeaders = ['提交編號'].concat(EMPLOYEE_FIELDS.map(f => f.header)).concat(['提交時間', '狀態', '處理人', '處理時間']);
    pending.appendRow(pendingHeaders);
  }

  let lineBinding = ss.getSheetByName(SHEET_LINE_BINDING);
  if (!lineBinding) lineBinding = ss.insertSheet(SHEET_LINE_BINDING);
  if (lineBinding.getLastRow() === 0) {
    lineBinding.appendRow(['識別碼', '類型', 'LineUserId', '綁定時間']);
  }

  let scheduleQuota = ss.getSheetByName(SHEET_SCHEDULE_QUOTA);
  if (!scheduleQuota) scheduleQuota = ss.insertSheet(SHEET_SCHEDULE_QUOTA);
  if (scheduleQuota.getLastRow() === 0) {
    scheduleQuota.appendRow(['年月(YYYY-MM)', '店點', '區塊', '起始日', '結束日', '可休天數']);
    scheduleQuota.appendRow(['例如 2027-01', '皮卡一店', 'A', '2027-01-01', '2027-01-15', 4]);
    scheduleQuota.appendRow(['例如 2027-01', '皮卡一店', 'B', '2027-01-16', '2027-01-31', 4]);
  }

  let scheduleRequest = ss.getSheetByName(SHEET_SCHEDULE_REQUEST);
  if (!scheduleRequest) scheduleRequest = ss.insertSheet(SHEET_SCHEDULE_REQUEST);
  if (scheduleRequest.getLastRow() === 0) {
    scheduleRequest.appendRow(['申請編號', ID_FIELD, '姓名', '店點', '職位', '日期', '狀態', '申請時間', '主管備注', '處理人', '處理時間']);
  }

  SpreadsheetApp.getUi().alert('資料表已就緒！\n\n請到「' + SHEET_CONFIG + '」分頁，把管理者（HR / 主管）的 Email 填好，一列一個。');
}

function showWebAppUrl() {
  const url = ScriptApp.getService().getUrl();
  SpreadsheetApp.getUi().alert(url ? ('目前部署網址：\n' + url) : '尚未部署，請點選右上角「部署 > 新增部署作業」。');
}

// ---------- 每日自動同步特休數據排程 ----------
function createDailySyncTrigger() {
  // 先移除舊的同名排程，避免重複建立
  ScriptApp.getProjectTriggers().forEach(function(t) {
    if (t.getHandlerFunction() === 'dailySyncAllLeaveStats') {
      ScriptApp.deleteTrigger(t);
    }
  });
  ScriptApp.newTrigger('dailySyncAllLeaveStats')
    .timeBased()
    .everyDays(1)
    .atHour(2) // 凌晨2點執行，避開上班時間
    .create();
  SpreadsheetApp.getUi().alert('已建立每日自動同步排程！系統會在每天凌晨 2 點左右，自動把所有員工的特休數據刷新寫入「員工資料」試算表。\n\n如果之後想取消，到 Apps Script 編輯器左側「觸發條件」分頁，找到 dailySyncAllLeaveStats 這個排程刪除即可。');
}

// 這是給每日排程呼叫的版本，不需要 HR 登入權杖（因為是系統自動執行，沒有人在操作）
function dailySyncAllLeaveStats() {
  bulkSyncLeaveStats_();
}

// ---------- 共用工具 ----------
function getSheet_(name) {
  const sh = SpreadsheetApp.getActiveSpreadsheet().getSheetByName(name);
  if (!sh) throw new Error('找不到工作表：' + name + '，請先執行選單「特休系統 > 初始化」。');
  return sh;
}

function sheetToObjects_(sheet) {
  const values = sheet.getDataRange().getValues();
  if (values.length < 2) return [];
  const headers = values[0];
  return values.slice(1)
    .filter(row => row.some(c => c !== '' && c !== null))
    .map((row, i) => {
      const obj = { _row: i + 2 };
      headers.forEach((h, idx) => obj[h] = row[idx]);
      return obj;
    });
}

function fmtDate_(d) {
  if (!d) return '';
  return Utilities.formatDate(new Date(d), TZ, 'yyyy-MM-dd');
}

function parseDate_(s) {
  const p = String(s).split('-').map(Number);
  return new Date(p[0], p[1] - 1, p[2]);
}

function addMonths_(date, months) {
  const d = new Date(date.getTime());
  d.setMonth(d.getMonth() + months);
  return d;
}

function truncateDate_(d) {
  const x = new Date(d.getTime());
  x.setHours(0, 0, 0, 0);
  return x;
}

function deriveStatus_(emp) {
  return emp['離職日期'] ? '離職' : '在職';
}

function normalizeId_(v) {
  return String(v || '').trim().toUpperCase();
}

// ---------- 管理者白名單 ----------
function getAdminEmails_() {
  const sh = getSheet_(SHEET_CONFIG);
  return sh.getDataRange().getValues().slice(1)
    .map(r => String(r[0]).trim().toLowerCase())
    .filter(e => e && e.indexOf('@') > -1);
}

function getAdminNameByEmail_(email) {
  const sh = getSheet_(SHEET_CONFIG);
  const target = String(email || '').trim().toLowerCase();
  const rows = sh.getDataRange().getValues().slice(1);
  const found = rows.find(r => String(r[0]).trim().toLowerCase() === target);
  return found && found[1] ? String(found[1]).trim() : '';
}

function isAdminEmail_(email) {
  if (!email) return false;
  return getAdminEmails_().indexOf(String(email).trim().toLowerCase()) > -1;
}

function adminLogin(email) {
  email = String(email || '').trim();
  if (!isAdminEmail_(email)) {
    return { success: false, message: '此 Email 不在管理者白名單中，如需權限請聯絡系統管理員新增。' };
  }
  const name = getAdminNameByEmail_(email);
  const token = Utilities.getUuid();
  CacheService.getScriptCache().put('admin_' + token, JSON.stringify({ email: email.toLowerCase(), name: name }), 21600); // 6 小時有效
  return { success: true, token: token, email: email, name: name };
}

// 回傳 { email, name }；name 若「系統設定」分頁沒填就會是空字串
function checkAdminToken_(token) {
  if (!token) throw new Error('尚未登入管理者帳號，或登入已過期，請重新登入。');
  const cached = CacheService.getScriptCache().get('admin_' + token);
  if (!cached) throw new Error('登入已過期，請重新登入管理者帳號。');
  try {
    return JSON.parse(cached);
  } catch (e) {
    return { email: cached, name: '' }; // 相容舊格式的快取資料
  }
}

// 顯示用：有填姓名就顯示姓名，沒填就顯示 Email
function adminDisplayName_(adminInfo) {
  return (adminInfo && adminInfo.name) ? adminInfo.name : (adminInfo ? adminInfo.email : '');
}

// ---------- 員工資料 ----------
function addEmployee(payload) {
  checkAdminToken_(payload.token);
  const name = String(payload.name || '').trim();
  const hireDate = String(payload.hireDate || '').trim();
  const nationalId = normalizeId_(payload.nationalId);

  if (!name || !hireDate || !nationalId) {
    throw new Error('姓名、到職日、身份證字號為必填欄位。');
  }

  const sh = getSheet_(SHEET_EMPLOYEES);
  const existing = sheetToObjects_(sh);
  if (existing.some(r => normalizeId_(r[ID_FIELD]) === nationalId)) {
    throw new Error('此身份證字號已經存在，請勿重複新增。');
  }

  const row = EMPLOYEE_FIELDS.map(f => {
    if (f.key === 'nationalId') return nationalId;
    return payload[f.key] !== undefined ? payload[f.key] : '';
  }).concat([new Date()]);
  sh.appendRow(row);
  return { success: true, nationalId: nationalId };
}

// ---------- 新進員工資料填寫（公開表單，需經 HR 審核後才會建立正式員工資料） ----------
function getNextPendingHireId_() {
  const rows = sheetToObjects_(getSheet_(SHEET_PENDING_HIRE));
  let max = 0;
  rows.forEach(r => {
    const m = String(r['提交編號']).match(/(\d+)/);
    if (m) max = Math.max(max, parseInt(m[1], 10));
  });
  return 'N' + String(max + 1).padStart(4, '0');
}

function submitNewHireForm(payload) {
  const name = String(payload.name || '').trim();
  const hireDate = String(payload.hireDate || '').trim();
  const nationalId = normalizeId_(payload.nationalId);

  if (!name || !hireDate || !nationalId) {
    throw new Error('姓名、到職日、身份證字號為必填欄位。');
  }

  const already = sheetToObjects_(getSheet_(SHEET_EMPLOYEES)).some(r => normalizeId_(r[ID_FIELD]) === nationalId);
  if (already) {
    throw new Error('此身份證字號已經是系統內的員工資料，如需異動請直接聯絡 HR。');
  }

  const sh = getSheet_(SHEET_PENDING_HIRE);
  const id = getNextPendingHireId_();
  const row = [id].concat(EMPLOYEE_FIELDS.map(f => {
    if (f.key === 'nationalId') return nationalId;
    return payload[f.key] !== undefined ? payload[f.key] : '';
  })).concat([new Date(), '待審核', '', '']);
  sh.appendRow(row);
  return { success: true, submissionId: id };
}

function getPendingNewHires(token) {
  checkAdminToken_(token);
  return sheetToObjects_(getSheet_(SHEET_PENDING_HIRE))
    .filter(r => r['狀態'] === '待審核')
    .map(r => ({
      submissionId: r['提交編號'],
      name: r['姓名'],
      nationalId: r[ID_FIELD],
      branch: r['店點'],
      employeeType: r['員工類型'],
      position: r['職位'],
      hireDate: fmtDate_(r['到職日']),
      mobilePhone: r['個人手機'],
      submittedAt: fmtDate_(r['提交時間'])
    }));
}

function approveNewHire(payload) {
  const adminInfo = checkAdminToken_(payload.token);
  const pendingSh = getSheet_(SHEET_PENDING_HIRE);
  const data = pendingSh.getDataRange().getValues();
  const headers = data[0];
  const idCol = headers.indexOf('提交編號');
  const statusCol = headers.indexOf('狀態');
  const handlerCol = headers.indexOf('處理人');
  const handledAtCol = headers.indexOf('處理時間');
  const nationalIdCol = headers.indexOf(ID_FIELD);

  for (let i = 1; i < data.length; i++) {
    if (data[i][idCol] === payload.submissionId) {
      const nationalId = normalizeId_(data[i][nationalIdCol]);
      const empSh = getSheet_(SHEET_EMPLOYEES);
      const alreadyExists = sheetToObjects_(empSh).some(r => normalizeId_(r[ID_FIELD]) === nationalId);
      if (alreadyExists) {
        throw new Error('此身份證字號已經存在於員工資料中，無法重複建立，請改用「忽略」處理這筆提交。');
      }

      const empRow = EMPLOYEE_FIELDS.map((f, idx) => data[i][idx + 1]).concat([new Date()]);
      empSh.appendRow(empRow);

      const rowNum = i + 1;
      pendingSh.getRange(rowNum, statusCol + 1).setValue('已建立');
      pendingSh.getRange(rowNum, handlerCol + 1).setValue(adminDisplayName_(adminInfo));
      pendingSh.getRange(rowNum, handledAtCol + 1).setValue(new Date());
      return { success: true, nationalId: nationalId };
    }
  }
  throw new Error('找不到此提交編號。');
}

function rejectNewHire(payload) {
  const adminInfo = checkAdminToken_(payload.token);
  const sh = getSheet_(SHEET_PENDING_HIRE);
  const data = sh.getDataRange().getValues();
  const headers = data[0];
  const idCol = headers.indexOf('提交編號');
  const statusCol = headers.indexOf('狀態');
  const handlerCol = headers.indexOf('處理人');
  const handledAtCol = headers.indexOf('處理時間');

  for (let i = 1; i < data.length; i++) {
    if (data[i][idCol] === payload.submissionId) {
      const rowNum = i + 1;
      sh.getRange(rowNum, statusCol + 1).setValue('已忽略');
      sh.getRange(rowNum, handlerCol + 1).setValue(adminDisplayName_(adminInfo));
      sh.getRange(rowNum, handledAtCol + 1).setValue(new Date());
      return { success: true };
    }
  }
  throw new Error('找不到此提交編號。');
}

function getEmployeeDetail(token, nationalId) {
  checkAdminToken_(token);
  nationalId = normalizeId_(nationalId);
  const found = sheetToObjects_(getSheet_(SHEET_EMPLOYEES)).find(r => normalizeId_(r[ID_FIELD]) === nationalId);
  if (!found) throw new Error('找不到此員工資料，可能已被刪除。');

  const detail = {};
  const dateKeys = ['hireDate', 'birthDate', 'insuranceDate', 'resignDate'];
  EMPLOYEE_FIELDS.forEach(f => {
    let v = found[f.header];
    if (dateKeys.indexOf(f.key) > -1) v = v ? fmtDate_(v) : '';
    detail[f.key] = v !== null && v !== undefined ? v : '';
  });

  return {
    success: true,
    employee: detail,
    status: deriveStatus_(found),
    leave: getLeaveSummary_(nationalId)
  };
}

function updateEmployee(payload) {
  checkAdminToken_(payload.token);
  const originalId = normalizeId_(payload.originalNationalId);
  if (!originalId) throw new Error('缺少原始身份證字號，無法定位員工資料。');

  const name = String(payload.name || '').trim();
  const hireDate = String(payload.hireDate || '').trim();
  const newNationalId = normalizeId_(payload.nationalId);
  if (!name || !hireDate || !newNationalId) {
    throw new Error('姓名、到職日、身份證字號為必填欄位。');
  }

  const sh = getSheet_(SHEET_EMPLOYEES);
  const data = sh.getDataRange().getValues();
  const headers = data[0];
  const idCol = headers.indexOf(ID_FIELD);

  for (let i = 1; i < data.length; i++) {
    if (normalizeId_(data[i][idCol]) === originalId) {
      const rowNum = i + 1;

      if (newNationalId !== originalId) {
        const dup = sheetToObjects_(sh).some(r => normalizeId_(r[ID_FIELD]) === newNationalId);
        if (dup) throw new Error('新的身份證字號已被其他員工使用，請確認。');
      }

      EMPLOYEE_FIELDS.forEach((f, idx) => {
        const col = idx + 1; // A欄=1，EMPLOYEE_FIELDS 從第1欄開始依序排列
        const val = f.key === 'nationalId' ? newNationalId : (payload[f.key] !== undefined ? payload[f.key] : '');
        sh.getRange(rowNum, col).setValue(val);
      });

      return { success: true, nationalId: newNationalId };
    }
  }
  throw new Error('找不到此員工資料，可能已被刪除。');
}

function getAllEmployeesForAdmin(token) {
  checkAdminToken_(token);
  const rows = sheetToObjects_(getSheet_(SHEET_EMPLOYEES));
  const allLeaveRecords = sheetToObjects_(getSheet_(SHEET_LEAVE)); // 只讀一次，所有員工共用，避免每個人都重新整份掃一次
  return rows.map(r => ({
    nationalId: r[ID_FIELD],
    branch: r['店點'],
    employeeType: r['員工類型'],
    position: r['職位'],
    name: r['姓名'],
    nickname: r['暱稱'],
    hireDate: fmtDate_(r['到職日']),
    salary: r['薪資'],
    account: r['銀行帳號'],
    resignDate: r['離職日期'] ? fmtDate_(r['離職日期']) : '',
    status: deriveStatus_(r),
    leave: getLeaveSummary_(r[ID_FIELD], allLeaveRecords, rows)
  }));
}

function findEmployee(payload) {
  const nationalId = normalizeId_(payload.nationalId);
  const name = String(payload.name || '').trim();
  if (!nationalId || !name) return { success: false, message: '請輸入姓名與身份證字號。' };

  const rows = sheetToObjects_(getSheet_(SHEET_EMPLOYEES));
  const found = rows.find(r =>
    normalizeId_(r[ID_FIELD]) === nationalId &&
    String(r['姓名']).trim() === name
  );
  if (!found) return { success: false, message: '查無此員工，請確認姓名與身份證字號是否與人資登記資料一致。' };

  const leave = getLeaveSummary_(found[ID_FIELD]);
  syncLeaveStatsToSheet_(found[ID_FIELD], leave); // 員工主動查詢時才順便更新試算表快照，避免每次列表都重複寫入

  return {
    success: true,
    employee: {
      nationalId: found[ID_FIELD],
      name: found['姓名'],
      nickname: found['暱稱'],
      branch: found['店點'],
      position: found['職位'],
      hireDate: fmtDate_(found['到職日']),
      status: deriveStatus_(found)
    },
    leave: leave
  };
}

// ---------- 特休天數計算（勞基法週年制，當年度不遞延） ----------
const LEAVE_TABLE_YEAR1_9 = [7, 10, 14, 14, 15, 15, 15, 15, 15]; // 第1~9年

function buildPeriods_(hireDate, coverUntil) {
  const periods = [];
  periods.push({ start: addMonths_(hireDate, 6), end: addMonths_(hireDate, 12), days: 3, label: '到職滿 6 個月' });
  for (let k = 1; k <= 9; k++) {
    periods.push({
      start: addMonths_(hireDate, 12 * k),
      end: addMonths_(hireDate, 12 * (k + 1)),
      days: LEAVE_TABLE_YEAR1_9[k - 1],
      label: '第 ' + k + ' 年'
    });
  }
  let k = 10;
  while (periods[periods.length - 1].end <= coverUntil) {
    periods.push({
      start: addMonths_(hireDate, 12 * k),
      end: addMonths_(hireDate, 12 * (k + 1)),
      days: Math.min(30, 15 + (k - 9)),
      label: '第 ' + k + ' 年'
    });
    k++;
    if (k > 60) break;
  }
  return periods;
}

function getLeaveSummary_(nationalId, cachedLeaveRecords, cachedEmployees) {
  nationalId = normalizeId_(nationalId);
  const employees = cachedEmployees || sheetToObjects_(getSheet_(SHEET_EMPLOYEES));
  const emp = employees.find(r => normalizeId_(r[ID_FIELD]) === nationalId);
  if (!emp) throw new Error('找不到員工資料：' + nationalId);

  const hireDate = new Date(emp['到職日']);
  const today = new Date();
  const monthlySalary = Number(emp['薪資'] || 0);
  const dailyWage = Math.round((monthlySalary / 30) * 100) / 100;

  // 這位員工是什麼時候被建檔進系統的；早於這個日期就開始、且已經結束的期別，
  // 因為系統沒有那段期間的真實請假紀錄，不列入「到期未休折抵」歷史計算，避免顯示不準確的金額。
  const createdRaw = emp['建立時間'];
  const recordCreatedDate = createdRaw ? truncateDate_(new Date(createdRaw)) : null;

  const periods = buildPeriods_(hireDate, addMonths_(today, 12));

  const leaveRecords = cachedLeaveRecords || sheetToObjects_(getSheet_(SHEET_LEAVE));
  const myLeaves = leaveRecords
    .filter(r => normalizeId_(r[ID_FIELD]) === nationalId && r['狀態'] === '已核准')
    .map(r => ({ start: new Date(r['起始日']), days: Number(r['天數']) }));

  function usedInPeriod(p) {
    return myLeaves.reduce((sum, lv) => (lv.start >= p.start && lv.start < p.end) ? sum + lv.days : sum, 0);
  }

  if (today < periods[0].start) {
    return {
      eligible: false,
      message: '到職未滿 6 個月，尚未取得特休。',
      nextEligibleDate: fmtDate_(periods[0].start),
      dailyWage: dailyWage,
      history: []
    };
  }

  let current = null;
  const history = [];
  for (const p of periods) {
    const used = usedInPeriod(p);
    if (today >= p.start && today < p.end) {
      current = {
        label: p.label,
        periodStart: fmtDate_(p.start),
        periodEnd: fmtDate_(p.end),
        entitled: p.days,
        used: used,
        remaining: Math.max(0, p.days - used)
      };
      break;
    } else if (p.end <= today) {
      if (recordCreatedDate && p.start < recordCreatedDate) {
        // 這個期別在員工被建檔進系統前就已經結束，沒有真實請假紀錄可核對，略過不列入歷史折抵計算
        continue;
      }
      const forfeited = Math.max(0, p.days - used);
      history.push({
        label: p.label,
        periodStart: fmtDate_(p.start),
        periodEnd: fmtDate_(p.end),
        entitled: p.days,
        used: used,
        forfeited: forfeited,
        forfeitedPay: Math.round(forfeited * dailyWage * 100) / 100
      });
    }
  }

  const daysUntilExpire = current ? Math.ceil((parseDate_(current.periodEnd) - today) / 86400000) : null;
  const forecastPay = current ? Math.round(current.remaining * dailyWage * 100) / 100 : 0;

  return {
    eligible: true,
    dailyWage: dailyWage,
    current: current,
    daysUntilExpire: daysUntilExpire,
    forecastPay: forecastPay,
    history: history.reverse()
  };
}

// ---------- 把特休數據同步寫回「員工資料」試算表（方便直接在 Sheet 上查看，不用另外查詢網頁） ----------
function syncLeaveStatsToSheet_(nationalId, summary) {
  try {
    const sh = getSheet_(SHEET_EMPLOYEES);
    const data = sh.getDataRange().getValues();
    const headers = data[0];
    const idCol = headers.indexOf(ID_FIELD);

    let entitledCol = headers.indexOf('特休天數(本期)');
    let usedCol = headers.indexOf('已用天數(本期)');
    let remainingCol = headers.indexOf('剩餘天數(本期)');
    let updatedCol = headers.indexOf('特休更新時間');

    // 如果這幾欄還不存在（例如舊的試算表），自動在最後面補上，不影響原本欄位順序
    if (entitledCol === -1) {
      const startCol = headers.length + 1;
      sh.getRange(1, startCol, 1, 4).setValues([['特休天數(本期)', '已用天數(本期)', '剩餘天數(本期)', '特休更新時間']]);
      entitledCol = startCol - 1;
      usedCol = startCol;
      remainingCol = startCol + 1;
      updatedCol = startCol + 2;
    }

    for (let i = 1; i < data.length; i++) {
      if (normalizeId_(data[i][idCol]) === normalizeId_(nationalId)) {
        const rowNum = i + 1;
        if (summary.eligible) {
          sh.getRange(rowNum, entitledCol + 1).setValue(summary.current.entitled);
          sh.getRange(rowNum, usedCol + 1).setValue(summary.current.used);
          sh.getRange(rowNum, remainingCol + 1).setValue(summary.current.remaining);
        } else {
          sh.getRange(rowNum, entitledCol + 1).setValue(0);
          sh.getRange(rowNum, usedCol + 1).setValue(0);
          sh.getRange(rowNum, remainingCol + 1).setValue(0);
        }
        sh.getRange(rowNum, updatedCol + 1).setValue(new Date());
        break;
      }
    }
  } catch (err) {
    // 同步失敗不應該擋下查詢/請假本身的功能
    console.error('同步特休資料到試算表失敗：' + err);
  }
}

// 實際執行批次同步的邏輯，不含權限檢查，讓「手動按鈕」和「每日排程」共用
function bulkSyncLeaveStats_() {
  const empSh = getSheet_(SHEET_EMPLOYEES);
  const empData = empSh.getDataRange().getValues();
  const headers = empData[0];

  let entitledCol = headers.indexOf('特休天數(本期)');
  let usedCol = headers.indexOf('已用天數(本期)');
  let remainingCol = headers.indexOf('剩餘天數(本期)');
  let updatedCol = headers.indexOf('特休更新時間');
  if (entitledCol === -1) {
    const startCol = headers.length + 1;
    empSh.getRange(1, startCol, 1, 4).setValues([['特休天數(本期)', '已用天數(本期)', '剩餘天數(本期)', '特休更新時間']]);
    entitledCol = startCol - 1;
    usedCol = startCol;
    remainingCol = startCol + 1;
    updatedCol = startCol + 2;
  }

  const employees = sheetToObjects_(empSh);
  const leaveRecords = sheetToObjects_(getSheet_(SHEET_LEAVE)); // 只讀一次，所有人共用
  const now = new Date();
  let count = 0;

  employees.forEach(function(emp) {
    try {
      const summary = getLeaveSummary_(emp[ID_FIELD], leaveRecords, employees);
      const entitled = summary.eligible ? summary.current.entitled : 0;
      const used = summary.eligible ? summary.current.used : 0;
      const remaining = summary.eligible ? summary.current.remaining : 0;
      empSh.getRange(emp._row, entitledCol + 1, 1, 3).setValues([[entitled, used, remaining]]);
      empSh.getRange(emp._row, updatedCol + 1).setValue(now);
      count++;
    } catch (err) {
      console.error('同步員工特休資料失敗：' + emp[ID_FIELD] + ' ' + err);
    }
  });

  return count;
}

// HR 後台的「同步特休數據」按鈕會呼叫這個
function syncAllLeaveStats(token) {
  checkAdminToken_(token);
  const count = bulkSyncLeaveStats_();
  return { success: true, count: count };
}

function getLeaveSummary(nationalId) {
  return getLeaveSummary_(nationalId);
}

// ---------- 固定額度假別（事假/病假）：每年固定天數，用到職日週年制起算，天數不隨年資遞增 ----------
function buildFixedPeriods_(hireDate, annualDays, coverUntil) {
  const periods = [];
  let k = 0;
  while (k === 0 || periods[periods.length - 1].end <= coverUntil) {
    periods.push({
      start: addMonths_(hireDate, 12 * k),
      end: addMonths_(hireDate, 12 * (k + 1)),
      days: annualDays,
      label: '第 ' + (k + 1) + ' 年'
    });
    k++;
    if (k > 60) break;
  }
  return periods;
}

function getFixedLeaveSummary_(nationalId, leaveType) {
  const annualDays = LEAVE_TYPES[leaveType].annualDays;
  const emp = sheetToObjects_(getSheet_(SHEET_EMPLOYEES)).find(r => normalizeId_(r[ID_FIELD]) === nationalId);
  if (!emp) throw new Error('找不到員工資料：' + nationalId);

  const hireDate = new Date(emp['到職日']);
  const today = new Date();
  const createdRaw = emp['建立時間'];
  const recordCreatedDate = createdRaw ? truncateDate_(new Date(createdRaw)) : null;

  const periods = buildFixedPeriods_(hireDate, annualDays, addMonths_(today, 12));

  const myLeaves = sheetToObjects_(getSheet_(SHEET_LEAVE))
    .filter(r => normalizeId_(r[ID_FIELD]) === nationalId && r['狀態'] === '已核准' && r['假別'] === leaveType)
    .map(r => ({ start: new Date(r['起始日']), days: Number(r['天數']) }));

  function usedInPeriod(p) {
    return myLeaves.reduce((sum, lv) => (lv.start >= p.start && lv.start < p.end) ? sum + lv.days : sum, 0);
  }

  let current = null;
  const history = [];
  for (const p of periods) {
    const used = usedInPeriod(p);
    if (today >= p.start && today < p.end) {
      current = {
        label: p.label,
        periodStart: fmtDate_(p.start),
        periodEnd: fmtDate_(p.end),
        entitled: p.days,
        used: used,
        remaining: Math.max(0, p.days - used)
      };
      break;
    } else if (p.end <= today) {
      if (recordCreatedDate && p.start < recordCreatedDate) continue;
      history.push({
        label: p.label,
        periodStart: fmtDate_(p.start),
        periodEnd: fmtDate_(p.end),
        entitled: p.days,
        used: used,
        forfeited: Math.max(0, p.days - used)
      });
    }
  }

  const daysUntilExpire = current ? Math.ceil((parseDate_(current.periodEnd) - today) / 86400000) : null;

  return {
    mode: 'fixed',
    eligible: true,
    current: current,
    daysUntilExpire: daysUntilExpire,
    history: history.reverse()
  };
}

// ---------- 事件假別（婚假/喪假/產假）：一次性天數，不做自動額度檢查，僅供參考，交由主管審核判斷 ----------
function getEventLeaveInfo_(nationalId, leaveType) {
  const defaultDays = LEAVE_TYPES[leaveType].defaultDays;
  const usedAllTime = sheetToObjects_(getSheet_(SHEET_LEAVE))
    .filter(r => normalizeId_(r[ID_FIELD]) === nationalId && r['狀態'] === '已核准' && r['假別'] === leaveType)
    .reduce((sum, r) => sum + Number(r['天數'] || 0), 0);

  return {
    mode: 'event',
    eligible: true,
    defaultDays: defaultDays,
    usedAllTime: usedAllTime,
    note: '公司預設天數僅供參考（' + defaultDays + ' 天），實際天數與合理性由主管審核判斷，系統不會自動限制。'
  };
}

// ---------- 統一的假別額度查詢入口（提供前端請假表單動態顯示） ----------
function getLeaveQuota(nationalId, leaveType) {
  nationalId = normalizeId_(nationalId);
  if (!LEAVE_TYPES[leaveType]) throw new Error('不支援的假別：' + leaveType);

  const mode = LEAVE_TYPES[leaveType].mode;
  if (mode === 'annual_scaling') return getLeaveSummary_(nationalId);
  if (mode === 'annual_fixed') return getFixedLeaveSummary_(nationalId, leaveType);
  if (mode === 'event') return getEventLeaveInfo_(nationalId, leaveType);
  throw new Error('未知的假別模式：' + mode);
}

// ---------- LINE 通知綁定與推播 ----------
// 因為 Apps Script 讀不到 LINE 傳來的簽章表頭（X-Line-Signature），沒辦法驗證 Webhook 請求真的來自 LINE，
// 所以綁定 LINE 帳號不能只靠「輸入身份證字號」（那樣任何知道別人身份證字號的人都能冒充綁定）。
// 改用「登入系統後取得限時 6 位數驗證碼，在 LINE 對話框輸入完成綁定」的方式，比較安全。

function generateLineLinkCode(payload) {
  let type, identifier;
  if (payload.token) {
    identifier = checkAdminToken_(payload.token).email;
    type = 'HR';
  } else if (payload.nationalId) {
    const nationalId = normalizeId_(payload.nationalId);
    const emp = sheetToObjects_(getSheet_(SHEET_EMPLOYEES)).find(r => normalizeId_(r[ID_FIELD]) === nationalId);
    if (!emp) throw new Error('找不到員工資料。');
    identifier = nationalId;
    type = '員工';
  } else {
    throw new Error('缺少必要參數。');
  }

  const code = String(Math.floor(100000 + Math.random() * 900000)); // 6 位數
  CacheService.getScriptCache().put('linecode_' + code, JSON.stringify({ type: type, identifier: identifier }), 600); // 10 分鐘有效

  return {
    success: true,
    code: code,
    lineOaId: LINE_OA_ID,
    addFriendUrl: 'https://line.me/R/ti/p/' + encodeURIComponent(LINE_OA_ID)
  };
}

function handleLineWebhook_(events) {
  events.forEach(function(event) {
    try {
      if (event.type === 'message' && event.message && event.message.type === 'text') {
        handleLineLinkMessage_(event.source.userId, String(event.message.text || '').trim(), event.replyToken);
      } else if (event.type === 'follow') {
        replyLine_(event.replyToken, '歡迎加入！請回到特休假系統，點選「綁定 LINE 通知」取得 6 位數驗證碼，並在這裡輸入該驗證碼完成綁定（10 分鐘內有效）。');
      }
    } catch (err) {
      console.error('處理 LINE 事件失敗：' + err);
    }
  });
}

function handleLineLinkMessage_(userId, text, replyToken) {
  const cacheKey = 'linecode_' + text;
  const cached = CacheService.getScriptCache().get(cacheKey);
  if (!cached) {
    replyLine_(replyToken, '驗證碼無效或已過期，請回到系統重新點選「綁定 LINE 通知」取得新的驗證碼。');
    return;
  }

  const info = JSON.parse(cached);
  const sh = getSheet_(SHEET_LINE_BINDING);
  const data = sh.getDataRange().getValues();
  // 同一個人重新綁定時，把舊的綁定紀錄清掉，避免同一人留下多筆
  for (let i = data.length - 1; i >= 1; i--) {
    if (String(data[i][0]) === String(info.identifier) && data[i][1] === info.type) {
      sh.deleteRow(i + 1);
    }
  }
  sh.appendRow([info.identifier, info.type, userId, new Date()]);
  CacheService.getScriptCache().remove(cacheKey);
  replyLine_(replyToken, '綁定成功！之後系統的相關通知會透過這個 LINE 帳號傳送給您。');
}

function replyLine_(replyToken, text) {
  if (!LINE_CHANNEL_ACCESS_TOKEN || LINE_CHANNEL_ACCESS_TOKEN.indexOf('PASTE_') === 0) return;
  try {
    UrlFetchApp.fetch('https://api.line.me/v2/bot/message/reply', {
      method: 'post',
      contentType: 'application/json',
      headers: { Authorization: 'Bearer ' + LINE_CHANNEL_ACCESS_TOKEN },
      payload: JSON.stringify({ replyToken: replyToken, messages: [{ type: 'text', text: text }] }),
      muteHttpExceptions: true
    });
  } catch (err) {
    console.error('LINE 回覆訊息失敗：' + err);
  }
}

function pushLineMessage_(userId, text) {
  if (!LINE_CHANNEL_ACCESS_TOKEN || LINE_CHANNEL_ACCESS_TOKEN.indexOf('PASTE_') === 0) return;
  try {
    UrlFetchApp.fetch('https://api.line.me/v2/bot/message/push', {
      method: 'post',
      contentType: 'application/json',
      headers: { Authorization: 'Bearer ' + LINE_CHANNEL_ACCESS_TOKEN },
      payload: JSON.stringify({ to: userId, messages: [{ type: 'text', text: text }] }),
      muteHttpExceptions: true
    });
  } catch (err) {
    console.error('LINE 推播訊息失敗：' + err);
  }
}

function getLineUserIds_(type, identifier) {
  return sheetToObjects_(getSheet_(SHEET_LINE_BINDING))
    .filter(r => r['類型'] === type && (identifier ? String(r['識別碼']) === String(identifier) : true))
    .map(r => r['LineUserId']);
}

function sendLineToHR_(text) {
  getLineUserIds_('HR', null).forEach(function(uid) { pushLineMessage_(uid, text); });
}

function sendLineToEmployee_(nationalId, text) {
  getLineUserIds_('員工', normalizeId_(nationalId)).forEach(function(uid) { pushLineMessage_(uid, text); });
}

// ---------- OneSignal 手機推播通知 ----------
// 只有 GitHub Pages 上的 PWA 版本會用到這個（Apps Script 內嵌網頁版無法訂閱推播）。
// 到 OneSignal 後台「Settings > Keys & IDs」取得下面兩個值後貼進來；沒有設定的話會靜默略過，不影響其他功能。
const ONESIGNAL_APP_ID = 'PASTE_YOUR_ONESIGNAL_APP_ID_HERE';
const ONESIGNAL_REST_API_KEY = 'PASTE_YOUR_ONESIGNAL_REST_API_KEY_HERE';

function sendPushNotification_(extraFields) {
  if (!ONESIGNAL_APP_ID || ONESIGNAL_APP_ID.indexOf('PASTE_') === 0) return; // 尚未設定，靜默略過
  try {
    const body = Object.assign({ app_id: ONESIGNAL_APP_ID }, extraFields);
    UrlFetchApp.fetch('https://onesignal.com/api/v1/notifications', {
      method: 'post',
      contentType: 'application/json',
      headers: { Authorization: 'Key ' + ONESIGNAL_REST_API_KEY },
      payload: JSON.stringify(body),
      muteHttpExceptions: true
    });
  } catch (err) {
    console.error('OneSignal 推播發送失敗：' + err);
  }
}

// HR/主管的推播用「標籤」(tag) 鎖定：前端在 HR 登入後會呼叫 OneSignal.User.addTag('role','hr')
function sendPushToHR_(title, message) {
  sendPushNotification_({
    headings: { en: title },
    contents: { en: message },
    filters: [{ field: 'tag', key: 'role', relation: '=', value: 'hr' }]
  });
}

// 員工的推播用「外部 ID」鎖定：前端在員工查詢登入後會呼叫 OneSignal.login(身份證字號)
function sendPushToEmployee_(nationalId, title, message) {
  sendPushNotification_({
    headings: { en: title },
    contents: { en: message },
    include_external_user_ids: [normalizeId_(nationalId)]
  });
}

// ---------- Email 通知 ----------
function notifyHRNewRequest_(name, leaveType, startDate, endDate, days, reason) {
  try {
    const admins = getAdminEmails_();
    if (admins.length) {
      const subject = '【特休假系統】新的請假申請待審核 - ' + name;
      const body =
        '姓名：' + name + '\n' +
        '假別：' + leaveType + '\n' +
        '期間：' + startDate + ' ~ ' + endDate + '（' + days + ' 天）\n' +
        (reason ? ('事由：' + reason + '\n') : '') +
        '\n請至系統的「待審核假單」處理。';
      admins.forEach(function(email) {
        MailApp.sendEmail(email, subject, body);
      });
    }
  } catch (err) {
    // 通知失敗不應該擋下請假申請本身
    console.error('通知 HR (Email) 失敗：' + err);
  }

  sendPushToHR_(
    '新的請假申請',
    name + ' 申請' + leaveType + '　' + startDate + ' ~ ' + endDate + '（' + days + ' 天）'
  );

  sendLineToHR_(
    '📋 新的請假申請\n姓名：' + name + '\n假別：' + leaveType + '\n期間：' + startDate + ' ~ ' + endDate + '（' + days + ' 天）' +
    (reason ? ('\n事由：' + reason) : '')
  );
}

function notifyEmployeeReviewResult_(nationalId, decision, rejectReason) {
  const status = decision === 'approve' ? '已核准' : '已拒絕';

  try {
    const emp = sheetToObjects_(getSheet_(SHEET_EMPLOYEES)).find(r => normalizeId_(r[ID_FIELD]) === normalizeId_(nationalId));
    if (emp && emp['Email']) {
      const subject = '【特休假系統】您的請假申請' + status;
      let body = '您好 ' + emp['姓名'] + '，您的請假申請已' + status + '。';
      if (decision !== 'approve' && rejectReason) {
        body += '\n拒絕原因：' + rejectReason;
      }
      MailApp.sendEmail(emp['Email'], subject, body);
    }
  } catch (err) {
    console.error('通知員工 (Email) 失敗：' + err);
  }

  let pushMsg = '您的請假申請已' + status + '。';
  if (decision !== 'approve' && rejectReason) pushMsg += '（原因：' + rejectReason + '）';
  sendPushToEmployee_(nationalId, '請假審核結果', pushMsg);
  sendLineToEmployee_(nationalId, '您的請假申請已' + status + '。' + (decision !== 'approve' && rejectReason ? ('\n原因：' + rejectReason) : ''));
}

// ---------- 排班／排休申請（四週變形工時） ----------
// 設計說明：
// - 因為四週變形工時的週期起始日不是每月1號，班表又是照日曆月份呈現，所以每個月會被切成 A、B 兩個區塊，
//   各自對應不同的變形工時週期，各自有各自的可休天數。這些「起訖日 + 可休天數」都是每年底由 HR 先算好，
//   直接填在「排休設定」分頁（年月 / 店點 / 區塊 / 起始日 / 結束日 / 可休天數），系統不會自動計算。
// - 對眼店每週一公休（STORE_CLOSURE_WEEKDAY 設定），這天員工不需要、也不應該再申請排休
// - 「同一天不可兩位技術師同時休假」這條規則，系統只會標記衝突、不會擋下申請，
//   因為員工是先排、主管再協調，最終由主管決定怎麼調整，不是系統自動核准/拒絕
// - 排休申請有開放時間限制：每月 25 號才能開放申請「下個月」的排休（SCHEDULE_OPEN_DAY 設定）

const SCHEDULE_OPEN_DAY = 25; // 每月這一天，開放申請「下個月」的排休

// 找出某個店點、某個日期，落在「排休設定」裡的哪一個區塊（A 或 B），回傳該區塊的起訖日與可休天數
function getScheduleSegment_(store, dateStr) {
  const date = parseDate_(dateStr);
  const rows = sheetToObjects_(getSheet_(SHEET_SCHEDULE_QUOTA));
  const found = rows.find(r => {
    if (String(r['店點']).trim() !== store) return false;
    const start = r['起始日'] ? parseDate_(fmtDate_(r['起始日']) || r['起始日']) : null;
    const end = r['結束日'] ? parseDate_(fmtDate_(r['結束日']) || r['結束日']) : null;
    if (!start || !end) return false;
    return date >= start && date <= end;
  });
  if (!found) return null;
  return {
    segment: String(found['區塊'] || '').trim(),
    startDate: fmtDate_(found['起始日']) || String(found['起始日']),
    endDate: fmtDate_(found['結束日']) || String(found['結束日']),
    quota: Number(found['可休天數']) || 0
  };
}

// 回傳某店點、某年月「A、B 兩個區塊」的設定，給前端一次顯示兩塊
function getScheduleSegmentsForMonth_(store, yearMonth) {
  const rows = sheetToObjects_(getSheet_(SHEET_SCHEDULE_QUOTA));
  return rows
    .filter(r => String(r['店點']).trim() === store && String(r['年月(YYYY-MM)']).trim() === yearMonth)
    .map(r => ({
      segment: String(r['區塊'] || '').trim(),
      startDate: fmtDate_(r['起始日']) || String(r['起始日']),
      endDate: fmtDate_(r['結束日']) || String(r['結束日']),
      quota: Number(r['可休天數']) || 0
    }))
    .sort((a, b) => a.startDate.localeCompare(b.startDate));
}

function isStoreClosureDate_(store, dateStr) {
  const weekday = STORE_CLOSURE_WEEKDAY[store];
  if (weekday === undefined) return false;
  const d = parseDate_(dateStr);
  return d.getDay() === weekday;
}

// 檢查某個日期是否已經開放申請（每月 25 號開放下個月）
function isScheduleSubmissionOpen_(dateStr) {
  const date = parseDate_(dateStr);
  const targetMonthFirstDay = new Date(date.getFullYear(), date.getMonth(), 1);
  const openDate = new Date(targetMonthFirstDay.getFullYear(), targetMonthFirstDay.getMonth() - 1, SCHEDULE_OPEN_DAY);
  const today = new Date();
  today.setHours(0, 0, 0, 0);
  return today >= openDate;
}

function submitDayOffRequest(payload) {
  const nationalId = normalizeId_(payload.nationalId);
  const name = String(payload.name || '').trim();
  const store = String(payload.store || '').trim();
  const position = String(payload.position || '').trim();
  const date = String(payload.date || '').trim();

  if (!nationalId || !store || !date) throw new Error('請填寫完整的排休申請資料。');
  if (isStoreClosureDate_(store, date)) {
    throw new Error('這天是' + store + '的固定公休日，不需要另外申請排休。');
  }
  if (!isScheduleSubmissionOpen_(date)) {
    const d = parseDate_(date);
    const openDate = new Date(d.getFullYear(), d.getMonth() - 1, SCHEDULE_OPEN_DAY);
    throw new Error('這個月份還沒開放排休申請，將於 ' + fmtDate_(openDate) + ' 開放。');
  }

  const segment = getScheduleSegment_(store, date);
  if (!segment || segment.quota <= 0) {
    throw new Error('人資尚未設定這段期間（' + date + '）的可休天數，請聯絡 HR。');
  }

  const sh = getSheet_(SHEET_SCHEDULE_REQUEST);
  const allRequests = sheetToObjects_(sh);

  // 用「同一區塊（起訖日範圍）」而不是單純同一個日曆月份來算配額
  const myRequestsInSegment = allRequests.filter(r => {
    if (normalizeId_(r[ID_FIELD]) !== nationalId || r['狀態'] === '已拒絕') return false;
    const rDate = fmtDate_(r['日期']) || String(r['日期']);
    return rDate >= segment.startDate && rDate <= segment.endDate;
  });
  if (myRequestsInSegment.some(r => (fmtDate_(r['日期']) || String(r['日期'])) === date)) {
    throw new Error('這天已經申請過排休了。');
  }
  if (myRequestsInSegment.length >= segment.quota) {
    throw new Error('已達本區間（' + segment.startDate + ' ~ ' + segment.endDate + '）可休天數上限（' + segment.quota + ' 天），如需調整請聯絡主管。');
  }

  // 檢查衝突：同店、同一天，是否已經有其他「技術師」申請（不擋下，只回報衝突讓前端提示）
  let conflict = false;
  if (position === '技術師') {
    conflict = allRequests.some(r =>
      String(r['店點']) === store &&
      (fmtDate_(r['日期']) || String(r['日期'])) === date &&
      String(r['職位']) === '技術師' &&
      normalizeId_(r[ID_FIELD]) !== nationalId &&
      r['狀態'] !== '已拒絕'
    );
  }

  const id = getNextScheduleRequestId_();
  sh.appendRow([id, nationalId, name, store, position, date, '待協調', new Date(), '', '', '']);

  notifyHRNewScheduleRequest_(name, store, date);

  return {
    success: true,
    requestId: id,
    conflict: conflict,
    segment: segment.segment,
    remaining: segment.quota - myRequestsInSegment.length - 1,
    quota: segment.quota
  };
}

function notifyHRNewScheduleRequest_(name, store, date) {
  try {
    const admins = getAdminEmails_();
    if (admins.length) {
      const subject = '【特休假系統】新的排休申請 - ' + name;
      const body = '姓名：' + name + '\n店點：' + store + '\n日期：' + date + '\n\n請至系統的「排休協調」處理。';
      admins.forEach(function(email) { MailApp.sendEmail(email, subject, body); });
    }
  } catch (err) {
    console.error('通知 HR 排休申請 (Email) 失敗：' + err);
  }
  sendPushToHR_('新的排休申請', name + '（' + store + '）申請 ' + date + ' 排休');
  sendLineToHR_('🗓️ 新的排休申請\n姓名：' + name + '\n店點：' + store + '\n日期：' + date);
}

function getNextScheduleRequestId_() {
  const rows = sheetToObjects_(getSheet_(SHEET_SCHEDULE_REQUEST));
  let max = 0;
  rows.forEach(r => {
    const m = String(r['申請編號']).match(/(\d+)/);
    if (m) max = Math.max(max, parseInt(m[1], 10));
  });
  return 'S' + String(max + 1).padStart(5, '0');
}

function getMyDayOffRequests(payload) {
  const nationalId = normalizeId_(payload.nationalId);
  const yearMonth = String(payload.yearMonth || '').trim();
  const requests = sheetToObjects_(getSheet_(SHEET_SCHEDULE_REQUEST))
    .filter(r => normalizeId_(r[ID_FIELD]) === nationalId && (!yearMonth || (fmtDate_(r['日期']) || String(r['日期'])).slice(0, 7) === yearMonth))
    .map(r => ({
      requestId: r['申請編號'],
      date: fmtDate_(r['日期']) || String(r['日期']),
      status: r['狀態'],
      note: r['主管備注']
    }))
    .sort((a, b) => a.date.localeCompare(b.date));

  const store = payload.store ? String(payload.store).trim() : '';
  const segments = (store && yearMonth) ? getScheduleSegmentsForMonth_(store, yearMonth) : [];
  // 幫每個區塊算出「已申請」天數，方便前端直接顯示配額使用狀況
  segments.forEach(seg => {
    seg.used = requests.filter(r => r.status !== '已拒絕' && r.date >= seg.startDate && r.date <= seg.endDate).length;
  });

  const closureWeekday = (store && STORE_CLOSURE_WEEKDAY[store] !== undefined) ? STORE_CLOSURE_WEEKDAY[store] : null;
  const submissionOpen = yearMonth ? isScheduleSubmissionOpen_(yearMonth + '-01') : true;
  let openDate = null;
  if (!submissionOpen) {
    const d = parseDate_(yearMonth + '-01');
    openDate = fmtDate_(new Date(d.getFullYear(), d.getMonth() - 1, SCHEDULE_OPEN_DAY));
  }

  return { requests: requests, segments: segments, closureWeekday: closureWeekday, submissionOpen: submissionOpen, openDate: openDate };
}

function cancelDayOffRequest(payload) {
  const nationalId = normalizeId_(payload.nationalId);
  const sh = getSheet_(SHEET_SCHEDULE_REQUEST);
  const data = sh.getDataRange().getValues();
  const headers = data[0];
  const idCol = headers.indexOf('申請編號');
  const idFieldCol = headers.indexOf(ID_FIELD);
  const statusCol = headers.indexOf('狀態');

  for (let i = 1; i < data.length; i++) {
    if (data[i][idCol] === payload.requestId && normalizeId_(data[i][idFieldCol]) === nationalId) {
      if (data[i][statusCol] === '已確認') throw new Error('這筆已經被主管確認，如需取消請直接聯絡主管。');
      sh.deleteRow(i + 1);
      return { success: true };
    }
  }
  throw new Error('找不到這筆申請。');
}

// HR/主管的協調畫面：回傳這個店、這個月，A/B 兩區塊設定 + 所有人的排休申請，並標記出技術師衝突的日期
function getStoreScheduleForMonth(payload) {
  checkAdminToken_(payload.token);
  const store = String(payload.store || '').trim();
  const yearMonth = String(payload.yearMonth || '').trim();
  if (!store || !yearMonth) throw new Error('請選擇店點與年月。');

  const segments = getScheduleSegmentsForMonth_(store, yearMonth);
  const closureWeekday = STORE_CLOSURE_WEEKDAY[store] !== undefined ? STORE_CLOSURE_WEEKDAY[store] : null;

  const requests = sheetToObjects_(getSheet_(SHEET_SCHEDULE_REQUEST))
    .filter(r => String(r['店點']) === store && (fmtDate_(r['日期']) || String(r['日期'])).slice(0, 7) === yearMonth)
    .map(r => ({
      requestId: r['申請編號'],
      nationalId: r[ID_FIELD],
      name: r['姓名'],
      position: r['職位'],
      date: fmtDate_(r['日期']) || String(r['日期']),
      status: r['狀態'],
      note: r['主管備注']
    }))
    .sort((a, b) => a.date.localeCompare(b.date));

  // 標記技術師衝突：同一天有 2 位以上「狀態不是已拒絕」的技術師申請
  const technicianCountByDate = {};
  requests.forEach(r => {
    if (r.position === '技術師' && r.status !== '已拒絕') {
      technicianCountByDate[r.date] = (technicianCountByDate[r.date] || 0) + 1;
    }
  });
  requests.forEach(r => {
    r.conflict = r.position === '技術師' && r.status !== '已拒絕' && technicianCountByDate[r.date] > 1;
    const seg = segments.find(s => r.date >= s.startDate && r.date <= s.endDate);
    r.segment = seg ? seg.segment : '';
  });

  segments.forEach(seg => {
    seg.used = requests.filter(r => r.status !== '已拒絕' && r.date >= seg.startDate && r.date <= seg.endDate).length;
  });

  return { segments: segments, closureWeekday: closureWeekday, requests: requests };
}

function reviewDayOffRequest(payload) {
  const adminInfo = checkAdminToken_(payload.token);
  const sh = getSheet_(SHEET_SCHEDULE_REQUEST);
  const data = sh.getDataRange().getValues();
  const headers = data[0];
  const idCol = headers.indexOf('申請編號');
  const statusCol = headers.indexOf('狀態');
  const noteCol = headers.indexOf('主管備注');
  const handlerCol = headers.indexOf('處理人');
  const handledAtCol = headers.indexOf('處理時間');

  const statusMap = { confirm: '已確認', adjust: '需調整', reject: '已拒絕' };
  const newStatus = statusMap[payload.decision];
  if (!newStatus) throw new Error('未知的處理方式：' + payload.decision);

  for (let i = 1; i < data.length; i++) {
    if (data[i][idCol] === payload.requestId) {
      const rowNum = i + 1;
      sh.getRange(rowNum, statusCol + 1).setValue(newStatus);
      sh.getRange(rowNum, noteCol + 1).setValue(payload.note || '');
      sh.getRange(rowNum, handlerCol + 1).setValue(adminDisplayName_(adminInfo));
      sh.getRange(rowNum, handledAtCol + 1).setValue(new Date());
      return { success: true };
    }
  }
  throw new Error('找不到此申請編號。');
}

// ---------- 請假申請 / 審核 ----------
function getNextRequestId_() {
  const rows = sheetToObjects_(getSheet_(SHEET_LEAVE));
  let max = 0;
  rows.forEach(r => {
    const m = String(r['申請編號']).match(/(\d+)/);
    if (m) max = Math.max(max, parseInt(m[1], 10));
  });
  return 'L' + String(max + 1).padStart(5, '0');
}

function submitLeaveRequest(payload) {
  const nationalId = normalizeId_(payload.nationalId);
  const name = String(payload.name || '').trim();
  const leaveType = String(payload.leaveType || '特休').trim();
  if (!LEAVE_TYPES[leaveType]) throw new Error('不支援的假別：' + leaveType);
  if (!nationalId || !payload.startDate || !payload.endDate) throw new Error('請填寫完整的請假區間。');

  const startDate = parseDate_(payload.startDate);
  const endDate = parseDate_(payload.endDate);
  if (endDate < startDate) throw new Error('結束日不可早於起始日。');

  const days = Math.round((endDate - startDate) / 86400000) + 1;
  const mode = LEAVE_TYPES[leaveType].mode;

  if (mode === 'annual_scaling') {
    const summary = getLeaveSummary_(nationalId);
    if (!summary.eligible) throw new Error('尚未取得特休資格，無法申請。');
    if (days > summary.current.remaining) {
      throw new Error('申請天數（' + days + ' 天）超過目前可用特休（剩餘 ' + summary.current.remaining + ' 天）。');
    }
  } else if (mode === 'annual_fixed') {
    const summary = getFixedLeaveSummary_(nationalId, leaveType);
    if (days > summary.current.remaining) {
      throw new Error('申請天數（' + days + ' 天）超過本期' + leaveType + '剩餘天數（' + summary.current.remaining + ' 天）。');
    }
  }
  // event 模式（婚假/喪假/產假）不做自動額度檢查，交由主管審核判斷

  const sh = getSheet_(SHEET_LEAVE);
  const id = getNextRequestId_();
  sh.appendRow([id, nationalId, name, payload.startDate, payload.endDate, days, String(payload.reason || '').trim(), '待審核', new Date(), '', '', '', leaveType]);

  notifyHRNewRequest_(name, leaveType, payload.startDate, payload.endDate, days, payload.reason);

  return { success: true, requestId: id, days: days };
}

function getMyLeaveRequests(nationalId) {
  nationalId = normalizeId_(nationalId);
  return sheetToObjects_(getSheet_(SHEET_LEAVE))
    .filter(r => normalizeId_(r[ID_FIELD]) === nationalId)
    .map(r => ({
      requestId: r['申請編號'],
      leaveType: r['假別'] || '特休',
      startDate: fmtDate_(r['起始日']),
      endDate: fmtDate_(r['結束日']),
      days: r['天數'],
      reason: r['事由'],
      status: r['狀態'],
      appliedAt: fmtDate_(r['申請時間']),
      rejectReason: r['拒絕原因']
    }))
    .sort((a, b) => b.appliedAt.localeCompare(a.appliedAt));
}

function getPendingRequests(token) {
  checkAdminToken_(token);
  return sheetToObjects_(getSheet_(SHEET_LEAVE))
    .filter(r => r['狀態'] === '待審核')
    .map(r => ({
      requestId: r['申請編號'],
      nationalId: r[ID_FIELD],
      name: r['姓名'],
      leaveType: r['假別'] || '特休',
      startDate: fmtDate_(r['起始日']),
      endDate: fmtDate_(r['結束日']),
      days: r['天數'],
      reason: r['事由'],
      appliedAt: fmtDate_(r['申請時間'])
    }));
}

function reviewLeaveRequest(payload) {
  const adminInfo = checkAdminToken_(payload.token);
  const sh = getSheet_(SHEET_LEAVE);
  const data = sh.getDataRange().getValues();
  const headers = data[0];
  const idCol = headers.indexOf('申請編號');
  const idFieldCol = headers.indexOf(ID_FIELD);
  const statusCol = headers.indexOf('狀態');
  const reviewerCol = headers.indexOf('審核人');
  const reviewTimeCol = headers.indexOf('審核時間');
  const rejectReasonCol = headers.indexOf('拒絕原因');

  for (let i = 1; i < data.length; i++) {
    if (data[i][idCol] === payload.requestId) {
      const rowNum = i + 1;
      const nationalId = data[i][idFieldCol];
      sh.getRange(rowNum, statusCol + 1).setValue(payload.decision === 'approve' ? '已核准' : '已拒絕');
      sh.getRange(rowNum, reviewerCol + 1).setValue(adminDisplayName_(adminInfo));
      sh.getRange(rowNum, reviewTimeCol + 1).setValue(new Date());
      if (payload.decision !== 'approve') {
        sh.getRange(rowNum, rejectReasonCol + 1).setValue(payload.rejectReason || '');
      }
      notifyEmployeeReviewResult_(nationalId, payload.decision, payload.rejectReason);
      return { success: true };
    }
  }
  throw new Error('找不到此申請編號。');
}

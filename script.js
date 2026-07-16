// ============================================================
// 特休假管理系統 - PWA 版前端邏輯
// 透過 fetch() 呼叫 Apps Script 的 doGet API，取代 google.script.run
//
// 這裡刻意用 GET 而不是 POST：Google Apps Script 對 POST 請求固定會回傳 302 轉址，
// 瀏覽器 fetch() 跟隨這個轉址時，有時會把 POST 降級成 GET，導致資料遺失、拿到 HTML 而不是 JSON。
// GET 請求不會有這個問題，是官方文件示範中唯一穩定可靠的模式。
// ============================================================

// 請把下面這一行換成你自己部署的 Apps Script 網頁應用程式網址（結尾是 /exec）
const API_BASE_URL = 'https://script.google.com/macros/s/AKfycbzvKzoSTeHlU43Xs9nYt39FMvFneiANgeE1yxhdaIGLRTSgtjDIyWu7HMroaNhnfRnN/exec';

async function callApi(action, payload) {
  const url = API_BASE_URL
    + '?action=' + encodeURIComponent(action)
    + '&payload=' + encodeURIComponent(JSON.stringify(payload || {}));
  const res = await fetch(url, { method: 'GET' });
  const text = await res.text();
  let json;
  try {
    json = JSON.parse(text);
  } catch (e) {
    throw new Error('伺服器回應格式錯誤（可能是 Apps Script 網址或部署設定不正確）：' + text.slice(0, 200));
  }
  if (!json.success) throw new Error(json.error || '發生未知錯誤');
  return json.data;
}

let CURRENT_EMPLOYEE = null;
let ADMIN_TOKEN = null;
let ADMIN_STORES = [];
let ADMIN_ROLE = '';
let EMP_TARGET_TAB = 'empTabQuery';
let SELECTED_SCHED_DATES = [];
let SCHED_CAL_STATE = { yearMonth: null, segments: [], closureWeekday: null, markers: {} };
const OTHER_LEAVE_TYPES = ['事假','病假','生理假'];

function switchMode(mode){
  const isEmp = (mode === 'emp-query');
  document.getElementById('panelEmp').classList.toggle('active', isEmp);
  document.getElementById('panelNewHire').classList.toggle('active', mode==='newhire');
  document.getElementById('panelAdmin').classList.toggle('active', mode==='admin');
  document.getElementById('btnModeEmpQuery').classList.toggle('active', mode==='emp-query');
  document.getElementById('btnModeNewHire').classList.toggle('active', mode==='newhire');
  document.getElementById('btnModeAdmin').classList.toggle('active', mode==='admin');
  if(isEmp){
    EMP_TARGET_TAB = 'empTabQuery';
    if(CURRENT_EMPLOYEE) switchEmpTab(EMP_TARGET_TAB);
    const loginTitle = document.getElementById('empLoginTitle');
    if(loginTitle) loginTitle.textContent = '特休查詢/請假申請';
  }
}

function switchEmpTab(tab){
  document.querySelectorAll('#empDashboard .tab-btn').forEach(b=>b.classList.toggle('active', b.dataset.tab===tab));
  document.querySelectorAll('#empDashboard .tab-content').forEach(c=>c.classList.toggle('active', c.id===tab));
}

// ---------- 年/月/日下拉選單（取代手機系統原生日期選擇器，避免跨機型跑版問題）----------
// 年份顯示民國年，但選項的 value 仍是西元年，內部儲存/計算都維持西元年不受影響
function buildDateSelectHtml_(idPrefix, includeDay){
  const currentYear = new Date().getFullYear();
  let yearOptions = '<option value="">年</option>';
  for(let y = currentYear + 1; y >= currentYear - 80; y--){
    yearOptions += '<option value="'+y+'">民國'+(y-1911)+'</option>';
  }
  let monthOptions = '<option value="">月</option>';
  for(let mo = 1; mo <= 12; mo++){
    const mv = String(mo).padStart(2,'0');
    monthOptions += '<option value="'+mv+'">'+mo+'</option>';
  }
  let html = '<div class="date-select-group">' +
    '<select id="'+idPrefix+'_y">'+yearOptions+'</select>' +
    '<select id="'+idPrefix+'_m">'+monthOptions+'</select>';
  if(includeDay){
    let dayOptions = '<option value="">日</option>';
    for(let d = 1; d <= 31; d++){
      const dv = String(d).padStart(2,'0');
      dayOptions += '<option value="'+dv+'">'+d+'</option>';
    }
    html += '<select id="'+idPrefix+'_d">'+dayOptions+'</select>';
  }
  html += '</div>';
  return html;
}

function getDateSelectValue_(idPrefix, includeDay){
  const yEl = document.getElementById(idPrefix+'_y');
  const mEl = document.getElementById(idPrefix+'_m');
  if(!yEl || !mEl) return '';
  const y = yEl.value, m = mEl.value;
  if(!y || !m) return '';
  if(includeDay){
    const dEl = document.getElementById(idPrefix+'_d');
    const d = dEl ? dEl.value : '';
    if(!d) return '';
    return y+'-'+m+'-'+d;
  }
  return y+'-'+m;
}

function setDateSelectValue_(idPrefix, value, includeDay){
  if(!value) return;
  const parts = String(value).split('-');
  const yEl = document.getElementById(idPrefix+'_y');
  const mEl = document.getElementById(idPrefix+'_m');
  if(yEl && parts[0]) yEl.value = parts[0];
  if(mEl && parts[1]) mEl.value = parts[1];
  if(includeDay && parts[2]){
    const dEl = document.getElementById(idPrefix+'_d');
    if(dEl) dEl.value = parts[2];
  }
}

function populateAllDateSelects_(){
  document.querySelectorAll('.date-select-placeholder').forEach(function(el){
    const idPrefix = el.dataset.id;
    const includeDay = el.dataset.day === 'true';
    if(!document.getElementById(idPrefix+'_y')){
      el.innerHTML = buildDateSelectHtml_(idPrefix, includeDay);
    }
  });
}

// ---------- 銀行帳號（固定台新銀行812前綴）----------
function getAccountValue_(idPrefix){
  const el = document.getElementById(idPrefix+'_account');
  if(!el) return '';
  const v = el.value.trim();
  return v ? ('812' + v) : '';
}

function setAccountValue_(idPrefix, fullValue){
  const el = document.getElementById(idPrefix+'_account');
  if(!el) return;
  const v = String(fullValue || '');
  el.value = v.indexOf('812') === 0 ? v.slice(3) : v;
}

function setBtnBusy(btn, busy, busyText){
  if(!btn) return;
  if(busy){
    if(btn.dataset.originalText === undefined) btn.dataset.originalText = btn.textContent;
    btn.textContent = busyText || '處理中…';
    btn.disabled = true;
  } else {
    btn.disabled = false;
    if(btn.dataset.originalText !== undefined) btn.textContent = btn.dataset.originalText;
  }
}

function showMsg(elId, text, ok){
  const el = document.getElementById(elId);
  const icon = ok ? '✓' : '⚠';
  el.innerHTML = '<div class="msg ' + (ok?'ok':'error') + '">' + icon + ' ' + text + '</div>';
}

/* ---------------- 員工端 ---------------- */
function doFindEmployee(){
  const name = document.getElementById('empName').value.trim();
  const nationalId = document.getElementById('empNationalId').value.trim();
  const rememberMe = document.getElementById('empRememberMe').checked;
  document.getElementById('empLoginMsg').innerHTML = '';
  callApi('findEmployee', {name: name, nationalId: nationalId})
    .then(function(res){
      if(!res.success){ showMsg('empLoginMsg', res.message, false); return; }
      CURRENT_EMPLOYEE = res.employee;
      if(rememberMe){
        try{ localStorage.setItem(SAVED_EMPLOYEE_KEY, JSON.stringify({name: name, nationalId: nationalId})); }catch(e){}
      }
      renderEmpDashboard(res.employee, res.leave);
      identifyOneSignalEmployee_(res.employee.nationalId);
    })
    .catch(function(err){ showMsg('empLoginMsg', err.message || String(err), false); });
}

const SAVED_EMPLOYEE_KEY = 'leaveapp_saved_employee';

function tryAutoLoginEmployee_(){
  let saved;
  try{ saved = JSON.parse(localStorage.getItem(SAVED_EMPLOYEE_KEY) || 'null'); }catch(e){ saved = null; }
  if(!saved || !saved.name || !saved.nationalId) return;
  callApi('findEmployee', { name: saved.name, nationalId: saved.nationalId })
    .then(function(res){
      if(!res.success) return; // 記住的身份已失效，靜默忽略，回到手動輸入
      CURRENT_EMPLOYEE = res.employee;
      renderEmpDashboard(res.employee, res.leave);
      identifyOneSignalEmployee_(res.employee.nationalId);
    })
    .catch(function(){ /* 忽略，讓使用者手動輸入 */ });
}

function forgetSavedEmployee_(){
  try{ localStorage.removeItem(SAVED_EMPLOYEE_KEY); }catch(e){}
  CURRENT_EMPLOYEE = null;
  document.getElementById('empDashboard').style.display = 'none';
  document.getElementById('empDashboard').innerHTML = '';
  document.getElementById('empLoginCard').style.display = 'block';
  document.getElementById('empName').value = '';
  document.getElementById('empNationalId').value = '';
  document.getElementById('empRememberMe').checked = false;
}

function renderEmpDashboard(emp, leave){
  document.getElementById('empLoginCard').style.display = 'none';
  document.getElementById('empDashboard').style.display = 'block';

  let queryHtml = '';
  if(!leave.eligible){
    queryHtml += '<div class="card"><h2>' + emp.name + ' 的特休狀態</h2>' +
            '<p class="hint">' + leave.message + '（預計 ' + leave.nextEligibleDate + ' 起取得特休）</p></div>';
  } else {
    const c = leave.current;
    const pct = c.entitled > 0 ? Math.min(1, c.used / c.entitled) : 0;
    const r = 54, circ = 2*Math.PI*r;
    const dash = circ * pct;

    queryHtml += '<div class="card">';
    queryHtml += '<h2>' + emp.name + ' 的特休狀態　<span style="font-size:12px;color:var(--ink-soft);font-weight:400;">(' + c.label + ')</span></h2>';
    queryHtml += '<div class="ring-wrap">';
    queryHtml += '<svg width="140" height="140" viewBox="0 0 140 140">' +
              '<circle cx="70" cy="70" r="'+r+'" fill="none" stroke="var(--ring-track)" stroke-width="12"/>' +
              '<circle cx="70" cy="70" r="'+r+'" fill="none" stroke="var(--accent)" stroke-width="12" ' +
                'stroke-dasharray="'+dash+' '+circ+'" stroke-linecap="round" ' +
                'transform="rotate(-90 70 70)"/>' +
              '<text x="70" y="66" text-anchor="middle" class="ring-num">' + c.remaining + '</text>' +
              '<text x="70" y="86" text-anchor="middle" class="ring-label">剩餘天數</text>' +
            '</svg>';
    queryHtml += '<div class="stat-grid">';
    queryHtml += statBox('本期特休天數', c.entitled + ' 天');
    queryHtml += statBox('已使用', c.used + ' 天');
    queryHtml += statBox('本期到期日', c.periodEnd);
    queryHtml += statBox('距離到期', leave.daysUntilExpire + ' 天');
    queryHtml += statBox('若到期未休完，預估折抵', 'NT$ ' + leave.forecastPay.toLocaleString(), true);
    queryHtml += '</div></div></div>';
  }

  if(leave.history && leave.history.length){
    queryHtml += '<div class="card"><h2>歷年特休紀錄</h2><div class="table-scroll"><table><thead><tr><th>期別</th><th>期間</th><th>應有天數</th><th>已使用</th><th>到期未休</th><th>已折抵金額</th></tr></thead><tbody>';
    leave.history.forEach(h=>{
      queryHtml += '<tr><td>'+h.label+'</td><td>'+h.periodStart+' ~ '+h.periodEnd+'</td><td>'+h.entitled+'</td><td>'+h.used+'</td><td>'+h.forfeited+'</td><td>NT$ '+h.forfeitedPay.toLocaleString()+'</td></tr>';
    });
    queryHtml += '</tbody></table></div></div>';
  }

  queryHtml += '<div class="card"><h2>其他假別總覽</h2><div class="table-scroll" id="otherLeaveOverview"><div class="empty">載入中…</div></div></div>';

  const leaveOptions = ['特休'].concat(OTHER_LEAVE_TYPES)
    .map(t => '<option value="'+t+'">'+t+'</option>').join('');

  const applyHtml =
    '<div class="card"><h2>請假申請</h2>' +
    '<label>假別</label>' +
    '<select id="reqLeaveType" onchange="onLeaveTypeChange()">' + leaveOptions + '</select>' +
    '<div id="leaveQuotaInfo" style="margin-top:10px;">' +
      renderQuotaPanel_(leave) +
    '</div>' +
    '<div class="row" style="margin-top:12px;">' +
      '<div><label>開始日</label>' + buildDateSelectHtml_('reqStart', true) + '</div>' +
      '<div><label>結束日</label>' + buildDateSelectHtml_('reqEnd', true) + '</div>' +
    '</div>' +
    '<label>事由（選填）</label><textarea id="reqReason" placeholder="例如：家庭旅遊"></textarea>' +
    '<button class="primary" onclick="doSubmitLeave(this)">送出申請</button>' +
    '<p class="hint">特休／事假／病假／生理假會依剩餘天數自動檢查。</p>' +
    '<div id="submitLeaveMsg"></div>' +
    '</div>' +
    '<div class="card"><h2>我的請假紀錄</h2><div class="table-scroll" id="myLeaveList"><div class="empty">載入中…</div></div></div>';

  const html =
    '<p class="hint" style="text-align:right;"><a href="#" onclick="forgetSavedEmployee_();return false;">不是我 / 清除記住的身份</a></p>' +
    '<div class="tab-content active" id="empTabQuery">' + queryHtml + applyHtml + '</div>';

  document.getElementById('empDashboard').innerHTML = html;
  switchEmpTab(EMP_TARGET_TAB);
  loadOtherLeaveOverview();
  loadMyLeaveRequests();
}

function loadOtherLeaveOverview(){
  const el = document.getElementById('otherLeaveOverview');
  if(!el) return;
  let html = '<table><thead><tr><th>假別</th><th>本期/預設天數</th><th>已用</th><th>剩餘／備注</th></tr></thead><tbody>';
  OTHER_LEAVE_TYPES.forEach(type=>{ html += '<tr id="otherLeaveRow_'+type+'"><td>'+type+'</td><td colspan="3">載入中…</td></tr>'; });
  html += '</tbody></table>';
  el.innerHTML = html;

  OTHER_LEAVE_TYPES.forEach(type=>{
    callApi('getLeaveQuota', { nationalId: CURRENT_EMPLOYEE.nationalId, leaveType: type })
      .then(function(quota){
        const row = document.getElementById('otherLeaveRow_'+type);
        if(!row) return;
        if(quota.mode === 'event'){
          row.innerHTML = '<td>'+type+'</td><td>'+quota.defaultDays+' 天（參考）</td><td>'+quota.usedAllTime+'</td><td>僅供參考，由主管審核</td>';
        } else {
          const c = quota.current;
          row.innerHTML = '<td>'+type+'</td><td>'+c.entitled+'</td><td>'+c.used+'</td><td>'+c.remaining+'（到期 '+c.periodEnd+'）</td>';
        }
      })
      .catch(function(err){
        const row = document.getElementById('otherLeaveRow_'+type);
        if(row) row.innerHTML = '<td>'+type+'</td><td colspan="3">'+(err.message||err)+'</td>';
      });
  });
}

function badgeHtml(status){
  const icons = {'待審核':'○','已核准':'✓','已拒絕':'✕','已銷假':'↩','在職':'●','離職':'–'};
  return '<span class="badge '+status+'">'+(icons[status]||'')+' '+status+'</span>';
}

function statBox(k, v, accent){
  return '<div class="stat"><div class="k">'+k+'</div><div class="v'+(accent?' accent':'')+'">'+v+'</div></div>';
}

function renderQuotaPanel_(quota){
  if(quota.mode === 'event'){
    return '<p class="hint">'+quota.note+'　（歷史已核准使用：'+quota.usedAllTime+' 天）</p>';
  }
  if(quota.eligible === false){
    return '<p class="hint">'+quota.message+'（預計 '+quota.nextEligibleDate+' 起可申請）</p>';
  }
  const c = quota.current;
  return '<div class="stat-grid">' +
    statBox('本期天數', c.entitled+' 天') +
    statBox('已用天數', c.used+' 天') +
    statBox('剩餘天數', c.remaining+' 天', true) +
    statBox('到期日', c.periodEnd) +
    '</div>';
}

function onLeaveTypeChange(){
  const type = document.getElementById('reqLeaveType').value;
  const el = document.getElementById('leaveQuotaInfo');
  el.innerHTML = '<div class="empty">載入中…</div>';
  callApi('getLeaveQuota', { nationalId: CURRENT_EMPLOYEE.nationalId, leaveType: type })
    .then(function(quota){ el.innerHTML = renderQuotaPanel_(quota); })
    .catch(function(err){ el.innerHTML = '<div class="msg error">'+(err.message||err)+'</div>'; });
}

function doSubmitLeave(btn){
  if(btn && btn.disabled) return;
  const leaveType = document.getElementById('reqLeaveType').value;
  const startDate = getDateSelectValue_('reqStart', true);
  const endDate = getDateSelectValue_('reqEnd', true);
  const reason = document.getElementById('reqReason').value;
  if(!startDate || !endDate){ showMsg('submitLeaveMsg','請選擇開始與結束日期。', false); return; }

  setBtnBusy(btn, true, '送出中…');
  callApi('submitLeaveRequest', {
    nationalId: CURRENT_EMPLOYEE.nationalId,
    name: CURRENT_EMPLOYEE.name,
    leaveType: leaveType,
    startDate: startDate,
    endDate: endDate,
    reason: reason
  })
    .then(function(res){
      setBtnBusy(btn, false);
      showMsg('submitLeaveMsg', '申請已送出（'+res.days+' 天），等待審核。', true);
      return callApi('getLeaveSummary', { nationalId: CURRENT_EMPLOYEE.nationalId });
    })
    .then(function(leave){
      EMP_TARGET_TAB = 'empTabQuery';
      renderEmpDashboard(CURRENT_EMPLOYEE, leave);
      document.getElementById('reqLeaveType').value = leaveType;
      onLeaveTypeChange();
    })
    .catch(function(err){ setBtnBusy(btn, false); showMsg('submitLeaveMsg', err.message || String(err), false); });
}

function loadMyLeaveRequests(){
  callApi('getMyLeaveRequests', { nationalId: CURRENT_EMPLOYEE.nationalId })
    .then(function(list){
      const el = document.getElementById('myLeaveList');
      if(!el) return;
      if(!list.length){ el.innerHTML = '<div class="empty">尚無申請紀錄。</div>'; return; }
      let html = '<table><thead><tr><th>申請日</th><th>假別</th><th>期間</th><th>天數</th><th>事由</th><th>狀態</th></tr></thead><tbody>';
      list.forEach(r=>{
        html += '<tr><td>'+r.appliedAt+'</td><td>'+(r.leaveType||'特休')+'</td><td>'+r.startDate+' ~ '+r.endDate+'</td><td>'+r.days+'</td><td>'+(r.reason||'-')+'</td>' +
                '<td>'+badgeHtml(r.status) + (r.status==='已拒絕' && r.rejectReason ? '<div class="hint">'+r.rejectReason+'</div>' : '') + '</td></tr>';
      });
      html += '</tbody></table>';
      el.innerHTML = html;
    })
    .catch(function(err){ console.error(err); });
}

/* ---------------- 新進員工資料填寫 ---------------- */
function validateRequiredFields_(prefix){
  const mobilePhone = document.getElementById(prefix+'_mobilePhone').value.trim();
  const lineId = document.getElementById(prefix+'_lineId').value.trim();
  const emergencyPhone = document.getElementById(prefix+'_emergencyPhone').value.trim();
  if(!mobilePhone) return '個人手機為必填欄位。';
  if(!lineId) return 'LINE ID 為必填欄位。';
  if(!emergencyPhone) return '緊急聯絡人手機為必填欄位。';
  return null;
}

function doSubmitNewHire(btn){
  if(btn && btn.disabled) return;
  const validationError = validateRequiredFields_('n');
  if(validationError){ showMsg('newHireMsg', validationError, false); return; }
  const payload = {
    branch: nval('n_branch'),
    employeeType: nval('n_employeeType'),
    position: nval('n_position'),
    name: nval('n_name'),
    nickname: nval('n_nickname'),
    hireDate: getDateSelectValue_('n_hireDate', true),
    nationalId: nval('n_nationalId'),
    birthDate: getDateSelectValue_('n_birthDate', true),
    gender: nval('n_gender'),
    householdAddress: nval('n_householdAddress'),
    mailingAddress: nval('n_mailingAddress'),
    homePhone: nval('n_homePhone'),
    mobilePhone: nval('n_mobilePhone'),
    education: nval('n_education'),
    hometown: nval('n_hometown'),
    insuranceDate: getDateSelectValue_('n_insuranceDate', true),
    salary: nval('n_salary'),
    emergencyContact: nval('n_emergencyContact'),
    emergencyRelation: nval('n_emergencyRelation'),
    emergencyPhone: nval('n_emergencyPhone'),
    note: nval('n_note'),
    ig: nval('n_ig'),
    lineId: nval('n_lineId'),
    resignDate: getDateSelectValue_('n_resignDate', true),
    account: getAccountValue_('n'),
    email: nval('n_email')
  };
  setBtnBusy(btn, true, '送出中…');
  callApi('submitNewHireForm', payload)
    .then(function(res){
      setBtnBusy(btn, false);
      showMsg('newHireMsg', '資料已送出（提交編號：'+res.submissionId+'），請等候人資審核建立。', true);
      document.querySelectorAll('#panelNewHire input, #panelNewHire select, #panelNewHire textarea').forEach(el=>el.value='');
    })
    .catch(function(err){ setBtnBusy(btn, false); showMsg('newHireMsg', err.message || String(err), false); });
}

function nval(id){ return document.getElementById(id).value; }

/* ---------------- HR / 主管後台 ---------------- */
const SAVED_ADMIN_KEY = 'leaveapp_saved_admin';

function doAdminLogin(btn){
  if(btn && btn.disabled) return;
  const email = document.getElementById('adminEmail').value.trim();
  const password = document.getElementById('adminPassword').value;
  const rememberMe = document.getElementById('adminRememberMe').checked;
  setBtnBusy(btn, true, '登入中…');
  callApi('adminLogin', { email: email, password: password })
    .then(function(res){
      setBtnBusy(btn, false);
      if(!res.success){
        showMsg('adminLoginMsg', res.message, false);
        if(res.needsPasswordSetup) document.getElementById('adminPasswordSetup').style.display = 'block';
        return;
      }
      ADMIN_TOKEN = res.token;
      ADMIN_STORES = res.stores || [];
      ADMIN_ROLE = res.role || '';
      if(rememberMe){
        try{ localStorage.setItem(SAVED_ADMIN_KEY, email); }catch(e){}
      }
      document.getElementById('adminLoginCard').style.display = 'none';
      document.getElementById('adminDashboard').style.display = 'block';
      document.getElementById('adminWelcome').textContent = '您好，' + (res.name || res.email) + '（' + (ADMIN_ROLE||'HR') + '，審核紀錄會用這個名稱記錄）' +
        (ADMIN_STORES.length ? '　您負責：' + ADMIN_STORES.join('、') : '');
      applyAdminStoreRestrictions_();
      loadEmployeeList();
      loadPendingRequests();
      loadPendingNewHires();
      identifyOneSignalHR_();
    })
    .catch(function(err){ setBtnBusy(btn, false); showMsg('adminLoginMsg', err.message || String(err), false); });
}

// 只預填記住的 Email，密碼每次都要輸入，不會自動略過登入（安全考量）
function tryAutoLoginAdmin_(){
  let savedEmail;
  try{ savedEmail = localStorage.getItem(SAVED_ADMIN_KEY); }catch(e){ savedEmail = null; }
  if(!savedEmail) return;
  const el = document.getElementById('adminEmail');
  if(el) el.value = savedEmail;
}

function toggleAdminPasswordSetup_(){
  const el = document.getElementById('adminPasswordSetup');
  el.style.display = (el.style.display === 'none') ? 'block' : 'none';
}

function doSetAdminPassword(btn){
  if(btn && btn.disabled) return;
  const email = document.getElementById('adminEmail').value.trim();
  const newPassword = document.getElementById('adminNewPassword').value;
  const confirmPassword = document.getElementById('adminNewPasswordConfirm').value;
  if(!email){ showMsg('adminPasswordSetupMsg', '請先在上方填寫您的管理者 Email。', false); return; }
  if(newPassword.length < 6){ showMsg('adminPasswordSetupMsg', '密碼至少需要 6 個字元。', false); return; }
  if(newPassword !== confirmPassword){ showMsg('adminPasswordSetupMsg', '兩次輸入的密碼不一致。', false); return; }
  setBtnBusy(btn, true, '設定中…');
  callApi('setAdminPassword', { email: email, newPassword: newPassword })
    .then(function(){
      setBtnBusy(btn, false);
      showMsg('adminPasswordSetupMsg', '密碼設定成功，請用新密碼登入。', true);
      document.getElementById('adminPassword').value = newPassword;
      document.getElementById('adminNewPassword').value = '';
      document.getElementById('adminNewPasswordConfirm').value = '';
    })
    .catch(function(err){ setBtnBusy(btn, false); showMsg('adminPasswordSetupMsg', err.message || String(err), false); });
}

function applyAdminStoreRestrictions_(){
  const isHR = ADMIN_ROLE === 'HR';

  if(ADMIN_STORES.length){
    const pendingTabs = document.querySelectorAll('#tabPending .tabs .tab-btn');
    let firstAllowed = null;
    pendingTabs.forEach(function(btn){
      const store = btn.dataset.store;
      const allowed = store === '全部' ? false : ADMIN_STORES.indexOf(store) > -1;
      btn.style.display = allowed ? '' : 'none';
      if(allowed && !firstAllowed) firstAllowed = store;
    });
    if(firstAllowed) switchPendingStore(firstAllowed);
  } else {
    document.querySelectorAll('#tabPending .tabs .tab-btn').forEach(function(btn){ btn.style.display = ''; });
  }

  const newHireTab = document.querySelector('[data-tab="tabNewHire"]');
  if(newHireTab) newHireTab.style.display = isHR ? '' : 'none';
  const addTab = document.querySelector('[data-tab="tabAdd"]');
  if(addTab) addTab.style.display = isHR ? '' : 'none';
  if(!isHR && (document.getElementById('tabNewHire').classList.contains('active') || document.getElementById('tabAdd').classList.contains('active'))){
    switchAdminTab('tabList');
  }
}

/* ---------------- OneSignal 推播訂閱設定 ---------------- */
function identifyOneSignalEmployee_(nationalId){
  if (!window.OneSignalDeferred) return;
  OneSignalDeferred.push(async function(OneSignal){
    try {
      await OneSignal.login(nationalId); // 用身份證字號當作 OneSignal 的外部 ID，方便之後精準推播給這個人
      await OneSignal.Notifications.requestPermission();
    } catch(e){ console.warn('OneSignal 訂閱設定失敗：', e); }
  });
}

function identifyOneSignalHR_(){
  if (!window.OneSignalDeferred) return;
  OneSignalDeferred.push(async function(OneSignal){
    try {
      await OneSignal.User.addTag('role', 'hr'); // 標記這個裝置是HR/主管，之後推播可以用這個標籤鎖定
      await OneSignal.Notifications.requestPermission();
    } catch(e){ console.warn('OneSignal 訂閱設定失敗：', e); }
  });
}

function adminLogout(){
  ADMIN_TOKEN = null;
  try{ localStorage.removeItem(SAVED_ADMIN_KEY); }catch(e){}
  document.getElementById('adminDashboard').style.display = 'none';
  document.getElementById('adminLoginCard').style.display = 'block';
  document.getElementById('adminEmail').value = '';
  document.getElementById('adminPassword').value = '';
  document.getElementById('adminRememberMe').checked = false;
}

function switchAdminTab(tab){
  document.querySelectorAll('.tab-btn').forEach(b=>b.classList.toggle('active', b.dataset.tab===tab));
  document.querySelectorAll('.tab-content').forEach(c=>c.classList.toggle('active', c.id===tab));
  if(tab==='tabList') loadEmployeeList();
  if(tab==='tabPending') loadPendingRequests();
  if(tab==='tabNewHire') loadPendingNewHires();
}

function doAddEmployee(btn){
  if(btn && btn.disabled) return;
  const validationError = validateRequiredFields_('f');
  if(validationError){ showMsg('addEmpMsg', validationError, false); return; }
  const payload = {
    token: ADMIN_TOKEN,
    branch: val('f_branch'),
    employeeType: val('f_employeeType'),
    position: val('f_position'),
    name: val('f_name'),
    nickname: val('f_nickname'),
    hireDate: getDateSelectValue_('f_hireDate', true),
    nationalId: val('f_nationalId'),
    birthDate: getDateSelectValue_('f_birthDate', true),
    gender: val('f_gender'),
    householdAddress: val('f_householdAddress'),
    mailingAddress: val('f_mailingAddress'),
    homePhone: val('f_homePhone'),
    mobilePhone: val('f_mobilePhone'),
    education: val('f_education'),
    hometown: val('f_hometown'),
    insuranceDate: getDateSelectValue_('f_insuranceDate', true),
    salary: val('f_salary'),
    emergencyContact: val('f_emergencyContact'),
    emergencyRelation: val('f_emergencyRelation'),
    emergencyPhone: val('f_emergencyPhone'),
    note: val('f_note'),
    ig: val('f_ig'),
    lineId: val('f_lineId'),
    resignDate: getDateSelectValue_('f_resignDate', true),
    account: getAccountValue_('f'),
    email: val('f_email')
  };
  setBtnBusy(btn, true, '新增中…');
  callApi('addEmployee', payload)
    .then(function(res){
      setBtnBusy(btn, false);
      showMsg('addEmpMsg', '新增成功！身份證字號：' + res.nationalId, true);
      document.querySelectorAll('#tabAdd input, #tabAdd select, #tabAdd textarea').forEach(el=>el.value='');
      loadEmployeeList();
    })
    .catch(function(err){ setBtnBusy(btn, false); showMsg('addEmpMsg', err.message || String(err), false); });
}

function val(id){ return document.getElementById(id).value; }

function doSyncAllLeaveStats(){
  document.getElementById('syncStatsMsg').innerHTML = '<div class="empty">同步中…</div>';
  callApi('syncAllLeaveStats', { token: ADMIN_TOKEN })
    .then(function(res){
      showMsg('syncStatsMsg', '已同步 ' + res.count + ' 位員工的特休數據。', true);
      loadEmployeeList();
    })
    .catch(function(err){ showMsg('syncStatsMsg', err.message || String(err), false); });
}

let EMP_LIST_CACHE = [];

function loadEmployeeList(){
  if(!ADMIN_TOKEN) return;
  callApi('getAllEmployeesForAdmin', { token: ADMIN_TOKEN })
    .then(function(list){
      EMP_LIST_CACHE = list;
      renderEmployeeTable_(list);
    })
    .catch(function(err){ document.getElementById('empListWrap').innerHTML = '<div class="msg error">'+(err.message||err)+'</div>'; });
}

function renderEmployeeTable_(list){
  const el = document.getElementById('empListWrap');
  if(!list.length){ el.innerHTML = '<div class="empty">尚無符合的員工資料。</div>'; return; }
  let html = '<table><thead><tr><th>身份證字號</th><th>店點</th><th>職位</th><th>姓名</th><th>暱稱</th><th>到職日</th><th>銀行帳號</th><th>狀態</th><th>本期特休</th><th>已用/剩餘</th><th>到期日</th></tr></thead><tbody>';
  list.forEach(e=>{
    const l = e.leave;
    const cur = l.eligible ? (l.current.used + ' / ' + l.current.remaining) : '-';
    const exp = l.eligible ? l.current.periodEnd : (l.nextEligibleDate || '-');
    const entitled = l.eligible ? l.current.entitled : 0;
    html += '<tr style="cursor:pointer" onclick="openEmployeeDetail(\''+e.nationalId+'\')" title="點選查看/編輯詳細資料">' +
            '<td>'+e.nationalId+'</td><td>'+(e.branch||'-')+'</td><td>'+(e.position||'-')+'</td><td>'+e.name+'</td><td>'+(e.nickname||'-')+'</td><td>'+e.hireDate+'</td><td>'+(e.account||'-')+'</td>' +
            '<td>'+badgeHtml(e.status)+'</td><td>'+entitled+'</td><td>'+cur+'</td><td>'+exp+'</td></tr>';
  });
  html += '</tbody></table>';
  el.innerHTML = html;
}

function filterEmployeeList_(){
  const kw = document.getElementById('empSearchInput').value.trim().toLowerCase();
  if(!kw){ renderEmployeeTable_(EMP_LIST_CACHE); return; }
  const filtered = EMP_LIST_CACHE.filter(e =>
    (e.name||'').toLowerCase().indexOf(kw) > -1 ||
    (e.nickname||'').toLowerCase().indexOf(kw) > -1 ||
    (e.nationalId||'').toLowerCase().indexOf(kw) > -1 ||
    (e.branch||'').toLowerCase().indexOf(kw) > -1
  );
  renderEmployeeTable_(filtered);
}

let CURRENT_DETAIL_NATIONAL_ID = null;

function openEmployeeDetail(nationalId){
  document.querySelectorAll('.tab-btn').forEach(b=>b.classList.remove('active'));
  document.querySelectorAll('.tab-content').forEach(c=>c.classList.toggle('active', c.id==='tabDetail'));
  document.getElementById('detailLeaveCard').innerHTML = '<div class="empty">載入中…</div>';
  document.getElementById('detailLeaveHistoryWrap').innerHTML = '<div class="empty">載入中…</div>';
  CURRENT_DETAIL_NATIONAL_ID = nationalId;
  callApi('getEmployeeDetail', { token: ADMIN_TOKEN, nationalId: nationalId })
    .then(function(res){
      const emp = res.employee;
      document.getElementById('e_originalNationalId').value = emp.nationalId;
      ['branch','employeeType','position','name','nickname','nationalId','gender',
       'householdAddress','mailingAddress','homePhone','mobilePhone','education','hometown',
       'salary','emergencyContact','emergencyRelation','emergencyPhone','note','ig','lineId','email']
      .forEach(k => { const el = document.getElementById('e_'+k); if(el) el.value = emp[k] || ''; });
      setDateSelectValue_('e_hireDate', emp.hireDate, true);
      setDateSelectValue_('e_birthDate', emp.birthDate, true);
      setDateSelectValue_('e_insuranceDate', emp.insuranceDate, true);
      setDateSelectValue_('e_resignDate', emp.resignDate, true);
      setAccountValue_('e', emp.account);

      const canEdit = !!res.canEdit;
      document.querySelectorAll('#detailEditCard input, #detailEditCard select, #detailEditCard textarea').forEach(el=>{
        if(el.id !== 'e_originalNationalId') el.disabled = !canEdit;
      });
      const saveBtn = document.querySelector('#detailEditCard button.primary');
      if(saveBtn) saveBtn.style.display = canEdit ? '' : 'none';
      let readOnlyNotice = document.getElementById('detailReadOnlyNotice');
      if(!canEdit){
        if(!readOnlyNotice){
          readOnlyNotice = document.createElement('p');
          readOnlyNotice.id = 'detailReadOnlyNotice';
          readOnlyNotice.className = 'hint';
          readOnlyNotice.textContent = '您目前是唯讀模式，只能瀏覽員工資料，如需編輯請聯絡 HR。';
          document.getElementById('detailEditCard').insertBefore(readOnlyNotice, document.getElementById('detailEditCard').querySelector('.section-title'));
        }
      } else if(readOnlyNotice){
        readOnlyNotice.remove();
      }
      document.getElementById('detailManualAddCard').style.display = canEdit ? 'block' : 'none';

      const l = res.leave;
      let lh = '<h2>'+emp.name+' 的特休狀態　<span style="font-size:12px;color:var(--ink-soft);font-weight:400;">('+badgeHtml(res.status)+')</span></h2>';
      if(!l.eligible){
        lh += '<p class="hint">'+l.message+'（預計 '+l.nextEligibleDate+' 起取得特休）</p>';
      } else {
        const c = l.current;
        lh += '<div class="stat-grid">' +
              statBox('本期('+c.label+')特休天數', c.entitled+' 天') +
              statBox('已使用', c.used+' 天') +
              statBox('剩餘天數', c.remaining+' 天', true) +
              statBox('本期到期日', c.periodEnd) +
              '</div>';
      }
      document.getElementById('detailLeaveCard').innerHTML = lh;
      document.getElementById('updateEmpMsg').innerHTML = '';

      loadEmployeeLeaveHistory_(nationalId);
    })
    .catch(function(err){
      document.getElementById('detailLeaveCard').innerHTML = '<div class="msg error">'+(err.message||err)+'</div>';
    });
}

function loadEmployeeLeaveHistory_(nationalId){
  callApi('getEmployeeLeaveRecords', { token: ADMIN_TOKEN, nationalId: nationalId })
    .then(function(records){
      const el = document.getElementById('detailLeaveHistoryWrap');
      if(!records.length){ el.innerHTML = '<div class="empty">尚無請假紀錄。</div>'; return; }
      const isHR = ADMIN_ROLE === 'HR';
      let html = '<table><thead><tr><th>假別</th><th>期間</th><th>天數</th><th>狀態</th><th>事由/備注</th><th>審核人</th>' + (isHR ? '<th>操作</th>' : '') + '</tr></thead><tbody>';
      records.forEach(r=>{
        html += '<tr><td>'+r.leaveType+'</td><td>'+r.startDate+' ~ '+r.endDate+'</td><td>'+r.days+'</td><td>'+badgeHtml(r.status)+'</td><td>'+(r.reason||'-')+(r.rejectReason?('<br><span style="color:var(--ink-soft);">拒絕原因：'+r.rejectReason+'</span>'):'')+'</td><td>'+(r.reviewer||'-')+'</td>' +
                (isHR ? '<td>' + (r.status==='已核准' ? '<button class="small-reject" onclick="doCancelApprovedLeave(\''+r.requestId+'\')">銷假</button>' : '-') + '</td>' : '') +
                '</tr>';
      });
      html += '</tbody></table>';
      el.innerHTML = html;
    })
    .catch(function(err){
      document.getElementById('detailLeaveHistoryWrap').innerHTML = '<div class="msg error">'+(err.message||err)+'</div>';
    });
}

function doCancelApprovedLeave(requestId){
  const note = prompt('銷假原因（選填，例如：提早回來上班）：');
  if(note === null) return;
  callApi('cancelApprovedLeaveRecord', { token: ADMIN_TOKEN, requestId: requestId, note: note })
    .then(function(){
      loadEmployeeLeaveHistory_(CURRENT_DETAIL_NATIONAL_ID);
      openEmployeeDetail(CURRENT_DETAIL_NATIONAL_ID);
    })
    .catch(function(err){ alert(err.message || err); });
}

function doManualAddLeave(btn){
  if(btn && btn.disabled) return;
  const leaveType = document.getElementById('manualLeaveType').value;
  const startDate = getDateSelectValue_('manualStart', true);
  const endDate = getDateSelectValue_('manualEnd', true);
  const note = document.getElementById('manualLeaveNote').value.trim();
  if(!startDate || !endDate){ showMsg('manualAddLeaveMsg', '請選擇開始日與結束日。', false); return; }
  setBtnBusy(btn, true, '登記中…');
  callApi('manualAddLeaveRecord', {
    token: ADMIN_TOKEN,
    nationalId: CURRENT_DETAIL_NATIONAL_ID,
    leaveType: leaveType,
    startDate: startDate,
    endDate: endDate,
    note: note
  })
    .then(function(res){
      setBtnBusy(btn, false);
      showMsg('manualAddLeaveMsg', '已登記（'+res.days+' 天）。', true);
      document.getElementById('manualLeaveNote').value = '';
      loadEmployeeLeaveHistory_(CURRENT_DETAIL_NATIONAL_ID);
      openEmployeeDetail(CURRENT_DETAIL_NATIONAL_ID);
    })
    .catch(function(err){ setBtnBusy(btn, false); showMsg('manualAddLeaveMsg', err.message || String(err), false); });
}

function doUpdateEmployee(btn){
  if(btn && btn.disabled) return;
  const validationError = validateRequiredFields_('e');
  if(validationError){ showMsg('updateEmpMsg', validationError, false); return; }
  const payload = {
    token: ADMIN_TOKEN,
    originalNationalId: val('e_originalNationalId'),
    branch: val('e_branch'),
    employeeType: val('e_employeeType'),
    position: val('e_position'),
    name: val('e_name'),
    nickname: val('e_nickname'),
    hireDate: getDateSelectValue_('e_hireDate', true),
    nationalId: val('e_nationalId'),
    birthDate: getDateSelectValue_('e_birthDate', true),
    gender: val('e_gender'),
    householdAddress: val('e_householdAddress'),
    mailingAddress: val('e_mailingAddress'),
    homePhone: val('e_homePhone'),
    mobilePhone: val('e_mobilePhone'),
    education: val('e_education'),
    hometown: val('e_hometown'),
    insuranceDate: getDateSelectValue_('e_insuranceDate', true),
    salary: val('e_salary'),
    emergencyContact: val('e_emergencyContact'),
    emergencyRelation: val('e_emergencyRelation'),
    emergencyPhone: val('e_emergencyPhone'),
    note: val('e_note'),
    ig: val('e_ig'),
    lineId: val('e_lineId'),
    resignDate: getDateSelectValue_('e_resignDate', true),
    account: getAccountValue_('e'),
    email: val('e_email')
  };
  setBtnBusy(btn, true, '儲存中…');
  callApi('updateEmployee', payload)
    .then(function(res){
      setBtnBusy(btn, false);
      showMsg('updateEmpMsg', '已儲存變更。', true);
      openEmployeeDetail(res.nationalId);
    })
    .catch(function(err){ setBtnBusy(btn, false); showMsg('updateEmpMsg', err.message || String(err), false); });
}

let PENDING_REQUESTS_ALL = [];
let PENDING_STORE_FILTER = '全部';

function loadPendingRequests(){
  if(!ADMIN_TOKEN) return;
  callApi('getPendingRequests', { token: ADMIN_TOKEN })
    .then(function(list){
      PENDING_REQUESTS_ALL = list;
      renderPendingTable();
    })
    .catch(function(err){ document.getElementById('pendingWrap').innerHTML = '<div class="msg error">'+(err.message||err)+'</div>'; });
}

function switchPendingStore(store){
  PENDING_STORE_FILTER = store;
  document.querySelectorAll('#tabPending .tab-btn').forEach(b=>b.classList.toggle('active', b.dataset.store===store));
  renderPendingTable();
}

function renderPendingTable(){
  const el = document.getElementById('pendingWrap');
  const list = PENDING_STORE_FILTER === '全部' ? PENDING_REQUESTS_ALL : PENDING_REQUESTS_ALL.filter(r => r.branch === PENDING_STORE_FILTER);
  if(!list.length){ el.innerHTML = '<div class="empty">目前沒有待審核的假單。</div>'; return; }
  const canReview = ADMIN_ROLE !== '行政';
  let html = '<table><thead><tr><th>申請編號</th><th>店點</th><th>員工</th><th>假別</th><th>期間</th><th>天數</th><th>事由</th><th>操作</th></tr></thead><tbody>';
  list.forEach(r=>{
    html += '<tr><td>'+r.requestId+'</td><td>'+(r.branch||'-')+'</td><td>'+r.name+' ('+r.nationalId+')</td><td>'+(r.leaveType||'特休')+'</td><td>'+r.startDate+' ~ '+r.endDate+'</td><td>'+r.days+'</td><td>'+(r.reason||'-')+'</td>' +
            '<td>' + (canReview ?
              '<button class="small-approve" onclick="doReview(\''+r.requestId+'\',\'approve\',this)">核准</button>' +
              '<button class="small-reject" onclick="doReview(\''+r.requestId+'\',\'reject\',this)">拒絕</button>'
              : '<span class="hint">僅供查看</span>') + '</td></tr>';
  });
  html += '</tbody></table>';
  el.innerHTML = html;
}

function doReview(requestId, decision, btn){
  if(btn && btn.disabled) return;
  let rejectReason = '';
  if(decision === 'reject'){
    rejectReason = prompt('請輸入拒絕原因（選填）：') || '';
  }
  if(btn) setBtnBusy(btn, true, '處理中…');
  callApi('reviewLeaveRequest', { token: ADMIN_TOKEN, requestId: requestId, decision: decision, rejectReason: rejectReason })
    .then(function(){ loadPendingRequests(); loadEmployeeList(); })
    .catch(function(err){ if(btn) setBtnBusy(btn, false); alert(err.message || err); });
}

function loadPendingNewHires(){
  if(!ADMIN_TOKEN) return;
  callApi('getPendingNewHires', { token: ADMIN_TOKEN })
    .then(function(list){
      const el = document.getElementById('newHirePendingWrap');
      if(!list.length){ el.innerHTML = '<div class="empty">目前沒有待審核的新進員工資料。</div>'; return; }
      let html = '<table><thead><tr><th>提交編號</th><th>姓名</th><th>身份證字號</th><th>店點</th><th>職位</th><th>到職日</th><th>手機</th><th>操作</th></tr></thead><tbody>';
      list.forEach(r=>{
        html += '<tr><td>'+r.submissionId+'</td><td>'+r.name+'</td><td>'+r.nationalId+'</td><td>'+(r.branch||'-')+'</td><td>'+(r.position||'-')+'</td><td>'+r.hireDate+'</td><td>'+(r.mobilePhone||'-')+'</td>' +
                '<td><button class="small-approve" onclick="doReviewNewHire(\''+r.submissionId+'\',\'approve\',this)">核准建立</button>' +
                '<button class="small-reject" onclick="doReviewNewHire(\''+r.submissionId+'\',\'reject\',this)">忽略</button></td></tr>';
      });
      html += '</tbody></table>';
      el.innerHTML = html;
    })
    .catch(function(err){ document.getElementById('newHirePendingWrap').innerHTML = '<div class="msg error">'+(err.message||err)+'</div>'; });
}

function doReviewNewHire(submissionId, decision, btn){
  if(btn && btn.disabled) return;
  if(decision === 'reject' && !confirm('確定要忽略這筆新進員工提交嗎？')) return;
  const action = decision === 'approve' ? 'approveNewHire' : 'rejectNewHire';
  if(btn) setBtnBusy(btn, true, '處理中…');
  callApi(action, { token: ADMIN_TOKEN, submissionId: submissionId })
    .then(function(){ loadPendingNewHires(); loadEmployeeList(); })
    .catch(function(err){ if(btn) setBtnBusy(btn, false); alert(err.message || err); });
}

// ---------- Service Worker 註冊（讓網頁可以離線快取外觀、支援加入主畫面）----------
if ('serviceWorker' in navigator) {
  window.addEventListener('load', function(){
    navigator.serviceWorker.register('service-worker.js').catch(function(err){
      console.warn('Service worker 註冊失敗：', err);
    });
  });
}

populateAllDateSelects_();
tryAutoLoginEmployee_();
tryAutoLoginAdmin_();

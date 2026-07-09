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
let EMP_TARGET_TAB = 'empTabQuery';
let SELECTED_SCHED_DATES = [];
let SCHED_CAL_STATE = { yearMonth: null, segments: [], closureWeekday: null, markers: {} };
const OTHER_LEAVE_TYPES = ['事假','病假','婚假','喪假','產假'];

function switchMode(mode){
  const isEmp = (mode === 'emp-query' || mode === 'schedule');
  document.getElementById('panelEmp').classList.toggle('active', isEmp);
  document.getElementById('panelNewHire').classList.toggle('active', mode==='newhire');
  document.getElementById('panelAdmin').classList.toggle('active', mode==='admin');
  document.getElementById('btnModeEmpQuery').classList.toggle('active', mode==='emp-query');
  document.getElementById('btnModeSchedule').classList.toggle('active', mode==='schedule');
  document.getElementById('btnModeNewHire').classList.toggle('active', mode==='newhire');
  document.getElementById('btnModeAdmin').classList.toggle('active', mode==='admin');
  if(isEmp){
    EMP_TARGET_TAB = (mode === 'schedule') ? 'empTabSchedule' : 'empTabQuery';
    if(CURRENT_EMPLOYEE) switchEmpTab(EMP_TARGET_TAB);
    const loginTitle = document.getElementById('empLoginTitle');
    if(loginTitle) loginTitle.textContent = (mode === 'schedule') ? '登入排休系統' : '特休查詢/請假申請';
  }
}

function switchEmpTab(tab){
  document.querySelectorAll('#empDashboard .tab-btn').forEach(b=>b.classList.toggle('active', b.dataset.tab===tab));
  document.querySelectorAll('#empDashboard .tab-content').forEach(c=>c.classList.toggle('active', c.id===tab));
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

  queryHtml += '<div class="card"><h2>LINE 通知綁定</h2>' +
    '<p class="hint">綁定後，請假審核結果會透過 LINE 通知您（跟 Email 通知同時發送）。</p>' +
    '<button class="ghost" onclick="doGetLineCode(\'emp\')">取得綁定驗證碼</button>' +
    '<div id="empLineCodeResult"></div></div>';

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
    '<p class="hint">特休／事假／病假會依剩餘天數自動檢查；婚假／喪假／產假天數僅供參考，交由主管審核判斷。</p>' +
    '<div id="submitLeaveMsg"></div>' +
    '</div>' +
    '<div class="card"><h2>我的請假紀錄</h2><div class="table-scroll" id="myLeaveList"><div class="empty">載入中…</div></div></div>';

  const scheduleHtml =
    '<div class="card"><h2>排休申請</h2>' +
    '<p class="hint">店點：' + (emp.branch||'-') + '　職位：' + (emp.position||'-') + '</p>' +
    '<label>選擇年月</label>' +
    buildDateSelectHtml_('schedYearMonth', false) +
    '<div id="schedQuotaInfo" style="margin-top:10px;"><div class="empty">載入中…</div></div>' +
    '<p class="hint">點月曆上的日期就能選取，可以不連續挑選好幾天（例如湊滿本月 8 天），選好後按下方按鈕一次送出。</p>' +
    '<div id="schedCalendar"></div>' +
    '<div id="schedSelectedInfo" style="margin-top:10px;"></div>' +
    '<button class="primary" onclick="doSubmitDayOff(this)">提交已選擇的排休申請</button>' +
    '<p class="hint">如果選到的日期已經有其他技術師申請排休，系統會提醒您，但仍會送出，最終由主管協調確認。</p>' +
    '<div id="submitSchedMsg"></div>' +
    '</div>' +
    '<div class="card"><h2>我的排休申請</h2><div class="table-scroll" id="mySchedList"><div class="empty">載入中…</div></div></div>';

  const html =
    '<p class="hint" style="text-align:right;"><a href="#" onclick="forgetSavedEmployee_();return false;">不是我 / 清除記住的身份</a></p>' +
    '<div class="tab-content active" id="empTabQuery">' + queryHtml + applyHtml + '</div>' +
    '<div class="tab-content" id="empTabSchedule">' + scheduleHtml + '</div>';

  document.getElementById('empDashboard').innerHTML = html;
  switchEmpTab(EMP_TARGET_TAB);
  setDateSelectValue_('schedYearMonth', defaultYearMonth_(), false);
  document.getElementById('schedYearMonth_y').addEventListener('change', loadMySchedule);
  document.getElementById('schedYearMonth_m').addEventListener('change', loadMySchedule);
  loadOtherLeaveOverview();
  loadMyLeaveRequests();
  loadMySchedule();
}

function renderMonthCalendar_(yearMonth, segments, closureWeekday, dayMarkers, selectable){
  const parts = yearMonth.split('-').map(Number);
  const y = parts[0], m = parts[1];
  const firstDay = new Date(y, m-1, 1);
  const daysInMonth = new Date(y, m, 0).getDate();
  const startWeekday = firstDay.getDay();
  const palette = ['#EDEDEA','#D3D3CE','#C0C0BA','#AEAEA7'];
  const labelColors = {};
  let colorIdx = 0;
  function colorForLabel(label){
    if(!labelColors[label]){ labelColors[label] = palette[colorIdx % palette.length]; colorIdx++; }
    return labelColors[label];
  }
  function findSegment(dateStr){
    return (segments||[]).find(s => dateStr >= s.startDate && dateStr <= s.endDate);
  }

  let html = '<div class="cal-grid">';
  ['日','一','二','三','四','五','六'].forEach(w => html += '<div class="cal-head">'+w+'</div>');
  for(let i=0;i<startWeekday;i++) html += '<div class="cal-cell cal-empty"></div>';
  for(let d=1; d<=daysInMonth; d++){
    const dateStr = yearMonth + '-' + String(d).padStart(2,'0');
    const weekday = new Date(y,m-1,d).getDay();
    const isClosure = closureWeekday !== null && closureWeekday !== undefined && weekday === closureWeekday;
    const seg = findSegment(dateStr);
    const bg = isClosure ? 'var(--border)' : (seg ? colorForLabel(seg.segment) : '#fff');
    const marker = (dayMarkers && dayMarkers[dateStr]) ? dayMarkers[dateStr] : '';
    const canClick = selectable && !isClosure;
    const isSelected = canClick && SELECTED_SCHED_DATES.indexOf(dateStr) > -1;
    const cellStyle = 'background:'+bg+';' + (canClick ? 'cursor:pointer;' : '') + (isSelected ? 'outline:3px solid var(--primary); outline-offset:-3px;' : '');
    html += '<div class="cal-cell" style="'+cellStyle+'" title="'+dateStr+'"' + (canClick ? ' onclick="toggleSchedDate(\''+dateStr+'\')"' : '') + '>' +
              '<div class="cal-daynum">'+d+(isClosure?' 休':'')+(isSelected?' ✓':'')+'</div>' +
              (marker ? '<div class="cal-marker">'+marker+'</div>' : '') +
            '</div>';
  }
  html += '</div>';
  html += '<div class="cal-legend">';
  Object.keys(labelColors).forEach(label => {
    html += '<span class="cal-legend-item"><span class="cal-legend-swatch" style="background:'+labelColors[label]+'"></span>'+label+' 區</span>';
  });
  if(closureWeekday !== null && closureWeekday !== undefined){
    html += '<span class="cal-legend-item"><span class="cal-legend-swatch" style="background:var(--border)"></span>公休</span>';
  }
  html += '</div>';
  return html;
}

// ---------- 年/月/日下拉選單（取代手機系統原生日期選擇器，避免跨機型跑版問題）----------
function buildDateSelectHtml_(idPrefix, includeDay){
  const currentYear = new Date().getFullYear();
  let yearOptions = '<option value="">年</option>';
  for(let y = currentYear + 1; y >= currentYear - 80; y--){
    yearOptions += '<option value="'+y+'">'+y+'</option>';
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

function defaultYearMonth_(){
  const d = new Date();
  return d.getFullYear() + '-' + String(d.getMonth()+1).padStart(2,'0');
}

function loadMySchedule(){
  const yearMonth = getDateSelectValue_('schedYearMonth', false);
  if(!yearMonth) return;
  SELECTED_SCHED_DATES = []; // 換月份時清空已選擇的日期
  document.getElementById('schedQuotaInfo').innerHTML = '<div class="empty">載入中…</div>';
  document.getElementById('mySchedList').innerHTML = '<div class="empty">載入中…</div>';
  callApi('getMyDayOffRequests', { nationalId: CURRENT_EMPLOYEE.nationalId, store: CURRENT_EMPLOYEE.branch, yearMonth: yearMonth })
    .then(function(res){
      let quotaHtml = '';
      if(!res.labelSummary.length){
        quotaHtml = '<p class="hint">人資尚未設定 ' + yearMonth + ' 的區塊與可休天數，請聯絡 HR。</p>';
      } else {
        res.labelSummary.forEach(function(pool){
          quotaHtml += '<p class="hint" style="margin-bottom:4px;"><strong>' + pool.segment + ' 區</strong></p>' +
            '<div class="stat-grid" style="margin-bottom:12px;">' +
              statBox('可休天數', pool.quota + ' 天') +
              statBox('已申請', pool.used + ' 天') +
              statBox('剩餘可申請', Math.max(0, pool.quota - pool.used) + ' 天', true) +
            '</div>';
        });
      }
      if(res.closureWeekday !== null){
        const weekdayNames = ['週日','週一','週二','週三','週四','週五','週六'];
        quotaHtml += '<p class="hint">' + weekdayNames[res.closureWeekday] + '為固定公休日，不需要另外申請排休。</p>';
      }
      if(!res.submissionOpen){
        quotaHtml += '<p class="hint">⚠ 這個月份尚未開放排休申請，將於 ' + res.openDate + ' 開放。</p>';
      }
      document.getElementById('schedQuotaInfo').innerHTML = quotaHtml;

      const markers = {};
      (res.storeRequests || []).forEach(function(r){
        const icon = r.isMe ? '● ' : '○ ';
        const line = icon + r.nickname;
        markers[r.date] = markers[r.date] ? (markers[r.date] + '<br>' + line) : line;
      });
      SCHED_CAL_STATE = { yearMonth: yearMonth, segments: res.segments, closureWeekday: res.closureWeekday, markers: markers, submissionOpen: res.submissionOpen };
      renderSchedCalendarWithSelection_();

      const el = document.getElementById('mySchedList');
      if(!res.requests.length){ el.innerHTML = '<div class="empty">本月尚無排休申請。</div>'; return; }
      let html2 = '<table><thead><tr><th>日期</th><th>狀態</th><th>主管備注</th><th>操作</th></tr></thead><tbody>';
      res.requests.forEach(r=>{
        html2 += '<tr><td>'+r.date+'</td><td>'+badgeHtml(r.status==='待協調'?'待審核':(r.status==='已確認'?'已核准':(r.status==='已拒絕'?'已拒絕':r.status)))+'</td><td>'+(r.note||'-')+'</td>' +
                '<td>' + (r.status==='待協調' ? '<button class="small-reject" onclick="doCancelDayOff(\''+r.requestId+'\')">取消</button>' : '-') + '</td></tr>';
      });
      html2 += '</tbody></table>';
      el.innerHTML = html2;
    })
    .catch(function(err){ document.getElementById('schedQuotaInfo').innerHTML = '<div class="msg error">'+(err.message||err)+'</div>'; });
}

function renderSchedCalendarWithSelection_(){
  const s = SCHED_CAL_STATE;
  if(!s.yearMonth) return;
  document.getElementById('schedCalendar').innerHTML = renderMonthCalendar_(s.yearMonth, s.segments, s.closureWeekday, s.markers, !!s.submissionOpen);
  updateSelectedDatesUI_();
}

function toggleSchedDate(dateStr){
  if(!SCHED_CAL_STATE.submissionOpen) return;
  const idx = SELECTED_SCHED_DATES.indexOf(dateStr);
  if(idx > -1) SELECTED_SCHED_DATES.splice(idx, 1);
  else SELECTED_SCHED_DATES.push(dateStr);
  SELECTED_SCHED_DATES.sort();
  renderSchedCalendarWithSelection_();
}

function updateSelectedDatesUI_(){
  const el = document.getElementById('schedSelectedInfo');
  if(!el) return;
  if(!SELECTED_SCHED_DATES.length){
    el.innerHTML = '<p class="hint">尚未選擇任何日期。</p>';
    return;
  }
  el.innerHTML = '<p class="hint"><strong>已選擇 ' + SELECTED_SCHED_DATES.length + ' 天：</strong>' + SELECTED_SCHED_DATES.join('、') +
    '　<a href="#" onclick="clearSchedSelection_();return false;">清空</a></p>';
}

function clearSchedSelection_(){
  SELECTED_SCHED_DATES = [];
  renderSchedCalendarWithSelection_();
}

function doSubmitDayOff(btn){
  if(btn && btn.disabled) return;
  if(!SELECTED_SCHED_DATES.length){ showMsg('submitSchedMsg', '請先點月曆選擇至少一天。', false); return; }
  setBtnBusy(btn, true, '送出中…');
  callApi('submitDayOffRequest', {
    nationalId: CURRENT_EMPLOYEE.nationalId,
    name: CURRENT_EMPLOYEE.name,
    store: CURRENT_EMPLOYEE.branch,
    position: CURRENT_EMPLOYEE.position,
    dates: SELECTED_SCHED_DATES
  })
    .then(function(res){
      setBtnBusy(btn, false);
      let msg = '申請已送出：' + res.submittedDates.join('、') + '（共 ' + res.submittedDates.length + ' 天）。';
      if(res.skippedClosureDates && res.skippedClosureDates.length){
        msg += ' 已自動略過公休日：' + res.skippedClosureDates.join('、') + '。';
      }
      if(res.conflictDates && res.conflictDates.length){
        msg += ' 其中 ' + res.conflictDates.join('、') + ' 已有其他技術師申請，主管會協調安排。';
      }
      showMsg('submitSchedMsg', msg, true);
      SELECTED_SCHED_DATES = [];
      loadMySchedule();
    })
    .catch(function(err){ setBtnBusy(btn, false); showMsg('submitSchedMsg', err.message || String(err), false); });
}

function doCancelDayOff(requestId){
  if(!confirm('確定要取消這筆排休申請嗎？')) return;
  callApi('cancelDayOffRequest', { nationalId: CURRENT_EMPLOYEE.nationalId, requestId: requestId })
    .then(function(){ loadMySchedule(); })
    .catch(function(err){ alert(err.message || err); });
}

function doGetLineCode(who){
  const resultElId = who === 'hr' ? 'hrLineCodeResult' : 'empLineCodeResult';
  const payload = who === 'hr' ? { token: ADMIN_TOKEN } : { nationalId: CURRENT_EMPLOYEE.nationalId };
  document.getElementById(resultElId).innerHTML = '<div class="empty">產生中…</div>';
  callApi('generateLineLinkCode', payload)
    .then(function(res){
      document.getElementById(resultElId).innerHTML =
        '<div class="msg ok">驗證碼：<strong style="font-size:18px;">' + res.code + '</strong>　（10 分鐘內有效）</div>' +
        '<p class="hint">步驟：1. 加官方帳號好友 → <a href="' + res.addFriendUrl + '" target="_blank">點此加入 LINE 好友</a>（或搜尋 ID：' + res.lineOaId + '）　2. 在對話框輸入上面這組驗證碼，即完成綁定。</p>';
    })
    .catch(function(err){
      document.getElementById(resultElId).innerHTML = '<div class="msg error">' + (err.message || err) + '</div>';
    });
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
  const icons = {'待審核':'○','已核准':'✓','已拒絕':'✕','在職':'●','離職':'–'};
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
function doSubmitNewHire(btn){
  if(btn && btn.disabled) return;
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
    account: nval('n_account'),
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
function doAdminLogin(btn){
  if(btn && btn.disabled) return;
  const email = document.getElementById('adminEmail').value.trim();
  setBtnBusy(btn, true, '登入中…');
  callApi('adminLogin', { email: email })
    .then(function(res){
      setBtnBusy(btn, false);
      if(!res.success){ showMsg('adminLoginMsg', res.message, false); return; }
      ADMIN_TOKEN = res.token;
      ADMIN_STORES = res.stores || [];
      document.getElementById('adminLoginCard').style.display = 'none';
      document.getElementById('adminDashboard').style.display = 'block';
      document.getElementById('adminWelcome').textContent = '您好，' + (res.name || res.email) + '（審核紀錄會用這個名稱記錄）' +
        (ADMIN_STORES.length ? '　您負責：' + ADMIN_STORES.join('、') : '');
      applyAdminStoreRestrictions_();
      loadEmployeeList();
      loadPendingRequests();
      loadPendingNewHires();
      identifyOneSignalHR_();
    })
    .catch(function(err){ setBtnBusy(btn, false); showMsg('adminLoginMsg', err.message || String(err), false); });
}

function applyAdminStoreRestrictions_(){
  if(!ADMIN_STORES.length){
    document.querySelector('[data-tab="tabNewHire"]').style.display = '';
    return;
  }
  const pendingTabs = document.querySelectorAll('#tabPending .tabs .tab-btn');
  let firstAllowed = null;
  pendingTabs.forEach(function(btn){
    const store = btn.dataset.store;
    const allowed = store === '全部' ? false : ADMIN_STORES.indexOf(store) > -1;
    btn.style.display = allowed ? '' : 'none';
    if(allowed && !firstAllowed) firstAllowed = store;
  });
  if(firstAllowed) switchPendingStore(firstAllowed);

  const schedSelect = document.getElementById('schedAdminStore');
  if(schedSelect){
    Array.from(schedSelect.options).forEach(function(opt){
      opt.style.display = ADMIN_STORES.indexOf(opt.value) > -1 ? '' : 'none';
    });
    if(ADMIN_STORES.indexOf(schedSelect.value) === -1) schedSelect.value = ADMIN_STORES[0];
  }

  const newHireTab = document.querySelector('[data-tab="tabNewHire"]');
  if(newHireTab) newHireTab.style.display = 'none';
  if(document.getElementById('tabNewHire').classList.contains('active')) switchAdminTab('tabAdd');
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
  document.getElementById('adminDashboard').style.display = 'none';
  document.getElementById('adminLoginCard').style.display = 'block';
  document.getElementById('adminEmail').value = '';
}

function switchAdminTab(tab){
  document.querySelectorAll('.tab-btn').forEach(b=>b.classList.toggle('active', b.dataset.tab===tab));
  document.querySelectorAll('.tab-content').forEach(c=>c.classList.toggle('active', c.id===tab));
  if(tab==='tabList') loadEmployeeList();
  if(tab==='tabPending') loadPendingRequests();
  if(tab==='tabNewHire') loadPendingNewHires();
  if(tab==='tabSchedule'){
    if(!getDateSelectValue_('schedAdminYearMonth', false)){
      setDateSelectValue_('schedAdminYearMonth', defaultYearMonth_(), false);
    }
  }
}

function doAddEmployee(btn){
  if(btn && btn.disabled) return;
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
    account: val('f_account'),
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

function loadEmployeeList(){
  if(!ADMIN_TOKEN) return;
  callApi('getAllEmployeesForAdmin', { token: ADMIN_TOKEN })
    .then(function(list){
      const el = document.getElementById('empListWrap');
      if(!list.length){ el.innerHTML = '<div class="empty">尚無員工資料。</div>'; return; }
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
    })
    .catch(function(err){ document.getElementById('empListWrap').innerHTML = '<div class="msg error">'+(err.message||err)+'</div>'; });
}

function openEmployeeDetail(nationalId){
  document.querySelectorAll('.tab-btn').forEach(b=>b.classList.remove('active'));
  document.querySelectorAll('.tab-content').forEach(c=>c.classList.toggle('active', c.id==='tabDetail'));
  document.getElementById('detailLeaveCard').innerHTML = '<div class="empty">載入中…</div>';
  callApi('getEmployeeDetail', { token: ADMIN_TOKEN, nationalId: nationalId })
    .then(function(res){
      const emp = res.employee;
      document.getElementById('e_originalNationalId').value = emp.nationalId;
      ['branch','employeeType','position','name','nickname','nationalId','gender',
       'householdAddress','mailingAddress','homePhone','mobilePhone','education','hometown',
       'salary','emergencyContact','emergencyRelation','emergencyPhone','note','ig','lineId','account','email']
      .forEach(k => { const el = document.getElementById('e_'+k); if(el) el.value = emp[k] || ''; });
      setDateSelectValue_('e_hireDate', emp.hireDate, true);
      setDateSelectValue_('e_birthDate', emp.birthDate, true);
      setDateSelectValue_('e_insuranceDate', emp.insuranceDate, true);
      setDateSelectValue_('e_resignDate', emp.resignDate, true);

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
    })
    .catch(function(err){
      document.getElementById('detailLeaveCard').innerHTML = '<div class="msg error">'+(err.message||err)+'</div>';
    });
}

function doUpdateEmployee(btn){
  if(btn && btn.disabled) return;
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
    account: val('e_account'),
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
  let html = '<table><thead><tr><th>申請編號</th><th>店點</th><th>員工</th><th>假別</th><th>期間</th><th>天數</th><th>事由</th><th>操作</th></tr></thead><tbody>';
  list.forEach(r=>{
    html += '<tr><td>'+r.requestId+'</td><td>'+(r.branch||'-')+'</td><td>'+r.name+' ('+r.nationalId+')</td><td>'+(r.leaveType||'特休')+'</td><td>'+r.startDate+' ~ '+r.endDate+'</td><td>'+r.days+'</td><td>'+(r.reason||'-')+'</td>' +
            '<td><button class="small-approve" onclick="doReview(\''+r.requestId+'\',\'approve\',this)">核准</button>' +
            '<button class="small-reject" onclick="doReview(\''+r.requestId+'\',\'reject\',this)">拒絕</button></td></tr>';
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

function loadStoreSchedule(){
  const store = document.getElementById('schedAdminStore').value;
  const yearMonth = getDateSelectValue_('schedAdminYearMonth', false);
  if(!yearMonth) return;
  document.getElementById('schedAdminQuotaInfo').innerHTML = '<div class="empty">載入中…</div>';
  document.getElementById('schedAdminWrap').innerHTML = '<div class="empty">載入中…</div>';
  callApi('getStoreScheduleForMonth', { token: ADMIN_TOKEN, store: store, yearMonth: yearMonth })
    .then(function(res){
      const weekdayNames = ['週日','週一','週二','週三','週四','週五','週六'];
      let quotaHtml = '';
      if(!res.labelSummary.length){
        quotaHtml = '<p class="hint">尚未設定這個月的區塊，請到「排休設定」試算表分頁填寫。</p>';
      } else {
        res.labelSummary.forEach(function(pool){
          quotaHtml += '<p class="hint" style="margin-bottom:4px;"><strong>' + pool.segment + ' 區</strong></p>' +
            '<div class="stat-grid" style="margin-bottom:12px;">' +
              statBox('可休天數', pool.quota + ' 天') +
              statBox('已申請（全店合計）', pool.used + ' 天') +
            '</div>';
        });
      }
      if(res.closureWeekday !== null){
        quotaHtml += '<p class="hint">' + weekdayNames[res.closureWeekday] + '為固定公休日。</p>';
      }
      document.getElementById('schedAdminQuotaInfo').innerHTML = quotaHtml;

      const markers = {};
      res.requests.forEach(function(r){
        if(r.status === '已拒絕') return;
        const icon = r.conflict ? '⚠' : (r.status==='已確認'?'✓':'○');
        const line = icon + (r.nickname || r.name);
        markers[r.date] = markers[r.date] ? (markers[r.date] + '<br>' + line) : line;
      });
      document.getElementById('schedAdminCalendar').innerHTML = renderMonthCalendar_(yearMonth, res.segments, res.closureWeekday, markers);

      const el = document.getElementById('schedAdminWrap');
      if(!res.requests.length){ el.innerHTML = '<div class="empty">這個月還沒有人申請排休。</div>'; return; }
      let html = '<table><thead><tr><th>日期</th><th>區塊</th><th>姓名</th><th>職位</th><th>狀態</th><th>操作</th></tr></thead><tbody>';
      res.requests.forEach(r=>{
        html += '<tr' + (r.conflict ? ' style="background:#F1E9E4;"' : '') + '>' +
                '<td>'+r.date+(r.conflict?' ⚠衝突':'')+'</td><td>'+(r.segment||'-')+'</td><td>'+r.name+'</td><td>'+(r.position||'-')+'</td><td>'+badgeHtml(r.status==='待協調'?'待審核':(r.status==='已確認'?'已核准':(r.status==='已拒絕'?'已拒絕':r.status)))+'</td>' +
                '<td>' +
                  '<button class="small-approve" onclick="doReviewSchedule(\''+r.requestId+'\',\'confirm\',this)">確認</button>' +
                  '<button class="small-reject" onclick="doReviewSchedule(\''+r.requestId+'\',\'adjust\',this)">需調整</button>' +
                  '<button class="small-reject" onclick="doReviewSchedule(\''+r.requestId+'\',\'reject\',this)">拒絕</button>' +
                '</td></tr>';
      });
      html += '</tbody></table>';
      el.innerHTML = html;
    })
    .catch(function(err){ document.getElementById('schedAdminWrap').innerHTML = '<div class="msg error">'+(err.message||err)+'</div>'; });
}

function doReviewSchedule(requestId, decision, btn){
  if(btn && btn.disabled) return;
  let note = '';
  if(decision !== 'confirm'){
    note = prompt('備注（選填，會顯示給員工看）：') || '';
  }
  if(btn) setBtnBusy(btn, true, '處理中…');
  callApi('reviewDayOffRequest', { token: ADMIN_TOKEN, requestId: requestId, decision: decision, note: note })
    .then(function(){ loadStoreSchedule(); })
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

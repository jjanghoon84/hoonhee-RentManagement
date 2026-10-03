// ============================================================
// 임대관리 웹앱 - Firebase(Auth + Firestore) 연동
// GitHub Pages용 정적 웹앱. 입주자 개인정보는 코드에 없음.
// ============================================================
import { initializeApp } from 'firebase/app';
import {
  getAuth, signInWithEmailAndPassword, signOut, onAuthStateChanged,
} from 'firebase/auth';
import {
  getFirestore, collection, doc, addDoc, updateDoc, deleteDoc,
  onSnapshot, writeBatch,
} from 'firebase/firestore';
import { firebaseConfig } from './firebase-config.js';

// ---------- PWA: 서비스 워커 등록 ----------
if ('serviceWorker' in navigator) {
  window.addEventListener('load', () => {
    navigator.serviceWorker.register('sw.js').catch(() => {});
  });
}

// ---------- 작은 도구들 ----------
const $ = (id) => document.getElementById(id);

function isPlaceholderConfig(cfg) {
  if (!cfg || typeof cfg !== 'object') return true;
  const v = cfg.apiKey || '';
  return !v || v.includes('여기에') || v.includes('PASTE');
}

function showView(name) {
  $('setupView').hidden = name !== 'setup';
  $('loginView').hidden = name !== 'login';
  $('appView').hidden = name !== 'app';
  window.__appBooted = true;
  const be = $('bootError');
  if (be) be.hidden = true;
}

let toastTimer = null;
function toast(msg) {
  const el = $('toast');
  el.textContent = msg;
  el.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { el.hidden = true; }, 3500);
}

function friendlyAuthError(code) {
  switch (code) {
    case 'auth/invalid-credential':
    case 'auth/user-not-found':
    case 'auth/wrong-password':
      return '이메일 또는 비밀번호가 맞지 않아요.';
    case 'auth/invalid-email':
      return '이메일 형식이 올바르지 않아요.';
    case 'auth/too-many-requests':
      return '로그인 시도가 너무 많아 잠시 잠겼어요. 잠시 후 다시 시도해 주세요.';
    case 'auth/network-request-failed':
      return '네트워크 연결을 확인해 주세요.';
    default:
      return '로그인 중 오류가 발생했어요. (' + code + ')';
  }
}

function friendlyDbError(err) {
  const code = (err && err.code) || '';
  if (code === 'permission-denied') return '데이터 읽기 권한이 없어요. Firestore 규칙을 확인해 주세요.';
  if (code === 'unavailable') return '서버에 연결할 수 없어요. 네트워크를 확인해 주세요.';
  return '오류가 발생했어요. (' + (code || 'unknown') + ')';
}

// ---------- 날짜/금액 ----------
function firstOfMonth(d) { return new Date(d.getFullYear(), d.getMonth(), 1); }
function monthKey(d) { return d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0'); }
function daysInMonth(y, m) { return new Date(y, m, 0).getDate(); } // m: 1~12
function money(n) { return Number(n || 0).toLocaleString('ko-KR') + '원'; }
function esc(s) {
  return String(s == null ? '' : s).replace(/[&<>"']/g, (c) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
  }[c]));
}
function safeDate(v) {
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(String(v || ''));
  return m ? m[1] + '-' + m[2] + '-' + m[3] : '';
}
function todayStr() {
  const d = new Date();
  return d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0');
}

// ---------- 데이터 정규화 (Firestore 스키마) ----------
// { building, room, tenant, phone, contractType, deposit, rent, fee,
//   dueDay, startDate, period, endDate, memo, payments: {'YYYY-MM':'paid'|'unpaid'} }
function normalizeRecord(raw) {
  raw = raw && typeof raw === 'object' ? raw : {};
  const payments = {};
  if (raw.payments && typeof raw.payments === 'object') {
    for (const k of Object.keys(raw.payments)) {
      if (/^\d{4}-\d{2}$/.test(k)) payments[k] = raw.payments[k] === 'paid' ? 'paid' : 'unpaid';
    }
  }
  const b = String(raw.building || '').trim();
  return {
    building: b === '형제그린빌라' ? '형제그린빌라' : '스마트빌',
    room: String(raw.room || '').slice(0, 20),
    tenant: String(raw.tenant || '').slice(0, 40),
    phone: String(raw.phone || '').slice(0, 20),
    contractType: raw.contractType === '전세' ? '전세' : '월세',
    deposit: Math.max(0, Number(raw.deposit) || 0),
    rent: Math.max(0, Number(raw.rent) || 0),
    fee: Math.max(0, Number(raw.fee) || 0),
    dueDay: Math.min(31, Math.max(1, Number(raw.dueDay) || 1)),
    startDate: safeDate(raw.startDate),
    period: String(raw.period || '').slice(0, 30),
    endDate: safeDate(raw.endDate),
    memo: String(raw.memo || raw.note || raw.notes || '').slice(0, 300),
    payments,
  };
}

// ---------- 월별 수납 상태 ----------
// 'paid' 입금완료(초록) / 'unpaid' 미납(빨강) / 'pending' 대기(회색)
function paymentState(rec, key) {
  if (rec.payments && rec.payments[key] === 'paid') return 'paid';
  const parts = key.split('-').map(Number);
  const due = new Date(parts[0], parts[1] - 1,
    Math.min(Number(rec.dueDay) || 1, daysInMonth(parts[0], parts[1])), 23, 59, 59);
  return due < new Date() ? 'unpaid' : 'pending';
}

function isExpiring(rec) {
  if (!rec.endDate) return false;
  const diff = Math.floor((new Date(rec.endDate + 'T00:00:00') - new Date()) / 86400000);
  return diff >= 0 && diff <= 90;
}

// ---------- CSV 파서 ----------
function parseCsv(text) {
  const rows = [];
  let row = [], cell = '', quoted = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i], n = text[i + 1];
    if (c === '"' && quoted && n === '"') { cell += '"'; i++; }
    else if (c === '"') { quoted = !quoted; }
    else if (c === ',' && !quoted) { row.push(cell); cell = ''; }
    else if ((c === '\n' || c === '\r') && !quoted) {
      if (c === '\r' && n === '\n') i++;
      row.push(cell);
      if (row.some((x) => x.trim())) rows.push(row);
      row = []; cell = '';
    } else { cell += c; }
  }
  if (cell || row.length) { row.push(cell); rows.push(row); }
  if (rows.length < 2) return [];
  const head = rows[0].map((x) => x.replace(/^﻿/, '').trim());
  return rows.slice(1).map((cols) => {
    const o = {};
    head.forEach((h, j) => { o[h] = (cols[j] || '').trim(); });
    return normalizeRecord({
      building: o['건물'] || '스마트빌',
      room: o['호실'] || '',
      tenant: o['입주자명'] || '',
      phone: o['전화번호'] || o['입주자 전화번호'] || '',
      contractType: o['계약형태'] || '월세',
      deposit: Number(String(o['보증금'] || 0).replace(/[^0-9.-]/g, '')),
      rent: Number(String(o['월세'] || 0).replace(/[^0-9.-]/g, '')),
      fee: Number(String(o['관리비'] || 0).replace(/[^0-9.-]/g, '')),
      dueDay: Number(String(o['납부일'] || 1).replace(/[^0-9]/g, '')) || 1,
      startDate: o['계약일'] || '',
      period: o['계약기간'] || '',
      endDate: o['만기일'] || '',
      memo: o['비고'] || '',
    });
  }).filter((r) => r.room && r.tenant);
}

// ---------- 파일 다운로드 ----------
function downloadFile(name, content, mime) {
  const blob = new Blob([content], { type: mime });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = name;
  document.body.appendChild(a);
  a.click();
  setTimeout(() => { URL.revokeObjectURL(a.href); a.remove(); }, 1000);
}

// ============================================================
// 설정 확인 → 안내 화면 or 앱 시작
// ============================================================
if (isPlaceholderConfig(firebaseConfig)) {
  showView('setup');
} else {
  boot();
}

function boot() {
  let auth, db;
  try {
    const app = initializeApp(firebaseConfig);
    auth = getAuth(app);
    db = getFirestore(app);
  } catch (e) {
    showView('setup');
    toast('Firebase 설정 값을 확인해 주세요.');
    return;
  }

  const recordsCol = collection(db, 'records');

  const state = {
    user: null,
    records: [],          // {id, ...fields}
    building: '스마트빌',
    viewDate: firstOfMonth(new Date()),
    filter: 'all',
    search: '',
    editingId: null,
    unsubscribe: null,
  };

  // ---------- 로그인 ----------
  $('loginForm').addEventListener('submit', async (e) => {
    e.preventDefault();
    $('loginError').hidden = true;
    const btn = $('loginBtn');
    btn.disabled = true;
    try {
      await signInWithEmailAndPassword(auth, $('email').value.trim(), $('password').value);
    } catch (err) {
      const p = $('loginError');
      p.textContent = friendlyAuthError(err.code);
      p.hidden = false;
    } finally {
      btn.disabled = false;
    }
  });

  $('logoutBtn').addEventListener('click', async () => {
    try { await signOut(auth); }
    catch (e) { toast('로그아웃 중 오류가 발생했어요.'); }
  });

  onAuthStateChanged(auth, (user) => {
    state.user = user;
    if (user) {
      $('userLine').textContent = '로그인: ' + (user.email || '');
      showView('app');
      subscribeRecords();
    } else {
      if (state.unsubscribe) { state.unsubscribe(); state.unsubscribe = null; }
      state.records = [];
      $('password').value = '';
      showView('login');
    }
  });

  // ---------- 실시간 구독 (두 사람이 동시에 같은 데이터) ----------
  function subscribeRecords() {
    if (state.unsubscribe) state.unsubscribe();
    state.unsubscribe = onSnapshot(recordsCol,
      (snap) => {
        state.records = snap.docs.map((d) => ({ id: d.id, ...d.data() }));
        render();
      },
      (err) => { toast(friendlyDbError(err)); });
  }

  // ---------- 건물 탭 ----------
  document.querySelectorAll('.building-tab').forEach((btn) => {
    btn.addEventListener('click', () => {
      state.building = btn.dataset.building;
      document.querySelectorAll('.building-tab').forEach((b) =>
        b.classList.toggle('active', b === btn));
      render();
    });
  });

  // ---------- 월 이동 ----------
  $('prevMonth').addEventListener('click', () => {
    state.viewDate = new Date(state.viewDate.getFullYear(), state.viewDate.getMonth() - 1, 1);
    render();
  });
  $('nextMonth').addEventListener('click', () => {
    state.viewDate = new Date(state.viewDate.getFullYear(), state.viewDate.getMonth() + 1, 1);
    render();
  });
  $('todayBtn').addEventListener('click', () => {
    state.viewDate = firstOfMonth(new Date());
    render();
  });

  // ---------- 검색 / 필터 ----------
  $('searchInput').addEventListener('input', (e) => { state.search = e.target.value; render(); });
  $('filters').addEventListener('click', (e) => {
    const btn = e.target.closest('[data-filter]');
    if (!btn) return;
    state.filter = btn.dataset.filter;
    document.querySelectorAll('#filters .chip').forEach((c) =>
      c.classList.toggle('active', c === btn));
    render();
  });

  // ---------- 목록 렌더 ----------
  function buildingRecords() {
    return state.records.filter((r) => r.building === state.building);
  }

  function visibleRecords() {
    const key = monthKey(state.viewDate);
    const q = state.search.trim().toLowerCase();
    return buildingRecords()
      .filter((r) => {
        if (q) {
          const hay = [r.room, r.tenant, r.phone, r.memo].join(' ').toLowerCase();
          if (!hay.includes(q)) return false;
        }
        const st = paymentState(r, key);
        if (state.filter === 'unpaid' && st !== 'unpaid') return false;
        if (state.filter === 'paid' && st !== 'paid') return false;
        if (state.filter === 'expiry' && !isExpiring(r)) return false;
        return true;
      })
      .sort((a, b) => String(a.room).localeCompare(String(b.room), 'ko'));
  }

  const STATUS_TEXT = { paid: '완납', unpaid: '미납', pending: '대기' };

  function cardHtml(r, key) {
    const st = paymentState(r, key);
    const monthly = (Number(r.rent) || 0) + (Number(r.fee) || 0);
    const toggleLabel = st === 'paid' ? '입금 취소' : '입금 처리';
    const toggleClass = st === 'paid' ? 'unpay' : 'pay';
    return '<article class="card">' +
      '<div class="card-head">' +
        '<div><span class="card-room">' + esc(r.room) + '호</span> ' +
        '<span class="badge">' + esc(r.contractType) + '</span></div>' +
        '<span class="status-pill status-' + st + '">' + STATUS_TEXT[st] + '</span>' +
      '</div>' +
      '<div><span class="card-tenant">' + esc(r.tenant) + '</span> ' +
        '<span class="card-phone">' + esc(r.phone) + '</span></div>' +
      '<div class="card-grid">' +
        '<div><span class="k">보증금</span><span class="v">' + money(r.deposit) + '</span></div>' +
        '<div><span class="k">월세</span><span class="v">' + money(r.rent) + '</span></div>' +
        '<div><span class="k">관리비</span><span class="v">' + money(r.fee) + '</span></div>' +
      '</div>' +
      '<div class="card-dates">매월 ' + esc(r.dueDay) + '일 납부 · 월 ' + money(monthly) +
        (r.startDate ? ' · ' + esc(r.startDate) + ' ~ ' + esc(r.endDate || '') : '') + '</div>' +
      (r.memo ? '<div class="card-memo">📝 ' + esc(r.memo) + '</div>' : '') +
      '<div class="card-actions">' +
        '<button class="btn ' + toggleClass + '" type="button" data-action="toggle" data-id="' + r.id + '">' + toggleLabel + '</button>' +
        '<button class="btn" type="button" data-action="edit" data-id="' + r.id + '">수정</button>' +
        '<button class="btn" type="button" data-action="delete" data-id="' + r.id + '">삭제</button>' +
      '</div>' +
    '</article>';
  }

  function render() {
    const key = monthKey(state.viewDate);
    const y = state.viewDate.getFullYear(), m = state.viewDate.getMonth() + 1;
    $('pageTitle').textContent = state.building + ' · ' + y + '년 ' + m + '월';
    $('monthLabel').textContent = y + '년 ' + m + '월';

    const inBuilding = buildingRecords();
    const smartCount = state.records.filter((r) => r.building === '스마트빌').length;
    const villaCount = state.records.filter((r) => r.building === '형제그린빌라').length;
    $('countSmartville').textContent = smartCount ? '등록 ' + smartCount + '실' : '';
    $('countVilla').textContent = villaCount ? '등록 ' + villaCount + '실' : '';

    // 대시보드
    let expected = 0, collected = 0;
    const unpaid = [];
    for (const r of inBuilding) {
      const monthly = (Number(r.rent) || 0) + (Number(r.fee) || 0);
      expected += monthly;
      const st = paymentState(r, key);
      if (st === 'paid') collected += monthly;
      else if (st === 'unpaid') unpaid.push(r);
    }
    $('statExpected').textContent = money(expected);
    $('statCollected').textContent = money(collected);
    $('statRate').textContent = expected > 0 ? Math.round((collected / expected) * 100) + '%' : '-';
    $('unpaidCount').textContent = unpaid.length ? '(' + unpaid.length + '실)' : '';
    $('unpaidList').innerHTML = unpaid.length
      ? unpaid.sort((a, b) => String(a.room).localeCompare(String(b.room), 'ko'))
          .map((r) => '<li>' + esc(r.room) + '호 ' + esc(r.tenant) + ' · 월 ' +
            money((Number(r.rent) || 0) + (Number(r.fee) || 0)) + '</li>').join('')
      : '<li class="none">미납이 없어요. 🎉</li>';

    const expiring = inBuilding.filter(isExpiring)
      .sort((a, b) => String(a.endDate).localeCompare(String(b.endDate)));
    $('expiryList').innerHTML = expiring.length
      ? expiring.map((r) => '<li>' + esc(r.room) + '호 ' + esc(r.tenant) +
          ' · 만기 ' + esc(r.endDate) + '</li>').join('')
      : '<li class="none">90일 이내 만기가 없어요.</li>';

    // 목록
    const list = visibleRecords();
    $('recordList').innerHTML = list.map((r) => cardHtml(r, key)).join('');
    $('emptyMsg').hidden = list.length > 0;
  }

  // ---------- 목록 버튼 (입금 처리 / 수정 / 삭제) ----------
  $('recordList').addEventListener('click', async (e) => {
    const btn = e.target.closest('[data-action]');
    if (!btn) return;
    const id = btn.dataset.id;
    const rec = state.records.find((r) => r.id === id);
    if (!rec) return;
    const action = btn.dataset.action;

    if (action === 'toggle') {
      const key = monthKey(state.viewDate);
      const next = paymentState(rec, key) === 'paid' ? 'unpaid' : 'paid';
      try {
        await updateDoc(doc(db, 'records', id), { ['payments.' + key]: next });
      } catch (err) { toast(friendlyDbError(err)); }
    } else if (action === 'edit') {
      openDialog(rec);
    } else if (action === 'delete') {
      if (!window.confirm(rec.room + '호 ' + rec.tenant + '님의 임대차 정보를 삭제할까요?\n삭제하면 되돌릴 수 없어요.')) return;
      try {
        await deleteDoc(doc(db, 'records', id));
        toast('삭제했어요.');
      } catch (err) { toast(friendlyDbError(err)); }
    }
  });

  // ---------- 등록/수정 다이얼로그 ----------
  const dialog = $('recordDialog');

  function openDialog(rec) {
    state.editingId = rec ? rec.id : null;
    $('dialogTitle').textContent = rec ? '임대차 수정' : '임대차 등록';
    $('fBuilding').value = rec ? rec.building : state.building;
    $('fRoom').value = rec ? rec.room : '';
    $('fTenant').value = rec ? rec.tenant : '';
    $('fPhone').value = rec ? rec.phone : '';
    $('fContractType').value = rec ? rec.contractType : '월세';
    $('fDeposit').value = rec ? rec.deposit : 0;
    $('fRent').value = rec ? rec.rent : 0;
    $('fFee').value = rec ? rec.fee : 0;
    $('fDueDay').value = rec ? rec.dueDay : 1;
    $('fStartDate').value = rec ? rec.startDate : '';
    $('fPeriod').value = rec ? rec.period : '';
    $('fEndDate').value = rec ? rec.endDate : '';
    $('fMemo').value = rec ? rec.memo : '';
    dialog.showModal();
  }

  $('addBtn').addEventListener('click', () => openDialog(null));
  $('cancelRecordBtn').addEventListener('click', () => dialog.close());

  $('recordForm').addEventListener('submit', async (e) => {
    e.preventDefault();
    const data = normalizeRecord({
      building: $('fBuilding').value,
      room: $('fRoom').value.trim(),
      tenant: $('fTenant').value.trim(),
      phone: $('fPhone').value.trim(),
      contractType: $('fContractType').value,
      deposit: $('fDeposit').value,
      rent: $('fRent').value,
      fee: $('fFee').value,
      dueDay: $('fDueDay').value,
      startDate: $('fStartDate').value,
      period: $('fPeriod').value.trim(),
      endDate: $('fEndDate').value,
      memo: $('fMemo').value.trim(),
    });
    if (!data.room || !data.tenant) { toast('호실과 입주자명은 꼭 입력해 주세요.'); return; }
    try {
      if (state.editingId) {
        await updateDoc(doc(db, 'records', state.editingId), data);
        toast('수정했어요.');
      } else {
        await addDoc(recordsCol, data);
        toast('등록했어요.');
      }
      dialog.close();
    } catch (err) { toast(friendlyDbError(err)); }
  });

  // ---------- 데이터 불러오기 (JSON / CSV) ----------
  $('importBtn').addEventListener('click', () => $('fileInput').click());
  $('fileInput').addEventListener('change', async (e) => {
    const file = e.target.files && e.target.files[0];
    e.target.value = '';
    if (!file) return;
    try {
      const text = await file.text();
      let records;
      if (file.name.toLowerCase().endsWith('.json')) {
        const parsed = JSON.parse(text);
        const arr = Array.isArray(parsed) ? parsed : parsed.records;
        if (!Array.isArray(arr)) throw new Error('invalid');
        records = arr.map(normalizeRecord).filter((r) => r.room && r.tenant);
      } else {
        records = parseCsv(text);
      }
      if (!records.length) { toast('불러올 데이터가 없어요. 파일 형식을 확인해 주세요.'); return; }
      if (!window.confirm(records.length + '건을 Firestore에 저장할까요?')) return;
      let done = 0;
      for (let i = 0; i < records.length; i += 400) {
        const batch = writeBatch(db);
        for (const r of records.slice(i, i + 400)) batch.set(doc(recordsCol), r);
        await batch.commit();
        done += Math.min(400, records.length - i);
      }
      toast(done + '건을 저장했어요.');
    } catch (err) {
      toast('파일을 읽지 못했어요. JSON 또는 CSV 형식인지 확인해 주세요.');
    }
  });

  // ---------- JSON 백업 ----------
  $('backupBtn').addEventListener('click', () => {
    const data = state.records.map(({ id, ...rest }) => rest);
    const name = '임대관리_백업_' + todayStr() + '.json';
    downloadFile(name, JSON.stringify({ records: data }, null, 1), 'application/json');
    toast('백업 파일을 저장했어요.');
  });

  // ---------- CSV 내보내기 (엑셀용) ----------
  $('csvBtn').addEventListener('click', () => {
    const head = ['건물', '호실', '입주자명', '전화번호', '계약형태', '보증금', '월세', '관리비', '납부일', '계약일', '계약기간', '만기일', '비고'];
    const q = (v) => '"' + String(v == null ? '' : v).replace(/"/g, '""') + '"';
    const lines = [head.map(q).join(',')];
    for (const r of buildingRecords().sort((a, b) => String(a.room).localeCompare(String(b.room), 'ko'))) {
      lines.push([r.building, r.room, r.tenant, r.phone, r.contractType, r.deposit, r.rent,
        r.fee, r.dueDay, r.startDate, r.period, r.endDate, r.memo].map(q).join(','));
    }
    const name = '임대관리_' + state.building + '_' + todayStr() + '.csv';
    downloadFile(name, '﻿' + lines.join('\r\n'), 'text/csv;charset=utf-8');
    toast('CSV 파일을 저장했어요.');
  });
}

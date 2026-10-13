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
  onSnapshot, writeBatch, arrayUnion,
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
//   dueDay, startDate, period, endDate, memo,
//   payments: {'YYYY-MM':'paid'|'unpaid'} (구방식, 호환용),
//   ledger: [{id, date:'YYYY-MM-DD', amount, memo, by, ts}],
//   closed: {'YYYY-MM': true}, history: [{ts, by, action, detail}],
//   settlement: {...} | null }
function normalizeRecord(raw) {
  raw = raw && typeof raw === 'object' ? raw : {};
  const payments = {};
  if (raw.payments && typeof raw.payments === 'object') {
    for (const k of Object.keys(raw.payments)) {
      if (/^\d{4}-\d{2}$/.test(k)) payments[k] = raw.payments[k] === 'paid' ? 'paid' : 'unpaid';
    }
  }
  const ledger = [];
  if (Array.isArray(raw.ledger)) {
    for (const e of raw.ledger) {
      if (!e || typeof e !== 'object') continue;
      const amt = Math.max(0, Number(e.amount) || 0);
      const d = safeDate(e.date);
      if (!d || amt <= 0) continue;
      ledger.push({
        id: String(e.id || '').slice(0, 40),
        date: d,
        amount: amt,
        memo: String(e.memo || '').slice(0, 100),
        by: String(e.by || '').slice(0, 60),
        ts: Number(e.ts) || 0,
      });
    }
  }
  const closed = {};
  if (raw.closed && typeof raw.closed === 'object') {
    for (const k of Object.keys(raw.closed)) {
      if (/^\d{4}-\d{2}$/.test(k) && raw.closed[k]) closed[k] = true;
    }
  }
  const history = Array.isArray(raw.history)
    ? raw.history.filter((h) => h && typeof h === 'object').slice(-50)
    : [];
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
    ledger,
    closed,
    history,
    settlement: raw.settlement && typeof raw.settlement === 'object' ? raw.settlement : null,
  };
}

// ---------- 자산/대출 데이터 정규화 ----------
const ASSET_CATEGORIES = ['부동산', '주식', '예금', '현금', '기타'];
const ASSET_OWNERS = ['공동', '본인', '아내'];

function normalizeAsset(raw) {
  raw = raw && typeof raw === 'object' ? raw : {};
  const cat = String(raw.category || '기타');
  const owner = String(raw.owner || '공동');
  return {
    name: String(raw.name || '').slice(0, 40),
    category: ASSET_CATEGORIES.includes(cat) ? cat : '기타',
    amount: Math.max(0, Number(raw.amount) || 0),
    owner: ASSET_OWNERS.includes(owner) ? owner : '공동',
    baseDate: safeDate(raw.baseDate),
    memo: String(raw.memo || '').slice(0, 300),
  };
}

function normalizeLoan(raw) {
  raw = raw && typeof raw === 'object' ? raw : {};
  return {
    name: String(raw.name || '').slice(0, 40),
    lender: String(raw.lender || '').slice(0, 40),
    balance: Math.max(0, Number(raw.balance) || 0),
    rate: Math.max(0, Number(raw.rate) || 0),
    monthlyPayment: Math.max(0, Number(raw.monthlyPayment) || 0),
    endDate: safeDate(raw.endDate),
    memo: String(raw.memo || '').slice(0, 300),
  };
}

// ---------- 입금 장부 ----------
// 구 payments('paid' 토글)는 장부에 수기 항목이 없는 달에만 이관 항목으로 계산 (중복 방지)
function getLedger(rec) {
  const manual = [];
  if (Array.isArray(rec.ledger)) {
    for (const e of rec.ledger) {
      if (!e || typeof e !== 'object') continue;
      const amt = Number(e.amount) || 0;
      const d = safeDate(e.date);
      if (!d || amt <= 0) continue;
      manual.push({
        id: String(e.id || ''),
        date: d,
        amount: amt,
        memo: String(e.memo || ''),
        by: String(e.by || ''),
        ts: Number(e.ts) || 0,
      });
    }
  }
  const manualMonths = new Set(manual.map((e) => e.date.slice(0, 7)));
  const out = manual.slice();
  if (rec.payments && typeof rec.payments === 'object') {
    const monthly = (Number(rec.rent) || 0) + (Number(rec.fee) || 0);
    for (const k of Object.keys(rec.payments)) {
      if (!/^\d{4}-\d{2}$/.test(k) || rec.payments[k] !== 'paid') continue;
      if (manualMonths.has(k)) continue; // 수기 항목이 있으면 토글은 무시
      if (out.some((e) => e.id === 'mig-' + k)) continue;
      const parts = k.split('-').map(Number);
      const d = Math.min(Number(rec.dueDay) || 1, daysInMonth(parts[0], parts[1]));
      out.push({
        id: 'mig-' + k,
        date: k + '-' + String(d).padStart(2, '0'),
        amount: monthly,
        memo: '기존 기록 이관',
        by: '',
        ts: 0,
      });
    }
  }
  return out.sort((a, b) => String(a.date).localeCompare(String(b.date)));
}

// 해당 월 입금 합계
function paidForMonth(rec, key) {
  return getLedger(rec).reduce((s, e) => s + (e.date.slice(0, 7) === key ? e.amount : 0), 0);
}

function monthClosed(rec, key) {
  return !!(rec.closed && rec.closed[key]);
}

// ---------- 월별 수납 상태 ----------
// 'paid' 완납(초록) / 'partial' 부분입금(주황) / 'unpaid' 미납(빨강) / 'pending' 대기(회색)
function paymentState(rec, key) {
  const monthly = (Number(rec.rent) || 0) + (Number(rec.fee) || 0);
  const paid = paidForMonth(rec, key);
  if (monthly <= 0) return paid > 0 ? 'paid' : 'pending';
  if (paid >= monthly) return 'paid';
  if (paid > 0) return 'partial';
  const parts = key.split('-').map(Number);
  const due = new Date(parts[0], parts[1] - 1,
    Math.min(Number(rec.dueDay) || 1, daysInMonth(parts[0], parts[1])), 23, 59, 59);
  return due < new Date() ? 'unpaid' : 'pending';
}

// 해당 월 미납액 (부분입금 포함)
function unpaidForMonth(rec, key) {
  const monthly = (Number(rec.rent) || 0) + (Number(rec.fee) || 0);
  return Math.max(0, monthly - paidForMonth(rec, key));
}

function makeLedgerId() {
  return 'L' + Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
}

function monthAdd(key, n) {
  const parts = key.split('-').map(Number);
  const d = new Date(parts[0], parts[1] - 1 + n, 1);
  return d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0');
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
  const assetsCol = collection(db, 'assets');
  const loansCol = collection(db, 'loans');

  const state = {
    user: null,
    records: [],          // {id, ...fields}
    assets: [],           // {id, ...assetFields}
    loans: [],            // {id, ...loanFields}
    mainView: 'rental',   // 'rental' | 'asset'
    building: '스마트빌',
    viewDate: firstOfMonth(new Date()),
    filter: 'all',
    search: '',
    editingId: null,
    editingAssetId: null,
    editingLoanId: null,
    unsubscribe: null,
    unsubAssets: null,
    unsubLoans: null,
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
      subscribeAssets();
      subscribeLoans();
    } else {
      if (state.unsubscribe) { state.unsubscribe(); state.unsubscribe = null; }
      if (state.unsubAssets) { state.unsubAssets(); state.unsubAssets = null; }
      if (state.unsubLoans) { state.unsubLoans(); state.unsubLoans = null; }
      state.records = [];
      state.assets = [];
      state.loans = [];
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

  function subscribeAssets() {
    if (state.unsubAssets) state.unsubAssets();
    state.unsubAssets = onSnapshot(assetsCol,
      (snap) => {
        state.assets = snap.docs.map((d) => ({ id: d.id, ...normalizeAsset(d.data()) }));
        render();
      },
      (err) => { toast(friendlyDbError(err)); });
  }

  function subscribeLoans() {
    if (state.unsubLoans) state.unsubLoans();
    state.unsubLoans = onSnapshot(loansCol,
      (snap) => {
        state.loans = snap.docs.map((d) => ({ id: d.id, ...normalizeLoan(d.data()) }));
        render();
      },
      (err) => { toast(friendlyDbError(err)); });
  }

  // ---------- 임대/자산 화면 전환 ----------
  document.querySelectorAll('.main-tab').forEach((btn) => {
    btn.addEventListener('click', () => {
      state.mainView = btn.dataset.mainview;
      document.querySelectorAll('.main-tab').forEach((b) =>
        b.classList.toggle('active', b === btn));
      $('rentalSection').hidden = state.mainView !== 'rental';
      $('assetSection').hidden = state.mainView !== 'asset';
      render();
    });
  });

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
        if (state.filter === 'unpaid' && st !== 'unpaid' && st !== 'partial') return false;
        if (state.filter === 'paid' && st !== 'paid') return false;
        if (state.filter === 'expiry' && !isExpiring(r)) return false;
        return true;
      })
      .sort((a, b) => String(a.room).localeCompare(String(b.room), 'ko'));
  }

  const STATUS_TEXT = { paid: '완납', partial: '부분입금', unpaid: '미납', pending: '대기' };

  function cardHtml(r, key) {
    const st = paymentState(r, key);
    const monthly = (Number(r.rent) || 0) + (Number(r.fee) || 0);
    const paid = paidForMonth(r, key);
    const settled = r.settlement && r.settlement.confirmedAt;
    return '<article class="card">' +
      '<div class="card-head">' +
        '<div><span class="card-room">' + esc(r.room) + '호</span> ' +
        '<span class="badge">' + esc(r.contractType) + '</span>' +
        (settled ? '<span class="badge settle-done">정산완료</span>' : '') + '</div>' +
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
        ' · 입금 ' + money(paid) +
        (r.startDate ? ' · ' + esc(r.startDate) + ' ~ ' + esc(r.endDate || '') : '') + '</div>' +
      (r.memo ? '<div class="card-memo">📝 ' + esc(r.memo) + '</div>' : '') +
      '<div class="card-actions">' +
        '<button class="btn pay" type="button" data-action="pay" data-id="' + r.id + '">입금 기록</button>' +
        '<button class="btn" type="button" data-action="settle" data-id="' + r.id + '">퇴실 정산</button>' +
        '<button class="btn" type="button" data-action="edit" data-id="' + r.id + '">수정</button>' +
        '<button class="btn" type="button" data-action="delete" data-id="' + r.id + '">삭제</button>' +
      '</div>' +
    '</article>';
  }

  function render() {
    if (state.mainView === 'asset') {
      $('pageTitle').textContent = '자산관리';
      renderAssets();
      return;
    }
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
      collected += Math.min(paidForMonth(r, key), monthly);
      const due = unpaidForMonth(r, key);
      const st = paymentState(r, key);
      if (st === 'unpaid' || st === 'partial') unpaid.push({ r, due });
    }
    $('statExpected').textContent = money(expected);
    $('statCollected').textContent = money(collected);
    $('statRate').textContent = expected > 0 ? Math.round((collected / expected) * 100) + '%' : '-';
    $('unpaidCount').textContent = unpaid.length ? '(' + unpaid.length + '실)' : '';
    $('unpaidList').innerHTML = unpaid.length
      ? unpaid.sort((a, b) => String(a.r.room).localeCompare(String(b.r.room), 'ko'))
          .map((u) => '<li>' + esc(u.r.room) + '호 ' + esc(u.r.tenant) + ' · 미납 ' +
            money(u.due) + '</li>').join('')
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

  // ---------- 목록 버튼 (입금 기록 / 퇴실 정산 / 수정 / 삭제) ----------
  $('recordList').addEventListener('click', async (e) => {
    const btn = e.target.closest('[data-action]');
    if (!btn) return;
    const id = btn.dataset.id;
    const rec = state.records.find((r) => r.id === id);
    if (!rec) return;
    const action = btn.dataset.action;

    if (action === 'pay') {
      openPayDialog(rec);
    } else if (action === 'settle') {
      openSettleDialog(rec);
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

  // ---------- 변경 이력 기록 ----------
  function historyEntry(action, detail) {
    return {
      ts: Date.now(),
      by: state.user ? String(state.user.email || '') : '',
      action: String(action),
      detail: String(detail || '').slice(0, 120),
    };
  }

  function fmtTs(ts) {
    if (!ts) return '';
    const d = new Date(ts);
    const p = (n) => String(n).padStart(2, '0');
    return d.getFullYear() + '-' + p(d.getMonth() + 1) + '-' + p(d.getDate()) +
      ' ' + p(d.getHours()) + ':' + p(d.getMinutes());
  }

  // ---------- 입금 장부 다이얼로그 ----------
  const payDialog = $('payDialog');
  let payRecId = null;

  function openPayDialog(rec) {
    payRecId = rec.id;
    $('payDialogTitle').textContent = rec.room + '호 ' + rec.tenant + ' · 입금 장부';
    renderPayDialog();
    payDialog.showModal();
  }

  function currentPayRec() {
    return state.records.find((r) => r.id === payRecId);
  }

  function renderPayDialog() {
    const rec = currentPayRec();
    if (!rec) { payDialog.close(); return; }
    const monthly = (Number(rec.rent) || 0) + (Number(rec.fee) || 0);
    const ledger = getLedger(rec);
    const groups = {};
    for (const e of ledger) {
      const k = e.date.slice(0, 7);
      (groups[k] = groups[k] || []).push(e);
    }
    const keys = Object.keys(groups).sort().reverse();
    if (!keys.length) {
      $('payMonthGroups').innerHTML = '<p class="empty-sm">아직 입금 기록이 없어요.<br>아래에서 첫 입금을 기록해 보세요.</p>';
    } else {
      $('payMonthGroups').innerHTML = keys.map((k) => {
        const paid = groups[k].reduce((s, e) => s + e.amount, 0);
        const rest = Math.max(0, monthly - paid);
        const closed = monthClosed(rec, k);
        const ym = k.replace('-', '년 ') + '월';
        const rows = groups[k].slice().reverse().map((e) =>
          '<div class="ledger-row">' +
            '<span class="ld-date">' + esc(e.date.slice(5)) + '</span>' +
            '<span class="ld-amt">' + money(e.amount) + '</span>' +
            '<span class="ld-memo">' + esc(e.memo || '') + (e.by ? ' · ' + esc(e.by.split('@')[0]) : '') + '</span>' +
            (closed || e.id.indexOf('mig-') === 0
              ? ''
              : '<button class="btn sm danger-ghost" type="button" data-del-ledger="' + esc(e.id) + '">삭제</button>') +
          '</div>').join('');
        return '<div class="month-group' + (closed ? ' locked' : '') + '">' +
          '<div class="month-group-head">' +
            '<strong>' + ym + '</strong>' +
            '<span>청구 ' + money(monthly) + ' · 입금 ' + money(paid) +
            (rest > 0 ? ' · <span class="neg">잔액 ' + money(rest) + '</span>' : ' · <span class="pos">완납</span>') + '</span>' +
            '<button class="btn sm" type="button" data-close-month="' + k + '">' +
              (closed ? '🔓 마감 해제' : '🔒 이 달 마감') + '</button>' +
          '</div>' + rows + '</div>';
      }).join('');
    }
    // 입력 기본값: 오늘 날짜, 남은 금액
    const today = todayStr();
    const tKey = today.slice(0, 7);
    const rest = Math.max(0, monthly - paidForMonth(rec, tKey));
    $('pDate').value = today;
    $('pAmount').value = rest > 0 ? rest : monthly;
    $('pMemo').value = '';
    // 변경 이력
    const hist = Array.isArray(rec.history) ? rec.history.slice().reverse().slice(0, 8) : [];
    $('payHistory').innerHTML = hist.length
      ? '<h3 class="sec-title">최근 변경 이력</h3>' +
        hist.map((h) => '<div class="hist-row"><span>' + esc(fmtTs(h.ts)) + '</span>' +
          '<span><strong>' + esc(h.action) + '</strong> ' + esc(h.detail || '') +
          (h.by ? ' <span class="muted">(' + esc(String(h.by).split('@')[0]) + ')</span>' : '') + '</span></div>').join('')
      : '';
  }

  $('payMonthGroups').addEventListener('click', async (e) => {
    const rec = currentPayRec();
    if (!rec) return;
    const delBtn = e.target.closest('[data-del-ledger]');
    const closeBtn = e.target.closest('[data-close-month]');
    try {
      if (delBtn) {
        const eid = delBtn.dataset.delLedger;
        const target = getLedger(rec).find((x) => x.id === eid);
        if (!target) return;
        if (monthClosed(rec, target.date.slice(0, 7))) { toast('마감된 달이에요. 마감을 해제한 뒤 삭제해 주세요.'); return; }
        if (!window.confirm(target.date + ' · ' + money(target.amount) + ' 입금 기록을 삭제할까요?')) return;
        const next = (Array.isArray(rec.ledger) ? rec.ledger : []).filter((x) => String(x.id) !== eid);
        await updateDoc(doc(db, 'records', rec.id), {
          ledger: next,
          history: arrayUnion(historyEntry('입금 삭제', target.date + ' ' + money(target.amount))),
        });
        toast('삭제했어요.');
      } else if (closeBtn) {
        const k = closeBtn.dataset.closeMonth;
        const closed = monthClosed(rec, k);
        if (!closed && !window.confirm(k.replace('-', '년 ') + '월을 마감할까요?\n마감하면 입금 내역을 함부로 바꿀 수 없어요.')) return;
        const nextClosed = Object.assign({}, rec.closed || {});
        if (closed) delete nextClosed[k];
        else nextClosed[k] = true;
        await updateDoc(doc(db, 'records', rec.id), {
          closed: nextClosed,
          history: arrayUnion(historyEntry(closed ? '마감 해제' : '월 마감', k.replace('-', '년 ') + '월')),
        });
        toast(closed ? '마감을 해제했어요.' : '이 달을 마감했어요.');
      }
    } catch (err) { toast(friendlyDbError(err)); }
  });

  $('payAddBtn').addEventListener('click', async () => {
    const rec = currentPayRec();
    if (!rec) return;
    const date = safeDate($('pDate').value);
    const amount = Math.max(0, Number($('pAmount').value) || 0);
    const memo = $('pMemo').value.trim();
    if (!date) { toast('입금일을 입력해 주세요.'); return; }
    if (amount <= 0) { toast('금액을 입력해 주세요.'); return; }
    const k = date.slice(0, 7);
    if (monthClosed(rec, k)) { toast('마감된 달이에요. 마감을 해제한 뒤 기록해 주세요.'); return; }
    const entry = {
      id: makeLedgerId(),
      date,
      amount,
      memo: memo.slice(0, 100),
      by: state.user ? String(state.user.email || '') : '',
      ts: Date.now(),
    };
    try {
      await updateDoc(doc(db, 'records', rec.id), {
        ledger: arrayUnion(entry),
        history: arrayUnion(historyEntry('입금 기록', date + ' ' + money(amount) + (memo ? ' ' + memo : ''))),
      });
      toast('입금을 기록했어요.');
      renderPayDialog();
    } catch (err) { toast(friendlyDbError(err)); }
  });

  $('payCloseBtn').addEventListener('click', () => payDialog.close());

  // ---------- 퇴실 정산 다이얼로그 ----------
  const settleDialog = $('settleDialog');
  let settleRecId = null;
  let settleEndMonth = monthKey(new Date());
  let settleForceEdit = false;

  function openSettleDialog(rec) {
    settleRecId = rec.id;
    settleEndMonth = monthKey(new Date());
    settleForceEdit = false;
    $('settleTitle').textContent = rec.room + '호 ' + rec.tenant + ' · 퇴실 정산';
    renderSettleDialog();
    settleDialog.showModal();
  }

  function currentSettleRec() {
    return state.records.find((r) => r.id === settleRecId);
  }

  function settleMonthRange(rec, endKey) {
    let startKey;
    if (rec.startDate) {
      startKey = rec.startDate.slice(0, 7);
    } else {
      const ledger = getLedger(rec);
      startKey = ledger.length ? ledger[0].date.slice(0, 7) : monthKey(new Date());
    }
    if (startKey > endKey) startKey = endKey;
    const keys = [];
    for (let k = startKey; k <= endKey; k = monthAdd(k, 1)) keys.push(k);
    return keys;
  }

  function calcSettlement(rec, endKey) {
    const monthly = (Number(rec.rent) || 0) + (Number(rec.fee) || 0);
    const months = settleMonthRange(rec, endKey).map((k) => {
      const paid = paidForMonth(rec, k);
      return { key: k, billed: monthly, paid, due: Math.max(0, monthly - paid) };
    });
    const totalBilled = months.reduce((s, m) => s + m.billed, 0);
    const totalPaid = months.reduce((s, m) => s + m.paid, 0);
    return { months, totalBilled, totalPaid, arrears: totalBilled - totalPaid };
  }

  function renderSettleDialog() {
    const rec = currentSettleRec();
    if (!rec) { settleDialog.close(); return; }
    const s = rec.settlement;
    if (s && s.confirmedAt && !settleForceEdit) {
      // 확정된 정산서 보기
      const rows = (s.months || []).map((m) =>
        '<tr><td>' + esc(String(m.key).replace('-', '/')) + '</td><td class="r">' + money(m.billed) +
        '</td><td class="r">' + money(m.paid) + '</td><td class="r ' + (m.due > 0 ? 'neg' : '') + '">' +
        money(m.due) + '</td></tr>').join('');
      $('settleBody').innerHTML =
        '<p class="settle-meta">확정일 ' + esc(s.confirmedAt) +
        (s.by ? ' · ' + esc(String(s.by).split('@')[0]) : '') + '</p>' +
        '<table class="settle-table"><thead><tr><th>월</th><th>청구액</th><th>입금액</th><th>미납액</th></tr></thead>' +
        '<tbody>' + rows + '</tbody></table>' +
        '<div class="settle-sum">' +
          '<div class="row"><span>총 청구액</span><strong>' + money(s.totalBilled) + '</strong></div>' +
          '<div class="row"><span>총 입금액</span><strong class="pos">' + money(s.totalPaid) + '</strong></div>' +
          '<div class="row"><span>미납 합계</span><strong class="neg">' + money(s.arrears) + '</strong></div>' +
          '<div class="row"><span>보증금</span><strong>' + money(s.deposit) + '</strong></div>' +
          '<div class="row"><span>기타 공제' + (s.deductionMemo ? ' (' + esc(s.deductionMemo) + ')' : '') + '</span><strong class="neg">−' + money(s.deduction) + '</strong></div>' +
          '<div class="row total"><span>반환액 (보증금 − 미납 − 공제)</span><strong class="' + (s.refund < 0 ? 'neg' : 'pos') + '">' + money(s.refund) + '</strong></div>' +
        '</div>' +
        (s.refund < 0 ? '<p class="warn">반환액이 마이너스예요. 입주자에게 ' + money(-s.refund) + ' 추가 납부를 받아야 해요.</p>' : '') +
        '<button class="btn" type="button" id="settleRedoBtn" style="width:100%">다시 정산하기</button>';
      $('settleConfirmBtn').hidden = true;
      $('settleRedoBtn').addEventListener('click', () => {
        settleForceEdit = true;
        renderSettleDialog();
      });
      return;
    }
    // 정산서 작성
    const c = calcSettlement(rec, settleEndMonth);
    const rows = c.months.map((m) =>
      '<tr><td>' + esc(m.key.replace('-', '/')) + '</td><td class="r">' + money(m.billed) +
      '</td><td class="r">' + money(m.paid) + '</td><td class="r ' + (m.due > 0 ? 'neg' : '') + '">' +
      money(m.due) + '</td></tr>').join('');
    $('settleBody').innerHTML =
      '<p class="settle-meta">' + esc(rec.room) + '호 ' + esc(rec.tenant) +
      (rec.startDate ? ' · 계약 ' + esc(rec.startDate) + ' ~ ' + esc(rec.endDate || '') : '') + '</p>' +
      '<label class="field">정산 기준월 (이 달까지 청구)<input id="sEndMonth" type="month" value="' + settleEndMonth + '"></label>' +
      '<table class="settle-table"><thead><tr><th>월</th><th>청구액</th><th>입금액</th><th>미납액</th></tr></thead>' +
      '<tbody>' + rows + '</tbody></table>' +
      '<div class="settle-sum">' +
        '<div class="row"><span>총 청구액</span><strong>' + money(c.totalBilled) + '</strong></div>' +
        '<div class="row"><span>총 입금액</span><strong class="pos">' + money(c.totalPaid) + '</strong></div>' +
        '<div class="row"><span>미납 합계</span><strong class="neg">' + money(c.arrears) + '</strong></div>' +
        '<div class="row"><span>보증금</span><strong>' + money(rec.deposit) + '</strong></div>' +
      '</div>' +
      '<div class="form-row">' +
        '<label class="field">기타 공제액 (원)<input id="sDeduction" type="number" min="0" step="1000" value="0" inputmode="numeric"></label>' +
        '<label class="field">공제 사유<input id="sDeductionMemo" maxlength="100" placeholder="예: 벽지 수리비"></label>' +
      '</div>' +
      '<div class="settle-sum"><div class="row total"><span>반환액 (보증금 − 미납 − 공제)</span>' +
      '<strong id="sRefundPreview" class="pos">' + money(Number(rec.deposit) - c.arrears) + '</strong></div></div>' +
      '<p class="hint">확정하면 이 순간의 정산서가 저장돼요. 나중에 분쟁이 생겨도 이 기록이 기준이 됩니다.</p>';
    $('settleConfirmBtn').hidden = false;
    const upd = () => {
      const d = Math.max(0, Number($('sDeduction').value) || 0);
      const refund = Number(rec.deposit) - c.arrears - d;
      const el = $('sRefundPreview');
      el.textContent = money(refund);
      el.className = refund < 0 ? 'neg' : 'pos';
    };
    $('sDeduction').addEventListener('input', upd);
    $('sEndMonth').addEventListener('change', (e) => {
      if (/^\d{4}-\d{2}$/.test(e.target.value)) { settleEndMonth = e.target.value; renderSettleDialog(); }
    });
  }

  $('settleConfirmBtn').addEventListener('click', async () => {
    const rec = currentSettleRec();
    if (!rec || (rec.settlement && rec.settlement.confirmedAt)) return;
    const c = calcSettlement(rec, settleEndMonth);
    const deduction = Math.max(0, Number($('sDeduction').value) || 0);
    const deductionMemo = $('sDeductionMemo').value.trim().slice(0, 100);
    const refund = Number(rec.deposit) - c.arrears - deduction;
    if (!window.confirm('정산을 확정할까요?\n반환액: ' + money(refund) + '\n확정 후에도 "다시 정산하기"로 고칠 수 있어요.')) return;
    const now = new Date();
    const p = (n) => String(n).padStart(2, '0');
    const snapshot = {
      confirmedAt: now.getFullYear() + '-' + p(now.getMonth() + 1) + '-' + p(now.getDate()) +
        ' ' + p(now.getHours()) + ':' + p(now.getMinutes()),
      by: state.user ? String(state.user.email || '') : '',
      endMonth: settleEndMonth,
      months: c.months,
      totalBilled: c.totalBilled,
      totalPaid: c.totalPaid,
      arrears: c.arrears,
      deposit: Number(rec.deposit) || 0,
      deduction,
      deductionMemo,
      refund,
    };
    try {
      await updateDoc(doc(db, 'records', rec.id), {
        settlement: snapshot,
        history: arrayUnion(historyEntry('정산 확정', settleEndMonth + ' 기준 · 반환액 ' + money(refund))),
      });
      toast('정산서를 확정했어요.');
      renderSettleDialog();
    } catch (err) { toast(friendlyDbError(err)); }
  });

  $('settleCloseBtn').addEventListener('click', () => settleDialog.close());

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
        // 수정 시에는 장부·마감·이력·정산 데이터를 건드리지 않음 (덮어쓰기 방지)
        delete data.ledger; delete data.closed; delete data.history;
        delete data.settlement; delete data.payments;
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

  // ============================================================
  // 자산관리
  // ============================================================
  function renderAssets() {
    const totalAssets = state.assets.reduce((s, a) => s + (Number(a.amount) || 0), 0);
    const loanBalance = state.loans.reduce((s, l) => s + (Number(l.balance) || 0), 0);
    const depositSum = state.records.reduce((s, r) => s + (Number(r.deposit) || 0), 0);
    const totalDebts = loanBalance + depositSum;
    $('aTotalAssets').textContent = money(totalAssets);
    $('aTotalDebts').textContent = money(totalDebts);
    const net = totalAssets - totalDebts;
    const netEl = $('aNetWorth');
    netEl.textContent = money(net);
    netEl.className = 'stat-value ' + (net < 0 ? 'red' : 'green');

    // 분류별 자산
    const byCat = {};
    for (const a of state.assets) {
      const c = a.category || '기타';
      byCat[c] = (byCat[c] || 0) + (Number(a.amount) || 0);
    }
    const catRows = ASSET_CATEGORIES
      .filter((c) => (byCat[c] || 0) > 0)
      .map((c) => '<li>' + esc(c) + ' · ' + money(byCat[c]) + '</li>');
    $('assetCategoryList').innerHTML = catRows.length
      ? catRows.join('')
      : '<li class="none">등록된 자산이 없어요.</li>';

    // 대출 요약
    const loanRows = state.loans.map((l) =>
      '<li>' + esc(l.name) + (l.lender ? ' (' + esc(l.lender) + ')' : '') +
      ' · 잔액 ' + money(l.balance) +
      (l.rate ? ' · 연 ' + esc(String(l.rate)) + '%' : '') + '</li>');
    if (depositSum > 0) {
      loanRows.push('<li>임대보증금 (반환 의무 · 임대 탭 자동) · ' + money(depositSum) + '</li>');
    }
    $('loanSummaryList').innerHTML = loanRows.length
      ? loanRows.join('')
      : '<li class="none">등록된 대출이 없어요.</li>';

    // 자산 목록 (금액 큰 순)
    const assets = state.assets.slice().sort((a, b) => (Number(b.amount) || 0) - (Number(a.amount) || 0));
    $('assetList').innerHTML = assets.map((a) =>
      '<article class="card">' +
        '<div class="card-head"><div><span class="card-room">' + esc(a.name) + '</span> ' +
        '<span class="badge">' + esc(a.category) + '</span>' +
        '<span class="badge">' + esc(a.owner) + '</span></div>' +
        '<span class="stat-value">' + money(a.amount) + '</span></div>' +
        (a.baseDate ? '<div class="card-dates">기준일 ' + esc(a.baseDate) + '</div>' : '') +
        (a.memo ? '<div class="card-memo">📝 ' + esc(a.memo) + '</div>' : '') +
        '<div class="card-actions">' +
          '<button class="btn" type="button" data-aaction="edit" data-id="' + a.id + '">수정</button>' +
          '<button class="btn" type="button" data-aaction="delete" data-id="' + a.id + '">삭제</button>' +
        '</div>' +
      '</article>').join('');
    $('assetEmptyMsg').hidden = assets.length > 0;

    // 대출 목록 (잔액 큰 순)
    const loans = state.loans.slice().sort((a, b) => (Number(b.balance) || 0) - (Number(a.balance) || 0));
    $('loanList').innerHTML = loans.map((l) =>
      '<article class="card">' +
        '<div class="card-head"><div><span class="card-room">' + esc(l.name) + '</span> ' +
        (l.lender ? '<span class="badge">' + esc(l.lender) + '</span>' : '') + '</div>' +
        '<span class="stat-value red">' + money(l.balance) + '</span></div>' +
        '<div class="card-grid">' +
          '<div><span class="k">금리</span><span class="v">' + (l.rate ? '연 ' + esc(String(l.rate)) + '%' : '-') + '</span></div>' +
          '<div><span class="k">월상환액</span><span class="v">' + (l.monthlyPayment ? money(l.monthlyPayment) : '-') + '</span></div>' +
          '<div><span class="k">만기일</span><span class="v">' + (esc(l.endDate) || '-') + '</span></div>' +
        '</div>' +
        (l.memo ? '<div class="card-memo">📝 ' + esc(l.memo) + '</div>' : '') +
        '<div class="card-actions">' +
          '<button class="btn" type="button" data-laction="edit" data-id="' + l.id + '">수정</button>' +
          '<button class="btn" type="button" data-laction="delete" data-id="' + l.id + '">삭제</button>' +
        '</div>' +
      '</article>').join('');
    $('loanEmptyMsg').hidden = loans.length > 0;
  }

  // ---------- 자산 목록 버튼 ----------
  $('assetList').addEventListener('click', async (e) => {
    const btn = e.target.closest('[data-aaction]');
    if (!btn) return;
    const a = state.assets.find((x) => x.id === btn.dataset.id);
    if (!a) return;
    if (btn.dataset.aaction === 'edit') {
      openAssetDialog(a);
    } else if (btn.dataset.aaction === 'delete') {
      if (!window.confirm('"' + a.name + '" 자산을 삭제할까요?\n삭제하면 되돌릴 수 없어요.')) return;
      try {
        await deleteDoc(doc(db, 'assets', a.id));
        toast('삭제했어요.');
      } catch (err) { toast(friendlyDbError(err)); }
    }
  });

  // ---------- 대출 목록 버튼 ----------
  $('loanList').addEventListener('click', async (e) => {
    const btn = e.target.closest('[data-laction]');
    if (!btn) return;
    const l = state.loans.find((x) => x.id === btn.dataset.id);
    if (!l) return;
    if (btn.dataset.laction === 'edit') {
      openLoanDialog(l);
    } else if (btn.dataset.laction === 'delete') {
      if (!window.confirm('"' + l.name + '" 대출을 삭제할까요?\n삭제하면 되돌릴 수 없어요.')) return;
      try {
        await deleteDoc(doc(db, 'loans', l.id));
        toast('삭제했어요.');
      } catch (err) { toast(friendlyDbError(err)); }
    }
  });

  // ---------- 자산 등록/수정 다이얼로그 ----------
  const assetDialog = $('assetDialog');

  function openAssetDialog(a) {
    state.editingAssetId = a ? a.id : null;
    $('assetDialogTitle').textContent = a ? '자산 수정' : '자산 등록';
    $('aName').value = a ? a.name : '';
    $('aCategory').value = a ? a.category : '부동산';
    $('aAmount').value = a ? a.amount : '';
    $('aOwner').value = a ? a.owner : '공동';
    $('aBaseDate').value = a ? a.baseDate : todayStr();
    $('aMemo').value = a ? a.memo : '';
    assetDialog.showModal();
  }

  $('addAssetBtn').addEventListener('click', () => openAssetDialog(null));
  $('cancelAssetBtn').addEventListener('click', () => assetDialog.close());

  $('assetForm').addEventListener('submit', async (e) => {
    e.preventDefault();
    const data = normalizeAsset({
      name: $('aName').value.trim(),
      category: $('aCategory').value,
      amount: $('aAmount').value,
      owner: $('aOwner').value,
      baseDate: $('aBaseDate').value,
      memo: $('aMemo').value.trim(),
    });
    if (!data.name) { toast('자산명을 입력해 주세요.'); return; }
    try {
      if (state.editingAssetId) {
        await updateDoc(doc(db, 'assets', state.editingAssetId), data);
        toast('수정했어요.');
      } else {
        await addDoc(assetsCol, data);
        toast('등록했어요.');
      }
      assetDialog.close();
    } catch (err) { toast(friendlyDbError(err)); }
  });

  // ---------- 대출 등록/수정 다이얼로그 ----------
  const loanDialog = $('loanDialog');

  function openLoanDialog(l) {
    state.editingLoanId = l ? l.id : null;
    $('loanDialogTitle').textContent = l ? '대출 수정' : '대출 등록';
    $('lName').value = l ? l.name : '';
    $('lLender').value = l ? l.lender : '';
    $('lBalance').value = l ? l.balance : '';
    $('lRate').value = l ? l.rate : '';
    $('lMonthly').value = l ? l.monthlyPayment : '';
    $('lEndDate').value = l ? l.endDate : '';
    $('lMemo').value = l ? l.memo : '';
    loanDialog.showModal();
  }

  $('addLoanBtn').addEventListener('click', () => openLoanDialog(null));
  $('cancelLoanBtn').addEventListener('click', () => loanDialog.close());

  $('loanForm').addEventListener('submit', async (e) => {
    e.preventDefault();
    const data = normalizeLoan({
      name: $('lName').value.trim(),
      lender: $('lLender').value.trim(),
      balance: $('lBalance').value,
      rate: $('lRate').value,
      monthlyPayment: $('lMonthly').value,
      endDate: $('lEndDate').value,
      memo: $('lMemo').value.trim(),
    });
    if (!data.name) { toast('대출명을 입력해 주세요.'); return; }
    try {
      if (state.editingLoanId) {
        await updateDoc(doc(db, 'loans', state.editingLoanId), data);
        toast('수정했어요.');
      } else {
        await addDoc(loansCol, data);
        toast('등록했어요.');
      }
      loanDialog.close();
    } catch (err) { toast(friendlyDbError(err)); }
  });
}

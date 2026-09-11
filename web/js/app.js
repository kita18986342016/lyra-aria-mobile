// 深空折韵 · 移动端核心逻辑（v1.0）
// 架构：Web 层只管 UI + 业务逻辑，音频交给原生播放核（NativePlayer 插件）；
// 本地媒体库走 MediaStore 插件；下载走 Downloader 插件；无原生环境时回退 HTML5 Audio。
import { leizSearch, leizResolve, leizLyrics, leizPlaylist, biliFavlist, biliResolve, biliDirectResolve, biliQrCreate, biliQrPoll, biliGetAcc, biliSetAcc, biliSetScope, biliMyFavs, biliNav } from './leiz.js';
import * as NE from './netease-core.js';
import { parsePlaylistInput, importPlaylist, kugouResolveShare } from './opl.js';
import * as KG from './kugou-core.js';
import { parseLrc, parseNeteaseWordLines, parseKrcWord, META_RE } from './lrc.js';
import { exportBundle, importBundle, bundleToJson, parseBundle } from './sync.js';

const $ = (id) => document.getElementById(id);

/* ================= 状态 ================= */
const state = {
  view: 'search',
  current: null,          // 当前播放歌曲
  list: [],               // 当前视图列表
  playing: false,
  position: 0, duration: 0, rate: 1, mode: 'order', // order|repeat|shuffle
  searchResults: [],
  onlinePlaylists: [],    // 持久化：localStorage opls
  mylists: [],            // 本地歌单（持久化 mpm_mylists）：[{id,name,songIds:[]}]
  currentMylist: null,    // 当前打开的本地歌单
  favorites: [],          // 持久化：localStorage favs
  recent: [],             // 最近播放（持久化 mpm_recent）
  localSongs: [], localAlbums: [], localArtists: [], localTab: 'songs',
  localDetailSongs: [],
  dlTasks: {},            // {songId: {status,pct,title,path}}
  dlDone: [],             // 已完成任务（持久化 mpm_dl）
  recentPls: [],          // 最近打开的歌单（持久化 mpm_recpls，上限 10）
  lrc: [], lrcIndex: -1,
  wordSegs: null,       // 逐字歌词段 [{t, chars:[{ch,t}]}]；null = 普通 LRC
  transLrc: null,       // 翻译歌词 [{t,text}]；t=-1 表示无时间戳按行序
  lyrTransOn: true,     // 翻译歌词显示开关
  queue: [],              // 播放队列（快照语义，随 playList 重建）
  queueIndex: -1,
  shuffleOrder: [], shufflePos: -1,
  oplQueue: [],           // 兼容旧逻辑
  oplQueueIndex: 0,
  // 批量选择模式（对齐桌面 batchSelect）：长按行进入；行点击=勾选切换
  batch: { mode: false, list: [], sel: new Set() },
  detailFilter: '',         // 详情页内搜索词
  searchSrcFilter: 'all',   // 搜索结果来源过滤
  currentLocalDetail: null  // {kind,item} 本地专辑/歌手详情重渲染用
};

/* ================= 本地多账号 + 持久化 ================= */
function rawGet(k) { try { return localStorage.getItem('mpm_' + k); } catch { return null; } }
function rawSet(k, v) { try { localStorage.setItem('mpm_' + k, v); } catch { /* 忽略 */ } }
function rawDel(k) { try { localStorage.removeItem('mpm_' + k); } catch { /* 忽略 */ } }
function accUuid() { return 'a' + Date.now().toString(36) + Math.random().toString(36).slice(2, 8); }
const ACC_SCOPED = { opls: 1, mylists: 1, favs: 1, recent: 1, recpls: 1, tomb: 1, syncbind: 1 };
let CUR_ACC = null;
function accPhysKey(k) { return (ACC_SCOPED[k] && CUR_ACC) ? ('a_' + CUR_ACC + '_' + k) : k; }
const LS = {
  load(k, d) { try { const v = localStorage.getItem('mpm_' + accPhysKey(k)); return v ? JSON.parse(v) : d; } catch { return d; } },
  save(k, v) { try { localStorage.setItem('mpm_' + accPhysKey(k), JSON.stringify(v)); } catch { /* 忽略 */ } }
};
function accList() { try { return JSON.parse(rawGet('accounts') || '[]'); } catch { return []; } }
function saveAccList(l) { rawSet('accounts', JSON.stringify(l)); }
function curAccount() { const l = accList(); return l.find((a) => a.id === CUR_ACC) || l[0] || null; }
function bootAccounts() {
  let list = accList();
  let cur = null; try { cur = JSON.parse(rawGet('curacc') || 'null'); } catch { cur = null; }
  if (!list.length) {
    let pk = {}; try { pk = JSON.parse(rawGet('prefs') || '{}') || {}; } catch { pk = {}; }
    const id = accUuid();
    list = [{ id, name: pk.nickname || '', avatar: pk.avatar || '', createdAt: Date.now() }];
    ['opls', 'mylists', 'favs', 'recent', 'recpls', 'netacc', 'kgacc', 'biliacc'].forEach((k) => { const v = rawGet(k); if (v != null) { rawSet('a_' + id + '_' + k, v); rawDel(k); } });
    cur = id;
    saveAccList(list); rawSet('curacc', JSON.stringify(cur));
  }
  if (!cur || !list.some((a) => a.id === cur)) { cur = list[0].id; rawSet('curacc', JSON.stringify(cur)); }
  CUR_ACC = cur;
  ['opls', 'mylists', 'favs', 'recent', 'recpls', 'netacc', 'kgacc', 'biliacc'].forEach((k) => { const v = rawGet(k); if (v != null) { if (rawGet('a_' + CUR_ACC + '_' + k) == null) rawSet('a_' + CUR_ACC + '_' + k, v); rawDel(k); } });
}
bootAccounts();
state.onlinePlaylists = LS.load('opls', []);
state.mylists = LS.load('mylists', []); // 本地歌单持久化
state.favorites = LS.load('favs', []);
state.recent = LS.load('recent', []);
state.dlDone = LS.load('dl', []);
state.recentPls = LS.load('recpls', []);
// 默认值对齐桌面：在线音质 高品(320)；下载音质 无损；翻译歌词默认开；倍速 1.0
const PREF = Object.assign({ onlineQ: 'high', dlQ: 'lossless', sources: { netease: true, kugou: true }, lyrTrans: true, resume: true, theme: 'auto', accent: 'blue', skin: 'default', bgMode: 'cover', bgPreset: 'dusk', bgData: '', rate: 1, ambOn: 1, ambStrength: 60, ambBlur: 46, pStyle: 'B', lyrWin: 0, lyrFs: 18, lyrOp: 100, lyrBg: 1, lyrC1: '#4deaff', lyrC2: '#ffffff', lyrLocked: 0, lyrSweep: 'soft', lyrFont: 'default', fmAuto: 1, fmFresh: 0, nickname: '', avatar: '', heroCard: '', autoSync: 1 }, LS.load('prefs', {}));
try { document.documentElement.style.setProperty('--lyr-sung', PREF.lyrC1 || '#4deaff'); } catch (e) {}
/* ---- 账号操作（数据按账号命名空间隔离；设置/外观为设备级不随账号） ---- */
(function syncProfileFromAccount() { const a = curAccount(); if (a) { PREF.nickname = a.name || ''; PREF.avatar = a.avatar || ''; } })();
function reloadSourceAccounts() { const s = CUR_ACC ? ('a_' + CUR_ACC + '_') : ''; try { NE.setScope(s); } catch (e) {} try { KG.setScope(s); } catch (e) {} try { biliSetScope(s); } catch (e) {} }
reloadSourceAccounts();
function flushCurAccountProfile() { const a = curAccount(); if (a) { a.name = PREF.nickname || ''; a.avatar = PREF.avatar || ''; saveAccList(accList().map((x) => x.id === a.id ? a : x)); } }
function loadAccountData() { state.onlinePlaylists = LS.load('opls', []); state.mylists = LS.load('mylists', []); state.favorites = LS.load('favs', []); state.recent = LS.load('recent', []); state.recentPls = LS.load('recpls', []); }
function saveAccountData() { saveOpls(); saveMylists(); LS.save('favs', state.favorites); LS.save('recent', state.recent); LS.save('recpls', state.recentPls); }
function rerenderAll() { try { renderOpls(); renderMylists(); renderFavs(); renderRecent(); refreshStats(); renderHomeSections(); updateHomeCards(); applyMeProfile(); refreshAccountUI(); refreshBiliUI(); refreshKgUI(); } catch (e) { /* 忽略 */ } }
function switchAccount(id) {
  if (!id || id === CUR_ACC) return;
  flushCurAccountProfile(); saveAccountData();
  CUR_ACC = id; rawSet('curacc', JSON.stringify(id));
  loadAccountData();
  const a = curAccount(); PREF.nickname = a ? a.name : ''; PREF.avatar = a ? a.avatar : ''; savePrefs();
  reloadSourceAccounts();
  try { if (state.view) setView(state.view); } catch (e) {}
  rerenderAll();
}
function createAccount(name) { const l = accList(); const id = accUuid(); l.push({ id, name: String(name || '').trim().slice(0, 24) || ('账号' + (l.length + 1)), avatar: '', createdAt: Date.now() }); saveAccList(l); return id; }
function deleteAccount(id) {
  let l = accList(); if (l.length <= 1) return false;
  l = l.filter((a) => a.id !== id); saveAccList(l);
  ['opls', 'mylists', 'favs', 'recent', 'recpls', 'netacc', 'kgacc', 'biliacc'].forEach((k) => rawDel('a_' + id + '_' + k));
  if (CUR_ACC === id) { CUR_ACC = l[0].id; rawSet('curacc', JSON.stringify(CUR_ACC)); loadAccountData(); const a = curAccount(); PREF.nickname = a ? a.name : ''; PREF.avatar = a ? a.avatar : ''; savePrefs(); reloadSourceAccounts(); rerenderAll(); }
  return true;
}
function renderCurAccount() {
  const a = curAccount();
  const nm = $('meCurAccName'); if (nm) nm.textContent = a ? (a.name || '未命名账号') : '';
  const av = $('meCurAccAvatar'); if (av) { if (a && a.avatar) { av.style.backgroundImage = 'url(' + JSON.stringify(a.avatar) + ')'; av.textContent = ''; } else { av.style.backgroundImage = ''; av.textContent = a ? String(a.name || '账').slice(0, 1) : '账'; } }
}
function renderAccManager() {
  const box = $('accList'); if (!box) return;
  const l = accList(); box.innerHTML = '';
  l.forEach((a) => {
    const row = document.createElement('div'); row.className = 'acc-mgr-item' + (a.id === CUR_ACC ? ' cur' : '');
    const av = document.createElement('span'); av.className = 'acc-mgr-av';
    if (a.avatar) av.style.backgroundImage = 'url(' + JSON.stringify(a.avatar) + ')'; else av.textContent = String(a.name || '账').slice(0, 1);
    const nm = document.createElement('span'); nm.className = 'acc-mgr-nm'; nm.textContent = a.name || '未命名账号';
    row.append(av, nm);
    if (a.id === CUR_ACC) { const ck = document.createElement('span'); ck.className = 'acc-mgr-ck'; ck.textContent = '✓'; row.appendChild(ck); }
    else {
      const del = document.createElement('button'); del.className = 'acc-mgr-del'; del.textContent = '删除'; let armed = false;
      del.addEventListener('click', (e) => {
        e.stopPropagation();
        if (accList().length <= 1) { toast('至少保留一个账号'); return; }
        if (!armed) { armed = true; del.textContent = '确认删除?'; del.classList.add('warn'); setTimeout(() => { if (armed) { armed = false; del.textContent = '删除'; del.classList.remove('warn'); } }, 3000); return; }
        deleteAccount(a.id); renderAccManager(); renderCurAccount(); toast('已删除账号');
      });
      row.appendChild(del);
    }
    row.addEventListener('click', () => { if (a.id === CUR_ACC) { $('accSheet').classList.add('hidden'); return; } switchAccount(a.id); renderAccManager(); renderCurAccount(); });
    box.appendChild(row);
  });
}
/* ================= 图标系统（描边 SVG，对齐底栏风格；动态位用 icon() 生成） ================= */
const ICONS = {
  play: '<path d="M8.5 5.5v13l10-6.5z" class="ic-f"/>',
  pause: '<path d="M8.5 5.5v13M15.5 5.5v13" class="ic-thick"/>',
  prev: '<path d="M7 5.5v13M17.5 6.5v11L10 12z"/>',
  next: '<path d="M17 5.5v13M6.5 6.5v11L14 12z"/>',
  modeOrder: '<path d="M5 5.5v13l10-6.5z" class="ic-f"/><path d="M18.5 5.5v13" class="ic-thick"/>',
  modeRepeat: '<path d="M6.5 11a5.5 5.5 0 0 1 9.2-4M17.5 13a5.5 5.5 0 0 1-9.2 4"/><path d="M14.2 4.4L16.2 7l-2.9.7M9.8 19.6L7.8 17l2.9-.7"/><text x="12" y="14.7" text-anchor="middle" font-size="7.5" class="ic-f" stroke="none">1</text>',
  modeShuffle: '<path d="M4 7h3.4l9.2 10H20M4 17h3.4l3-3.4M14.2 8.6l2.4-2.6H20"/><path d="M17.6 4.2l2.8 2.8-2.8 2.8M17.6 14.2l2.8 2.8-2.8 2.8"/>',
  heart: '<path d="M12 20s-7.5-4.8-9.3-9.1C1.4 7.6 3.6 4.5 6.8 4.5c2 0 3.6 1.1 5.2 3 1.6-1.9 3.2-3 5.2-3 3.2 0 5.4 3.1 4.1 6.4C19.5 15.2 12 20 12 20z"/>',
  heartFill: '<path d="M12 20s-7.5-4.8-9.3-9.1C1.4 7.6 3.6 4.5 6.8 4.5c2 0 3.6 1.1 5.2 3 1.6-1.9 3.2-3 5.2-3 3.2 0 5.4 3.1 4.1 6.4C19.5 15.2 12 20 12 20z" class="ic-f"/>',
  download: '<path d="M12 4v10M8 10.5l4 4 4-4M4 19h16"/>',
  queue: '<path d="M4 6h11M4 12h11M4 18h7"/><path d="M18.5 10.5v7M15.5 14.5h6"/>',
  more: '<path d="M12 5.5v0M12 12v0M12 18.5v0" class="ic-thick"/>',
  close: '<path d="M6 6l12 12M18 6L6 18"/>',
  back: '<path d="M19 12H5M11 6l-6 6 6 6"/>',
  share: '<path d="M6 18c0-6 5-9 12-9M13 4.5L18 9l-5 4.5"/>',
  plus: '<path d="M12 5v14M5 12h14"/>',
  edit: '<path d="M4 20h4L19 9l-4-4L4 16z"/><path d="M13.5 6.5l4 4"/>',
  grid: '<path d="M4 4h6v6H4zM14 4h6v6h-6zM4 14h6v6H4zM14 14h6v6h-6z"/>',
  list: '<path d="M4 6h11M4 12h11M4 18h11"/><path d="M18.5 10.5v7M15.5 14.5h6"/>',
  filter: '<path d="M4 5h16l-6 7v6l-4 2v-8z"/>',
  search: '<circle cx="11" cy="11" r="7"/><path d="M20.5 20.5l-4.2-4.2"/>',
  dotsV: '<circle cx="12" cy="5" r="1.5" class="ic-f"/><circle cx="12" cy="12" r="1.5" class="ic-f"/><circle cx="12" cy="19" r="1.5" class="ic-f"/>',
  dotsH: '<circle cx="5" cy="12" r="1.5" class="ic-f"/><circle cx="12" cy="12" r="1.5" class="ic-f"/><circle cx="19" cy="12" r="1.5" class="ic-f"/>',
  multiSelect: '<path d="M8.5 3.5h9a3 3 0 0 1 3 3v9"/><rect x="3.5" y="8.5" width="12" height="12" rx="3"/><path d="M6.9 14.7l2.3 2.3 4-4.4"/>',
  sortV: '<path d="M7 20V7M7 7L4.6 9.6M7 7l2.4 2.6M17 4v13M17 17l-2.4-2.6M17 17l2.4-2.6"/>',
  listView: '<path d="M4 6.5h16M4 12h16M4 17.5h10"/>',
  lock: '<path d="M7 11h10v9H7zM9 11V7a3 3 0 0 1 6 0v4"/>',
  unlock: '<path d="M7 11h10v9H7zM9 11V7a3 3 0 0 1 6 0"/>',
  trash: '<path d="M4 7h16M9 7V5h6v2M6 7l1 13h10l1-13"/><path d="M10 11v6M14 11v6"/>',
  moon: '<path d="M20 14.5A8 8 0 1 1 9.5 4 6.5 6.5 0 0 0 20 14.5z"/>',
  comment: '<path d="M4 5h16v11H9l-4 3v-3H4z"/>',
  bot: '<rect x="5" y="8" width="14" height="10" rx="2.5"/><path d="M12 5v3M9 12v2M15 12v2"/>',
  note: '<path d="M9 17V6l10-2v11"/><circle cx="7" cy="17" r="2.2"/><circle cx="17" cy="15" r="2.2"/>',
  chevUp: '<path d="M6 14l6-6 6 6"/>',
  chevDn: '<path d="M6 10l6 6 6-6"/>',
  retry: '<path d="M20 12a8 8 0 1 1-2.3-5.6M20 4v4h-4"/>',
};

function icon(name, size = 18) {
  return ['<svg class="ic-svg" viewBox="0 0 24 24" width="', size, '" height="', size, '">', ICONS[name] || '', '</svg>'].join('');
}
// 骨架屏：列表行 / 卡片两种，加载时占位
function skelRows(n) {
  let h = '';
  for (let i = 0; i < n; i++) h += '<div class="skel-row"><div class="skel skel-cov"></div><div class="skel-lines"><div class="skel skel-l1"></div><div class="skel skel-l2"></div></div></div>';
  return h;
}
function skelCards(n) {
  let h = '<div class="daily-scroll">';
  for (let i = 0; i < n; i++) h += '<div class="skel-card"><div class="skel skel-cov"></div><div class="skel skel-l1"></div></div>';
  return h + '</div>';
}
function showSkel(el, kind, n) { if (el) el.innerHTML = kind === 'card' ? skelCards(n || 5) : skelRows(n || 6); }
// 统一空状态（图标+文案+可选动作）
function emptyState(el, iconName, text, btnLabel, btnFn) {
  if (!el) return;
  el.className = 'empty-state';
  el.innerHTML = icon(iconName || 'note', 44) + '<div class="es-text">' + esc(text) + '</div>';
  el.classList.remove('hidden');
  if (btnLabel && btnFn) {
    const b = document.createElement('button'); b.className = 'es-btn'; b.textContent = btnLabel;
    b.addEventListener('click', btnFn); el.appendChild(b);
  }
}
// 原生返回（系统返回键 / 边缘手势）→ App 内逐级返回；无可返回内容才请求原生退出桌面
window.__handleNativeBack = () => {
  const open = [...document.querySelectorAll('.overlay:not(.hidden), .drawer:not(.hidden)')];
  if (open.length) { open.forEach((o) => o.classList.add('hidden')); return 'handled'; }
  if (document.body.classList.contains('pp-open')) {
    const pp = $('playerPage');
    if (pp && pp.classList.contains('lyric-full')) { pp.classList.remove('lyric-full'); const fl = $('ppLyricFull'); if (fl) fl.classList.add('hidden'); return 'handled'; }
    try { closePlayerPage(); } catch (e) {} return 'handled';
  }
  if (state.batch && state.batch.mode) { try { exitBatch(); } catch (e) {} return 'handled'; }
  const subs = ['opldetail', 'mylistdetail', 'localdetail', 'recentpls', 'plcat', 'settings', 'settingsub'];
  if (subs.includes(state.view)) { backFromDetail(); return 'handled'; }
  // 根页面：请求原生退出到桌面
  try { const AB = window.Capacitor && window.Capacitor.Plugins && window.Capacitor.Plugins.AppBridge; if (AB && AB.exitApp) { AB.exitApp(); return 'exit'; } } catch (e) {}
  return 'exit';
};

function savePrefs() { LS.save('prefs', PREF); }

// 氛围背景可调参数（对齐 PC 设置-背景强度/背景模糊：强度=压暗遮罩 0-100，模糊=封面 blur 0-60px）
function applyAmbient() {
  const s = Math.max(0, Math.min(100, +PREF.ambStrength || 0)) / 100;
  const b = Math.max(0, Math.min(60, +PREF.ambBlur >= 0 ? +PREF.ambBlur : 46));
  if (currentSkin() !== 'default') document.documentElement.style.removeProperty('--amb-strength');
  else document.documentElement.style.setProperty('--amb-strength', s + '');
  document.documentElement.style.setProperty('--amb-blur', b + 'px');
}
// 进度条样式（对齐 PC mp_progress_style：A 滑杆式 / B 细线式，默认 B；移动端作用于播放页 #ppSeek）
function applyProgressStyle() {
  const page = $('playerPage');
  if (!page) return;
  page.classList.toggle('progress-b', PREF.pStyle !== 'A');
  page.classList.toggle('progress-a', PREF.pStyle === 'A');
}
// 桌面歌词悬浮窗开关（含权限申请引导）
// 桌面歌词样式设置（字号/透明度/底色/已唱未唱色；实时 setStyle，300ms 防抖持久化）
const LYR_PALETTE = ['#4deaff', '#ffffff', '#ffd700', '#7fff00', '#ff6eb4', '#a855f7'];
function lyrStylePayload() { return { fontSize: PREF.lyrFs, opacity: PREF.lyrOp, bg: !!PREF.lyrBg, sung: PREF.lyrC1, unsung: PREF.lyrC2, sweep: PREF.lyrSweep, font: PREF.lyrFont }; }
function lyrPushStyle() { const P = window.Capacitor && window.Capacitor.Plugins; if (PREF.lyrWin && P && P.LyricsWin) { try { P.LyricsWin.setStyle(lyrStylePayload()); } catch (e) {} } }
// 锁定/解锁统一入口（悬浮窗锁按钮/通知栏锁定/设置页开关共用）；失败返回 false
async function applyLyrLocked(want) {
  const P = window.Capacitor && window.Capacitor.Plugins;
  if (P && P.LyricsWin) {
    try { await P.LyricsWin.setLocked({ locked: !!want }); } catch (e) { return false; }
  }
  PREF.lyrLocked = want ? 1 : 0;
  savePrefs();
  const lockSeg = $('setLyrLock');
  if (lockSeg) lockSeg.querySelectorAll('.seg-item').forEach((x) => x.classList.toggle('active', (+x.dataset.v ? 1 : 0) === (PREF.lyrLocked ? 1 : 0)));
  return true;
}
// ---------- 应用内检查更新（GitHub Release，原生 AppUpdate 插件） ----------
function upPlugin() { return window.Capacitor && window.Capacitor.Plugins ? window.Capacitor.Plugins.AppUpdate : null; }
let upDownloading = false;
function bindUpdateUi() {
  const P = upPlugin();
  const btn = $('btnCheckUpdate');
  if (!P || !btn) return;
  // 关于：显示真实版本
  try { P.getVersion().then((v) => { const el = $('aboutText'); if (el && v && v.versionName) el.textContent = '深空折韵 v' + v.versionName; }).catch(() => {}); } catch (e) {}
  const setBtn = (txt, busy) => { btn.textContent = txt; btn.disabled = !!busy; };
  // 进度事件
  try { P.addListener('downloadProgress', (d) => { if (d && typeof d.percent === 'number') setBtn('下载中 ' + d.percent + '%', true); }); } catch (e) {}
  btn.addEventListener('click', async () => {
    setBtn('检查中…', true);
    let r = null;
    try { r = await P.checkUpdate({}); } catch (e) { setBtn('检查', false); toast('检查更新失败：' + ((e && e.message) || e)); return; }
    if (!r || !r.available) { setBtn('检查', false); toast('已是最新版本'); try { localStorage.setItem('mp_last_update_check', String(Date.now())); } catch (e) {} return; }
    setBtn('检查', false);
    const mb = r.size ? '（' + Math.round(r.size / 1048576) + 'MB）' : '';
    if (confirm('发现新版本 ' + (r.tag || '') + mb + '，现在下载更新？')) {
      upDownloading = true; setBtn('下载中 0%', true);
      try {
        const dl = await P.downloadApk({ url: r.url, name: 'lyra-update.apk' });
        setBtn('安装中…', true);
        await P.installApk({ path: dl.path });
        setBtn('检查', false);
        toast('请在安装器中确认升级');
      } catch (e) {
        setBtn('重试下载', false);
        toast('更新失败：' + ((e && e.message) || e));
      } finally { upDownloading = false; }
    }
    try { localStorage.setItem('mp_last_update_check', String(Date.now())); } catch (e) {}
  });
  // 启动静默检查（24h 节流；只提示不自动下载）
  setTimeout(async () => {
    try {
      const last = Number(localStorage.getItem('mp_last_update_check') || 0);
      if (Date.now() - last < 20 * 3600 * 1000) return;
      const r = await P.checkUpdate({});
      localStorage.setItem('mp_last_update_check', String(Date.now()));
      if (r && r.available) toast('发现新版本 ' + (r.tag || '') + '，可到设置-检查更新升级');
    } catch (e) { /* 静默失败 */ }
  }, 6000);
}
function bindLyrWinStyle() {
  const fsEl = $('setLyrFs'), opEl = $('setLyrOp'), bgSeg = $('setLyrBg'), c1Box = $('setLyrC1'), c2Box = $('setLyrC2');
  if (!fsEl) return;
  let timer = null;
  const saveSoon = () => { clearTimeout(timer); timer = setTimeout(savePrefs, 300); };
  fsEl.value = PREF.lyrFs; opEl.value = PREF.lyrOp;
  $('setLyrFsVal').textContent = PREF.lyrFs; $('setLyrOpVal').textContent = PREF.lyrOp;
  fsEl.addEventListener('input', (e) => { PREF.lyrFs = +e.target.value; $('setLyrFsVal').textContent = PREF.lyrFs; lyrPushStyle(); saveSoon(); });
  opEl.addEventListener('input', (e) => { PREF.lyrOp = +e.target.value; $('setLyrOpVal').textContent = PREF.lyrOp; lyrPushStyle(); saveSoon(); });
  bgSeg.querySelectorAll('.seg-item').forEach((b) => {
    b.classList.toggle('active', (+b.dataset.v ? 1 : 0) === (PREF.lyrBg ? 1 : 0));
    b.addEventListener('click', () => { PREF.lyrBg = +b.dataset.v ? 1 : 0; bgSeg.querySelectorAll('.seg-item').forEach((x) => x.classList.toggle('active', x === b)); lyrPushStyle(); saveSoon(); });
  });
  const buildDots = (boxId, key) => {
    const box = $(boxId); if (!box) return;
    box.innerHTML = '';
    LYR_PALETTE.forEach((color) => {
      const d = document.createElement('button'); d.className = 'color-dot'; d.style.background = color; d.title = color;
      if (color.toLowerCase() === String(PREF[key]).toLowerCase()) d.classList.add('active');
      d.addEventListener('click', () => { PREF[key] = color; box.querySelectorAll('.color-dot').forEach((x) => x.classList.toggle('active', x === d)); if (key === 'lyrC1') document.documentElement.style.setProperty('--lyr-sung', color); lyrPushStyle(); saveSoon(); });
      box.appendChild(d);
    });
  };
  buildDots('setLyrC1', 'lyrC1'); buildDots('setLyrC2', 'lyrC2');
  // 扫色样式 5 seg（对齐 PC sweepStyle：clean 极简/soft 柔光/bold 立体/legacy 旧影/classic 描边）
  const sweepSeg = $('setLyrSweep');
  if (sweepSeg) {
    const syncSweep = () => sweepSeg.querySelectorAll('.seg-item').forEach((x) => x.classList.toggle('active', x.dataset.v === PREF.lyrSweep));
    syncSweep();
    sweepSeg.querySelectorAll('.seg-item').forEach((b) => {
      b.addEventListener('click', () => { PREF.lyrSweep = b.dataset.v; syncSweep(); lyrPushStyle(); saveSoon(); });
    });
  }
  // 歌词字体（对齐 PC lyricFont 9 款：快捷 4 项 + ⋯ 弹层全 9 款）
  const LYR_FONTS = [['default', '默认'], ['kai', '楷体'], ['xinwei', '新魏'], ['songti', '宋体'], ['yahei', '雅黑'], ['noto', '思源黑体'], ['misans', 'MiSans'], ['wenkai', '文楷'], ['xingkai', '行书']];
  const fontSeg = $('setLyrFont');
  const fontOv = $('lyrFontOverlay');
  if (fontSeg) {
    const syncFont = () => fontSeg.querySelectorAll('.seg-item').forEach((x) => x.classList.toggle('active', x.dataset.v === PREF.lyrFont));
    syncFont();
    fontSeg.querySelectorAll('.seg-item').forEach((b) => {
      b.addEventListener('click', () => {
        if (b.dataset.v === 'more') {
          const grid = $('lyrFontGrid');
          if (grid) {
            grid.innerHTML = '';
            LYR_FONTS.forEach(([key, name]) => {
              const btn = document.createElement('button');
              btn.className = 'ghost-btn';
              btn.style.fontSize = '13px';
              btn.textContent = name + (PREF.lyrFont === key ? ' ✓' : '');
              btn.addEventListener('click', () => {
                PREF.lyrFont = key;
                syncFont();
                lyrPushStyle();
                saveSoon();
                if (fontOv) fontOv.classList.add('hidden');
              });
              grid.appendChild(btn);
            });
          }
          if (fontOv) fontOv.classList.remove('hidden');
          return;
        }
        PREF.lyrFont = b.dataset.v;
        syncFont();
        lyrPushStyle();
        saveSoon();
      });
    });
  }
  if ($('lyrFontCancel') && fontOv) $('lyrFontCancel').addEventListener('click', () => fontOv.classList.add('hidden'));
  const lockSeg = $('setLyrLock');
  if (lockSeg) {
    lockSeg.querySelectorAll('.seg-item').forEach((b) => {
      b.classList.toggle('active', (+b.dataset.v ? 1 : 0) === (PREF.lyrLocked ? 1 : 0));
      b.addEventListener('click', async () => {
        const ok = await applyLyrLocked(+b.dataset.v ? 1 : 0);
        if (!ok) toast('操作失败');
        else lockSeg.querySelectorAll('.seg-item').forEach((x) => x.classList.toggle('active', x === b));
      });
    });
  }
}
function bindLyrWinSeg() {
  const seg = $('setLyrWin');
  if (!seg) return;
  const sync = () => seg.querySelectorAll('.seg-item').forEach((b) => b.classList.toggle('active', (+b.dataset.v ? 1 : 0) === (PREF.lyrWin ? 1 : 0)));
  sync();
  seg.querySelectorAll('.seg-item').forEach((b) => {
    b.addEventListener('click', async () => {
      const want = +b.dataset.v ? 1 : 0;
      if (want === PREF.lyrWin) return;
      const ok = await toggleLyrWin(want === 1);
      if (!ok) { sync(); return; }
      PREF.lyrWin = want;
      savePrefs();
      sync();
    });
  });
}
function bindProgressStyleSeg() {
  const seg = $('setPStyle');
  if (!seg) return;
  seg.querySelectorAll('.seg-item').forEach((b) => {
    b.classList.toggle('active', b.dataset.v === (PREF.pStyle === 'A' ? 'A' : 'B'));
    b.addEventListener('click', () => {
      PREF.pStyle = b.dataset.v === 'A' ? 'A' : 'B';
      savePrefs();
      seg.querySelectorAll('.seg-item').forEach((x) => x.classList.toggle('active', x === b));
      applyProgressStyle();
    });
  });
  applyProgressStyle();
}
function bindAmbientSettings() {
  applyAmbient();
  // 滑块实时生效 + 300ms 防抖持久化（照 PC bgBlurRange 模式）
  const bindRange = (id, valId, key, fmt) => {
    const el = $(id), vl = $(valId);
    if (!el) return;
    el.value = PREF[key];
    if (vl) vl.textContent = fmt(PREF[key]);
    let timer = null;
    el.addEventListener('input', (e) => {
      const v = +e.target.value;
      PREF[key] = v;
      if (vl) vl.textContent = fmt(v);
      applyAmbient();
      clearTimeout(timer);
      timer = setTimeout(savePrefs, 300);
    });
  };
  bindRange('setAmbStrength', 'setAmbStrengthVal', 'ambStrength', (v) => String(Math.round(v)));
  bindRange('setAmbBlur', 'setAmbBlurVal', 'ambBlur', (v) => (Math.round(v * 10) / 10).toFixed(1));
}

/* ================= 外观（主题 + 强调色 + 背景模式/预设/自定义 + 整套皮肤，对齐桌面 applyAppearance） ================= */
const ACCENTS = [
  { id: 'blue', name: '星蓝', c: '#60a5fa' },
  { id: 'purple', name: '暮紫', c: '#a78bfa' },
  { id: 'green', name: '翡翠', c: '#34d399' },
  { id: 'orange', name: '暖橙', c: '#fb923c' },
  { id: 'pink', name: '樱粉', c: '#f472b6' },
  { id: 'coral', name: '珊瑚', c: '#ff7f6f' },
];
const BG_PRESETS = [
  { id: 'starry', name: '星空', bg: 'linear-gradient(160deg,#0f2027,#203a43 40%,#2c5364)' },
  { id: 'dusk', name: '暮色', bg: 'linear-gradient(180deg,#2b1055,#7597de 55%,#e2a9a9)' },
  { id: 'forest', name: '森林', bg: 'linear-gradient(160deg,#134e5e,#71b280)' },
  { id: 'sunset', name: '日落', bg: 'linear-gradient(160deg,#ff512f,#dd2476)' },
  { id: 'ocean', name: '海洋', bg: 'linear-gradient(160deg,#2e3192,#1bffff)' },
  { id: 'mist', name: '雾霭', bg: 'linear-gradient(160deg,#606c88,#3f4c6b)' },
  { id: 'netease', name: '网易云红', bg: 'linear-gradient(160deg,#c20c0c,#8a0a0a 55%,#4a0505)' },
  { id: 'qq', name: 'QQ绿', bg: 'linear-gradient(160deg,#1ed45f,#0f9d48 55%,#063a1a)' },
  { id: 'kugou', name: '酷狗蓝紫', bg: 'linear-gradient(160deg,#4a7dff,#6a5ae0 55%,#2b2d8a)' },
  { id: 'spotify', name: 'Spotify黑绿', bg: 'linear-gradient(160deg,#1db954,#0f7a35 40%,#121212)' },
  { id: 'ytm', name: 'YouTube红', bg: 'linear-gradient(160deg,#ff0000,#8f0000 55%,#1a0000)' },
  { id: 'soundcloud', name: 'SoundCloud橙', bg: 'linear-gradient(160deg,#ff5500,#c73d00 55%,#4a1600)' },
];
const SKINS = [
  { id: 'applered', name: 'Apple红' },
  { id: 'kugouneon', name: '酷狗霓虹' },
  { id: 'netease', name: '网易云红' },
  { id: 'qqdark', name: 'QQ炫黑' },
  { id: 'spotifyw', name: 'Spotify白' },
  { id: 'xuancai', name: '网易云炫彩' },
  { id: 'huancai', name: '酷狗幻彩' },
];
function currentSkin() { return (PREF.skin && PREF.skin !== 'default' && SKINS.some((s) => s.id === PREF.skin)) ? PREF.skin : 'default'; }
function currentBgMode() { return ['solid', 'preset', 'cover', 'custom'].includes(PREF.bgMode) ? PREF.bgMode : 'cover'; }
function applyAppearance() {
  const theme = ['auto', 'dark', 'light'].includes(PREF.theme) ? PREF.theme : 'auto';
  const dark = theme === 'dark' || (theme === 'auto' && window.matchMedia && window.matchMedia('(prefers-color-scheme: dark)').matches);
  document.documentElement.setAttribute('data-theme', dark ? 'dark' : 'light');
  const accent = ACCENTS.some((a) => a.id === PREF.accent) ? PREF.accent : 'blue';
  document.documentElement.setAttribute('data-accent', accent);
  const skin = currentSkin();
  if (skin === 'default') document.documentElement.removeAttribute('data-skin');
  else document.documentElement.setAttribute('data-skin', skin);
  applyBackground(skin !== 'default');
  applyAmbient();
}
// 背景层：#appAmbient 承载渐变/图片，body.ambient-on 让主表面半透明透出背景
function applyBackground(skinActive) {
  const body = document.body, amb = $('appAmbient'), img = $('appAmbientImg');
  if (!amb || !img) return;
  body.classList.remove('ambient-on');
  amb.style.background = '';
  if (skinActive) {
    amb.style.background = 'var(--skin-bg)';
    if (img.dataset.url) { img.removeAttribute('src'); img.dataset.url = ''; }
    amb.classList.add('show'); body.classList.add('ambient-on'); return;
  }
  const mode = currentBgMode();
  if (mode === 'solid') { amb.classList.remove('show'); return; }
  if (mode === 'preset') {
    const p = BG_PRESETS.find((x) => x.id === (PREF.bgPreset || 'dusk')) || BG_PRESETS[0];
    amb.style.background = p.bg;
    if (img.dataset.url) { img.removeAttribute('src'); img.dataset.url = ''; }
    amb.classList.add('show'); body.classList.add('ambient-on'); return;
  }
  if (mode === 'custom') {
    if (PREF.bgData) { if (img.dataset.url !== PREF.bgData) { img.dataset.url = PREF.bgData; img.src = PREF.bgData; } amb.classList.add('show'); body.classList.add('ambient-on'); }
    else { amb.classList.remove('show'); }
    return;
  }
  // cover：交由 setAmbient 按当前播放封面渲染
  setAmbient();
}
function syncAppearanceControls() {
  const skinActive = currentSkin() !== 'default';
  const mode = currentBgMode();
  // 强调色选中态
  document.querySelectorAll('#setAccent .acc-dot').forEach((b) => b.classList.toggle('active', b.dataset.v === (ACCENTS.some((a) => a.id === PREF.accent) ? PREF.accent : 'blue')));
  // 背景模式选中态
  document.querySelectorAll('#setBgMode .seg-item').forEach((b) => b.classList.toggle('active', b.dataset.v === mode));
  // 行显隐：皮肤激活时隐藏背景相关；否则按模式显示
  const show = (id, on) => { const el = $(id); if (el) el.classList.toggle('hidden', !on); };
  show('setBgModeRow', !skinActive);
  show('setPresetRow', !skinActive && mode === 'preset');
  show('setCustomRow', !skinActive && mode === 'custom');
  show('setStrengthRow', !skinActive && mode !== 'solid');
  show('setBlurRow', !skinActive && (mode === 'cover' || mode === 'custom'));
  // 皮肤 / 预设 按钮文案
  const sb = $('setSkinBtn'); if (sb) { const s = SKINS.find((x) => x.id === PREF.skin); sb.textContent = s ? s.name : '深空（默认）'; }
  const pb = $('setPresetBtn'); if (pb) { const p = BG_PRESETS.find((x) => x.id === (PREF.bgPreset || 'dusk')); pb.textContent = p ? p.name : '暮色'; }
}
function bindAppearanceSegs() {
  const $id = (id) => document.getElementById(id);
  // 主题
  if ($id('setTheme')) {
    $id('setTheme').querySelectorAll('.seg-item').forEach((b) => {
      b.classList.toggle('active', (PREF.theme || 'auto') === b.dataset.v);
      b.addEventListener('click', () => {
        PREF.theme = b.dataset.v; savePrefs();
        $id('setTheme').querySelectorAll('.seg-item').forEach((x) => x.classList.toggle('active', x === b));
        applyAppearance();
      });
    });
  }
  // 强调色（6 圆点）
  const acc = $id('setAccent');
  if (acc && !acc.dataset.built) {
    acc.innerHTML = ACCENTS.map((a) => `<button class="acc-dot" data-v="${a.id}" title="${a.name}" style="background:${a.c}"></button>`).join('');
    acc.dataset.built = '1';
    acc.querySelectorAll('.acc-dot').forEach((b) => b.addEventListener('click', () => {
      PREF.accent = b.dataset.v; savePrefs(); applyAppearance(); syncAppearanceControls();
    }));
  }
  // 背景模式
  if ($id('setBgMode')) {
    $id('setBgMode').querySelectorAll('.seg-item').forEach((b) => {
      b.addEventListener('click', () => {
        PREF.bgMode = b.dataset.v; savePrefs(); applyAppearance(); syncAppearanceControls();
      });
    });
  }
  // 皮肤选择弹层
  const sg = $id('skinGrid');
  if (sg && !sg.dataset.built) {
    const cards = [{ id: 'default', name: '深空（默认）' }].concat(SKINS);
    sg.innerHTML = cards.map((s) => `<button class="skin-card" data-v="${s.id}"><span class="skin-sw" data-skin="${s.id}"></span><span class="skin-nm">${s.name}</span></button>`).join('');
    sg.dataset.built = '1';
    sg.querySelectorAll('.skin-card').forEach((b) => b.addEventListener('click', () => {
      PREF.skin = b.dataset.v; savePrefs(); applyAppearance(); syncAppearanceControls();
      sg.querySelectorAll('.skin-card').forEach((x) => x.classList.toggle('active', x === b));
      $id('skinSheet').classList.add('hidden');
    }));
  }
  if ($id('setSkinBtn')) $id('setSkinBtn').addEventListener('click', () => {
    const g = $id('skinGrid'); if (g) g.querySelectorAll('.skin-card').forEach((x) => x.classList.toggle('active', x.dataset.v === (PREF.skin || 'default')));
    $id('skinSheet').classList.remove('hidden');
  });
  if ($id('skinClose')) $id('skinClose').addEventListener('click', () => $id('skinSheet').classList.add('hidden'));
  // 预设选择弹层
  const pg = $id('presetGrid');
  if (pg && !pg.dataset.built) {
    pg.innerHTML = BG_PRESETS.map((p) => `<button class="preset-card" data-v="${p.id}"><span class="preset-sw" style="background:${p.bg}"></span><span class="preset-nm">${p.name}</span></button>`).join('');
    pg.dataset.built = '1';
    pg.querySelectorAll('.preset-card').forEach((b) => b.addEventListener('click', () => {
      PREF.bgPreset = b.dataset.v; PREF.bgMode = 'preset'; savePrefs(); applyAppearance(); syncAppearanceControls();
      $id('presetSheet').classList.add('hidden');
    }));
  }
  if ($id('setPresetBtn')) $id('setPresetBtn').addEventListener('click', () => {
    const g = $id('presetGrid'); if (g) g.querySelectorAll('.preset-card').forEach((x) => x.classList.toggle('active', x.dataset.v === (PREF.bgPreset || 'dusk')));
    $id('presetSheet').classList.remove('hidden');
  });
  if ($id('presetClose')) $id('presetClose').addEventListener('click', () => $id('presetSheet').classList.add('hidden'));
  // 自定义背景图
  if ($id('setBgCustomBtn')) $id('setBgCustomBtn').addEventListener('click', () => { const f = $id('bgPick'); if (f) f.click(); });
  const bgPick = $id('bgPick');
  if (bgPick) bgPick.addEventListener('change', (e) => {
    const f = e.target.files && e.target.files[0]; if (!f) return;
    const rd = new FileReader();
    rd.onload = () => { PREF.bgData = rd.result; PREF.bgMode = 'custom'; savePrefs(); applyAppearance(); syncAppearanceControls(); };
    rd.readAsDataURL(f);
  });
  syncAppearanceControls();
  // 跟随系统：监听系统深浅色切换
  if (window.matchMedia) {
    const mql = window.matchMedia('(prefers-color-scheme: dark)');
    const onChange = () => { if ((PREF.theme || 'auto') === 'auto') applyAppearance(); };
    if (typeof mql.addEventListener === 'function') mql.addEventListener('change', onChange);
    else if (typeof mql.addListener === 'function') mql.addListener(onChange);
  }
}

/* ================= 音质映射（对齐桌面端） ================= */
const LEVEL_MAP = {
  netease: { standard: 'standard', high: 'higher', lossless: 'lossless' },
  kugou: { standard: '128', high: '320', lossless: 'lossless' }
};
const QUALITY_NORM = { higher: 'high', 标准: 'standard', 高品: 'high', 无损: 'lossless', '128': 'standard', '320': 'high' };
const QUALITY_LABEL = { standard: '标准', high: '高品', lossless: '无损' };
function qualityToLevel(source, quality) {
  let q = String(quality || 'high');
  if (QUALITY_NORM[q]) q = QUALITY_NORM[q];
  if (!['standard', 'high', 'lossless'].includes(q)) q = 'high';
  const m = LEVEL_MAP[source] || LEVEL_MAP.netease;
  return m[q] || 'lossless';
}
function normQuality(lv) {
  const n = QUALITY_NORM[lv] || lv;
  return ['standard', 'high', 'lossless'].includes(n) ? n : null;
}
// leiz 返回值归一为徽章档位（可能是 level 名/码率数字/flac 标记）
function normLeizLevel(v) {
  const s = String(v).toLowerCase();
  if (/lossless|flac|dolby|atmos|sq|无损|hi-?res/.test(s)) return 'lossless';
  if (/\b(320)\b/.test(s) || /high|hq|320k|高品/.test(s)) return 'high';
  if (/\b(128|96)\b/.test(s) || /standard|sq128|128k|标准/.test(s)) return 'standard';
  return normQuality(v);
}

/* ================= 原生插件 ================= */
let NP = null, MS = null, DLR = null, html5 = null;

async function initPlayer() {
  try {
    if (window.Capacitor && window.Capacitor.Plugins) {
      const P = window.Capacitor.Plugins;
      if (P.NativePlayer) {
        NP = P.NativePlayer;
        NP.addListener('state', (e) => onPlayerState(e));
      }
      if (P.MediaStore) { MS = P.MediaStore; }
      if (P.Downloader) {
        DLR = P.Downloader;
        DLR.addListener('download', (e) => onDlEvent(e));
      }
      if (NP) { console.log('[player] native backend'); return 'native'; }
    }
  } catch (e) { console.log('[player] native init fail:', e); }
  html5 = new Audio();
  html5.addEventListener('timeupdate', () => onPlayerState({ state: 'progress', position: html5.currentTime, duration: html5.duration || 0 }));
  html5.addEventListener('ended', () => onPlayerState({ state: 'ended' }));
  html5.addEventListener('error', () => onPlayerState({ state: 'error', message: '播放失败' }));
  html5.addEventListener('playing', () => onPlayerState({ state: 'playing' }));
  html5.addEventListener('pause', () => onPlayerState({ state: 'paused' }));
  console.log('[player] html5 backend');
  return 'html5';
}

function onPlayerState(e) {
  if (e.state === 'media') {
    // 通知栏/线控命令：切歌/收藏/锁定桌面歌词
    if (e.message === 'next') playNext();
    else if (e.message === 'prev') playPrev();
    else if (e.message === 'fav') { if (state.current) { toggleFav(state.current); updatePlayerBar(); } }
    else if (e.message === 'lock') applyLyrLocked(!(PREF.lyrLocked === 1));
    return;
  }
  if (e.state === 'progress' || e.state === 'loaded') {
    state.position = e.position || 0;
    if (e.duration) state.duration = e.duration;
    posSample = { pos: state.position, t: (window.performance && performance.now) ? performance.now() : Date.now() };
    updateProgressUI();
    updateLyricHighlight();
    // 断点续播：progress 节流保存（≥3s 一次，避免高频写 localStorage）
    if (PREF.resume !== false && state.current) {
      const now = Date.now();
      if (now - (lastResumeSaveAt || 0) >= 3000) {
        lastResumeSaveAt = now;
        saveResumeState(state.current, state.position);
      }
    }
  } else if (e.state === 'playing') {
    state.playing = true; playErrRetry = 0; updatePlayBtn();
  } else if (e.state === 'paused') {
    state.playing = false; updatePlayBtn();
    if (PREF.resume !== false && state.current) saveResumeState(state.current, state.position);
  } else if (e.state === 'ended') {
    state.playing = false; updatePlayBtn();
    if (PREF.resume !== false && state.current) saveResumeState(state.current, 0); // 播完归零
    if (state.mode === 'repeat') { playerSeek(0); playerPlay(); }
    else if (FM.active && PREF.fmAuto) fmAdvance();
    else playNext();
  } else if (e.state === 'error') {
    recoverFromError();
  }
}

/* 播放失败容错（对齐 PC 端换链续播）：解析成功但直链失效/断流时，换源重拿新直链，
   保留进度续播，最多 2 次；仍失败则回退到「跳下一首」的旧行为 */
let playErrRetry = 0;
let recoveringErr = false;
async function recoverFromError() {
  if (recoveringErr) return;
  const cur = state.current;
  const canRetry = cur && !cur.local && !cur.demo && playErrRetry < 2 && state.playing;
  if (!canRetry) {
    toast('播放失败：' + '请检查网络后重试');
    // 断流自动跳下一首（队列还有后续时），避免播放停死
    if (state.queue.length > 1 && state.playing) {
      setTimeout(() => { if (state.playing) playNext(); }, 1500);
    }
    return;
  }
  recoveringErr = true;
  playErrRetry++;
  const resumeAt = state.position || 0;
  toast('播放失败，正在换源重试…');
  try {
    const resolved = await Promise.race([
      resolvePlayable(cur),
      new Promise((res) => setTimeout(() => res({ song: null, url: null }), 20000))
    ]);
    if (resolved && resolved.url && state.current && state.current.id === cur.id) {
      if (resolved.song && resolved.song.id !== cur.id) {
        state.current = resolved.song;
        if (state.queueIndex >= 0 && state.queue[state.queueIndex]) state.queue[state.queueIndex] = resolved.song;
        updatePlayerBar();
      }
      await playerLoad(state.current, resolved.url);
      if (resumeAt > 3) await playerSeek(resumeAt);
      await playerPlay();
      applyRate();
      toast('已换源续播：' + (SRC_NAMES[state.current.source] || ''));
    } else {
      throw new Error('换源失败');
    }
  } catch (e) {
    recoveringErr = false;
    recoverFromError();
    return;
  }
  recoveringErr = false;
}

async function playerLoad(song, url) {
  if (NP) {
    await NP.load({ url, title: song.title, artist: song.artist || '', duration: song.duration || 0 });
  } else {
    html5.src = url;
  }
}
async function playerPlay() { NP ? await NP.play() : html5.play().catch(() => {}); }
async function playerPause() { NP ? await NP.pause() : html5.pause(); }
async function playerSeek(t) { NP ? await NP.seek({ position: t }) : (html5.currentTime = t); }
async function playerSetRate(r) { NP ? await NP.setRate({ rate: r }) : (html5.playbackRate = r); }
// 应用倍速（切歌后 ExoPlayer 速度会随新 MediaItem 重置，需重新下发）
function applyRate() {
  const r = +PREF.rate || 1;
  if (r === 1) return;
  try { Promise.resolve(playerSetRate(r)).catch(() => {}); } catch (e) {}
}

/* ================= 工具 ================= */
let toastTimer = null;
function toast(msg) {
  const t = $('toast');
  t.textContent = msg;
  t.classList.add('show');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => t.classList.remove('show'), 2200);
}
function esc(s) { return String(s || '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c])); }
function fmtDur(sec) {
  if (!sec || sec <= 0) return '';
  const m = Math.floor(sec / 60), s = Math.floor(sec % 60);
  return m + ':' + String(s).padStart(2, '0');
}
const PLACEHOLDER = 'data:image/svg+xml,' + encodeURIComponent('<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 48 48"><rect width="48" height="48" fill="#1d242e"/><text x="24" y="30" font-size="20" text-anchor="middle" fill="#4deaff">♪</text></svg>');
const SRC_NAMES = { netease: '网易云', kugou: '酷狗', bilibili: 'B站', local: '本地' };

/* ================= 搜索净化（对齐桌面端 2196-2202 行） ================= */
const NON_ORIG_EN = /\b(live|dj|ktv|remix|instrumental|mashup|cover|demo|medley|karaoke)\b/i;
const NON_ORIG_CN = ['现场', '演唱会', '伴奏', '纯音乐', '串烧', '慢摇', '铃声', '钢琴版', '吉他版', '合唱版', '深情版', '女声版', '女生版', '男声版', '独唱版', '翻唱', '变奏', '车载', '电音', '清唱', '原唱'];
function isNonOrig(item) {
  const txt = String(item.title || '') + ' ' + String(item.artist || '');
  return NON_ORIG_EN.test(txt) || NON_ORIG_CN.some((w) => txt.includes(w));
}

/* ================= 视图切换 ================= */
/* 首页子tab状态：recommend=推荐, library=乐库 */
let homeTab = 'recommend';
function setHomeTab(tab) {
  homeTab = tab;
  document.querySelectorAll('.home-top-tab').forEach((b) => b.classList.toggle('active', b.dataset.htab === tab));
  const hr = $('homeRecommend'); if (hr) hr.classList.toggle('hidden', tab !== 'recommend');
  // 乐库已迁至歌单页曲库 tab；首页不再有乐库
}
// 歌单页 音乐/曲库 两 tab
let oplsTab = 'music';
function setOplsTab(tab) {
  oplsTab = tab;
  document.querySelectorAll('#pageOpls .me-top-tab').forEach((b) => b.classList.toggle('active', b.dataset.otab === tab));
  const m = $('otabMusic'), l = $('otabLibrary');
  if (m) m.classList.toggle('hidden', tab !== 'music');
  if (l) l.classList.toggle('hidden', tab !== 'library');
  if (tab === 'library') { if (!state.localSongs.length) scanLocal().catch(() => {}); renderLocalFiltered(); }
}
// 跳到歌单页并定位到某分类分区（我的歌单/最近听过/临时歌单）
function gotoOplsSection(id) {
  setView('opls'); setOplsTab('music');
  document.querySelectorAll('#pageOpls .pl-cap').forEach((c) => c.classList.toggle('active', c.dataset.plcap === id));
  const el = $(id), page = $('page');
  if (!el || !page) return;
  // 直接设 scrollTop（scrollIntoView 在本 WebView 不生效）
  const top = el.getBoundingClientRect().top - page.getBoundingClientRect().top + page.scrollTop;
  page.scrollTo({ top: Math.max(0, top - 4), behavior: 'smooth' });
}
// 猜你喜欢池（对齐 PC「常听 + 收藏」混合推荐）：最近播放在前权重高，收藏去重并入
function guessPool() {
  const pool = resolveRecent().slice();
  const seen = new Set(pool.map((s) => s.id));
  state.favorites.forEach((f) => { if (!seen.has(f.id)) pool.push(f); });
  return pool;
}

/* ================= 猜你喜欢 FM（点名片开播，播完自动续猜；尝新=酷狗个性化流，默认本地池） ================= */
const FM = { active: false, mode: 'local' };
function kgSongOf(s) {
  return {
    id: 'online:kugou:' + s.hash, online: true, source: 'kugou', ref: s.hash,
    title: s.name || '', artist: s.artist || '', album: s.album || '',
    duration: s.duration || 0, picUrl: s.cover || '', level: normQuality(PREF.onlineQ) || 'high'
  };
}
// 旧酷狗数据回填（封面/歌手映射修复前导入的歌单字段为空）：按 hash 从歌单接口补齐，同步收藏/最近播放快照
async function backfillKgCovers(pl) {
  if (!pl || pl._covFix || pl.source !== 'kugou' || !/^kg:/.test(pl.id || '')) return;
  pl._covFix = 1;
  const songs = await KG.collectAllSongs(pl.id.slice(3)).catch(() => []);
  if (!songs.length) return;
  const map = {};
  songs.forEach((s) => { if (s.hash) map[s.hash] = { pic: s.pic || '', artist: s.singername || s.artist || '', name: s.name || '' }; });
  let n = 0;
  const patch = (s) => {
    if (!s || s.source !== 'kugou') return;
    const m = map[s.ref]; if (!m) return;
    if (!s.picUrl && m.pic) { s.picUrl = m.pic; n++; }
    if (!s.artist && m.artist) { s.artist = m.artist; n++; }
  };
  (pl.songs || []).forEach(patch);
  state.favorites.forEach(patch);
  state.recent.forEach((r) => patch(r.snap));
  if (state.current) patch(state.current);
  if (n) {
    saveOpls(); LS.save('favs', state.favorites); LS.save('recent', state.recent);
    updatePlayerBar();
    updateHomeCards();
    renderFavs(); renderRecent();
    if (state.view === 'opldetail' && state.currentPl === pl) rerenderCurrentDetail();
  }
}
function backfillKgCoversAll() {
  const need = (state.onlinePlaylists || []).filter((p) => p.source === 'kugou' && (p.songs || []).length && (p.songs || []).filter((s) => !s.picUrl).length > (p.songs || []).length / 2);
  need.reduce((chain, p) => chain.then(() => backfillKgCovers(p)).then(() => new Promise((r) => setTimeout(r, 300))), Promise.resolve()).catch(() => {});
}
let guessPick = null;
async function startGuessFm() {
  const pool = guessPool().slice();
  for (let i = pool.length - 1; i > 0; i--) { const j = Math.floor(Math.random() * (i + 1)); [pool[i], pool[j]] = [pool[j], pool[i]]; }
  if (guessPick) { const gi = pool.findIndex((s) => s && s.id === guessPick.id); if (gi > 0) { pool.unshift(pool.splice(gi, 1)[0]); } }
  const wantFresh = PREF.fmFresh && KG.loggedIn();
  // 本地池优先：立即开播（消除点击后等待个性化流的空档）；无本地池才等酷狗
  if (pool.length) {
    await playFrom(pool[0], pool.slice(0, 12));
    FM.active = true; FM.mode = 'local';
    showPlayerPage();
    if (wantFresh) {
      KG.guessYouLike().then((r) => {
        if (r && r.ok && r.songs.length) {
          const seen = new Set([pool[0].id]);
          const add = r.songs.map(kgSongOf).filter((s) => !seen.has(s.id));
          if (add.length) { state.queue = [pool[0], ...add]; state.queueIndex = 0; if (typeof rebuildShuffle === 'function') rebuildShuffle(); updateQueueUI(); FM.mode = 'kugou'; }
        }
      }).catch(() => {});
    }
    return;
  }
  let queue = [];
  if (wantFresh) {
    const r = await KG.guessYouLike().catch(() => ({ ok: false }));
    if (r.ok && r.songs.length) queue = r.songs.map(kgSongOf);
  }
  if (!queue.length) { toast('暂无推荐 — 先听几首或收藏歌曲'); return; }
  await playFrom(queue[0], queue);
  FM.active = true;
  FM.mode = queue[0].source === 'kugou' ? 'kugou' : 'local';
  showPlayerPage();
}
// 播完续猜：kugou 模式带听完反馈拉下一批；失败回退本地池（不断流）
async function fmAdvance() {
  const cur = state.current;
  if (FM.mode === 'kugou' && cur && cur.source === 'kugou') {
    const r = await KG.guessYouLike({ action: 'play', hash: cur.ref, playtime: Math.round(state.position || 0) }).catch(() => ({ ok: false }));
    if (r.ok && r.songs.length) {
      const seen = new Set(state.queue.map((s) => s.id));
      const add = r.songs.map(kgSongOf).filter((s) => !seen.has(s.id));
      if (add.length) { state.queue.push(...add); updateQueueUI(); }
    } else FM.mode = 'local';
  }
  if (FM.mode === 'local') {
    const inQ = new Set(state.queue.map((s) => s.id));
    const pool = guessPool().filter((s) => !inQ.has(s.id));
    if (pool.length) { state.queue.push(pool[Math.floor(Math.random() * pool.length)]); updateQueueUI(); }
  }
  await playNext();
  updateHomeCards(); // 名片跟随 FM 当前曲
}
// 手动跳过 FM 曲：fire-and-forget 反馈（帮酷狗校准画像）
function fmSkipFeedback() {
  if (!FM.active || FM.mode !== 'kugou' || !state.current || state.current.source !== 'kugou') return;
  KG.guessYouLike({ action: 'skip', hash: state.current.ref }).catch(() => {});
}
function bindGuessFmSettings() {
  const bindSeg = (id, key) => {
    const seg = $(id);
    if (!seg) return;
    const sync = () => seg.querySelectorAll('.seg-item').forEach((b) => b.classList.toggle('active', (+b.dataset.v ? 1 : 0) === (PREF[key] ? 1 : 0)));
    sync();
    seg.querySelectorAll('.seg-item').forEach((b) => b.addEventListener('click', () => { PREF[key] = +b.dataset.v ? 1 : 0; savePrefs(); sync(); }));
  };
  bindSeg('setFmAuto', 'fmAuto');
  bindSeg('setFmFresh', 'fmFresh');
}
// 首页大卡封面拼贴（真实封面 2x2 小图，无数据回退线性音符）
// diff 更新：URL 签名不变跳过重建；新图先载后显（淡入），杜绝刷新时的空白闪烁
function cardCovers(cardId, songs) {
  const card = $(cardId);
  if (!card) return;
  const first = (songs || []).find((x) => x && x.picUrl);
  const bg = card.querySelector('.hbb-bg');
  if (bg) {
    const want = first ? 'url("' + first.picUrl + '")' : 'none';
    if (bg.style.backgroundImage !== want) {
      if (first) { const im = new Image(); im.onload = () => { bg.style.backgroundImage = want; }; im.src = first.picUrl; }
      else bg.style.backgroundImage = 'none';
    }
  }
  const box = card.querySelector('.home-big-card-cover');
  if (!box) return;
  const list = (songs || []).filter((s) => s && s.picUrl).slice(0, 4);
  if (!list.length) {
    box.dataset.sig = '';
    box.innerHTML = '<svg viewBox="0 0 24 24" class="hbc-note"><path d="M9 17V6l10-2v10"/><circle cx="7" cy="17" r="2.2"/><circle cx="17" cy="14.5" r="2.2"/></svg>';
    return;
  }
  const sig = list.map((s) => s.picUrl).join('|');
  if (box.dataset.sig === sig && box.querySelector('img')) return;
  box.dataset.sig = sig;
  box.innerHTML = list.map(() => '<img alt="">').join('');
  const imgs = box.querySelectorAll('img');
  list.forEach((s, i) => {
    const img = imgs[i];
    img.style.opacity = '0';
    img.onload = () => { img.style.opacity = '1'; };
    img.onerror = () => img.remove();
    img.src = s.picUrl;
  });
}
function updateHomeCards() {
  // 猜你喜欢：FM 进行中显示当前曲；否则最近播放+收藏 混合池随机一首
  const pool = guessPool();
  // 当前 FM 曲无封面（旧数据）时回退池内有封面的歌，避免卡片只剩占位音符
  let fav;
  if (FM.active && state.current) {
    fav = (state.current.picUrl ? state.current : null) || pool.find((s) => s && s.picUrl) || state.current;
  } else {
    const cands = pool.filter((s) => s && s.picUrl);
    fav = cands.length ? cands[Math.floor(Math.random() * cands.length)] : (pool[0] || null);
    guessPick = fav;
  }
  $('cardGuessSub').textContent = fav ? fav.title : '暂无推荐';
  cardCovers('cardGuess', fav ? [fav] : pool.slice(0, 4));
  // 每日推荐卡由 renderDaily 管理；最近听过=最近打开的歌单
  const recent = resolveRecent();
  const rp = state.recentPls || [];
  $('cardRecentSub').textContent = rp.length ? rp[0].name : (recent.length ? recent[0].title : '暂无记录');
  cardCovers('cardRecent', rp[0] && rp[0].cover ? [{ picUrl: rp[0].cover }] : recent.slice(0, 4));
}
function setView(v, opts = {}) {
  if (v === 'local') { setView('opls'); setOplsTab('library'); return; }
  if (state.batch.mode) { state.batch = { mode: false, list: [], sel: new Set() }; $('batchBar').classList.add('hidden'); }
  state.view = v;
  // 子页面显示顶栏（返回按钮），首页隐藏
  const isSub = (v === 'opldetail' || v === 'localdetail' || v === 'mylistdetail' || v === 'recentpls' || v === 'plcat' || v === 'settings' || v === 'settingsub');
  $('topBar').classList.toggle('hidden', !isSub);
  const pages = { search: 'pageSearch', opls: 'pageOpls', opldetail: 'pageOplDetail', mylistdetail: 'pageMylistDetail', localdetail: 'pageLocalDetail', recentpls: 'pageRecentPls', plcat: 'pagePlCat', settings: 'pageSettings', settingsub: 'pageSettingsSub', me: 'pageMe' };
  Object.entries(pages).forEach(([k, id]) => { const el = $(id); if (el) el.classList.toggle('hidden', k !== v); });
  // 底栏高亮：local 视图映射到 search+乐库 tab
  const navMap = { search: 'search', opls: 'opls', opldetail: 'opls', mylistdetail: 'opls', recentpls: 'opls', plcat: 'opls', settings: 'me', settingsub: 'me', local: 'search', localdetail: 'search', me: 'me' };
  document.querySelectorAll('#bottomNav .nav-item').forEach((b) => b.classList.toggle('active', b.dataset.view === navMap[v]));
  $('topBar').classList.toggle('tb-light', v === 'opldetail');
  $('topBar').classList.toggle('tb-home', v === 'recentpls');
  document.body.classList.toggle('detail-white', v === 'opldetail');
  // 详情页沉浸：底栏滑出屏幕，迷你条下移补位
  document.body.classList.toggle('detail-immersive', v === 'opldetail');
  if (v !== 'opldetail') $('topActions').innerHTML = '';
  $('topBack').classList.toggle('hidden', !isSub);
  $('topTitle').textContent = (v === 'opldetail' || v === 'localdetail' || v === 'mylistdetail') ? '歌单详情' : v === 'recentpls' ? '最近听过' : v === 'plcat' ? (opts.title || '歌单') : v === 'settings' ? '设置' : v === 'settingsub' ? (opts.title || '设置') : '深空折韵';
  if (v === 'plcat' || v === 'settings' || v === 'settingsub') $('topBar').classList.add('tb-home');
  if (v === 'opls') { renderOpls(); renderMylists(); if (oplsTab === 'library') setOplsTab('library'); }
  if (v === 'search') renderHomeSections();
  if (v === 'me') { renderFavs(); renderRecent(); renderDlTasks(); refreshAccountUI(); refreshBiliUI(); refreshKgUI(); renderCurAccount(); applyHeroCard(); }
}

/* ================= 本地歌单（对齐桌面 playlists.json：新建/重命名/删除/加歌/播放） ================= */
// 保存时按内容签名盖章 updatedAt（契约 §3：任何创建/改名/加删歌/换封面/重排都要盖真实时间戳，
// 否则 buildSyncBundle 缺时间戳回退 Date.now()，会让手机永远判赢、覆盖对端真实修改）。
function saveMylists() {
  const now = Date.now();
  for (const pl of (state.mylists || [])) {
    if (!pl.createdAt) pl.createdAt = pl.updatedAt || now;
    const idOf = (e) => (e && typeof e === 'object' ? e.id : e);
    const sig = (pl.name || '') + '\u0001' + (pl.cover || '') + '\u0001' + (pl.songIds || []).map(idOf).join(',');
    if (pl._sig !== sig) { pl.updatedAt = now; pl._sig = sig; }
  }
  LS.save('mylists', state.mylists);
  scheduleAutoSync();
}
// 在线歌单持久化：仅收藏(fav)的进本地存储（我的歌单，跨会话保留）；未收藏=临时歌单，仅本次会话，重启即清
function saveOpls() { LS.save('opls', (state.onlinePlaylists || []).filter((p) => p.fav)); scheduleAutoSync(); }
// 我的页用户卡：应用自定义头像与昵称
function applyMeProfile() {
  const av = $('meAvatar');
  if (av) {
    if (PREF.avatar) { av.style.backgroundImage = 'url("' + PREF.avatar + '")'; av.classList.add('has-img'); }
    else { av.style.backgroundImage = ''; av.classList.remove('has-img'); }
  }
  const nm = $('meUserName');
  if (nm) nm.innerHTML = esc(PREF.nickname || '深空折韵用户') + ' <button class="me-name-edit" id="meNameEdit" aria-label="改名"><svg viewBox="0 0 24 24" width="15" height="15"><path d="M4 20h4L19 9l-4-4L4 16z"/><path d="M13.5 6.5l4 4"/></svg></button>';
  const edit = $('meNameEdit');
  if (edit) edit.addEventListener('click', (e) => {
    e.stopPropagation();
    const t = $('mylistOvTitle'); if (t) t.textContent = '修改昵称';
    const inp = $('mylistOvInput'); if (inp) { inp.value = PREF.nickname || ''; inp.placeholder = '给自己起个名字'; }
    mylistOvMode = 'nickname'; mylistOvTarget = null;
    const ov = $('mylistOverlay'); if (ov) ov.classList.remove('hidden');
    if (inp) inp.focus();
  });
  try { flushCurAccountProfile(); renderCurAccount(); } catch (e) { /* 忽略 */ }
}
// 我的页 hero 卡片背景：默认首页同款深空折韵名片，支持自定义图片
function applyHeroCard() {
  const el = $('meHero'); if (!el) return;
  el.style.backgroundImage = PREF.heroCard ? 'url(' + JSON.stringify(PREF.heroCard) + ')' : 'url("img/shz-card.png")';
}
function clearTempCaches() {
  const before = (state.onlinePlaylists || []).length;
  state.onlinePlaylists = (state.onlinePlaylists || []).filter((p) => p.fav);
  try { if (typeof prewarmCache !== 'undefined' && prewarmCache.clear) prewarmCache.clear(); } catch (e) {}
  const cleared = before - state.onlinePlaylists.length;
  renderOpls(); renderMylists();
  toast(cleared > 0 ? `已清除临时歌单 ${cleared} 个` : '没有临时缓存可清除');
}

/* ================= 歌单卡片长按拖拽排序（对齐桌面；长按 450ms 起拖，DOM+数据同步重排，松手持久化） ================= */
function enableDragSort(container, getList, save) {
  if (!container || container.dataset.dragBound) return;
  container.dataset.dragBound = '1';
  let dragEl = null, dragging = false, timer = null, sx = 0, sy = 0, suppressClick = false;
  const clearTimer = () => { clearTimeout(timer); timer = null; };
  const stopDrag = (save2) => {
    clearTimer();
    if (dragging && dragEl) {
      dragEl.classList.remove('dragging');
      if (save2) { save(); toast('歌单顺序已保存'); }
      suppressClick = true;
      setTimeout(() => { suppressClick = false; }, 350);
    }
    dragging = false; dragEl = null;
  };
  container.addEventListener('pointerdown', (e) => {
    if (e.button !== 0 || dragging) return;
    const card = e.target.closest('.opl-card');
    if (!card || !container.contains(card) || e.target.closest('button')) return;
    dragEl = card; sx = e.clientX; sy = e.clientY;
    timer = setTimeout(() => {
      dragging = true;
      dragEl.classList.add('dragging');
      navigator.vibrate && navigator.vibrate(30);
    }, 450);
  });
  container.addEventListener('pointermove', (e) => {
    if (!dragEl) return;
    if (!dragging) {
      // 未起拖就大幅移动 → 用户在滚动列表，取消本次长按
      if (Math.abs(e.clientX - sx) > 10 || Math.abs(e.clientY - sy) > 10) { clearTimer(); dragEl = null; }
      return;
    }
    e.preventDefault();
    const over = document.elementFromPoint(e.clientX, e.clientY);
    const target = over && over.closest ? over.closest('.opl-card') : null;
    if (!target || target === dragEl || !container.contains(target)) return;
    const r = target.getBoundingClientRect();
    const kids = [...container.children];
    const items = getList();
    const from = kids.indexOf(dragEl);
    const targetIdx = kids.indexOf(target);
    const after = e.clientY >= r.top + r.height / 2;
    container.insertBefore(dragEl, after ? target.nextSibling : target);
    const to = after ? targetIdx + 1 : targetIdx;
    const [moved] = items.splice(from, 1);
    items.splice(to > from ? to - 1 : to, 0, moved);
  });
  // 拖拽中禁掉页面滚动（否则浏览器触发 pointercancel 中断拖拽）
  container.addEventListener('touchmove', (e) => { if (dragging) e.preventDefault(); }, { passive: false });
  container.addEventListener('pointerup', () => stopDrag(true));
  container.addEventListener('pointercancel', () => stopDrag(false));
  container.addEventListener('click', (e) => {
    if (suppressClick) { e.stopPropagation(); e.preventDefault(); suppressClick = false; }
  }, true);
}

/* ================= 歌单内歌曲拖拽排序（对齐 PC：拖到哪行落到哪行位置；触屏用行首手柄，长按手势已让给批量） ================= */
function enableHandleDragSort(container, onReorder) {
  if (!container || container.dataset.handleDragBound) return;
  container.dataset.handleDragBound = '1';
  let srcRow = null, dragging = false, suppressClick = false;
  container.addEventListener('pointerdown', (e) => {
    const h = e.target.closest('.drag-handle');
    if (!h || state.batch.mode) return;
    srcRow = h.closest('.song-row');
    if (!srcRow) return;
    dragging = true;
    srcRow.classList.add('drag-src');
    navigator.vibrate && navigator.vibrate(30);
    e.preventDefault();
  });
  container.addEventListener('pointermove', (e) => {
    if (!dragging || !srcRow) return;
    e.preventDefault();
    const el = document.elementFromPoint(e.clientX, e.clientY);
    const target = el && el.closest ? el.closest('.song-row') : null;
    container.querySelectorAll('.song-row.drag-over').forEach((r) => { if (r !== target) r.classList.remove('drag-over'); });
    if (target && target !== srcRow && container.contains(target)) target.classList.add('drag-over');
  });
  const finish = (apply) => {
    if (!dragging || !srcRow) return;
    const target = container.querySelector('.song-row.drag-over');
    const srcId = srcRow.dataset.id;
    const dstId = target ? target.dataset.id : null;
    container.querySelectorAll('.song-row.drag-over, .song-row.drag-src').forEach((r) => r.classList.remove('drag-over', 'drag-src'));
    dragging = false; srcRow = null;
    if (apply && dstId && dstId !== srcId) {
      suppressClick = true;
      setTimeout(() => { suppressClick = false; }, 350);
      onReorder(srcId, dstId);
    }
  };
  container.addEventListener('pointerup', () => finish(true));
  container.addEventListener('pointercancel', () => finish(false));
  container.addEventListener('touchmove', (e) => { if (dragging) e.preventDefault(); }, { passive: false });
  container.addEventListener('click', (e) => { if (suppressClick) { e.stopPropagation(); e.preventDefault(); suppressClick = false; } }, true);
}
// 我的歌单 songIds 重排：照 PC——from/to 取目标行原下标，splice(from,1) 后 splice(to,0)
function reorderMylistSongs(srcId, dstId) {
  const pl = state.currentMylist;
  if (!pl || srcId === dstId) return;
  const find = (sid) => pl.songIds.findIndex((x) => (x && typeof x === 'object') ? String(x.id) === String(sid) : x === String(sid));
  const from = find(srcId), to = find(dstId);
  if (from < 0 || to < 0 || from === to) return;
  const [entry] = pl.songIds.splice(from, 1);
  pl.songIds.splice(to, 0, entry);
  saveMylists();
  openMylist(pl.id, true);
  toast('歌单顺序已保存');
}

function mylistSongs(pl) {
  // songIds 元素：在线歌曲对象（online/source/ref）或本地歌曲 id（字符串，从媒体库解析）
  return (pl.songIds || []).map((e) => {
    if (e && typeof e === 'object') return e;
    return state.localSongs.find((s) => String(s.id) === String(e)) || null;
  }).filter(Boolean);
}
function mylistCard(pl) {
  const card = document.createElement('div');
  card.className = 'opl-card';
  const cov = document.createElement('div');
  cov.className = 'cov artist-cov';
  cov.textContent = String(pl.name || '歌').slice(0, 1);
  const info = document.createElement('div');
  info.style.flex = '1';
  info.innerHTML = `<div class="name">${esc(pl.name)}</div><div class="meta">${(pl.songIds || []).length} 首</div>`;
  const del = document.createElement('button');
  del.className = 'icon-btn';
  del.innerHTML = icon('trash', 18);
  del.title = '删除歌单';
  del.addEventListener('click', (e) => { e.stopPropagation(); deleteMylist(pl.id); });
  const ren = document.createElement('button');
  ren.className = 'icon-btn';
  ren.innerHTML = icon('edit', 18);
  ren.title = '重命名';
  ren.addEventListener('click', (e) => { e.stopPropagation(); openMylistRename(pl); });
  card.append(cov, info, ren, del);
  card.addEventListener('click', () => openMylist(pl.id));
  return card;
}
function renderMylists() {
  const el = $('mylistList');
  if (!el) { refreshStats(); return; }
  el.innerHTML = '';
  // 我的歌单 = 自建歌单 + 已收藏(fav)的在线歌单（对齐 PC）；首页上限 10，超出走"更多"
  const mine = [...state.mylists, ...(state.onlinePlaylists || []).filter((p) => p.fav)];
  mine.slice(0, 10).forEach((pl) => el.appendChild(pl.id && String(pl.id).startsWith('ml') ? mylistCard(pl) : oplCard(pl, true)));
  const more = document.querySelector('#pageOpls .pl-more[data-plcat=myPl]'); if (more) more.classList.toggle('hidden', mine.length <= 10);
  const cnt = $('playlistCount'); if (cnt) cnt.textContent = String(mine.length);
  enableDragSort(el, () => state.mylists, saveMylists);
  refreshStats();
}
// —— 首页「最近播放」横滑卡 ——
function homeRecentCard(s, list) {
  const card = document.createElement('div');
  card.className = 'daily-card';
  const img = document.createElement('img');
  img.src = s.picUrl || PLACEHOLDER;
  img.onerror = () => { img.onerror = null; img.src = PLACEHOLDER; };
  const nm = document.createElement('div');
  nm.className = 'daily-card-name';
  nm.textContent = s.title || '';
  const ar = document.createElement('div');
  ar.className = 'daily-card-artist';
  ar.textContent = s.artist || SRC_NAMES[s.source] || '';
  card.append(img, nm, ar);
  card.addEventListener('click', () => playFrom(s, list));
  return card;
}
function renderHomeSections() {
  const rc = $('homeRecentCards');
  if (rc) {
    rc.innerHTML = '';
    const list = resolveRecent();
    list.slice(0, 12).forEach((s) => rc.appendChild(homeRecentCard(s, list)));
    const emp = $('homeRecentEmpty'); if (emp) emp.classList.toggle('hidden', list.length > 0);
    const sec = $('homeRecent'); if (sec) sec.classList.toggle('hidden', list.length === 0);
  }
}
// 歌单分类完整列表页（我的歌单/最近听过/临时歌单）
function plCatItems(cat) {
  if (cat === 'myPl') return { title: '我的歌单', items: [...state.mylists, ...(state.onlinePlaylists || []).filter((p) => p.fav)], kind: 'pl' };
  if (cat === 'tempPl') return { title: '临时歌单', items: (state.onlinePlaylists || []).filter((p) => !p.fav), kind: 'pl' };
  return { title: '最近听过', items: state.recentPls || [], kind: 'recent' };
}
function openPlCategory(cat) {
  const { title, items, kind } = plCatItems(cat);
  state.plCat = cat;
  const el = $('plCatList'); if (!el) return;
  el.innerHTML = '';
  if (kind === 'recent') {
    items.forEach((it) => el.appendChild(recentPlCard(it)));
  } else {
    items.forEach((pl) => el.appendChild(cat === 'myPl' && String(pl.id).startsWith('ml') ? mylistCard(pl) : oplCard(pl, cat === 'myPl')));
  }
  const emp = $('plCatEmpty'); if (emp) emp.classList.toggle('hidden', items.length > 0);
  setView('plcat', { title });
  $('page').scrollTop = 0;
}
// 在线歌单卡（我的/临时通用）；mine=true 显示收藏标记
function oplCard(pl, mine) {
  const card = document.createElement('div');
  card.className = 'opl-card';
  const cov = document.createElement('img');
  cov.className = 'cov';
  cov.src = pl.cover || PLACEHOLDER;
  cov.onerror = () => { cov.src = PLACEHOLDER; };
  const info = document.createElement('div');
  info.style.flex = '1';
  info.innerHTML = `<div class="name">${esc(pl.name)}</div><div class="meta">${esc(SRC_NAMES[pl.source] || pl.source || '')} · ${(pl.songs || []).length} 首</div>`;
  const fav = document.createElement('button');
  fav.className = 'icon-btn' + (pl.fav ? ' opl-fav-on' : '');
  fav.innerHTML = icon(pl.fav ? 'heartFill' : 'heart', 18);
  fav.title = pl.fav ? '取消收藏' : '收藏歌单';
  if (pl.fav) fav.style.color = '#ff8fa0';
  fav.addEventListener('click', (e) => { e.stopPropagation(); pl.fav = !pl.fav; saveOpls(); renderMylists(); renderOpls(); });
  const del = document.createElement('button');
  del.className = 'icon-btn';
  del.innerHTML = icon('trash', 18);
  del.addEventListener('click', (e) => {
    e.stopPropagation();
    state.onlinePlaylists = state.onlinePlaylists.filter((x) => x.id !== pl.id);
    addTombstone('pl:' + pl.id);
    saveOpls();
    renderMylists(); renderOpls(); toast('已移除歌单');
  });
  card.append(cov, info, fav);
  if (!mine) card.appendChild(del);
  card.addEventListener('click', () => openOpl(pl));
  return card;
}
function openMylist(plId, keepFilter) {
  const pl = state.mylists.find((x) => x.id === plId);
  if (!pl) { toast('歌单不存在'); return; }
  state.currentMylist = pl;
  state.list = mylistSongs(pl);
  if (!keepFilter) { resetDetailFilter('mylistDetailFilter'); resetDFilter(); }
  setView('mylistdetail', { title: pl.name });
  const mySongs = mylistSongs(pl).filter(Boolean);
  const myCover = (mySongs.find((s) => s.picUrl) || {}).picUrl || '';
  const myHasOnline = mySongs.some((s) => s.online);
  const myDlBtn = myHasOnline ? `<button id="btnMylistDlAll" class="dh-btn dh-dl">${icon('download', 14)} 全部下载</button>` : '';
  $('mylistDetailHead').innerHTML = `<div class="dh"><div class="dh-cover">${myCover ? `<img src="${esc(myCover)}" onerror="this.style.visibility='hidden'">` : ''}</div><div class="dh-info"><div class="dh-name">${esc(pl.name)}</div><div class="dh-sub">${mySongs.length} 首</div><div class="dh-btns"><button id="btnMylistPlayAll" class="dh-btn dh-play">${icon('play', 14)} 全部播放</button>${myDlBtn}<button id="btnMylistRename" class="dh-btn dh-rename">${icon('edit', 14)} 重命名</button><button id="btnDhFilter" class="dh-btn dh-ghost">筛选</button><button id="btnDhGrid" class="dh-btn dh-ghost"></button></div></div></div>`;
  bindDhViewBtns();
  $('btnMylistPlayAll').addEventListener('click', (e) => { e.stopPropagation(); if (state.list.length) playList(state.list, 0); else toast('歌单是空的'); });
  if (myHasOnline) $('btnMylistDlAll').addEventListener('click', (e) => { e.stopPropagation(); batchDownload(mySongs.filter((s) => s.online)); });
  $('btnMylistRename').addEventListener('click', (e) => { e.stopPropagation(); openMylistRename(pl); });
  fillFiltered($('mylistDetailList'), state.list, { withRemove: pl.id, dragHandle: true });
  if (!state.list.length) $('mylistDetailList').innerHTML = '<div class="hint">歌单是空的 — 在歌曲上长按批量加入</div>';
}
function openMylistRename(pl) {
  $('mylistOvTitle').textContent = '重命名歌单';
  $('mylistOvInput').value = pl.name;
  $('mylistOvInput').placeholder = '歌单名称';
  mylistOvMode = 'rename'; mylistOvTarget = pl;
  $('mylistOverlay').classList.remove('hidden');
  $('mylistOvInput').focus();
}
function createMylist(name) {
  const n = String(name || '').trim();
  if (!n) { toast('请输入歌单名称'); return null; }
  if (state.mylists.some((p) => p.name === n)) { toast('已有同名歌单'); return null; }
  const pl = { id: 'ml' + Date.now(), name: n, songIds: [] };
  state.mylists.push(pl);
  saveMylists();
  renderMylists();
  return pl;
}
// 从歌单移除单曲（对齐桌面 playlist contextmenu 移除）
function removeFromMylist(plId, song) {
  const pl = state.mylists.find((x) => x.id === plId);
  if (!pl) return;
  const keyOf = (e) => (e && typeof e === 'object' ? e.id : String(e));
  pl.songIds = (pl.songIds || []).filter((e) => keyOf(e) !== String(song.id));
  saveMylists();
  if (state.view === 'mylistdetail' && state.currentMylist && state.currentMylist.id === plId) openMylist(plId);
  else renderMylists();
}
// 删除确认：二次点击（移动端 WebView 原生 confirm 阻塞且无法自动化；对齐桌面"确认删除"语义）
let deletePending = null;
function deleteMylist(id) {
  const pl = state.mylists.find((x) => x.id === id);
  if (!pl) return;
  if (deletePending !== id) {
    deletePending = id;
    toast('再次点击确认删除「' + pl.name + '」');
    setTimeout(() => { if (deletePending === id) deletePending = null; }, 3000);
    return;
  }
  deletePending = null;
  state.mylists = state.mylists.filter((x) => x.id !== id);
  addTombstone('pl:' + id);
  saveMylists();
  renderMylists();
  if (state.view === 'mylistdetail' && state.currentMylist && state.currentMylist.id === id) setView('opls');
  toast('已删除歌单');
}
// 加入歌曲（id 去重；在线对象直接存，本地 id 存字符串）
function addToMylist(plId, songs) {
  const pl = state.mylists.find((x) => x.id === plId);
  if (!pl) return 0;
  const keyOf = (e) => (e && typeof e === 'object' ? e.id : String(e));
  const have = new Set((pl.songIds || []).map(keyOf).filter(Boolean));
  let added = 0;
  (songs || []).forEach((s) => {
    if (!s) return;
    const k = keyOf(s);
    if (!k || have.has(k)) return;
    // 本地歌曲存 id（保证与桌面语义一致：重扫后仍可解析）；在线歌曲存完整对象
    pl.songIds.push(s.online ? s : String(s.id));
    have.add(k);
    added++;
  });
  if (added) { saveMylists(); renderMylists(); }
  return added;
}
// 批量加入歌单（对齐桌面 plPick）：弹选择面板
let plPickSongs = []; // 待加入歌曲（批量）
function openPlPick(songs) {
  plPickSongs = songs || [];
  const list = $('plPickList');
  list.innerHTML = '';
  $('plPickEmpty').classList.toggle('hidden', state.mylists.length > 0);
  state.mylists.forEach((pl) => {
    const row = document.createElement('div');
    row.className = 'song-row';
    const info = document.createElement('div');
    info.className = 'info';
    info.innerHTML = `<div class="t">${esc(pl.name)}</div><div class="a">${(pl.songIds || []).length} 首</div>`;
    row.append(info);
    row.addEventListener('click', () => {
      const n = addToMylist(pl.id, plPickSongs);
      closePlPick();
      if (state.batch.mode) exitBatch();
      toast(n ? `已加入歌单「${pl.name}」${n} 首` : '歌曲已在该歌单中');
    });
    list.appendChild(row);
  });
  $('plPickInput').value = '';
  $('plPickOverlay').classList.remove('hidden');
}
function closePlPick() { $('plPickOverlay').classList.add('hidden'); plPickSongs = []; }
function batchPlSelected() {
  const songs = batchSelectedSongs();
  if (!songs.length) { toast('请先选择歌曲'); return; }
  openPlPick(songs);
}
function bindMylistUi() {
  $('btnNewMylist').addEventListener('click', () => {
    $('mylistOvTitle').textContent = '新建歌单';
    $('mylistOvInput').value = '';
    $('mylistOvInput').placeholder = '歌单名称';
    mylistOvMode = 'create'; mylistOvTarget = null;
    $('mylistOverlay').classList.remove('hidden');
    $('mylistOvInput').focus();
  });
  $('mylistOvOk').addEventListener('click', () => {
    const n = $('mylistOvInput').value.trim();
    if (!n) { toast('请输入歌单名称'); return; }
    if (mylistOvMode === 'nickname') {
      PREF.nickname = n.slice(0, 24); savePrefs(); applyMeProfile();
      toast('昵称已更新');
    } else if (mylistOvMode === 'renameopl' && mylistOvTarget) {
      mylistOvTarget.name = n;
      mylistOvTarget.updatedAt = Date.now();
      saveOpls();
      renderOpls();
      if (state.view === 'opldetail' && state.currentPl === mylistOvTarget) openOpl(mylistOvTarget, true);
      toast('已重命名为「' + n + '」');
    } else if (mylistOvMode === 'rename' && mylistOvTarget) {
      if (state.mylists.some((p) => p !== mylistOvTarget && p.name === n)) { toast('已有同名歌单'); return; }
      mylistOvTarget.name = n;
      saveMylists(); renderMylists();
      if (state.view === 'mylistdetail' && state.currentMylist && state.currentMylist.id === mylistOvTarget.id) openMylist(mylistOvTarget.id);
      toast('已重命名为「' + n + '」');
    } else {
      createMylist(n);
    }
    $('mylistOverlay').classList.add('hidden');
    mylistOvMode = 'create'; mylistOvTarget = null;
  });
  $('mylistOvCancel').addEventListener('click', () => { $('mylistOverlay').classList.add('hidden'); mylistOvMode = 'create'; mylistOvTarget = null; });
  $('plPickAdd').addEventListener('click', () => {
    const n = $('plPickInput').value.trim();
    if (!n) { toast('请输入歌单名称'); return; }
    const pl = createMylist(n);
    if (!pl) return;
    const added = addToMylist(pl.id, plPickSongs);
    closePlPick();
    if (state.batch.mode) exitBatch();
    toast(added ? `已创建歌单「${pl.name}」并加入 ${added} 首` : `已创建歌单「${pl.name}」`);
  });
  $('plPickCancel').addEventListener('click', closePlPick);
  $('batchPl').addEventListener('click', batchPlSelected);
}
let mylistOvMode = 'create', mylistOvTarget = null;

/* ================= 歌曲行 ================= */
// 徽章三槽（对齐 PC t1 在线/本地、t2 来源、t3 音质；色值照 PC CSS）
function levelBadge(song) {
  const n = normQuality(song.level);
  if (!n) return '';
  return `<span class="st st-q-${n}">${QUALITY_LABEL[n]}</span>`;
}
// 详情页歌手名截断：最多 4 个汉字宽（拉丁字符按半宽计；截断时含省略号共 4 宽），配合固定列宽使三标签 x 轴对齐
function truncArtist(name) {
  const s = String(name || '');
  const cw = (c) => /[\u2e80-\ufaff\uff00-\uffef]/.test(c) ? 1 : 0.5;
  let w = 0, i = 0;
  for (; i < s.length; i++) {
    w += cw(s[i]);
    if (w > 4) break;
  }
  if (i >= s.length) return s;
  let k = i, wk = w;
  for (; k > 0 && wk > 3; k--) wk -= cw(s[k - 1]);
  return s.slice(0, k) + '…';
}
function songTagRow(song) {
  const t1 = song.local ? '<span class="st st-local">本地</span>' : (song.online ? '<span class="st st-online">在线</span>' : '');
  const srcName = song.local ? '曲库' : (SRC_NAMES[song.source] || '');
  if (!srcName) return t1;
  const srcCls = song.local ? 'st-src-local' : (song.source === 'netease' ? 'st-src-netease' : song.source === 'kugou' ? 'st-src-kugou' : 'st-src-other');
  return t1 + `<span class="st ${srcCls}">${esc(srcName)}</span>`;
}
function songRow(song, opts = {}) {
  const row = document.createElement('div');
  row.className = 'song-row' + (state.current && state.current.id === song.id ? ' playing' : '');
  row.dataset.id = String(song.id);
  const cov = document.createElement('img');
  cov.className = 'cov';
  cov.src = song.picUrl || PLACEHOLDER;
  cov.onerror = () => { cov.src = PLACEHOLDER; };
  // 批量勾选圈（默认隐藏；批量模式显示）
  const bck = document.createElement('span');
  bck.className = 'b-check hidden';
  const info = document.createElement('div');
  info.className = 'info';
  // 全站统一详情行样式：粗黑歌名 + 歌手(≤4字宽)+徽章同行 + 红心/更多操作
  info.innerHTML = `<div class="t">${esc(song.title)}${song.demo ? '<span class="demo-tag">示例</span>' : ''}</div><div class="a"><span class="a-name">${esc(truncArtist(song.artist))}</span>${songTagRow(song)}${levelBadge(song)}</div>`;
  row.append(bck, cov, info);
  if (!opts.noOps) {
    const ops = document.createElement('div');
    ops.className = 'ops';
    const fav = document.createElement('button');
    fav.className = 'icon-btn';
    const fv0 = isFav(song.id); fav.innerHTML = icon(fv0 ? 'heartFill' : 'heart', 18); fav.style.color = fv0 ? '#ff6b6b' : '';
    fav.addEventListener('click', (e) => { e.stopPropagation(); toggleFav(song); const fv = isFav(song.id); fav.innerHTML = icon(fv ? 'heartFill' : 'heart', 18); fav.style.color = fv ? '#ff6b6b' : ''; fav.classList.remove('heart-pop'); void fav.offsetWidth; fav.classList.add('heart-pop'); });
    ops.append(fav);
    const mb = document.createElement('button');
    mb.className = 'icon-btn';
    mb.innerHTML = icon('dotsH', 18);
    mb.title = '更多操作';
    mb.addEventListener('click', (e) => { e.stopPropagation(); openSongMore(song, opts); });
    ops.append(mb);
    if (opts.withRemove) {
      const rm = document.createElement('button');
      rm.className = 'icon-btn';
      rm.innerHTML = icon('close', 16);
      rm.title = '从歌单移除';
      rm.addEventListener('click', (e) => {
        e.stopPropagation();
        removeFromMylist(opts.withRemove, song);
        toast('已从歌单移除');
      });
      ops.append(rm);
    }
    row.append(ops);
  }
  if (opts.dragHandle) {
    const grip = document.createElement('span');
    grip.className = 'drag-handle';
    grip.title = '拖动排序';
    row.prepend(grip);
  }
  // 长按 500ms 进入批量模式（对齐桌面多选；行内按钮不受影响）
  let lpTimer = null, lpFired = false;
  row.addEventListener('pointerdown', (e) => {
    if (e.button !== 0 || state.batch.mode) return;
    if (e.target.closest('.drag-handle')) return; // 拖拽手柄：走排序手势，不进批量
    lpFired = false;
    lpTimer = setTimeout(() => {
      lpFired = true;
      navigator.vibrate && navigator.vibrate(30);
      enterBatch(opts.list || state.list);
    }, 500);
  });
  const cancelLp = () => { clearTimeout(lpTimer); lpTimer = null; };
  row.addEventListener('pointerup', cancelLp);
  row.addEventListener('pointerleave', cancelLp);
  row.addEventListener('pointercancel', cancelLp);
  row.addEventListener('contextmenu', (e) => { e.preventDefault(); if (!state.batch.mode) enterBatch(opts.list || state.list); });
  row.addEventListener('click', () => {
    // 长按已进入批量：先吞掉随后的 click（须在 batch.mode 判断之前，L2 修复）
    if (lpFired) { lpFired = false; return; }
    if (state.batch.mode) { toggleBatchSel(song); return; }
    playFrom(song, opts.list || state.list, opts.idx);
  });
  return row;
}

/* ================= 批量模式（对齐桌面 batchSelect） ================= */
function enterBatch(list) {
  state.batch = { mode: true, list: list || state.list, sel: new Set() };
  $('batchBar').classList.remove('hidden');
  syncBatchUI();
  toast('批量模式：点选歌曲，再点下方操作');
}
function syncBatchUI() {
  const b = state.batch;
  if (!b.mode) return;
  // 按视图限定容器，避免"我的"页多列表索引错位
  const v = state.view;
  let rows = [];
  if (v === 'search') rows = document.querySelectorAll('#searchList .song-row');
  else if (v === 'opldetail') rows = document.querySelectorAll('#oplDetailList .song-row');
  else if (v === 'mylistdetail') rows = document.querySelectorAll('#mylistDetailList .song-row');
  else if (v === 'local') rows = document.querySelectorAll('#localList .song-row');
  else if (v === 'localdetail') rows = document.querySelectorAll('#localDetailList .song-row');
  else if (v === 'me') {
    // 批量列表若是收藏则只扫 favList；最近播放列表同理（按首个匹配容器的顺序）
    const inFav = b.list.length && b.list === state.favorites;
    rows = inFav ? document.querySelectorAll('#favList .song-row') : document.querySelectorAll('#recentList .song-row');
  }
  b.list.forEach((s, i) => {
    const row = rows[i];
    if (!row) return;
    const ck = row.querySelector('.b-check');
    if (ck) {
      ck.classList.remove('hidden');
      const on = b.sel.has(s.id);
      ck.textContent = on ? '✓' : '';
      ck.classList.toggle('on', on);
      row.classList.toggle('b-sel', on);
    }
  });
  $('batchCount').textContent = '已选 ' + b.sel.size + ' 首';
}
function toggleBatchSel(song) {
  const b = state.batch;
  if (!b.mode) return;
  if (b.sel.has(song.id)) b.sel.delete(song.id); else b.sel.add(song.id);
  syncBatchUI();
}
function batchSelectedSongs() {
  const b = state.batch;
  return b.list.filter((s) => b.sel.has(s.id));
}
function exitBatch() {
  state.batch = { mode: false, list: [], sel: new Set() };
  $('batchBar').classList.add('hidden');
  const v = state.view;
  if (v === 'search') {
    const el = $('searchList');
    el.innerHTML = '';
    state.searchResults.forEach((s, i) => el.appendChild(songRow(s, { list: state.searchResults, idx: i })));
  } else if (v === 'opldetail') {
    const pl = state.currentPl;
    if (pl) fillFiltered($('oplDetailList'), pl.songs || [], { plDetail: true });
  } else if (v === 'mylistdetail') {
    const pl = state.currentMylist;
    if (pl) { const songs = mylistSongs(pl); const el = $('mylistDetailList'); el.innerHTML = ''; songs.forEach((s, i) => el.appendChild(songRow(s, { list: songs, idx: i, withRemove: pl.id, dragHandle: true }))); }
  } else if (v === 'me') { renderFavs(); renderRecent(); }
  else if (v === 'local') renderLocalFiltered();
  else if (v === 'localdetail' && state.localDetailSongs) {
    const el = $('localDetailList');
    el.innerHTML = '';
    state.localDetailSongs.forEach((s, i) => el.appendChild(songRow(s, { list: state.localDetailSongs, idx: i })));
  }
}
function batchSelectAll() {
  const b = state.batch;
  if (!b.mode) return;
  b.sel = new Set(b.list.map((s) => s.id));
  syncBatchUI();
}
async function batchPlaySelected() {
  const songs = batchSelectedSongs();
  if (!songs.length) { toast('请先选择歌曲'); return; }
  exitBatch();
  await playList(songs, 0);
}
async function batchFavSelected() {
  const songs = batchSelectedSongs();
  if (!songs.length) { toast('请先选择歌曲'); return; }
  songs.forEach((s) => { if (!isFav(s.id)) toggleFav(s); });
  exitBatch();
  toast('已收藏 ' + songs.length + ' 首');
}
function batchDlSelected() {
  const picked = batchSelectedSongs();
  if (!picked.length) { toast('请先选择歌曲'); return; }
  if (picked.some((s) => s.source === 'bilibili')) toast('B站歌曲仅支持在线播放，已跳过下载');
  const songs = picked.filter((s) => s.online && !s.demo && s.source !== 'bilibili' && DLR);
  if (!songs.length) { toast('所选歌曲无法下载（本地歌/B站歌不下载）'); return; }
  songs.forEach((s) => startDownload(s));
  exitBatch();
  toast('已加入下载：' + songs.length + ' 首');
}

/* ================= 搜索（三源 + 净化） ================= */
let searchSeq = 0;
async function doSearch() {
  if (state.batch.mode) { state.batch = { mode: false, list: [], sel: new Set() }; $('batchBar').classList.add('hidden'); }
  const q = $('searchInput').value.trim();
  if (!q) { toast('请输入关键词'); return; }
  const mySeq = ++searchSeq;
  $('searchHint').textContent = '搜索中…';
  $('searchHint').classList.remove('hidden');
  const listEl = $('searchList');
  listEl.innerHTML = '';
  showSkel(listEl, 'row', 7);
  const withTimeout = (p, ms) => Promise.race([p, new Promise((res) => setTimeout(() => res(null), ms))]);
  const want = $('searchSource') ? $('searchSource').value : 'all';
  const sources = want === 'all'
    ? ['netease', 'kugou'].filter((s) => PREF.sources[s])
    : (PREF.sources[want] ? [want] : []);
  if (!sources.length) { $('searchHint').textContent = '该音源已在设置中关闭'; return; }
  const tasks = sources.map((s) => withTimeout(leizSearch(s, q).catch(() => null), 10000));
  const results = await Promise.all(tasks);
  // 竞态守卫：期间用户已发起新搜索则丢弃本次结果
  if (mySeq !== searchSeq) return;
  const items = [];
  results.forEach((r, i) => {
    const s = sources[i];
    if (!r || !r.ok) return;
    const arr = Array.isArray(r.data) ? r.data : [];
    for (const it of arr) {
      let song;
      {
        const ref = s === 'netease'
          ? String(it.id || '')
          : String((it.shareUrl && /^https?:\/\//.test(it.shareUrl)) ? it.shareUrl : (it.hash || ''));
        if (!ref) continue;
        song = {
          id: 'online:' + s + ':' + (s === 'netease' ? it.id : it.hash),
          online: true, source: s, ref,
          title: it.name || it.song_name || '', artist: it.artists || it.author_name || '',
          album: it.album || '', duration: it.duration || 0, picUrl: it.picUrl || '',
          level: qualityToLevel(s, PREF.onlineQ)
        };
      }
      items.push(song);
    }
  });
  // 搜索净化：过滤非原版；全滤空则回退保留原结果
  const cleaned = items.filter((s) => !isNonOrig(s));
  state.searchResults = cleaned.length ? cleaned : items;
  if (!state.searchResults.length) { $('searchHint').classList.add('hidden'); emptyState(listEl, 'search', '没有找到相关歌曲，换个关键词试试'); return; }
  $('searchHint').classList.add('hidden');
  // 来源过滤胶囊复位为「全部」并显示
  const tabs = $('searchSrcTabs');
  if (tabs) {
    tabs.classList.remove('hidden');
    state.searchSrcFilter = 'all';
    tabs.querySelectorAll('.home-source-tab').forEach((x) => x.classList.toggle('active', x.dataset.sfilter === 'all'));
  }
  renderSearchList();
}

/* ================= 首页推荐歌单（占位示例数据：仅演示 UI 交互，不走网络解析） ================= */
function demoSong(id, title, artist, album) {
  return { id, demo: true, online: true, source: String(id).split(':')[1] || 'netease', ref: '', title, artist, album: album || '', duration: 0, picUrl: '' };
}
const DEMO_RECS = {
  netease: [
    { id: 'demo:pl:ne1', demo: true, source: 'netease', name: '深夜学习 · 轻钢琴', cover: '', songs: [
      demoSong('demo:ne:1', '琴键上的星光', '示例歌手', '示例专辑'), demoSong('demo:ne:2', '雨夜书页', '示例乐团', '示例专辑'), demoSong('demo:ne:3', '白噪练习曲', '示例歌手', '示例专辑')] },
    { id: 'demo:pl:ne2', demo: true, source: 'netease', name: '华语经典 · 回忆杀', cover: '', songs: [
      demoSong('demo:ne:4', '旧时光', '示例歌手', '示例专辑'), demoSong('demo:ne:5', '巷口的风', '示例乐团', '示例专辑'), demoSong('demo:ne:6', '老磁带', '示例歌手', '示例专辑')] },
    { id: 'demo:pl:ne3', demo: true, source: 'netease', name: '通勤节奏 · 电子能量', cover: '', songs: [
      demoSong('demo:ne:7', '霓虹快线', '示例歌手', '示例专辑'), demoSong('demo:ne:8', '午夜班列', '示例乐团', '示例专辑'), demoSong('demo:ne:9', '城市脉搏', '示例歌手', '示例专辑')] }
  ],
  kugou: [
    { id: 'demo:pl:kg1', demo: true, source: 'kugou', name: '粤语金曲精选', cover: '', songs: [
      demoSong('demo:kg:1', '晚风信', '示例歌手', '示例专辑'), demoSong('demo:kg:2', '天台月光', '示例乐团', '示例专辑'), demoSong('demo:kg:3', '渡口', '示例歌手', '示例专辑')] },
    { id: 'demo:pl:kg2', demo: true, source: 'kugou', name: '周末咖啡馆', cover: '', songs: [
      demoSong('demo:kg:4', '焦糖玛奇朵', '示例歌手', '示例专辑'), demoSong('demo:kg:5', '落日航班', '示例乐团', '示例专辑'), demoSong('demo:kg:6', '猫与留声机', '示例歌手', '示例专辑')] },
    { id: 'demo:pl:kg3', demo: true, source: 'kugou', name: '运动节拍', cover: '', songs: [
      demoSong('demo:kg:7', '热身循环', '示例歌手', '示例专辑'), demoSong('demo:kg:8', '冲线时刻', '示例乐团', '示例专辑'), demoSong('demo:kg:9', '深呼吸', '示例歌手', '示例专辑')] }
  ]
};
function shuffleArr(a) {
  a = a.slice();
  for (let i = a.length - 1; i > 0; i--) { const j = Math.floor(Math.random() * (i + 1)); const t = a[i]; a[i] = a[j]; a[j] = t; }
  return a;
}
function renderHomeRecs() {
  // 示例兜底先行；真实数据（网易云个性推荐/酷狗推荐歌单，均匿名可用）到达后替换
  const fill = (elId, pls) => {
    const el = $(elId);
    if (!el || el.dataset.sig) return; // 已上过真实数据就不再清回示例（防刷新闪烁+网易"刷新失效"假象）
    el.innerHTML = '';
    pls.forEach((pl) => {
      const card = document.createElement('div');
      card.className = 'opl-card';
      const cov = document.createElement('div');
      cov.className = 'cov artist-cov';
      cov.textContent = String(pl.name || '歌').slice(0, 1);
      const info = document.createElement('div');
      info.style.flex = '1';
      info.innerHTML = `<div class="name">${esc(pl.name)} <span class="demo-tag">示例</span></div><div class="meta">示例歌单 · ${(pl.songs || []).length} 首</div>`;
      card.append(cov, info);
      card.addEventListener('click', () => openOpl(pl));
      el.appendChild(card);
    });
  };
  fill('recNeteaseList', DEMO_RECS.netease);
  fill('recKugouList', DEMO_RECS.kugou);
  // 真实数据替换（双列网格封面卡）+ 点击导入打开；签名不变跳过重建，新图淡入
  const fillReal = (elId, pls, src) => {
    const el = $(elId);
    if (!el || !pls.length) return;
    const sig = src + ':' + pls.map((p) => p.id).join(',');
    if (el.dataset.sig === sig) return;
    el.dataset.sig = sig;
    el.className = 'daily-scroll';
    el.innerHTML = '';
    pls.forEach((pl) => {
      const card = document.createElement('div');
      card.className = 'daily-card';
      const img = document.createElement('img');
      img.style.opacity = '0';
      img.onload = () => { img.style.opacity = '1'; };
      img.onerror = () => { img.onerror = null; img.style.opacity = '1'; img.src = PLACEHOLDER; };
      img.src = pl.pic || PLACEHOLDER;
      const nm = document.createElement('div');
      nm.className = 'daily-card-name';
      nm.textContent = pl.name || '';
      const ar = document.createElement('div');
      ar.className = 'daily-card-artist';
      ar.textContent = '歌单';
      card.append(img, nm);
      if (ar) card.append(ar);
      card.addEventListener('click', () => importRecPlaylist(src, pl));
      el.appendChild(card);
    });
  };
  window.__recPromise = Promise.all([
    // 服务端歌单池当日基本稳定（实测两次返回相同），拉大池子随机抽 6，刷新即换批
    NE.personalizedPlaylists(30).then((r) => {
      if (r.ok) fillReal('recNeteaseList', shuffleArr(r.playlists).slice(0, 6).map((p) => ({ id: p.id, name: p.name, pic: p.picUrl })), 'netease');
    }).catch(() => {}),
    KG.recommendPlaylists(0, 1, 24).then((r) => {
      if (r.ok) fillReal('recKugouList', shuffleArr(r.playlists).slice(0, 6).map((p) => ({ id: p.gcid, name: p.name, pic: p.img })), 'kugou');
    }).catch(() => {})
  ]);
}
// 下拉刷新：内容整体橡皮筋下移，提示文字显示在下拉产生的空白中（无 spinner）
function bindPullRefresh() {
  const box = document.getElementById('pageSearch');
  const inner = document.getElementById('homeRecommend');
  const rf = document.getElementById('refresher'), rfText = document.getElementById('rfText');
  if (!box || !inner || box.dataset.pullBound) return;
  box.dataset.pullBound = '1';
  rf.style.top = inner.offsetTop + 'px'; // 提示文字落在下拉产生的空白正中
  let startY = 0, pulling = false, armed = false, refreshing = false;
  const setTf = (y, anim) => {
    inner.style.transition = anim ? 'transform .32s cubic-bezier(.22,.61,.36,1)' : 'none';
    inner.style.transform = y > 0 ? 'translateY(' + y + 'px)' : '';
    // refresher 高度=空白高度，文字垂直居中于空白内
    rf.style.transition = anim ? 'height .32s cubic-bezier(.22,.61,.36,1)' : 'none';
    rf.style.height = y + 'px';
  };
  box.addEventListener('touchstart', (e) => {
    if (box.scrollTop <= 0 && e.touches.length === 1 && !refreshing) { startY = e.touches[0].clientY; pulling = true; armed = false; }
    else pulling = false;
  }, { passive: true });
  box.addEventListener('touchmove', (e) => {
    if (!pulling) return;
    const dy = e.touches[0].clientY - startY;
    if (dy <= 0 || box.scrollTop > 0) return;
    const pull = Math.min(96, dy * 0.5);
    setTf(pull, false);
    armed = pull >= 44;
    rfText.textContent = armed ? '松开刷新' : '下拉刷新';
  }, { passive: true });
  box.addEventListener('touchend', () => {
    if (!pulling) return;
    pulling = false;
    if (armed && !refreshing) {
      refreshing = true;
      setTf(52, true);
      rfText.textContent = '正在刷新…';
      refreshHomeData().finally(() => {
        refreshing = false;
        rfText.textContent = '刷新完成';
        setTimeout(() => {
          setTf(0, true);
          setTimeout(() => { rfText.textContent = '下拉刷新'; }, 340);
        }, 420);
      });
    } else {
      setTf(0, true);
      setTimeout(() => { rfText.textContent = '下拉刷新'; }, 340);
    }
  }, { passive: true });
}
async function refreshHomeData() {
  updateHomeCards(); // 猜你喜欢卡重抽
  renderHomeRecs();
  await loadDaily();
  await Promise.race([window.__recPromise || Promise.resolve(), new Promise((r) => setTimeout(r, 8000))]);
}

// 推荐歌单点击：导入并打开详情
async function importRecPlaylist(src, pl) {
  toast('正在导入推荐歌单…');
  if (src === 'kugou') {
    const songs = await KG.collectAllSongs(pl.id).catch(() => []);
    if (!songs.length) { toast('歌单拉取失败'); return; }
    const mapped = songs.map((s) => ({
      id: 'online:kugou:' + s.hash, online: true, source: 'kugou', ref: s.hash,
      title: s.name || '', artist: s.singername || '', album: s.album || '',
      duration: s.duration || 0, picUrl: s.pic || '', level: normQuality(PREF.onlineQ) || 'high'
    }));
    const kept = cleanImportedSongs(mapped);
    const plObj = { id: 'kg:' + pl.id, name: pl.name || '酷狗歌单', source: 'kugou', cover: pl.pic || '', songs: kept };
    const dup = state.onlinePlaylists.findIndex((x) => x.id === plObj.id);
    if (dup >= 0) state.onlinePlaylists.splice(dup, 1);
    state.onlinePlaylists.unshift(plObj);
    saveOpls();
    openOpl(plObj);
    return;
  }
  const r = await importPlaylist('netease', pl.id);
  if (!r.ok) { toast(r.reason || '歌单导入失败'); return; }
  r.pl.songs = cleanImportedSongs(r.pl.songs);
  const dup = state.onlinePlaylists.findIndex((x) => x.id === r.pl.id);
  if (dup >= 0) state.onlinePlaylists.splice(dup, 1);
  state.onlinePlaylists.unshift(r.pl);
  saveOpls();
  openOpl(r.pl);
}

/* ================= 歌单 ================= */
function renderOpls() {
  // 最近听过（最近打开的歌单，首页上限 10，超出走"更多"）
  const rl = $('oplRecentList');
  const recent = state.recentPls || [];
  if (rl) {
    rl.innerHTML = '';
    recent.slice(0, 300).forEach((it) => rl.appendChild(recentPlCard(it)));
    const re = $('oplRecentEmpty'); if (re) re.classList.toggle('hidden', recent.length > 0);
  }
  const rmore = document.querySelector('#pageOpls .pl-more[data-plcat=recentPl]'); if (rmore) rmore.classList.toggle('hidden', recent.length <= 300);
  // 临时歌单 = 未收藏的在线歌单（首页上限 10）
  const tl = $('oplTempList');
  const temp = (state.onlinePlaylists || []).filter((p) => !p.fav);
  if (tl) {
    tl.innerHTML = '';
    temp.slice(0, 10).forEach((pl) => tl.appendChild(oplCard(pl, false)));
    const te = $('oplTempEmpty'); if (te) te.classList.toggle('hidden', temp.length > 0);
  }
  const tmore = document.querySelector('#pageOpls .pl-more[data-plcat=tempPl]'); if (tmore) tmore.classList.toggle('hidden', temp.length <= 10);
  refreshStats();
}
// 最近听过卡（供歌单页分区与"更多"完整页复用）
function recentPlCard(it) {
  const card = document.createElement('div');
  card.className = 'opl-card';
  let cov;
  if (it.cover) { cov = document.createElement('img'); cov.className = 'cov'; cov.src = it.cover; cov.onerror = () => { cov.src = PLACEHOLDER; }; }
  else { cov = document.createElement('div'); cov.className = 'cov artist-cov'; cov.textContent = String(it.name || '歌').slice(0, 1); }
  const info = document.createElement('div');
  info.style.flex = '1';
  info.innerHTML = `<div class="name">${esc(it.name)}</div><div class="meta">${esc(SRC_NAMES[it.source] || it.source || '')} · ${timeAgo(it.at)}</div>`;
  card.append(cov, info);
  card.addEventListener('click', () => {
    if (it.id === 'n:daily') { openDailyPlaylist(); return; }
    const pl = state.onlinePlaylists.find((x) => x.id === it.id) || state.mylists.find((x) => x.id === it.id);
    if (!pl) { toast('歌单已被移除'); state.recentPls = (state.recentPls || []).filter((x) => x.id !== it.id); LS.save('recpls', state.recentPls); renderOpls(); if (state.view === 'plcat') openPlCategory(state.plCat); return; }
    if (pl.songs) openOpl(pl); else openMylist(pl.id);
  });
  return card;
}

function openOpl(pl, keepFilter) {
  recordRecentPl(pl);
  state.currentPl = pl;
  state.list = pl.songs;
  if (!keepFilter) { resetDetailFilter('oplDetailFilter'); resetDFilter(); }
  if (state.view !== 'opldetail') state.plFrom = state.view; // 返回键回来源页（首页/歌单页/最近听过）
  setView('opldetail', { title: pl.name });
  state.plSort = '';
  const songs = pl.songs || [];
  const heroCov = pl.cover || (songs[0] && songs[0].picUrl) || PLACEHOLDER;
  $('topBar').style.setProperty('--hero-img', 'url("' + String(heroCov).replace(/"/g, '') + '")');
  const canFav = !pl.demo && pl.id !== 'n:daily';
  const orderLabel = () => (state.mode === 'shuffle' ? '随机' : '顺序');
  const orderHtml = () => icon(state.mode === 'shuffle' ? 'modeShuffle' : 'modeOrder', 16);
  const favHtml = () => icon(pl.fav ? 'heartFill' : 'heart', 16);
  $('oplDetailHead').innerHTML = `<div class="pl-hero"><img class="pl-hero-bg" src="${esc(heroCov)}" alt="" aria-hidden="true"><div class="pl-hero-covwrap"><img class="pl-hero-glow" src="${esc(heroCov)}" alt="" aria-hidden="true"><img class="pl-hero-cov" src="${esc(heroCov)}" alt=""></div><div class="pl-hero-info"><div class="pl-hero-name">${esc(pl.name)}</div><div class="pl-hero-meta">${esc(SRC_NAMES[pl.source] || (pl.demo ? '示例' : '本地'))} · ${songs.length} 首</div>${pl.desc ? `<div class="pl-hero-desc">${esc(pl.desc.replace(/\s+/g, ' ').slice(0, 42))}</div>` : ''}<div class="pl-hero-acts"><button class="pl-play-pill" id="plHeroPlay">${icon('play', 13)} 播放全部</button>${canFav ? `<button class="pl-ghost-pill${pl.fav ? ' on' : ''}" id="plHeroFav">${favHtml()}</button>` : ''}<button class="pl-ghost-pill" id="plHeroOrder">${orderHtml()}</button></div></div></div><div class="pl-subbar"><span class="pl-count">${songs.length}首歌曲</span><div class="pl-sub-acts">
    <button class="icon-btn" id="plBatchBtn" title="多选">${icon('multiSelect', 19)}</button>
    <button class="icon-btn" id="plAddAllBtn" title="加入播放队列">${icon('queue', 19)}</button>
    <button class="icon-btn" id="plSortBtn" title="排序">${icon('sortV', 19)}</button>
    <button class="icon-btn" id="plViewBtn" title="视图">${icon(gridMode ? 'list' : 'grid', 19)}</button>
  </div></div>`;
  const hcv = $('oplDetailHead').querySelector('.pl-hero-cov');
  if (hcv) hcv.onerror = () => { hcv.src = PLACEHOLDER; };
  $('plHeroPlay').addEventListener('click', () => {
    if (pl.demo) { toast('示例歌单·仅演示，暂不可播放'); return; }
    if (!songs.length) { toast('歌单是空的'); return; }
    playList(songs, 0);
  });
  const favPill = $('plHeroFav');
  if (favPill) favPill.addEventListener('click', () => {
    const isOnline = /^(n:|kg:|b:|q:)/.test(pl.id || '');
    if (isOnline) {
      pl.fav = !pl.fav; saveOpls(); renderMylists(); renderOpls();
      favPill.innerHTML = favHtml(); favPill.classList.toggle('on', !!pl.fav);
      toast(pl.fav ? '已收藏到「我的歌单」' : '已取消收藏');
    } else favPlaylist(pl);
  });
  $('plHeroOrder').addEventListener('click', () => {
    state.mode = state.mode === 'shuffle' ? 'order' : 'shuffle';
    LS.save('mode', state.mode);
    if (state.mode === 'shuffle' && state.queue.length) rebuildShuffle();
    const pm = $('ppMode'); if (pm) pm.innerHTML = icon(state.mode === 'shuffle' ? 'modeShuffle' : state.mode === 'repeat' ? 'modeRepeat' : 'modeOrder', 22);
    $('plHeroOrder').innerHTML = orderHtml();
    toast('播放顺序：' + orderLabel());
  });
  $('plBatchBtn').addEventListener('click', () => enterBatch(pl.songs));
  $('plAddAllBtn').addEventListener('click', () => {
    if (pl.demo) { toast('示例歌单·仅演示'); return; }
    const list = pl.songs || [];
    if (!list.length) { toast('歌单是空的'); return; }
    list.forEach((sg) => queueAppend(sg));
    if (typeof updateQueueUI === 'function') updateQueueUI();
    toast('已加入 ' + list.length + ' 首到播放队列');
  });
  $('plSortBtn').addEventListener('click', () => openPlSortSheet(pl));
  $('plViewBtn').addEventListener('click', () => {
    gridMode = gridMode ? 0 : 1;
    LS.save('grid', gridMode);
    openOpl(pl, true);
  });
  // 顶栏动作：搜索 / 更多
  $('topActions').innerHTML = `<button class="icon-btn" id="tbSearch" title="搜索">${icon('search', 20)}</button><button class="icon-btn" id="tbMore" title="更多">${icon('dotsV', 20)}</button>`;
  const flt = $('oplDetailFilter');
  if (flt) { flt.classList.add('hidden'); flt.value = ''; }
  $('tbSearch').addEventListener('click', () => { const f = $('oplDetailFilter'); f.classList.toggle('hidden'); if (!f.classList.contains('hidden')) f.focus(); });
  $('tbMore').addEventListener('click', () => openOplMoreSheet(pl));
  fillFiltered($('oplDetailList'), pl.songs || [], { plDetail: true });
}
// —— 歌单详情页规格菜单组 ——
let songMoreTarget = null;
let songMoreOpts = null;
function openSongMore(song, opts) {
  songMoreTarget = song; songMoreOpts = opts || {};
  const box = $('songMoreItems');
  if (!box) return;
  box.innerHTML = '';
  const mk = (label, fn) => { const b = document.createElement('button'); b.className = 'sheet-item'; b.innerHTML = label; b.addEventListener('click', () => { $('songMoreSheet').classList.add('hidden'); fn(); }); box.appendChild(b); };
  mk(icon('play', 16) + '下一首播放', () => queuePlayNext(song));
  mk((isFav(song.id) ? icon('heartFill', 16) : icon('heart', 16)) + (isFav(song.id) ? '取消收藏' : '收藏'), () => { toggleFav(song); rerenderCurrentDetail(); });
  if (song.online && DLR && song.source !== 'bilibili') mk(icon('download', 16) + '下载', () => startDownload(song));
  const lists = (state.mylists || []).filter((m) => m && m.name);
  if (lists.length && !song.local) {
    lists.slice(0, 6).forEach((m) => mk(icon('plus', 16) + '加入「' + esc(m.name) + '」', () => {
      if ((m.songIds || []).indexOf(song.id) >= 0) { toast('已在该歌单中'); return; }
      m.songIds = m.songIds || []; m.songIds.push(song.id); saveMylists(); toast('已加入 ' + m.name);
    }));
  }
  if (songMoreOpts.withRemove) mk(icon('close', 16) + '从歌单移除', () => { removeFromMylist(songMoreOpts.withRemove, song); toast('已从歌单移除'); });
  $('songMoreSheet').classList.remove('hidden');
}
function openPlSortSheet(pl) {
  const box = $('plSortItems');
  if (!box) return;
  box.innerHTML = '';
  const mk = (label, key) => { const b = document.createElement('button'); b.className = 'sheet-item' + ((state.plSort || '') === key ? ' active' : ''); b.textContent = label; b.addEventListener('click', () => { state.plSort = key; $('plSortSheet').classList.add('hidden'); rerenderCurrentDetail(); }); box.appendChild(b); };
  mk('默认顺序', '');
  mk('按歌名', 'name');
  mk('按歌手', 'artist');
  mk('按时长', 'dur');
  $('plSortSheet').classList.remove('hidden');
}
function openOplMoreSheet(pl) {
  const box = $('oplMoreItems');
  if (!box) return;
  box.innerHTML = '';
  const mk = (label, fn) => { const b = document.createElement('button'); b.className = 'sheet-item'; b.innerHTML = label; b.addEventListener('click', () => { $('oplMoreSheet').classList.add('hidden'); fn(); }); box.appendChild(b); };
  const songs = pl.songs || [];
  mk(icon('queue', 16) + '添加到播放队列', () => {
    if (pl.demo) { toast('示例歌单·仅演示'); return; }
    if (!songs.length) { toast('歌单是空的'); return; }
    songs.forEach((s) => queueAppend(s));
    if (typeof updateQueueUI === 'function') updateQueueUI();
    toast('已添加 ' + songs.length + ' 首到播放队列');
  });
  const isSys = /^sys:/.test(pl.id || '');
  const isOnline = /^(n:|kg:|b:|q:)/.test(pl.id || '');
  if (!pl.demo && !isSys) mk(icon('edit', 16) + '重命名歌单', () => openPlRename(pl));
  mk(icon('download', 16) + '一键下载全部', () => { if (pl.demo) { toast('示例歌单·仅演示，暂不可播放'); return; } batchDownload(songs); });
  if (!isSys) mk(icon(pl.fav ? 'heartFill' : 'heart', 16) + (pl.fav ? '取消收藏歌单' : '收藏歌单'), () => {
    if (isOnline) { pl.fav = !pl.fav; saveOpls(); renderMylists(); renderOpls(); toast(pl.fav ? '已收藏到「我的歌单」' : '已取消收藏'); }
    else favPlaylist(pl);
  });
  if (isOnline) mk(icon('trash', 16) + '移除歌单', () => {
    state.onlinePlaylists = state.onlinePlaylists.filter((x) => x.id !== pl.id);
    addTombstone('pl:' + pl.id);
    saveOpls();
    state.recentPls = (state.recentPls || []).filter((x) => x.id !== pl.id);
    LS.save('recpls', state.recentPls);
    renderOpls();
    toast('已移除歌单');
    backFromDetail();
  });
  mk(icon('filter', 16) + '筛选', () => openFilterPopup());
  $('oplMoreSheet').classList.remove('hidden');
}
// 重命名在线歌单（复用新建/重命名弹层，renameopl 模式）
function openPlRename(pl) {
  $('mylistOvTitle').textContent = '重命名歌单';
  $('mylistOvInput').value = pl.name || '';
  $('mylistOvInput').placeholder = '歌单名称';
  mylistOvMode = 'renameopl'; mylistOvTarget = pl;
  $('mylistOverlay').classList.remove('hidden');
  $('mylistOvInput').focus();
}
// 收藏歌单：网易云原单走订阅接口；其他来源存为本地歌单（对象引用，不复制数据）
async function favPlaylist(pl) {
  if (pl.demo) { toast('示例歌单·仅演示'); return; }
  if (pl.source === 'netease' && /^n:\d+$/.test(pl.id || '')) {
    const r = await NE.subscribePlaylist(pl.id.slice(2)).catch(() => ({ ok: false }));
    toast(r.ok ? '已收藏到网易云歌单' : '收藏失败' + (r && r.code ? '（' + r.code + '）' : ''));
    return;
  }
  let name = pl.name || '收藏的歌单';
  if (state.mylists.some((m) => m.name === name)) name += ' (2)';
  const ml = { id: 'ml' + Date.now(), name, songIds: (pl.songs || []).slice() };
  state.mylists.push(ml); saveMylists(); renderMylists();
  toast('已收藏到「我的歌单」：' + name);
}
function backFromDetail() {
  if (state.view === 'localdetail') { setView('local'); return; }
  if (state.view === 'recentpls') { setView('search'); return; }
  if (state.view === 'plcat') { setView('opls'); return; }
  if (state.view === 'settings') { setView(state.settingsFrom || 'me'); return; }
  if (state.view === 'settingsub') { setView('settings'); return; }
  if (state.view === 'opldetail') {
    const from = state.plFrom;
    if (from === 'search') { setView('search'); return; }
    if (from === 'recentpls') { openRecentPls(); return; }
    if (from === 'plcat') { openPlCategory(state.plCat); return; }
  }
  setView('opls');
}

// 导入净化（对齐 PC「导入自动适配原版」）：剔除带非原版标记的歌；全滤空回退原列表
function cleanImportedSongs(songs) {
  const arr = (songs || []).filter(Boolean);
  const cleaned = arr.filter((s) => !isNonOrig(s));
  return cleaned.length ? cleaned : arr;
}

// B站预热：导入后后台合成前几首（照 PC：节流 1.5s，失败即停不轰炸上游）
function biliWarm(bvids) {
  (async () => {
    for (const bvid of (bvids || [])) {
      if (!/^BV[0-9A-Za-z]{8,12}$/.test(String(bvid || ''))) continue;
      const r = await biliResolve(bvid).catch(() => ({ ok: false }));
      if (!r.ok) break;
      await new Promise((res) => setTimeout(res, 1500));
    }
  })();
}

/* ================= 网易云账号（扫码登录+每日推荐+收藏夹导入，对齐 PC acc 链路） ================= */
let loginPollTimer = null;
function refreshAccountUI() {
  const anyAcc = NE.loggedIn() || KG.loggedIn() || biliGetAcc();
  const qs = $('qkAccSub'); if (qs) qs.textContent = anyAcc ? '已登录' : '未登录';
  const sa = $('sumAcc'); if (sa) sa.textContent = anyAcc ? '已登录' : '未登录';
  const name = $('accNeteaseName'), btn = $('accNeteaseBtn'), imp = $('accNeteaseImport');
  if (!name || !btn) return;
  const st = NE.getState();
  if (NE.loggedIn()) {
    name.textContent = st.account || '已登录';
    btn.textContent = '退出';
    if (imp) { imp.classList.remove('hidden'); imp.textContent = '一键导入'; }
  } else {
    name.textContent = '未登录';
    btn.textContent = '登录';
    if (imp) imp.classList.add('hidden');
  }
}
function stopLoginPoll() { if (loginPollTimer) { clearInterval(loginPollTimer); loginPollTimer = null; } }
async function openNeteaseLogin() {
  const ov = $('loginOverlay'), box = $('loginQrBox'), tip = $('loginTip');
  if (!ov || !box || !tip) return;
  state.loginPlat = 'netease';
  const tt = $('loginTitle');
  if (tt) tt.textContent = '网易云扫码登录';
  ov.classList.remove('hidden');
  box.innerHTML = '';
  tip.textContent = '正在获取二维码…';
  stopLoginPoll();
  const anon = await NE.anonimous();
  // 匿名会话失败不阻塞（照 PC：部分环境返回 400，二维码流程不依赖它）
  const q = await NE.qrCreate();
  if (!q.ok || !q.qrurl) { tip.textContent = '二维码获取失败' + (q.msg ? '（' + q.msg + '）' : ''); return; }
  box.innerHTML = '';
  // eslint-disable-next-line no-new
  new QRCode(box, { text: q.qrurl, width: 180, height: 180, correctLevel: QRCode.CorrectLevel.M });
  tip.textContent = '请用网易云音乐 App 扫码';
  let created = Date.now();
  const poll = async () => {
    const r = await NE.qrCheck(q.unikey);
    if (r.ok && r.code === 803) {
      stopLoginPoll();
      tip.textContent = '登录成功';
      const info = await NE.accountInfo();
      if (info.ok) NE.setState(Object.assign(NE.getState(), { account: info.nickname, avatar: info.avatar, uid: info.uid }));
      refreshAccountUI();
      toast('网易云登录成功：' + (NE.getState().account || ''));
      ov.classList.add('hidden');
      loadDaily();
      return;
    }
    if (r.code === 802) tip.textContent = '已扫描，请在手机上确认';
    else if (r.code === 800) {
      // 过期自动换码（对齐 PC 85s）
      if (Date.now() - created > 85000) {
        stopLoginPoll();
        openNeteaseLogin();
        return;
      }
      tip.textContent = '二维码已过期';
    } else tip.textContent = '请用网易云音乐 App 扫码';
  };
  loginPollTimer = setInterval(poll, 2500);
}

// ---------- B站扫码登录 + 我的收藏夹导入（passport qrcode generate/poll） ----------
function refreshBiliUI() {
  const name = $('accBiliName'), btn = $('accBiliBtn'), imp = $('accBiliImport');
  if (!name || !btn) return;
  const acc = biliGetAcc();
  if (acc && acc.cookie) {
    name.textContent = acc.uname || ('UID ' + acc.mid);
    btn.textContent = '退出';
    if (imp) { imp.classList.remove('hidden'); imp.textContent = '一键导入'; }
  } else {
    name.textContent = '未登录';
    btn.textContent = '登录';
    if (imp) imp.classList.add('hidden');
  }
}
async function openBiliLogin() {
  const ov = $('loginOverlay'), box = $('loginQrBox'), tip = $('loginTip');
  if (!ov || !box || !tip) return;
  state.loginPlat = 'bili';
  const tt = $('loginTitle');
  if (tt) tt.textContent = 'B站扫码登录';
  ov.classList.remove('hidden');
  box.innerHTML = '';
  tip.textContent = '正在获取二维码…';
  stopLoginPoll();
  const q = await biliQrCreate();
  if (!q.ok) { tip.textContent = '二维码获取失败（' + (q.reason || '') + '）'; return; }
  box.innerHTML = '';
  new QRCode(box, { text: q.url, width: 180, height: 180, correctLevel: QRCode.CorrectLevel.M });
  tip.textContent = '请用哔哩哔哩 App 扫码';
  const created = Date.now();
  window.__bpLog = ['qr key=' + q.qrcodeKey];
  const poll = async () => {
    const r = await biliQrPoll(q.qrcodeKey);
    window.__bpLog.push('code=' + (r.code != null ? r.code : r.ok ? 0 : '?') + ' ok=' + r.ok + (r.cookie ? ' cookie=yes' : ''));
    if (r.ok) {
      stopLoginPoll();
      window.__bpLog.push('success-enter');
      biliSetAcc({ cookie: r.cookie, mid: r.mid, uname: '' }); // 先存登录态（nav 需要读 cookie）
      // poll 接口不返回昵称 → nav 补全（5s 兜底防挂起，拿不到昵称就显示 UID）
      const nav = await Promise.race([
        biliNav().catch(() => ({ ok: false })),
        new Promise((res) => setTimeout(() => res({ ok: false }), 5000))
      ]);
      window.__bpLog.push('nav=' + (nav.ok ? 'ok:' + (nav.uname || '') : 'fail'));
      biliSetAcc({ cookie: r.cookie, mid: nav.ok ? nav.mid : r.mid, uname: nav.ok ? nav.uname : '' });
      window.__bpLog.push('setacc-done');
      refreshBiliUI();
      toast('B站登录成功' + (nav.ok && nav.uname ? '：' + nav.uname : ''));
      ov.classList.add('hidden');
      return;
    }
    if (r.code === 86090) tip.textContent = '已扫描，请在手机上确认';
    else if (r.code === 86038 || Date.now() - created > 180000) { stopLoginPoll(); openBiliLogin(); return; }
    else tip.textContent = '请用哔哩哔哩 App 扫码';
  };
  loginPollTimer = setInterval(poll, 2000);
}
// 通用挑选导入弹层（对齐 PC：列出歌单让用户勾选，确认后导入）
function openPickOverlay(title, items, onConfirm) {
  const ov = $('pickOverlay'), list = $('pickList'), tt = $('pickTitle'), ok = $('pickOk');
  if (!ov || !list) { onConfirm(items); return; }
  tt.textContent = title;
  list.innerHTML = '';
  const CHK = '<svg viewBox="0 0 24 24" width="16" height="16"><path d="M5 12.5l4.5 4.5L19 7.5" fill="none" stroke="currentColor" stroke-width="2.6" stroke-linecap="round" stroke-linejoin="round"/></svg>';
  const updateFoot = () => {
    const n = list.querySelectorAll('.pick-row.on').length;
    if (ok) ok.textContent = n ? `导入选中（${n}）` : '导入选中';
    const allBtn = $('pickAll'); if (allBtn) allBtn.textContent = n === items.length && n ? '取消全选' : '全选';
  };
  items.forEach((it) => {
    const row = document.createElement('div');
    row.className = 'pick-row on';
    row.dataset.pid = it.id;
    const cov = document.createElement('div');
    cov.className = 'pick-cov';
    if (it.cover) { const im = document.createElement('img'); im.src = it.cover; im.onerror = () => im.remove(); cov.appendChild(im); }
    else cov.textContent = String(it.name || '歌').slice(0, 1);
    const info = document.createElement('div');
    info.className = 'pick-info';
    info.innerHTML = `<div class="pick-name">${esc(it.name || '')}</div><div class="pick-count">${it.count != null ? it.count + ' 首' : ''}</div>`;
    const ck = document.createElement('span'); ck.className = 'pick-check'; ck.innerHTML = CHK;
    row.append(cov, info, ck);
    row.addEventListener('click', () => { row.classList.toggle('on'); updateFoot(); });
    list.appendChild(row);
  });
  const all = $('pickAll');
  if (all) all.onclick = () => {
    const on = list.querySelectorAll('.pick-row.on').length;
    list.querySelectorAll('.pick-row').forEach((r) => r.classList.toggle('on', on !== items.length));
    updateFoot();
  };
  const cancel = $('pickCancel');
  const close = () => ov.classList.add('hidden');
  if (cancel) cancel.onclick = close;
  if (ok) ok.onclick = () => {
    const picked = [...list.querySelectorAll('.pick-row.on')].map((r) => items.find((it) => String(it.id) === r.dataset.pid)).filter(Boolean);
    close();
    if (!picked.length) { toast('未选择任何歌单'); return; }
    onConfirm(picked);
  };
  updateFoot();
  ov.classList.remove('hidden');
}

async function importMyBiliFavs() {
  if (!biliGetAcc()) { toast('请先登录B站账号'); return; }
  toast('正在获取我的收藏夹…');
  const r = await biliMyFavs();
  if (!r.ok) { toast(r.reason || '收藏夹列表获取失败'); return; }
  if (!r.list.length) { toast('没有含视频的收藏夹'); return; }
  openPickOverlay('选择要导入的B站收藏夹', r.list.map((f) => ({ id: f.fid, name: f.title, count: f.count, cover: f.cover })), async (picked) => {
    let done = 0;
    for (const f of picked) {
      toast(`导入收藏夹 ${done + 1}/${picked.length}：${f.name.slice(0, 14)}…`);
      const fr = await biliFavlist(f.id).catch(() => ({ ok: false }));
      if (!fr.ok || !fr.data.songs.length) continue;
      const songs = fr.data.songs.map((x) => ({
        id: 'online:bilibili:' + x.ref, online: true, source: 'bilibili', ref: x.ref,
        title: x.title || '', artist: x.artist || '', album: '', duration: x.duration || 0,
        picUrl: x.picUrl || '', level: 'standard'
      }));
      const kept = cleanImportedSongs(songs);
      const pl = { id: 'b:' + f.id, name: f.name ? `${f.name}（${kept.length} 首）` : `B站收藏夹（${kept.length} 首）`, source: 'bilibili', cover: fr.data.cover || '', songs: kept };
      const dup = state.onlinePlaylists.findIndex((x) => x.id === pl.id);
      if (dup >= 0) state.onlinePlaylists.splice(dup, 1);
      state.onlinePlaylists.unshift(pl);
      saveOpls();
      done++;
      await new Promise((res) => setTimeout(res, 800)); // 对上游礼貌节流
    }
    renderOpls();
    toast(`导入完成：${done} 个收藏夹`);
  });
}

// ---------- 酷狗扫码登录 + 自建歌单导入（v2/qrcode web 签名） ----------
function refreshKgUI() {
  const name = $('accKgName'), btn = $('accKgBtn'), imp = $('accKgImport');
  if (!name || !btn) return;
  const st = KG.getState();
  if (KG.loggedIn()) {
    name.textContent = st.account || ('UID ' + st.userid);
    btn.textContent = '退出';
    if (imp) { imp.classList.remove('hidden'); imp.textContent = '一键导入'; }
  } else {
    name.textContent = '未登录';
    btn.textContent = '登录';
    if (imp) imp.classList.add('hidden');
  }
}
async function openKgLogin() {
  const ov = $('loginOverlay'), box = $('loginQrBox'), tip = $('loginTip');
  if (!ov || !box || !tip) return;
  state.loginPlat = 'kugou';
  const tt = $('loginTitle');
  if (tt) tt.textContent = '酷狗扫码登录';
  ov.classList.remove('hidden');
  box.innerHTML = '';
  tip.textContent = '正在获取二维码…';
  stopLoginPoll();
  const q = await KG.qrCreate();
  if (!q.ok) { tip.textContent = '二维码获取失败'; return; }
  box.innerHTML = '';
  new QRCode(box, { text: q.qrurl, width: 180, height: 180, correctLevel: QRCode.CorrectLevel.M });
  tip.textContent = '请用酷狗音乐 App 扫码';
  const created = Date.now();
  const poll = async () => {
    const r = await KG.qrCheck(q.key);
    if (r.ok) {
      stopLoginPoll();
      refreshKgUI();
      toast('酷狗登录成功' + (r.nickname ? '：' + r.nickname : ''));
      ov.classList.add('hidden');
      return;
    }
    if (r.status === 2) tip.textContent = '已扫描，请在手机上确认';
    else if (r.status === 0 || Date.now() - created > 120000) { stopLoginPoll(); openKgLogin(); return; }
    else tip.textContent = '请用酷狗音乐 App 扫码';
  };
  loginPollTimer = setInterval(poll, 2500);
}
async function importMyKgPlaylists() {
  if (!KG.loggedIn()) { toast('请先登录酷狗账号'); return; }
  toast('正在获取我的歌单…');
  const mine = await KG.myPlaylists();
  if (!mine.ok) { toast(mine.reason || '歌单列表获取失败'); return; }
  if (!mine.playlists.length) { toast('账号下没有歌单'); return; }
  openPickOverlay('选择要导入的酷狗歌单', mine.playlists.map((p) => ({ id: p.id, name: p.name, count: p.trackCount, cover: p.picUrl })), async (picked) => {
    let done = 0;
    for (const p of picked) {
      toast(`导入歌单 ${done + 1}/${picked.length}：${(p.name || '').slice(0, 14)}…`);
      const songs = await KG.collectAllSongs(p.id).catch(() => []);
      if (!songs.length) continue;
      const mapped = songs.map((s) => ({
        id: 'online:kugou:' + s.hash, online: true, source: 'kugou', ref: s.hash,
        title: s.name || '', artist: s.singername || '', album: s.album || '',
        duration: s.duration || 0, picUrl: '', level: 'standard'
      }));
      const kept = cleanImportedSongs(mapped);
      const pl = { id: 'kg:' + p.id, name: p.name || '酷狗歌单', source: 'kugou', cover: p.picUrl || '', songs: kept };
      const dup = state.onlinePlaylists.findIndex((x) => x.id === pl.id);
      if (dup >= 0) state.onlinePlaylists.splice(dup, 1);
      state.onlinePlaylists.push(pl);
      saveOpls();
      done++;
      await new Promise((res) => setTimeout(res, 800));
    }
    renderOpls();
    toast(`导入完成：${done} 个歌单`);
  });
}
async function importMyPlaylists() {
  if (!NE.loggedIn()) { toast('请先登录网易云账号'); return; }
  toast('正在获取我的歌单…');
  const uid = NE.getState().uid;
  const mine = await NE.myPlaylists(uid);
  if (!mine.ok) { toast('歌单列表获取失败（' + (mine.code || '') + '）'); return; }
  const lists = mine.playlists.filter((p) => p.id && p.trackCount > 0);
  if (!lists.length) { toast('账号下没有歌单'); return; }
  openPickOverlay('选择要导入的网易云歌单', lists.map((p) => ({ id: p.id, name: p.name, count: p.trackCount, cover: p.picUrl })), async (picked) => {
    let done = 0;
    for (const p of picked) {
      toast(`导入歌单 ${done + 1}/${picked.length}：${(p.name || '').slice(0, 14)}…`);
      const r = await NE.playlistSongsAll(p.id).catch(() => ({ ok: false }));
      if (!r.ok || !r.songs.length) continue;
      const songs = r.songs.map((s) => ({
        id: 'online:netease:' + s.id, online: true, source: 'netease', ref: s.id,
        title: s.name || '', artist: s.artist || '', album: s.album || '',
        duration: s.duration || 0, picUrl: s.picUrl || '', level: 'standard'
      }));
      const kept = cleanImportedSongs(songs);
      const pl = { id: 'n:' + p.id, name: p.name || '网易云歌单', source: 'netease', cover: p.picUrl || '', songs: kept };
      const dup = state.onlinePlaylists.findIndex((x) => x.id === pl.id);
      if (dup >= 0) state.onlinePlaylists.splice(dup, 1);
      state.onlinePlaylists.push(pl);
      saveOpls();
      done++;
    }
    renderOpls();
    toast(`导入完成：${done} 个歌单`);
  });
}

// 每日推荐（登录后真实数据）：顶部卡片进入"每日推荐"歌单页
let dailySongs = [];
function dailyPlaylist() {
  return { id: 'n:daily', name: '每日推荐', source: 'netease', cover: (dailySongs[0] || {}).picUrl || '', songs: dailySongs.slice(0, 30) };
}
function openDailyPlaylist() {
  if (!NE.loggedIn()) { toast('登录网易云账号后解锁每日推荐'); return; }
  if (!dailySongs.length) { toast('每日推荐获取中，稍后再试'); loadDaily(); return; }
  openOpl(dailyPlaylist());
}
function renderDaily() {
  const sub = $('cardDailySub');
  if (sub) sub.textContent = NE.loggedIn() && dailySongs.length ? `为你精选 ${dailySongs.length} 首` : '登录后解锁个性化';
  cardCovers('cardDaily', dailySongs.slice(0, 4));
}
// 最近听过：最近打开过的歌单列表（上限 10，含每日推荐/网易云/酷狗推荐歌单）
function timeAgo(ts) {
  const d = Date.now() - ts;
  if (d < 3600e3) return Math.max(1, Math.round(d / 60e3)) + ' 分钟前';
  if (d < 86400e3) return Math.round(d / 3600e3) + ' 小时前';
  return Math.round(d / 86400e3) + ' 天前';
}
function recordRecentPl(pl) {
  if (!pl || pl.demo || /^sys:/.test(pl.id || '')) return;
  const item = { id: pl.id, name: pl.name || '歌单', source: pl.source || '', cover: pl.cover || ((pl.songs || [])[0] || {}).picUrl || '', at: Date.now() };
  state.recentPls = (state.recentPls || []).filter((x) => x.id !== item.id);
  state.recentPls.unshift(item);
  state.recentPls = state.recentPls.slice(0, 300);
  LS.save('recpls', state.recentPls);
}
function openRecentPls() {
  const list = state.recentPls || [];
  if (!list.length) { toast('还没有打开过的歌单'); return; }
  const box = $('recentPlList');
  if (!box) return;
  box.innerHTML = '';
  list.forEach((it) => {
    const row = document.createElement('div');
    row.className = 'opl-card';
    let cov;
    if (it.cover) { cov = document.createElement('img'); cov.className = 'cov'; cov.src = it.cover; cov.onerror = () => { cov.src = PLACEHOLDER; }; }
    else { cov = document.createElement('div'); cov.className = 'cov artist-cov'; cov.textContent = String(it.name).slice(0, 1); }
    const info = document.createElement('div');
    info.style.flex = '1';
    info.innerHTML = `<div class="name">${esc(it.name)}</div><div class="meta">${esc(SRC_NAMES[it.source] || it.source || '')} · ${timeAgo(it.at)}</div>`;
    row.append(cov, info);
    row.addEventListener('click', () => {
      if (it.id === 'n:daily') { openDailyPlaylist(); return; }
      const pl = state.onlinePlaylists.find((x) => x.id === it.id) || state.mylists.find((x) => x.id === it.id);
      if (!pl) { toast('歌单已被移除'); state.recentPls = state.recentPls.filter((x) => x.id !== it.id); LS.save('recpls', state.recentPls); return; }
      if (pl.songs) openOpl(pl); else openMylistDetail(pl);
    });
    box.appendChild(row);
  });
  setView('recentpls');
}
async function loadDaily() {
  if (!NE.loggedIn()) { renderDaily(); return; }
  const r = await NE.recommendSongs().catch(() => ({ ok: false }));
  if (r.ok && r.songs.length) {
    dailySongs = r.songs.map((s) => ({
      id: 'online:netease:' + s.id, online: true, source: 'netease', ref: s.id,
      title: s.name || '', artist: s.artist || '', album: s.album || '',
      duration: s.duration || 0, picUrl: s.picUrl || '', level: 'standard'
    }));
  } else dailySongs = [];
  renderDaily();
}

async function doImport(raw) {
  const s = String(raw || '').trim();
  if (!s) { toast('请输入歌单链接或 ID'); return; }
  // B站收藏夹（对齐 PC 一期：仅公开收藏夹导入 + 在线播放，不可搜索/下载/无歌词）。
  // 仅识别 bilibili 链接（纯数字不做 B站处理——网易云歌单 ID 同为纯数字，防误伤）
  const biliFid = s.match(/fid=(\d{4,})/);
  if (/bilibili\.com/i.test(s) || biliFid) {
    const fid = biliFid ? biliFid[1] : (s.trim().match(/^(\d{4,})$/) || [])[1];
    if (!fid) { toast('无法识别收藏夹（请粘贴 space.bilibili.com 的 favlist 链接）'); return; }
    toast('正在导入 B站收藏夹…');
    const r = await biliFavlist(fid);
    if (!r.ok) { toast(r.reason || 'B站收藏夹导入失败'); return; }
    const songs = r.data.songs.map((x) => ({
      id: 'online:bilibili:' + x.ref, online: true, source: 'bilibili', ref: x.ref,
      title: x.title || '', artist: x.artist || '', album: '', duration: x.duration || 0,
      picUrl: x.picUrl || '', level: 'standard'
    }));
    const kept = cleanImportedSongs(songs);
    const pl = { id: 'b:' + fid, name: r.data.name ? `${r.data.name}（${kept.length} 首）` : `B站收藏夹（${kept.length} 首）`, source: 'bilibili', cover: r.data.cover || '', songs: kept };
    const dup = state.onlinePlaylists.findIndex((x) => x.id === pl.id);
    if (dup >= 0) state.onlinePlaylists.splice(dup, 1);
    state.onlinePlaylists.unshift(pl);
    saveOpls();
    closeImportOverlay();
    toast('歌单导入成功：' + pl.name + (r.data.truncated ? '（超过 400 首已截断）' : ''));
    openOpl(pl);
    biliWarm(kept.slice(0, 5).map((x) => x.ref)); // 预热前 5 首（照 PC：导入后自动合成，点开头几首秒开）
    return;
  }
  const parsed = parsePlaylistInput(s);
  if (!parsed) { toast('请输入歌单链接或 ID'); return; }
  if (parsed.type === 'error') { toast(parsed.reason); return; }
  if (parsed.type === 'share') {
    toast('正在解析酷狗分享链接…');
    const r = await kugouResolveShare(parsed.url);
    if (!r.ok) { toast(r.reason || '分享解析失败'); return; }
    const kept = cleanImportedSongs(r.songs);
    const pl = { id: 'k:share:' + Date.now(), name: r.name ? `${r.name}（${kept.length} 首）` : `酷狗分享歌单（${kept.length} 首）`, source: 'kugou', cover: '', songs: kept };
    state.onlinePlaylists.unshift(pl);
    saveOpls();
    closeImportOverlay();
    toast('歌单导入成功：' + pl.name);
    openOpl(pl);
    return;
  }
  toast('正在导入歌单…');
  const r = await importPlaylist(parsed.source, parsed.ref);
  if (!r.ok) { toast(r.reason || '歌单导入失败'); return; }
  r.pl.songs = cleanImportedSongs(r.pl.songs);
  const dup = state.onlinePlaylists.findIndex((x) => x.id === r.pl.id);
  if (dup >= 0) state.onlinePlaylists.splice(dup, 1);
  state.onlinePlaylists.unshift(r.pl);
  saveOpls();
  closeImportOverlay();
  toast('歌单导入成功：' + r.pl.name + '（' + r.pl.songs.length + ' 首）');
  openOpl(r.pl);
}

/* ================= 播放核心（队列状态机，对齐桌面端） ================= */
function currentSong() { return state.queue[state.queueIndex] || null; }

// 重建随机序：当前曲固定首位，其余洗牌（一轮无重复）
function rebuildShuffle() {
  const rest = [];
  for (let i = 0; i < state.queue.length; i++) if (i !== state.queueIndex) rest.push(i);
  for (let i = rest.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [rest[i], rest[j]] = [rest[j], rest[i]];
  }
  state.shuffleOrder = state.queueIndex >= 0 ? [state.queueIndex, ...rest] : rest;
  state.shufflePos = 0;
}

// 播放列表（队列重建唯一入口）
async function playList(list, idx, autoPlay = true) {
  FM.active = false; // 任何常规列表播放都退出猜你喜欢 FM
  if (!list || !list.length || idx == null || !list[idx]) { toast('请先选择歌曲'); return; }
  state.queue = list.slice();
  state.queueIndex = idx;
  if (state.mode === 'shuffle') rebuildShuffle();
  if (await startSong(list[idx])) addHistory(list[idx]);
  updateQueueUI();
}

// 点击单曲：队列空/未在播/点当前曲 → 重建；否则插到当前曲后立即播放（不重置队列）
async function playSongOnClick(song, sourceList) {
  FM.active = false; // 手动点歌退出 FM（startGuessFm 会在调用后重新置位）
  const busy = state.queue.length > 0 && state.queueIndex >= 0 && !!state.current && state.playing === true;
  if (!busy || (state.current && state.current.id === song.id)) {
    const idx = (sourceList || state.list).indexOf(song);
    await playList(sourceList || state.list, idx >= 0 ? idx : 0);
    return;
  }
  // 防重复：队列中同 id 项移除（若在当前位置之前，需先修正 queueIndex）
  const dupIdx = state.queue.findIndex((x) => x.id === song.id);
  if (dupIdx >= 0) {
    state.queue.splice(dupIdx, 1);
    if (dupIdx < state.queueIndex) state.queueIndex--;
  }
  const at = Math.min(state.queueIndex + 1, state.queue.length);
  state.queue.splice(at, 0, song);
  // 直接以修正后的插入位置为 queueIndex（勿用 indexOf：重复 id 时会指向旧副本，M2 修复）
  state.queueIndex = at;
  if (state.mode === 'shuffle') rebuildShuffle();
  if (await startSong(song)) addHistory(song);
  updateQueueUI();
}

async function playFrom(song, list, idx) {
  await playSongOnClick(song, list);
}

// 下一首播放（插入当前曲后；随机模式对齐桌面：[当前, 新歌, 其余去重随机]）
function queuePlayNext(song) {
  if (state.queueIndex < 0 || !state.queue.length) {
    playList([song], 0);
    toast('正在播放：' + song.title);
    return;
  }
  const dupIdx = state.queue.findIndex((x) => x.id === song.id);
  if (dupIdx >= 0) {
    state.queue.splice(dupIdx, 1);
    // 去重删除发生在当前曲之前 → queueIndex 前移（对齐 playSongOnClick 的修正逻辑）
    if (dupIdx < state.queueIndex) state.queueIndex--;
  }
  if (state.mode === 'shuffle') {
    // 随机模式：新歌进队尾，重排为 [当前, 新歌, 其余去重随机]
    const newIdx = state.queue.length;
    state.queue.push(song);
    const rest = [];
    for (let i = 0; i < newIdx; i++) if (i !== state.queueIndex) rest.push(i);
    for (let i = rest.length - 1; i > 0; i--) {
      const j = Math.floor(Math.random() * (i + 1));
      [rest[i], rest[j]] = [rest[j], rest[i]];
    }
    state.shuffleOrder = [state.queueIndex, newIdx, ...rest];
    state.shufflePos = 0;
  } else {
    state.queue.splice(state.queueIndex + 1, 0, song);
  }
  updateQueueUI();
  toast('已加入下一首播放：' + song.title);
}

// 添加到队列末尾（随机模式：按 id 去重后追加本轮末尾，保持一轮无重复）
// 对齐桌面：空队列也仅追加不播放（queueIndex 保持 -1）
function queueAppend(song) {
  if (!state.queue.length) state.queue = [];
  state.queue.push(song);
  if (state.mode === 'shuffle' && state.shuffleOrder.length) {
    const newIdx = state.queue.length - 1;
    state.shuffleOrder = state.shuffleOrder.filter((i) => state.queue[i] && state.queue[i].id !== song.id);
    state.shuffleOrder.push(newIdx);
  } else if (state.mode === 'shuffle') {
    // 空序分支：queueIndex<0（未播放仅追加）时直接追加新歌索引——rebuildShuffle 已含全部索引，
    // 再 push 会重复；queueIndex>=0 的异常空序才需要重建（L1 修复）
    if (state.queueIndex >= 0) {
      rebuildShuffle();
    } else {
      state.shuffleOrder.push(state.queue.length - 1);
    }
  }
  updateQueueUI();
  toast('已添加到队列：' + song.title);
}

// 移除（当前曲不可移除）
function queueRemoveAt(idx) {
  if (idx < 0 || idx >= state.queue.length || idx === state.queueIndex) return;
  state.queue.splice(idx, 1);
  if (state.mode === 'shuffle' && state.shuffleOrder.length) {
    state.shuffleOrder = state.shuffleOrder.filter((i) => i !== idx).map((i) => i > idx ? i - 1 : i);
    state.shufflePos = Math.min(state.shufflePos, Math.max(0, state.shuffleOrder.length - 1));
  }
  if (state.queueIndex > idx) state.queueIndex--;
  updateQueueUI();
}

function queueMove(from, to) {
  if (from < 0 || to < 0 || from >= state.queue.length || to >= state.queue.length || from === to) return;
  const [item] = state.queue.splice(from, 1);
  state.queue.splice(to, 0, item);
  // 顺序模式：跨过当前曲时 queueIndex 随动（M3 修复；随机模式 rebuildShuffle 自会重建）
  if (state.mode === 'shuffle') {
    rebuildShuffle();
  } else {
    if (from === state.queueIndex) state.queueIndex = to;
    else if (from < state.queueIndex && to >= state.queueIndex) state.queueIndex--;
    else if (from > state.queueIndex && to <= state.queueIndex) state.queueIndex++;
  }
  updateQueueUI();
}

function queueClear() {
  state.queue = [];
  state.queueIndex = -1;
  state.shuffleOrder = [];
  state.shufflePos = -1;
  updateQueueUI();
}

// 解析可播放对象：{song, url}；失败返回 {song:null, url:null}
// 解析失败 → 严格换源兜底
// 预热缓存：当前歌开播后预解析队列下一首，切歌秒开（解析结果 30 分钟有效）
const prewarmCache = new Map(); // song.id -> {song, url, ts}
function prewarmNext() {
  try {
    if (!state.queue.length) return;
    const next = state.queue[(state.queueIndex + 1) % state.queue.length];
    if (!next || next.local || next.demo || prewarmCache.has(next.id)) return;
    resolvePlayable(next).then((r) => {
      if (r.url) prewarmCache.set(next.id, { song: r.song || next, url: r.url, ts: Date.now() });
    }).catch(() => {});
  } catch { /* 预热失败静默 */ }
}

async function resolvePlayable(song) {
  // 预热命中：直接用缓存的解析结果（用后即弃，避免 URL 过期）
  const pc = prewarmCache.get(song.id);
  if (pc && Date.now() - pc.ts < 30 * 60 * 1000) {
    prewarmCache.delete(song.id);
    return { song: pc.song, url: pc.url };
  }
  const lv = () => qualityToLevel(song.source, PREF.onlineQ);
  if (song.source === 'bilibili') {
    // B站：优先直连 DASH 分轨（高音质、秒开）；失败回退 leiz 合成流；均败不换源（对齐 PC）
    const d = await biliDirectResolve(song.ref).catch(() => ({ ok: false }));
    if (d.ok && d.data && d.data.url) return { song, url: d.data.url };
    const r = await biliResolve(song.ref);
    if (r.ok && r.data && r.data.url) return { song, url: r.data.url };
    return { song: null, url: null };
  }
  const r = await leizResolve(song.source, song.ref, song.level || lv());
  if (r.ok && r.data && (r.data.url || r.data.src)) {
    // 徽章如实反映 leiz 实际返回的音质（leiz 服务端有会员权限，酷狗返回什么就标什么，不看本地账号）
    const got = r.data.level || r.data.quality || r.data.bitrate;
    if (got != null) { const nl = normLeizLevel(got); if (nl) song.level = nl; }
    return { song, url: r.data.url || r.data.src };
  }
  const fb = await strictFallback(song);
  if (fb) {
    const r2 = await leizResolve(fb.source, fb.ref, qualityToLevel(fb.source, PREF.onlineQ));
    if (r2.ok && r2.data && (r2.data.url || r2.data.src)) return { song: fb, url: r2.data.url || r2.data.src };
  }
  return { song: null, url: null };
}

// 实际开始播放（本地直连 / 在线解析）；seekTo>0 时加载后跳转进度（断点续播用）
// 返回 true=成功，false=失败（M4：失败时回滚 queueIndex，防 UI 高亮与实际播放脱节）
async function startSong(song, seekTo = 0) {
  if (song && song.demo) { toast('示例歌单·仅演示，暂不可播放'); return false; }
  const reqId = song.id;
  const prevIndex = state.queueIndex;
  if (song.local) {
    state.current = song;
    updatePlayerBar();
    updateQueueUI();
    LS.save('last', lastSnapshot(song));
    await playerLoad(song, song.uri);
    if (seekTo > 0) await playerSeek(seekTo);
    await playerPlay();
    applyRate();
    loadLocalLyrics(song); // 先显示无歌词，后台在线补齐（严格匹配才采用）
    saveResumeState(song, seekTo);
    return true;
  }
  // 轻量加载指示：播放条标题旁转圈（替代占屏 toast，减少等待焦虑）
  document.body.classList.add('resolving');
  try {
    // 总超时兜底：主解析 + 严格换源串行最坏约 48s，超时上限 30s 让用户尽快得到明确失败而非永久挂起
    const resolved = await Promise.race([
      resolvePlayable(song),
      new Promise((res) => setTimeout(() => res({ song: null, url: null, timeout: true }), 30000))
    ]);
    // 切歌竞态守卫：解析期间用户已点了别的歌则放弃本次结果
    const cur = state.queue[state.queueIndex];
    if (state.queueIndex < 0 || !cur || cur.id !== reqId) return false;
    const { song: playSong, url } = resolved;
    if (resolved && resolved.timeout) { toast('播放地址获取超时，请检查网络后重试'); return rollbackFailed(prevIndex); }
    if (!url || !playSong) { toast('无法获取播放地址，请稍后重试'); return rollbackFailed(prevIndex); }
    if (playSong.id !== song.id) {
      toast('已按严格匹配切换音源：' + (SRC_NAMES[playSong.source] || playSong.source));
      // 队列内同步替换（保持 UI 一致）
      if (state.queueIndex >= 0 && state.queue[state.queueIndex]) state.queue[state.queueIndex] = playSong;
    }
    state.current = playSong;
    updatePlayerBar();
    updateQueueUI();
    LS.save('last', lastSnapshot(playSong));
    await playerLoad(playSong, url);
    if (seekTo > 0) await playerSeek(seekTo);
    await playerPlay();
    applyRate();
    loadLyrics(playSong);
    if (!$('playerPage').classList.contains('hidden')) showPlayerPage();
    saveResumeState(playSong, seekTo);
    prewarmNext(); // 开播即预热队列下一首（切歌秒开）
    return true;
  } finally {
    document.body.classList.remove('resolving');
  }
}

// M4 失败回滚：解析失败时若上一首仍在队列则指回它，否则回退调用前索引，防高亮与播放脱节
function rollbackFailed(prevIndex) {
  const cur = state.current;
  if (cur) {
    const idx = state.queue.findIndex((x) => x.id === cur.id);
    if (idx >= 0) { state.queueIndex = idx; updateQueueUI(); return false; }
  }
  state.queueIndex = prevIndex;
  updateQueueUI();
  return false;
}

// 最近播放快照（L5：带 id/source/online/uri 最小判定字段，冷启动当前曲高亮/点击判定可用）
function lastSnapshot(song) {
  return {
    id: song.id, online: !!song.online, local: !!song.local,
    source: song.source || '', ref: song.ref || '', uri: song.uri || '',
    title: song.title, artist: song.artist || '', picUrl: song.picUrl || ''
  };
}

// 断点续播：播放位置持久化（对齐桌面 savePlaybackState）；仅当开关开启
let lastResumeSaveAt = 0;
function saveResumeState(song, position) {
  if (PREF.resume === false || !song || !song.id) return;
  LS.save('resume', {
    song: {
      id: song.id, online: !!song.online, source: song.source || '', ref: song.ref || '',
      local: !!song.local, uri: song.uri || '',
      title: song.title, artist: song.artist || '', album: song.album || '',
      duration: song.duration || 0, picUrl: song.picUrl || ''
    },
    position: Math.max(0, Math.floor(position || 0)),
    mode: state.mode,
    at: Date.now()
  });
}

// 从持久化断点恢复播放（对齐桌面 checkResume）：上次位置 >3s 才值得恢复
async function resumePlayback() {
  if (PREF.resume === false) return;
  const r = LS.load('resume', null);
  if (!r || !r.song || !r.song.id) return;
  const pos = Math.max(0, Math.floor(r.position || 0));
  if (pos < 3) return; // 刚开头不恢复
  const song = r.song;
  state.queue = [song];
  state.queueIndex = 0;
  if (state.mode === 'shuffle') rebuildShuffle();
  updateQueueUI();
  toast('继续播放：' + (song.title || '') + '（' + fmtDur(pos) + '）');
  await startSong(song, pos);
}

// 严格换源：歌名完全相等（norm 后）+ 歌手匹配才允许；宁缺毋滥
async function strictFallback(song) {
  const norm = (t) => String(t || '').trim().toLowerCase().replace(/\s+/g, '');
  const want = norm(song.title);
  if (!want) return null;
  const artists = String(song.artist || '').split(/[、,，\/]/).map(norm).filter(Boolean);
  const others = ['netease', 'kugou'].filter((s) => s !== song.source && PREF.sources[s]);
  const withTimeout = (p, ms) => Promise.race([p, new Promise((res) => setTimeout(() => res(null), ms))]);
  const results = await Promise.all(others.map((s) => withTimeout(leizSearch(s, song.title).catch(() => null), 8000)));
  for (let i = 0; i < others.length; i++) {
    const s = others[i];
    const r = results[i];
    if (!r || !r.ok) continue;
    const arr = Array.isArray(r.data) ? r.data : [];
    for (const it of arr) {
      const cand = {
        source: s,
        title: it.name || it.song_name || '',
        artist: it.artists || it.author_name || ''
      };
      if (norm(cand.title) !== want) continue;
      const candArtists = String(cand.artist || '').split(/[、,，\/]/).map(norm).filter(Boolean);
      // 歌手匹配：整词相等（收紧；双向子串会把"王菲"误配"菲儿乐队"）。两边都有歌手时必须命中一个；仅一边有 → 不换源
      const artOk = artists.length && candArtists.length && artists.some((a) => candArtists.some((ca) => ca === a));
      if (!artOk) continue;
      // 命中：构造可播放对象
      const ref = s === 'netease' ? String(it.id || '') : String(it.hash || it.shareUrl || '');
      if (!ref) continue;
      return { id: 'online:' + s + ':' + (s === 'netease' ? it.id : it.hash), online: true, source: s, ref, title: cand.title, artist: cand.artist, album: it.album || '', duration: it.duration || 0, picUrl: it.picUrl || '', level: qualityToLevel(s, PREF.onlineQ) };
    }
  }
  return null;
}

function togglePlay() {
  if (!state.current) return;
  if (state.playing) playerPause(); else playerPlay();
}

async function playNext() {
  if (!state.queue.length) return;
  fmSkipFeedback(); // FM 中手动跳过：反馈给酷狗校准画像
  // 单曲队列：随机模式下重播自己（无"下一首"可言）
  if (state.queue.length === 1) { playerSeek(0); playerPlay(); return; }
  let i = state.queueIndex;
  if (state.mode === 'shuffle') {
    if (!state.shuffleOrder.length) rebuildShuffle();
    state.shufflePos++;
    if (state.shufflePos >= state.shuffleOrder.length) {
      rebuildShuffle();
      state.shufflePos = Math.min(1, state.shuffleOrder.length - 1);
    }
    const n = state.shuffleOrder[state.shufflePos];
    if (n == null || n === state.queueIndex) {
      if (n == null) {
        // queueIndex=-1（仅追加未播放）：兜底播队列首曲，不清空队列
        i = state.queueIndex >= 0 ? state.queueIndex : 0;
      } else {
        // 兜底重排
        rebuildShuffle();
        state.shufflePos = 0;
        i = state.shuffleOrder[0];
      }
    } else { i = n; }
  } else {
    i = (state.queueIndex + 1) % state.queue.length;
  }
  state.queueIndex = i;
  if (await startSong(state.queue[i])) addHistory(state.queue[i]);
}

async function playPrev() {
  if (!state.queue.length) return;
  let i = state.queueIndex;
  if (state.position > 3) { playerSeek(0); return; }
  if (state.mode === 'shuffle') {
    if (state.shufflePos > 0) { state.shufflePos--; i = state.shuffleOrder[state.shufflePos]; }
    else i = state.queueIndex;
  } else {
    i = (state.queueIndex - 1 + state.queue.length) % state.queue.length;
  }
  state.queueIndex = i;
  if (await startSong(state.queue[i])) addHistory(state.queue[i]);
}

/* ================= 队列 UI ================= */
function updateQueueUI() {
  const panel = $('queuePanel');
  if (!panel.classList.contains('hidden')) renderQueue();
  const upcoming = state.queueIndex >= 0 ? Math.max(0, state.queue.length - state.queueIndex - 1) : state.queue.length;
  $('queueCount').textContent = upcoming ? `队列（${upcoming} 首待播）` : '队列（空）';
  // 队列入口角标（对齐 PC 99+ 红点）
  const badge = upcoming > 0 ? (upcoming > 99 ? '99+' : String(upcoming)) : '';
  ['ppQueueBadge', 'pbQueueBadge'].forEach((id) => {
    const el = $(id);
    if (!el) return;
    el.textContent = badge;
    el.classList.toggle('hidden', !badge);
  });
}
function renderQueue() {
  const wrap = $('queueList');
  wrap.innerHTML = '';
  if (!state.queue.length) {
    wrap.appendChild(Object.assign(document.createElement('div'), { className: 'hint', textContent: '队列为空 — 点歌曲行右侧 ＋ 加入' }));
    return;
  }
  state.queue.forEach((song, idx) => {
    const row = document.createElement('div');
    row.className = 'song-row' + (idx === state.queueIndex ? ' playing' : '');
    const cov = document.createElement('img');
    cov.className = 'cov';
    cov.src = song.picUrl || PLACEHOLDER;
    cov.onerror = () => { cov.src = PLACEHOLDER; };
    const info = document.createElement('div');
    info.className = 'info';
    info.innerHTML = `<div class="t">${idx === state.queueIndex ? '<span class="q-now">' + icon('play', 12) + '</span>' : ''}${esc(song.title)}</div><div class="a">${esc(song.artist || '')} · ${SRC_NAMES[song.source] || ''}</div>`;
    row.append(cov, info);
    if (idx !== state.queueIndex) {
      const up = document.createElement('button');
      up.className = 'icon-btn';
      up.innerHTML = icon('chevUp', 16);
      up.title = '上移';
      up.addEventListener('click', (e) => { e.stopPropagation(); queueMove(idx, idx - 1); });
      const dn = document.createElement('button');
      dn.className = 'icon-btn';
      dn.innerHTML = icon('chevDn', 16);
      dn.title = '下移';
      dn.addEventListener('click', (e) => { e.stopPropagation(); queueMove(idx, idx + 1); });
      const rm = document.createElement('button');
      rm.className = 'icon-btn';
      rm.innerHTML = icon('close', 16);
      rm.title = '移除';
      rm.addEventListener('click', (e) => { e.stopPropagation(); queueRemoveAt(idx); });
      const ops = document.createElement('div');
      ops.className = 'ops';
      ops.append(up, dn, rm);
      row.append(ops);
      row.addEventListener('click', () => { state.queueIndex = idx; startSong(state.queue[idx]).then((ok) => { if (ok) addHistory(state.queue[idx]); }); });
    }
    wrap.appendChild(row);
  });
}

/* ================= 歌词 ================= */
function loadLocalLyricsNone() {
  state.lrc = []; state.lrcIndex = -1; state.wordSegs = null; state.transLrc = null;
  pushNotifyLyric(''); overlaySync('', ''); // 本地歌无歌词 → 通知栏不显示歌词行
  $('lyricBox').innerHTML = '<div>（本地歌曲暂无歌词）</div>';
}
async function loadLyrics(song) {
  state.lrc = []; state.lrcIndex = -1; state.wordSegs = null; state.transLrc = null;
  pushNotifyLyric(''); overlaySync('', ''); // 切歌先清空通知栏歌词（新歌行未定）
  $('lyricBox').innerHTML = '<div>（歌词加载中…）</div>';
  let r;
  r = await leizLyrics(song.source, song.ref, song.level || qualityToLevel(song.source, PREF.onlineQ));
  const ly = r.ok && r.data ? r.data.lyrics : null;
  applyLyrics(song, ly);
}
// 歌词解析+渲染（在线歌词与本地歌在线补齐共用）
function applyLyrics(song, ly) {
  if (!state.current || state.current.id !== song.id) return;
  if (!ly || !ly.original) { $('lyricBox').innerHTML = '<div>（暂无歌词）</div>'; return; }
  const orig = String(ly.original).trim();
  // 翻译歌词：标准 LRC 解析；无时间戳则按行序静态存（t=-1）
  let transLrc = null;
  if (ly.translated) {
    const tLines = parseLrc(String(ly.translated));
    if (tLines.length) transLrc = tLines;
    else {
      const bare = String(ly.translated).split(/\r?\n/).map((s) => s.trim()).filter(Boolean).filter((s) => !META_RE.test(s));
      if (bare.length) transLrc = bare.map((text) => ({ t: -1, text }));
    }
  }
  state.transLrc = transLrc;
  // 逐字歌词：网易云 JSON 行 / 酷狗 KRC；解析为空（如仅元信息 JSON 行）→ 回退普通 LRC
  let wordSegs = null;
  if (/^\{"t":\d+/.test(orig)) wordSegs = parseNeteaseWordLines(orig);
  else if (/^\[\d+,\d+\]/.test(orig)) wordSegs = parseKrcWord(orig);
  if (wordSegs && wordSegs.length) {
    state.wordSegs = wordSegs;
    state.lrc = [];
  } else {
    // 混合格式兜底：JSON 行全是元信息而歌词是普通 LRC 行 → 走 LRC 解析
    state.wordSegs = null;
    state.lrc = parseLrc(orig);
  }
  if (state.lrc.length || (state.wordSegs && state.wordSegs.length)) renderLyrics();
  else $('lyricBox').innerHTML = '<div>' + esc(orig.slice(0, 300)) + '</div>';
}
/* 本地歌歌词在线补齐（对齐 PC「本地歌词链路→单首在线补齐」）：
   标题归一相等 + 歌手含首个主歌手名才采用，宁缺毋滥；失败静默回落无歌词 */
async function loadLocalLyrics(song) {
  loadLocalLyricsNone();
  try {
    if (!song.title) return;
    const q = (song.artist ? song.artist + ' ' : '') + song.title;
    const r = await leizSearch('netease', q);
    if (!r || !r.ok || !Array.isArray(r.data) || !r.data.length) return;
    const norm = (t) => String(t || '').trim().toLowerCase().replace(/\s+/g, '');
    const want = norm(song.title);
    const leadArtist = String(song.artist || '').split(/[、,，\/]/)[0].trim().toLowerCase();
    const hit = r.data.find((it) => {
      if (norm(it.name || it.song_name || '') !== want) return false;
      if (!leadArtist) return true;
      return String(it.artists || it.author_name || '').toLowerCase().includes(leadArtist);
    });
    if (!hit || !hit.id) return;
    const lr = await leizLyrics('netease', String(hit.id), 'standard');
    const ly = lr.ok && lr.data ? lr.data.lyrics : null;
    if (!ly || !ly.original) return;
    applyLyrics(song, ly);
  } catch (e) { /* 补齐失败保持无歌词态 */ }
}
function renderLyrics() {
  const box = $('lyricBox');
  box.innerHTML = '';
  if (state.wordSegs && state.wordSegs.length) {
    // 逐字模式：每段一行，字为 span（高亮定位用 data-w）
    state.wordSegs.forEach((seg, i) => {
      const d = document.createElement('div');
      d.className = 'lyric-line';
      d.dataset.i = i;
      seg.chars.forEach((c, j) => {
        const s = document.createElement('span');
        s.textContent = c.ch;
        s.dataset.w = j;
        d.appendChild(s);
      });
      d.addEventListener('click', () => { if (seg.t >= 0) playerSeek(seg.t); });
      box.appendChild(d);
    });
    state.lrcEls = box.children;
    return;
  }
  state.lrc.forEach((l, i) => {
    const d = document.createElement('div');
    d.className = 'lyric-line';
    d.dataset.i = i;
    d.appendChild(Object.assign(document.createElement('div'), { className: 'lrc-main', textContent: l.text || ' ' }));
    if (PREF.lyrTrans) {
      const tr = transForLine(i);
      if (tr) d.appendChild(Object.assign(document.createElement('div'), { className: 'lrc-trans', textContent: tr }));
    }
    d.addEventListener('click', () => { if (l.t >= 0) playerSeek(l.t); });
    box.appendChild(d);
  });
  state.lrcEls = box.children;
  updateLyricHighlight();
}
// 翻译行匹配：优先时间 ±0.35s；无时间戳或未命中 → 行序兜底（对齐桌面）
function transForLine(i) {
  if (!state.transLrc || !state.lrc || !state.lrc[i]) return null;
  const t = state.lrc[i].t;
  for (const tr of state.transLrc) {
    if (tr.t >= 0 && Math.abs(tr.t - t) < 0.35) return tr.text || null;
  }
  if (i < state.transLrc.length) return state.transLrc[i].text || null;
  return null;
}
// 通知栏歌词：当前行文本推送原生（行变化才发；空行/无歌词 → 清空）
let lastNotifyLyric = null;
function pushNotifyLyric(line) {
  const t = (line == null ? '' : String(line)).trim();
  if (t === lastNotifyLyric) return;
  lastNotifyLyric = t;
  if (NP && NP.setLyric) { try { NP.setLyric({ line: t }); } catch (e) {} }
}

/* ================= 桌面歌词悬浮窗（对齐 PC lyricWin：双行居中、可拖动、位置记忆） ================= */
let lastOverlayKey = null;
// 固定配对双行模型（用户批次16规范）：显示第 2k+1、2k+2 行（0 基 = 第 2m、2m+1 行）；
// 唱上行时上行扫色、下行白色；上行唱完扫色移到下行（上行满色）；下行唱完整体换下一对。
// curRow=当前唱的行（0=上行 1=下行）；single=有翻译时只显示当前句一行
function overlaySync(topText, botText, curRow, charsIn, lineEnd, single) {
  let chars = charsIn;
  const LW = window.Capacitor && window.Capacitor.Plugins ? window.Capacitor.Plugins.LyricsWin : null;
  if (!PREF.lyrWin || !LW) return;
  const l1 = (topText == null ? '' : String(topText));
  const l2 = (botText == null ? '' : String(botText));
  const payload = { top: l1, bottom: l2, curRow: curRow ? 1 : 0, single: single ? 1 : 0 };
  if (chars && chars.length && lineEnd > chars[0]) {
    // 退化时间轴修复（照 PC 歌词窗均分兜底）：每字 t 全部≈行首（极差<0.1s）→ 按行窗均分，
    // 否则原生扫色会瞬间扫满全句并在末字内抖动（leiz 网易逐字数据实测如此）
    if (chars.length > 1 && chars[chars.length - 1] - chars[0] < 0.1) {
      const t0 = chars[0], step = (lineEnd - t0) / chars.length;
      chars = chars.map((_, i) => t0 + step * i);
    }
    payload.chars = chars;
    payload.lineEnd = lineEnd;
  }
  const key = l1 + '\u0001' + l2 + '\u0001' + (curRow ? 1 : 0) + '\u0001' + (single ? 1 : 0) + '\u0001' + (chars ? chars.length : 0) + '\u0001' + (chars && chars.length ? chars[0] : 0);
  if (key === lastOverlayKey) return;
  lastOverlayKey = key;
  try { LW.update(payload); } catch (e) {}
}
 // 扫色进度由原生每帧直读内核位置（v5），JS 无需心跳/锚点推送
async function toggleLyrWin(on) {
  if (on) {
    if (!(window.Capacitor && window.Capacitor.Plugins && window.Capacitor.Plugins.LyricsWin)) { toast('无原生悬浮窗支持'); return false; }
    try {
      const r = await window.Capacitor.Plugins.LyricsWin.canDrawOverlays();
      if (!(r && r.ok)) {
        await window.Capacitor.Plugins.LyricsWin.requestPerm();
        toast('请在系统页允许「显示在其他应用上层」，回来再开');
        return false;
      }
      await window.Capacitor.Plugins.LyricsWin.show({ line1: (state.current && state.current.title) || '深空折韵', line2: '' });
      try { window.Capacitor.Plugins.LyricsWin.setStyle(lyrStylePayload()); } catch (e) {}
      if (PREF.lyrLocked) { try { await window.Capacitor.Plugins.LyricsWin.setLocked({ locked: true }); } catch (e) {} }
      lastOverlayKey = '';
      return true;
    } catch (e) { toast('悬浮窗开启失败：' + ((e && e.message) || '')); return false; }
  }
  try { await window.Capacitor.Plugins.LyricsWin.hide(); } catch (e) {}
  lastOverlayKey = null;
  return true;
}

let posSample = { pos: 0, t: 0 };
function estPos() {
  if (!state.playing) return state.position;
  const now = (window.performance && performance.now) ? performance.now() : Date.now();
  const dt = Math.max(0, (now - posSample.t) / 1000);
  const r = PREF.rate || 1;
  const p = posSample.pos + dt * r;
  return state.duration ? Math.min(p, state.duration) : p;
}
// 轻量逐帧扫色：只更新当前行进度，不重建 DOM / 不滚动 / 不同步悬浮窗
function sweepLyricTo(pos) {
  const box = $('lyricBox'); if (!box) return;
  if (state.wordSegs && state.wordSegs.length) {
    if (state.lrcIndex >= 0) updateWordChar(box.children[state.lrcIndex], pos);
    return;
  }
  if (!state.lrc || !state.lrc.length) return;
  let idx = -1;
  for (let i = 0; i < state.lrc.length; i++) { if (state.lrc[i].t <= pos + 0.3) idx = i; else break; }
  if (idx < 0 || !state.lrc[idx]) return;
  const t = state.lrc[idx].t;
  const te = state.lrc[idx + 1] ? state.lrc[idx + 1].t : t + 5;
  const p = te > t ? ((pos - t) / (te - t)) * 100 : 0;
  setLyricSweep(box.children[idx], p);
  const pc = $('ppLyricCur'); if (pc) setLyricSweep(pc, p);
}
let lyricRaf = 0;
function startLyricLoop() {
  if (lyricRaf) return;
  const tick = () => {
    const pp = $('playerPage');
    if (!pp || pp.classList.contains('hidden')) { lyricRaf = 0; return; }
    if (state.playing) sweepLyricTo(estPos());
    lyricRaf = requestAnimationFrame(tick);
  };
  lyricRaf = requestAnimationFrame(tick);
}
function updateLyricHighlight() {
  const box = $('lyricBox');
  if (state.wordSegs && state.wordSegs.length) {
    // 逐字：定位当前段 + 段内当前字
    let segIdx = -1;
    for (let i = 0; i < state.wordSegs.length; i++) {
      if (state.wordSegs[i].t <= state.position + 0.3) segIdx = i; else break;
    }
    if (segIdx === state.lrcIndex) { if (state.lrcIndex >= 0) updateWordChar(box.children[segIdx], state.position); return; }
    state.lrcIndex = segIdx;
    renderPpLyrics();
    // 通知栏歌词：当前段文本 = 各字拼接；悬浮窗同步（下一行作第二行）
    const seg = segIdx >= 0 ? state.wordSegs[segIdx] : null;
    const segText = seg ? seg.chars.map((c) => c.ch).join('') : '';
    const nextSeg = state.wordSegs[segIdx + 1];
    pushNotifyLyric(segText);
    // 词元时间 → 每字符时间（词元内均分，行尾封口），保证 text.length == 时间轴长度
    let perChar = null;
    if (seg && seg.chars && seg.chars.length && seg.t >= 0) {
      perChar = [];
      const endT = nextSeg ? nextSeg.t : seg.t + 5;
      // 退化时间轴（每字 t 全=行首，leiz 数据常见）→ 按行窗均分每字（照 PC 均分兜底）；
      // 跳过会让原生时间轴滞留旧行，后续行扫色全部错位
      const span = seg.chars[seg.chars.length - 1].t - seg.chars[0].t;
      const timed = span >= 0.1;
      const winStart = timed ? seg.t : Math.max(seg.t, state.position || 0);
      const winEnd = timed ? seg.chars[seg.chars.length - 1].t : Math.max(endT, winStart + 0.5);
      for (let j = 0; j < seg.chars.length; j++) {
        const tCur = timed ? seg.chars[j].t : winStart + (winEnd - winStart) * (j / seg.chars.length);
        const tNext = timed ? (j + 1 < seg.chars.length ? seg.chars[j + 1].t : Math.max(endT, tCur + 0.2)) : (j + 1 < seg.chars.length ? winStart + (winEnd - winStart) * ((j + 1) / seg.chars.length) : winEnd);
        const chs = seg.chars[j].ch.split('');
        const step = Math.max(0, tNext - tCur) / Math.max(1, chs.length);
        for (let k = 0; k < chs.length; k++) perChar.push(tCur + step * k);
      }
    }
    // 固定配对：本段与其配对行（2m/2m+1，m = segIdx>>1）成对显示
    const m = segIdx >> 1;
    const topSeg = state.wordSegs[m * 2];
    const botSeg = state.wordSegs[m * 2 + 1];
    const topText = topSeg ? topSeg.chars.map((c) => c.ch).join('') : '';
    const botText = botSeg ? botSeg.chars.map((c) => c.ch).join('') : '';
    const hasTr = PREF.lyrTrans && !!transForLine(segIdx);
    overlaySync(topText, botText, segIdx % 2, perChar, nextSeg ? nextSeg.t : (seg ? seg.t + 5 : 0), hasTr);
    [...box.children].forEach((c, i) => c.classList.toggle('cur', i === segIdx));
    const cur = box.children[segIdx];
    if (cur && cur.scrollIntoView) cur.scrollIntoView({ block: 'center', behavior: 'smooth' });
    if (segIdx >= 0) updateWordChar(box.children[segIdx], state.position);
    return;
  }
  if (!state.lrc.length) return;
  let idx = -1;
  for (let i = 0; i < state.lrc.length; i++) {
    if (state.lrc[i].t <= state.position + 0.3) idx = i; else break;
  }
  const lineSweep = (i) => {
    if (i < 0 || !state.lrc[i]) return;
    const t = state.lrc[i].t;
    const te = state.lrc[i + 1] ? state.lrc[i + 1].t : t + 5;
    const p = te > t ? ((state.position - t) / (te - t)) * 100 : 0;
    const el = box.children[i]; setLyricSweep(el, p);
    const pc = $('ppLyricCur'); if (pc) setLyricSweep(pc, p);
  };
  if (idx === state.lrcIndex) { lineSweep(idx); return; }
  state.lrcIndex = idx;
  renderPpLyrics();
  // 通知栏歌词：当前行文本（含翻译行？只推主行，简洁）；悬浮窗同步（翻译/下一行作第二行）
  pushNotifyLyric(idx >= 0 ? (state.lrc[idx].text || '') : '');
  if (idx >= 0) {
    const tr = transForLine(idx);
    const t = state.lrc[idx].t;
    const txt = state.lrc[idx].text || '';
    const te = state.lrc[idx + 1] ? state.lrc[idx + 1].t : t + 5;
    let chars = null;
    if (t >= 0 && te > t && txt.length) {
      const step = (te - t) / txt.length;
      chars = txt.split('').map((_, i) => t + step * i);
    }
    // 固定配对：本行与其配对行（2m/2m+1，m = idx>>1）成对显示
    const m = idx >> 1;
    const topT = state.lrc[m * 2] ? (state.lrc[m * 2].text || '') : '';
    const botT = state.lrc[m * 2 + 1] ? (state.lrc[m * 2 + 1].text || '') : '';
    overlaySync(topT, botT, idx % 2, chars, te, PREF.lyrTrans && !!tr);
  } else overlaySync('', '');
  [...box.children].forEach((c) => c.classList.toggle('cur', +c.dataset.i === idx));
  const cur = box.children[idx];
  if (cur && cur.scrollIntoView) cur.scrollIntoView({ block: 'center', behavior: 'smooth' });
}
// 扫色：给元素设当前进度渐变填充（0..100），配合 CSS background-clip:text
function setLyricSweep(el, p) {
  if (!el) return;
  el.style.setProperty('--p', Math.max(0, Math.min(100, p)).toFixed(1) + '%');
  el.classList.add('sweep');
}
// 逐字段内高亮 + 连续扫色进度
function updateWordChar(lineEl, pos) {
  if (!lineEl) return;
  const seg = state.wordSegs[state.lrcIndex];
  if (!seg) return;
  const n = seg.chars.length;
  let w = -1;
  for (let j = 0; j < n; j++) {
    if (seg.chars[j].t <= pos + 0.1) w = j; else break;
  }
  [...lineEl.children].forEach((s, j) => s.classList.toggle('wcur', j <= w));
  if (n) {
    const cur = seg.chars[Math.max(0, w)];
    const nxt = seg.chars[Math.min(n - 1, w + 1)];
    const t0 = w < 0 ? seg.t : cur.t;
    const t1 = w + 1 >= n ? (nxt ? nxt.t + 0.4 : t0 + 0.4) : nxt.t;
    const frac = w < 0 ? 0 : Math.max(0, Math.min(1, (pos - t0) / Math.max(0.05, t1 - t0)));
    setLyricSweep(lineEl, ((Math.max(0, w) + frac) / n) * 100);
    const pc = $('ppLyricCur'); if (pc) setLyricSweep(pc, ((Math.max(0, w) + frac) / n) * 100);
  }
}

/* ================= 历史（最近播放） ================= */
function addHistory(song) {
  if (!song || !song.id) return;
  state.recent = [{
    id: song.id, at: Date.now(),
    online: !!song.online, source: song.source || '', ref: song.ref || '',
    snap: lastSnapshot(song) // 完整快照：搜索结果等未入库的歌也能在最近播放展示
  }].concat(state.recent.filter((x) => x.id !== song.id)).slice(0, 200);
  LS.save('recent', state.recent);
  renderRecent(); // 歌单页最近卡片区随播放即时刷新
}
function resolveRecent() {
  // 本地曲库 + 收藏 + 在线歌单联合查找；未入库的歌回退到播放时的完整快照
  const pool = [];
  const seen = new Set();
  const push = (s) => { if (s && !seen.has(s.id)) { seen.add(s.id); pool.push(s); } };
  state.localSongs.forEach(push);
  state.favorites.forEach(push);
  state.onlinePlaylists.forEach((pl) => (pl.songs || []).forEach(push));
  return state.recent.map((r) => pool.find((s) => s.id === r.id) || (r.snap && r.snap.id === r.id ? r.snap : null)).filter(Boolean);
}
function renderRecent() {
  const list = resolveRecent();
  // 歌单页（pageOpls）的最近播放
  const el = $('recentList');
  if (el) { el.innerHTML = ''; list.forEach((s, i) => el.appendChild(songRow(s, { list, idx: i }))); }
  const emp = $('recentEmpty');
  if (emp) emp.classList.toggle('hidden', list.length > 0);
  // 歌单页最近播放：横滑圆角封面卡（封面+歌名+歌手，对齐首页推荐歌单形式）
  const cards = $('recentCards');
  if (cards) {
    cards.className = 'daily-scroll';
    cards.querySelectorAll('.daily-card').forEach((c) => c.remove());
    list.slice(0, 12).forEach((s) => {
      const card = document.createElement('div');
      card.className = 'daily-card';
      const img = document.createElement('img');
      img.src = s.picUrl || PLACEHOLDER;
      img.onerror = () => { img.onerror = null; img.src = PLACEHOLDER; };
      const nm = document.createElement('div');
      nm.className = 'daily-card-name';
      nm.textContent = s.title || '';
      const ar = document.createElement('div');
      ar.className = 'daily-card-artist';
      ar.textContent = s.artist || SRC_NAMES[s.source] || '';
      card.append(img, nm, ar);
      card.addEventListener('click', () => playFrom(s, list));
      cards.appendChild(card);
    });
  }
  // 我的页（pageMe）的最近播放
  const el2 = $('meRecentList');
  if (el2) { el2.innerHTML = ''; list.forEach((s, i) => el2.appendChild(songRow(s, { list, idx: i }))); }
  const emp2 = $('meRecentEmpty');
  if (emp2) emp2.classList.toggle('hidden', list.length > 0);
}

/* ================= 收藏 ================= */
function isFav(id) { return state.favorites.some((f) => f.id === id); }
function toggleFav(song) {
  if (isFav(song.id)) {
    state.favorites = state.favorites.filter((f) => f.id !== song.id);
    if (song.source && song.ref) addTombstone('fav:' + song.source + ':' + song.ref);
    toast('已取消收藏');
  } else {
    // 存完整字段：本地歌保留 uri/local（收藏页可直接播放），在线歌保留全部元数据
    state.favorites.unshift({
      id: song.id, online: !song.local, source: song.source, ref: song.ref || '',
      title: song.title, artist: song.artist || '', album: song.album || '',
      duration: song.duration || 0, picUrl: song.picUrl || '',
      local: !!song.local, uri: song.uri || '', updatedAt: Date.now()
    });
    toast('已收藏');
  }
  LS.save('favs', state.favorites);
  renderFavs();
  updateFavHeart();
  scheduleAutoSync();
}
function renderFavs() {
  const el = $('favList');
  if (el) { el.innerHTML = ''; state.favorites.forEach((f, i) => el.appendChild(songRow(f, { list: state.favorites, idx: i }))); }
  const emp = $('favEmpty');
  if (emp) emp.classList.toggle('hidden', state.favorites.length > 0);
  refreshStats();
}

/* ================= 五宫格数字刷新 ================= */
function refreshStats() {
  const set = (id, v) => { const el = $(id); if (el) el.textContent = v; };
  const favN = state.favorites.length, dlN = state.dlDone.length, rcN = state.recent.length, libN = state.localSongs.length;
  set('statFavNum', favN);
  set('statDlNum', dlN);
  set('statRecentNum', rcN);
  set('statLibNum', libN);
  // 我的页功能宫格数字
  set('qkDlNum', dlN); set('qkFavNum', favN); set('qkRecentNum', rcN); set('qkLibNum', libN);
  set('meStatFavNum', favN); set('meStatDlNum', dlN); set('meStatRecentNum', rcN); set('meStatLibNum', libN);
  const myPl = state.mylists.length + (state.onlinePlaylists || []).filter((p) => p.fav).length;
  set('playlistCount', myPl);
  set('meStatPlNum', myPl);
  // 设置分组摘要（折叠态也能看到当前值）
  set('sumPlay', (PREF.rate || 1) + 'x' + (PREF.resume === false ? ' · 续播关' : ''));
  set('sumUi', ({ auto: '跟随系统', dark: '深色', light: '浅色' })[PREF.theme] || '跟随系统');
  set('sumSrc', QUALITY_LABEL[normQuality(PREF.onlineQ) || 'high']);
  set('sumLyr', PREF.lyrWin ? '已开启' : '关闭');
  const sub = $('meUserSub');
  if (sub) sub.textContent = `收藏 ${favN} · 下载 ${dlN} · 曲库 ${libN}`;
}

/* ================= 本地媒体库（MediaStore） ================= */
let localScanning = false;
function renderLocalFiltered() {
  // 本地页搜索过滤（歌曲 tab）：标题/歌手/专辑 包含匹配
  const kw = ($('localSearch').value || '').trim().toLowerCase();
  const listEl = $('localList');
  listEl.innerHTML = '';
  let arr = state.localSongs;
  if (kw) arr = arr.filter((s) => (s.title || '').toLowerCase().includes(kw) || (s.artist || '').toLowerCase().includes(kw) || (s.album || '').toLowerCase().includes(kw));
  arr.forEach((s, i) => listEl.appendChild(songRow(s, { list: arr, idx: i })));
  $('localCount').textContent = arr.length + ' 首';
}
async function scanLocal() {
  if (!MS) { $('localEmpty').classList.remove('hidden'); $('localEmpty').textContent = '无原生支持（浏览器预览模式）'; return; }
  if (localScanning) return;
  localScanning = true;
  $('localEmpty').classList.remove('hidden');
  $('localEmpty').textContent = '正在扫描本地音乐…';
  try {
    const tab = state.localTab;
    let data = null;
    if (tab === 'albums') data = await MS.scanAlbums();
    else if (tab === 'artists') data = await MS.scanArtists();
    else data = await MS.scanSongs();
    // L3 修复：扫描期间用户切了 tab → 丢弃本次结果，不渲染到错误 tab（避免"专辑页显示歌曲列表"）
    if (state.localTab !== tab) { localScanning = false; scanLocal(); return; }
    const listEl = $('localList');
    listEl.innerHTML = '';
    if (tab === 'songs') {
      state.localSongs = (data && data.songs) ? data.songs.map((s) => Object.assign(s, { picUrl: '', source: 'local', local: true, online: false })) : [];
      $('localCount').textContent = state.localSongs.length + ' 首';
      $('localEmpty').classList.toggle('hidden', state.localSongs.length > 0);
      $('localEmpty').textContent = '本地暂无音乐 — 请先向手机导入音频文件，或下载在线歌曲';
      state.localSongs.forEach((s, i) => listEl.appendChild(songRow(s, { list: state.localSongs, idx: i })));
      // 扫描完成后刷新最近播放解析池（启动后台扫描场景）
      if (state.view === 'me') renderRecent();
    } else if (tab === 'albums') {
      state.localAlbums = (data && data.albums) || [];
      $('localCount').textContent = state.localAlbums.length + ' 张';
      $('localEmpty').classList.toggle('hidden', state.localAlbums.length > 0);
      state.localAlbums.forEach((a) => listEl.appendChild(albumCard(a)));
    } else {
      state.localArtists = (data && data.artists) || [];
      $('localCount').textContent = state.localArtists.length + ' 位';
      $('localEmpty').classList.toggle('hidden', state.localArtists.length > 0);
      state.localArtists.forEach((a) => listEl.appendChild(artistCard(a)));
    }
  } catch (e) {
    $('localEmpty').classList.remove('hidden');
    $('localEmpty').textContent = '扫描失败：' + ((e && e.message) || '未知错误');
    // 可能是权限被拒：引导授权
    if (e && e.message && e.message.includes('权限')) toast('需要音乐权限，请在系统设置中允许');
  } finally {
    localScanning = false;
  }
}

function albumCard(a) {
  const card = document.createElement('div');
  card.className = 'opl-card';
  const cov = document.createElement('img');
  cov.className = 'cov';
  cov.src = PLACEHOLDER;
  if (MS && a.albumId != null) {
    MS.albumArt({ albumId: a.albumId }).then((r) => { if (r && r.dataUrl) cov.src = r.dataUrl; }).catch(() => {});
  }
  cov.onerror = () => { cov.src = PLACEHOLDER; };
  const info = document.createElement('div');
  info.style.flex = '1';
  info.innerHTML = `<div class="name">${esc(a.name)}</div><div class="meta">${esc(a.artist || '')} · ${a.count || 0} 首</div>`;
  card.append(cov, info);
  card.addEventListener('click', () => openLocalDetail('album', a));
  return card;
}

function artistCard(a) {
  const card = document.createElement('div');
  card.className = 'opl-card';
  const cov = document.createElement('div');
  cov.className = 'cov artist-cov';
  cov.textContent = String(a.name || '?').slice(0, 1);
  const info = document.createElement('div');
  info.style.flex = '1';
  info.innerHTML = `<div class="name">${esc(a.name)}</div><div class="meta">${a.tracks || 0} 首 · ${a.albums || 0} 张专辑</div>`;
  card.append(cov, info);
  card.addEventListener('click', () => openLocalDetail('artist', a));
  return card;
}

async function openLocalDetail(kind, item, keepFilter) {
  if (!MS) return;
  if (!keepFilter) { resetDetailFilter('localDetailFilter'); resetDFilter(); }
  state.currentLocalDetail = { kind, item };
  setView('localdetail', { title: kind === 'album' ? item.name : item.name });
  $('localDetailHead').innerHTML = `<div class="dh"><div class="dh-info"><div class="dh-name">${esc(item.name)}</div><div class="dh-sub">${kind === 'album' ? esc(item.artist || '') : ''} ${(kind === 'album' ? item.count : item.tracks) || 0} 首</div><div class="dh-btns"><button id="btnDhFilter" class="dh-btn dh-ghost">筛选</button><button id="btnDhGrid" class="dh-btn dh-ghost"></button></div></div></div>`;
  bindDhViewBtns();
  const listEl = $('localDetailList');
  listEl.innerHTML = '<div class="hint">查询中…</div>';
  try {
    const r = kind === 'album' ? await MS.songsOfAlbum({ albumId: item.albumId }) : await MS.songsOfArtist({ artistId: item.artistId });
    const songs = (r && r.songs) ? r.songs.map((s) => Object.assign(s, { picUrl: '', source: 'local', local: true, online: false })) : [];
    state.localDetailSongs = songs;
    fillFiltered(listEl, songs, {});
    if (!songs.length) listEl.innerHTML = '<div class="hint">该分类下暂无歌曲</div>';
  } catch (e) {
    listEl.innerHTML = '<div class="hint">查询失败</div>';
  }
}

/* ================= 下载管理 ================= */
// 记录任务对应的源歌曲（失败重试需要完整对象）
const dlSongs = {};
async function resolveDownloadUrl(song) {
  if (song.local) return song.uri;
  const r = await leizResolve(song.source, song.ref, qualityToLevel(song.source, PREF.dlQ));
  return (r.ok && r.data) ? (r.data.url || r.data.src) : null;
}

async function startDownload(song) {
  if (song && song.demo) { toast('示例歌单·仅演示，暂不可下载'); return; }
  if (song && song.source === 'bilibili') { toast('B站一期仅支持在线播放，暂不可下载'); return; }
  if (!DLR) { toast('无原生下载支持'); return; }
  const DL_ACTIVE = ['queued', 'resolving', 'downloading', 'cover', 'tagging'];
  if (state.dlTasks[song.id] && DL_ACTIVE.includes(state.dlTasks[song.id].status)) {
    toast('该歌曲已在下载中'); return;
  }
  toast('正在解析播放地址…');
  dlSongs[song.id] = song;
  state.dlTasks[song.id] = { status: 'resolving', pct: 0, title: song.title, path: null };
  renderDlTasks();
  const url = await resolveDownloadUrl(song);
  if (!url) { state.dlTasks[song.id] = { status: 'error', pct: 0, title: song.title, path: null, reason: '无法获取下载地址' }; renderDlTasks(); toast('无法获取下载地址（该歌曲暂不可下载）'); return; }
  state.dlTasks[song.id] = { status: 'downloading', pct: 0, title: song.title, path: null };
  renderDlTasks();
  // 歌词落盘准备：拉取并归一为标准 LRC 文本（失败重试 1 次，仍失败静默，不影响下载）
  let lrc = '';
  try {
    for (let a = 0; a < 2 && !lrc; a++) {
      const lr = await leizLyrics(song.source, song.ref, qualityToLevel(song.source, PREF.onlineQ));
      if (lr.ok && lr.data && lr.data.lyrics) lrc = buildLrcText(lr.data.lyrics);
      if (!lrc && a === 0) await new Promise((r) => setTimeout(r, 800));
    }
  } catch (_) {}
  try {
    await DLR.start({
      id: song.id, url,
      title: song.title, artist: song.artist || '',
      album: song.album || '', source: song.source,
      coverUrl: song.picUrl || '', lrc
    });
  } catch (e) {
    state.dlTasks[song.id] = { status: 'error', pct: 0, title: song.title, path: null, reason: (e && e.message) || '下载失败' };
    renderDlTasks();
    toast('下载失败：' + ((e && e.message) || ''));
  }
}

// 下载用 .lrc 文本：普通 LRC / 网易逐字 / 酷狗 KRC 统一转标准 [mm:ss.xx] 行；翻译行随原行输出（双语）
// 注：实际数据可能是混合格式（逐字行 + 普通 LRC 行并存），三个解析器取产出最多的那个
function buildLrcText(ly) {
  if (!ly || !ly.original) return '';
  const orig = String(ly.original).trim();
  if (!orig) return '';
  const asWord = parseNeteaseWordLines(orig).map((s) => ({ t: s.t, text: s.chars.map((c) => c.ch).join('') }));
  const asKrc = parseKrcWord(orig).map((s) => ({ t: s.t, text: s.chars.map((c) => c.ch).join('') }));
  const asLrc = parseLrc(orig);
  const lines = asWord.length >= asKrc.length && asWord.length >= asLrc.length ? asWord : (asKrc.length >= asLrc.length ? asKrc : asLrc);
  if (!lines.length) return '';
  const trans = ly.translated ? parseLrc(String(ly.translated)) : [];
  const nearTrans = (t) => {
    let best = null;
    for (const x of trans) if (!best || Math.abs(x.t - t) < Math.abs(best.t - t)) best = x;
    return best && Math.abs(best.t - t) <= 0.6 ? best.text : null;
  };
  const fmt = (t) => { const m = Math.floor(t / 60); return String(m).padStart(2, '0') + ':' + (t - m * 60).toFixed(2).padStart(5, '0'); };
  return lines.map((x) => {
    const tr = nearTrans(x.t);
    return `[${fmt(x.t)}]${x.text}${tr ? '\r\n[' + fmt(x.t) + ']' + tr : ''}`;
  }).join('\r\n');
}

function onDlEvent(e) {
  const t = state.dlTasks[e.id];
  if (!t) { state.dlTasks[e.id] = { status: e.status, pct: e.pct || 0, title: e.title || '', path: e.path || null, reason: e.reason || null }; }
  else { t.status = e.status; t.pct = e.pct || 0; if (e.path) t.path = e.path; if (e.reason) t.reason = e.reason; }
  if (e.status === 'done') {
    state.dlDone = state.dlDone.filter((x) => x.id !== e.id).concat([{ id: e.id, title: e.title, path: e.path, at: Date.now() }]).slice(-20);
    LS.save('dl', state.dlDone);
    toast('下载完成：' + e.title);
    // 下载完成 → 刷新本地媒体库（MediaScanner 已登记）
    if (state.view === 'local' && MS) scanLocal();
  }
  renderDlTasks();
  refreshStats();
}

let dlManage = false;
function renderDlTasks() {
  const el = $('dlTaskList');
  if (!el) return;
  el.innerHTML = '';
  const tasks = Object.values(state.dlTasks).filter((t) => ['queued', 'resolving', 'downloading', 'cover', 'tagging', 'error'].includes(t.status));
  tasks.forEach((t) => {
    const row = document.createElement('div');
    row.className = 'dl-row';
    const pct = Math.round((t.pct || 0) * 100);
    const statusText = t.status === 'queued' ? '排队中' : t.status === 'resolving' ? '解析地址中…' : t.status === 'downloading' ? `下载中 ${pct}%` : (t.status === 'cover' || t.status === 'tagging') ? '处理中…' : `失败（${t.reason || ''}）`;
    row.innerHTML = `<div class="info"><div class="t">${esc(t.title)}</div><div class="a">${esc(statusText)}</div></div>`;
    // 操作：下载中→取消；失败→重试
    const ops = document.createElement('div');
    ops.className = 'ops';
    if (t.status === 'error') {
      const retry = document.createElement('button');
      retry.className = 'icon-btn';
      retry.innerHTML = icon('retry', 16);
      retry.title = '重试';
      retry.addEventListener('click', (e) => { e.stopPropagation(); startDownload(dlSongs[t.id] || { id: t.id, title: t.title, artist: '', source: 'netease', ref: '', online: true }); });
      ops.appendChild(retry);
    } else if (['queued', 'resolving', 'downloading', 'cover', 'tagging'].includes(t.status) && DLR) {
      const cancel = document.createElement('button');
      cancel.className = 'icon-btn';
      cancel.innerHTML = icon('close', 16);
      cancel.title = '取消';
      cancel.addEventListener('click', (e) => {
        e.stopPropagation();
        DLR.cancel({ id: t.id }).catch(() => {});
        state.dlTasks[t.id] = { status: 'error', pct: t.pct || 0, title: t.title, path: null, reason: '已取消' };
        renderDlTasks();
      });
      ops.appendChild(cancel);
    }
    if (dlManage) {
      const rm = document.createElement('button');
      rm.className = 'icon-btn';
      rm.innerHTML = icon('trash', 16);
      rm.title = '移除';
      rm.addEventListener('click', (e) => {
        e.stopPropagation();
        delete state.dlTasks[t.id];
        renderDlTasks();
      });
      ops.appendChild(rm);
    }
    if (ops.children.length) row.appendChild(ops);
    if (t.status === 'downloading') {
      const bar = document.createElement('div');
      bar.className = 'dl-bar';
      const fill = document.createElement('div');
      fill.className = 'dl-bar-fill';
      fill.style.width = pct + '%';
      bar.appendChild(fill);
      row.appendChild(bar);
    }
    el.appendChild(row);
  });
  const hint = $('dlDoneHint');
  if (hint) hint.textContent = (!tasks.length && state.dlDone.length) ? '最近完成：' + state.dlDone.slice(-3).map((d) => d.title).join('、') : '';
  renderDlDone();
}
// 我的页"已下载"横拉卡（上限6，封面取下载时缓存的 dlSongs，重启后回退首字块）
function renderDlDone() {
  const cards = $('dlDoneCards'); if (!cards) return;
  cards.querySelectorAll('.daily-card').forEach((c) => c.remove());
  const done = state.dlDone.slice().reverse();
  const more = $('dlMore'); if (more) more.classList.toggle('hidden', done.length <= 6);
  const emp = $('dlDoneEmpty'); if (emp) emp.classList.toggle('hidden', done.length > 0);
  done.slice(0, 6).forEach((d) => {
    const full = dlSongs[d.id] || {};
    const card = document.createElement('div');
    card.className = 'daily-card';
    const pic = full.picUrl || '';
    let cov;
    if (pic) { cov = document.createElement('img'); cov.src = pic; cov.onerror = () => { cov.onerror = null; cov.style.display = 'none'; }; }
    else { cov = document.createElement('div'); cov.className = 'daily-card-tile'; cov.textContent = String(d.title || '♪').slice(0, 1); }
    const nm = document.createElement('div'); nm.className = 'daily-card-name'; nm.textContent = d.title || '';
    const ar = document.createElement('div'); ar.className = 'daily-card-artist'; ar.textContent = full.artist || '本地';
    card.append(cov, nm, ar);
    card.addEventListener('click', () => { const s = dlSongs[d.id] || { id: 'dlfile:' + (d.path || d.id), local: true, source: 'local', uri: d.path, title: d.title, artist: '', duration: 0, picUrl: '' }; playList([s], 0); });
    cards.appendChild(card);
  });
}

function batchDownload(songs) {
  const list = (songs || []).filter((s) => s && s.online && !s.demo);
  if (!list.length) { toast('可下载 0 首'); return; }
  toast('已加入下载队列：' + list.length + ' 首');
  list.forEach((s) => startDownload(s));
}

async function openDlList() {
  if (!DLR) { toast('无原生下载支持'); return; }
  try {
    const r = await DLR.listDownloaded();
    const files = (r && r.files) || [];
    const overlay = $('importOverlay');
    overlay.querySelector('.overlay-title').textContent = '已下载（' + files.length + ' 首）';
    const box = overlay.querySelector('.overlay-box');
    // 清掉旧内容
    box.querySelectorAll('.dl-file-list, .dl-file-item').forEach((x) => x.remove());
    const wrap = document.createElement('div');
    wrap.className = 'dl-file-list';
    if (!files.length) wrap.innerHTML = '<div class="hint">还没有下载</div>';
    files.forEach((f) => {
      const item = document.createElement('div');
      item.className = 'dl-file-item';
      item.innerHTML = `<div class="info"><div class="t">${esc(f.name)}</div><div class="a">${fmtSize(f.size)}</div></div>`;
      const play = document.createElement('button');
      play.className = 'ghost-btn';
      play.textContent = '播放';
      play.addEventListener('click', async () => {
        const song = { id: 'dlfile:' + f.path, local: true, source: 'local', uri: f.url, title: f.name.replace(/\.[^.]+$/, ''), artist: '', duration: 0, picUrl: '' };
        closeImportOverlay();
        await playList([song], 0);
      });
      const del = document.createElement('button');
      del.className = 'ghost-btn';
      del.textContent = '删除';
      del.addEventListener('click', async () => {
        await DLR.deleteFile({ path: f.path });
        toast('已删除');
        openDlList();
      });
      const edit = document.createElement('button');
      edit.className = 'ghost-btn';
      edit.innerHTML = icon('edit', 16);
      edit.title = '编辑标签';
      edit.addEventListener('click', () => openTagEditor(f));
      item.append(play, edit, del);
      wrap.appendChild(item);
    });
    box.insertBefore(wrap, overlay.querySelector('.row'));
    $('importOk').classList.add('hidden');
    $('importCancel').textContent = '关闭';
    overlay.classList.remove('hidden');
  } catch (e) {
    toast('读取下载列表失败');
  }
}
function fmtSize(n) {
  if (n >= 1048576) return (n / 1048576).toFixed(1) + ' MB';
  return Math.round(n / 1024) + ' KB';
}

/* ================= 标签编辑器（对齐 PC：标题/歌手/专辑 + 封面三态 undefined=不动/null=移除/对象=新图） ================= */
let tagTarget = null, tagPicture;
async function openTagEditor(f) {
  if (!DLR) return;
  const ext = (f.name.match(/\.[^.]+$/) || [''])[0].toLowerCase();
  if (ext !== '.mp3' && ext !== '.flac') { toast('仅支持 MP3/FLAC 文件写入标签'); return; }
  tagTarget = f; tagPicture = undefined;
  $('tagOvSong').value = ''; $('tagOvArtist').value = ''; $('tagOvAlbum').value = '';
  $('tagOvCover').src = PLACEHOLDER;
  let title = '', artist = '', album = '';
  try {
    const r = await DLR.readTags({ path: f.path });
    if (r && r.ok) {
      title = r.title || ''; artist = r.artist || ''; album = r.album || '';
      if (r.picture) $('tagOvCover').src = 'data:' + (r.mime || 'image/jpeg') + ';base64,' + r.picture;
    }
  } catch (_) {}
  if (!title || !artist) {
    const base = f.name.replace(/\.[^.]+$/, '');
    const m = base.split(' - ');
    if (m.length >= 2) { artist = artist || m[0]; title = title || m.slice(1).join(' - '); }
    else title = title || base;
  }
  $('tagOvSong').value = title; $('tagOvArtist').value = artist; $('tagOvAlbum').value = album;
  $('tagOverlay').classList.remove('hidden');
}
function bindTagEditor() {
  if (!$('tagOverlay')) return;
  $('tagOvCancel').addEventListener('click', () => $('tagOverlay').classList.add('hidden'));
  $('tagOvChangePic').addEventListener('click', () => $('tagOvPicInput').click());
  $('tagOvPicInput').addEventListener('change', (e) => {
    const file = e.target.files && e.target.files[0];
    e.target.value = '';
    if (!file) return;
    if (file.size > 2 * 1024 * 1024) { toast('封面图片不能超过 2MB'); return; } // 照 PC
    const rd = new FileReader();
    rd.onload = () => {
      const m = String(rd.result || '').match(/^data:(image\/[^;]+);base64,(.+)$/);
      if (!m) { toast('图片读取失败'); return; }
      tagPicture = { mime: m[1], b64: m[2] };
      $('tagOvCover').src = 'data:' + m[1] + ';base64,' + m[2];
    };
    rd.readAsDataURL(file);
  });
  $('tagOvRemovePic').addEventListener('click', () => { tagPicture = null; $('tagOvCover').src = PLACEHOLDER; });
  $('tagOvOk').addEventListener('click', async () => {
    if (!tagTarget) return;
    try {
      const r = await DLR.writeTags({
        path: tagTarget.path,
        title: $('tagOvSong').value.trim(),
        artist: $('tagOvArtist').value.trim(),
        album: $('tagOvAlbum').value.trim(),
        pictureBase64: tagPicture && tagPicture.b64 ? tagPicture.b64 : undefined,
        pictureMime: tagPicture && tagPicture.mime ? tagPicture.mime : undefined,
        removePicture: tagPicture === null
      });
      if (r && r.ok) {
        $('tagOverlay').classList.add('hidden');
        toast('标签已保存'); // 照 PC 文案
        // 当前播放若是该文件 → 同步 UI（照 PC：更新 state 对象 + 刷新播放条）
        if (state.current && state.current.uri === 'file://' + tagTarget.path) {
          state.current.title = $('tagOvSong').value.trim() || state.current.title;
          state.current.artist = $('tagOvArtist').value.trim();
          state.current.album = $('tagOvAlbum').value.trim();
          updatePlayerBar();
        }
        if (MS) scanLocal().catch(() => {});
      } else toast((r && r.reason) || '标签保存失败');
    } catch (e) { toast('标签保存失败：' + ((e && e.message) || '')); }
  });
}

/* ================= 重复歌曲清理（对齐 PC：大小分桶+SHA1；每组第 0 个保留，其余默认全选） ================= */
let dupeGroups = [];
async function openDupes() {
  if (!DLR) { toast('无原生下载支持'); return; }
  dupeGroups = [];
  $('dupeList').innerHTML = '<div class="hint">扫描中…</div>';
  $('dupeSummary').textContent = '';
  $('dupeOk').disabled = true;
  $('dupeOverlay').classList.remove('hidden');
  try {
    const r = await DLR.scanDupes();
    dupeGroups = (r && r.groups) || [];
    renderDupes();
  } catch (e) { $('dupeList').innerHTML = '<div class="hint">扫描失败：' + esc((e && e.message) || '') + '</div>'; }
}
function renderDupes() {
  const box = $('dupeList');
  box.innerHTML = '';
  if (!dupeGroups.length) { box.innerHTML = '<div class="hint">没有发现重复歌曲🎉</div>'; $('dupeSummary').textContent = ''; $('dupeOk').disabled = true; return; }
  dupeGroups.forEach((g, gi) => {
    const head = document.createElement('div');
    head.className = 'dupe-group-head';
    head.textContent = `重复组 ${gi + 1}（${g.length} 份 · ${fmtSize(g[0].size)}）`;
    box.appendChild(head);
    g.forEach((f, fi) => {
      const row = document.createElement('label');
      row.className = 'dupe-row' + (fi === 0 ? ' keep' : '');
      const cb = document.createElement('input');
      cb.type = 'checkbox';
      if (fi === 0) { cb.checked = true; cb.disabled = true; }
      else { cb.checked = true; cb.addEventListener('change', updateSummary); }
      const span = document.createElement('span');
      span.textContent = f.name;
      span.title = f.path;
      row.append(cb, span);
      box.appendChild(row);
    });
  });
  updateSummary();
  function updateSummary() {
    let n = 0;
    box.querySelectorAll('.dupe-row:not(.keep) input:checked').forEach(() => n++);
    $('dupeSummary').textContent = `将删除 ${n} 个重复文件`;
    $('dupeOk').disabled = n === 0;
  }
}
async function deleteDupes() {
  const paths = [];
  $('dupeList').querySelectorAll('.dupe-row:not(.keep)').forEach((row) => {
    if (row.querySelector('input').checked) paths.push(row.querySelector('span').title);
  });
  if (!paths.length) return;
  try {
    const r = await DLR.deleteFiles({ paths });
    const failed = (r && r.failed) || 0;
    toast(`已删除 ${paths.length - failed} 个重复文件${failed ? `，${failed} 个失败` : ''}`);
  } catch (e) { toast('删除失败：' + ((e && e.message) || '')); return; }
  $('dupeOverlay').classList.add('hidden');
  if (MS) scanLocal().catch(() => {});
  refreshStats();
}
function bindDupes() {
  if (!$('stDupes')) return;
  $('stDupes').addEventListener('click', openDupes);
  $('dupeCancel').addEventListener('click', () => $('dupeOverlay').classList.add('hidden'));
  $('dupeOk').addEventListener('click', deleteDupes);
}

/* ================= 同步 ================= */
function overlayReplaceInput(ta) {
  const cur = $('importInput');
  if (cur) cur.replaceWith(ta); else {
    const row = document.querySelector('#importOverlay .row');
    if (row) row.insertBefore(ta, row);
  }
  return ta;
}
function collectAllSongMap() {
  const m = {};
  const add = (s) => { if (s && s.id) m[s.id] = s; };
  (state.onlinePlaylists || []).forEach((pl) => (pl.songs || []).forEach(add));
  (state.favorites || []).forEach(add);
  try { resolveRecent().forEach(add); } catch (e) {}
  return m;
}
// 构造同步包 v2：在线歌单 + 自建歌单(解析为在线引用) + 收藏 + 最近 + profile + accounts
function tombList() { return LS.load('tomb', []); }
function addTombstone(key) { if (!key) return; const l = tombList().filter((t) => t.key !== key); l.push({ key, at: Date.now() }); LS.save('tomb', l); }
function mergeTombstones(list) { const m = new Map(); for (const t of tombList()) m.set(t.key, t.at || 0); for (const t of (list || [])) { if (!t || !t.key) continue; m.set(t.key, Math.max(m.get(t.key) || 0, t.at || 0)); } LS.save('tomb', [...m].map(([key, at]) => ({ key, at }))); }
let _deviceName = '';
try { const AB = window.Capacitor && window.Capacitor.Plugins && window.Capacitor.Plugins.AppBridge; if (AB && AB.getDeviceInfo) AB.getDeviceInfo().then((d) => { _deviceName = (d && d.deviceName) || ''; }).catch(() => {}); } catch (e) {}
function buildSyncBundle() {
  const songMap = collectAllSongMap();
  const pls = (state.onlinePlaylists || []).slice();
  for (const ml of (state.mylists || [])) {
    const songs = (ml.songIds || []).map((id) => songMap[id]).filter((s) => s && s.online);
    if (songs.length) pls.push({ id: ml.id, name: ml.name, source: 'local-pl', cover: ml.cover || '', songs, updatedAt: ml.updatedAt || ml.createdAt || Date.now() });
  }
  const acct = curAccount() || {};
  return exportBundle({
    onlinePlaylists: pls,
    favorites: state.favorites,
    recent: state.recent,
    profile: { nickname: PREF.nickname || '', avatar: PREF.avatar || '', updatedAt: acct.updatedAt || 0 },
    accounts: { netease: NE.getState(), kugou: KG.getState(), bilibili: biliGetAcc() },
    tombstones: tombList()
  }, (_deviceName || 'mobile'));
}
// 应用同步结果：并集数据 + 墓碑传播删除/解绑 + profile + 各源登录态（本地未登录才采用对方的）
function applySyncBundle(r) {
  if (!r || !r.ok) return;
  _applyingSync = true;
  try {
  const tom = r.tombstones || [];
  const tomAt = (k) => { const t = tom.find((x) => x.key === k); return t ? (t.at || 0) : 0; };
  for (const pl of r.onlinePlaylists) {
    pl.fav = true; // 同步来的歌单标记收藏，确保落库并在"我的歌单"显示
    const dup = state.onlinePlaylists.findIndex((x) => x.id === pl.id);
    if (dup >= 0) state.onlinePlaylists[dup] = Object.assign({}, state.onlinePlaylists[dup], pl, { fav: true }); else state.onlinePlaylists.unshift(pl);
  }
  for (const f of r.favorites) {
    const ex = state.favorites.find((x) => x.id === f.id);
    if (!ex) { state.favorites.push(f); continue; }
    if (f.picUrl && !ex.picUrl) ex.picUrl = f.picUrl;
    if (f.title && !ex.title) ex.title = f.title;
    if (f.artist && !ex.artist) ex.artist = f.artist;
  }
  for (const rc of r.recent) if (!state.recent.some((x) => x.id === rc.id)) state.recent.push(rc);
  // 墓碑：删除/取消收藏（本地项更新时间早于墓碑则移除）
  state.onlinePlaylists = state.onlinePlaylists.filter((p) => !(tomAt('pl:' + p.id) > (p.updatedAt || 0)));
  state.mylists = (state.mylists || []).filter((p) => !(tomAt('pl:' + p.id) > (p.updatedAt || p.createdAt || 0)));
  state.favorites = state.favorites.filter((f) => !(tomAt('fav:' + f.source + ':' + f.ref) > (f.updatedAt || 0)));
  if (r.profile && (r.profile.nickname || r.profile.avatar)) {
    if (r.profile.nickname) PREF.nickname = r.profile.nickname;
    if (r.profile.avatar) PREF.avatar = r.profile.avatar;
    savePrefs();
    try { applyMeProfile(); } catch (e) {}
  }
  const acc = r.accounts || {};
  try { if (acc.netease && acc.netease.cookie && !NE.loggedIn() && !(tomAt('acc:netease') > (acc.netease.updatedAt || 0))) NE.setState(acc.netease); } catch (e) {}
  try { if (acc.kugou && acc.kugou.token && !KG.loggedIn() && !(tomAt('acc:kugou') > (acc.kugou.updatedAt || 0))) KG.setState(acc.kugou); } catch (e) {}
  try { if (acc.bilibili && acc.bilibili.cookie && !biliGetAcc() && !(tomAt('acc:bilibili') > (acc.bilibili.updatedAt || 0))) biliSetAcc(acc.bilibili); } catch (e) {}
  try { if (tomAt('acc:netease') > 0) NE.logout(); } catch (e) {}
  try { if (tomAt('acc:kugou') > 0) KG.logout(); } catch (e) {}
  try { if (tomAt('acc:bilibili') > 0) biliSetAcc(null); } catch (e) {}
  mergeTombstones(tom);
  saveOpls(); saveMylists(); LS.save('favs', state.favorites); LS.save('recent', state.recent);
  renderOpls(); renderMylists(); renderFavs(); renderRecent(); refreshStats(); renderHomeSections();
  try { refreshAccountUI(); refreshBiliUI(); refreshKgUI(); } catch (e) {}
  } finally { _applyingSync = false; }
}
/* ================= v4 绑定层：identity + deviceToken + 全自动静默同步 ================= */
function loadBindings() { const m = LS.load('syncbind', null); return (m && typeof m === 'object') ? m : {}; }
function saveBindings(m) { LS.save('syncbind', m || {}); }
function upsertBinding(b) { if (!b || !b.identity) return; const m = loadBindings(); m[b.identity] = Object.assign({}, m[b.identity], b, { identity: b.identity }); saveBindings(m); }
function dropBinding(identity) { const m = loadBindings(); if (m[identity]) { delete m[identity]; saveBindings(m); } }
function nativeHttp() { return window.Capacitor && window.Capacitor.Plugins && window.Capacitor.Plugins.NativeHttp; }
function parseHostPort(host) { const m = /^https?:\/\/([^:/]+)(?::(\d+))?/i.exec(host || ''); return m ? { ip: m[1], port: m[2] ? +m[2] : 8790 } : { ip: '', port: 8790 }; }
async function discoverPCs(timeoutMs) {
  const LD = window.Capacitor && window.Capacitor.Plugins && window.Capacitor.Plugins.LanDiscovery;
  if (!LD) return [];
  try { const r = await LD.scan({ discPort: 41230, timeoutMs: timeoutMs || 3000 }); return (r && r.devices) || []; } catch (e) { return []; }
}
// 应用一次同步响应（importBundle + applySyncBundle）→ {ok, identity, token, skew, pcName, reason}
function applySyncResponse(resp) {
  if (!resp || !resp.ok) return { ok: false, reason: (resp && resp.reason) || '同步失败' };
  const imp = importBundle(resp.bundle);
  if (!imp.ok) return { ok: false, reason: imp.reason || '数据格式错误' };
  applySyncBundle(imp);
  const skew = (resp.bundle && resp.bundle.exportedAt) ? Math.abs(Date.now() - resp.bundle.exportedAt) : 0;
  return { ok: true, identity: resp.identity || '', token: resp.token || '', skew, pcName: (imp.profile && imp.profile.nickname) || '' };
}
// 手动配对/同步（来自 lanSheet）：host + 可选 code；成功后落存 binding（首次配对/一键允许都会回发 token）
async function pairSync() {
  let host = ($('lanHost').value || '').trim().replace(/\/+$/, '');
  const code = ($('lanCode').value || '').trim();
  const st = $('lanStatus');
  const set = (t, c) => { if (st) { st.textContent = t; st.className = 'lan-status' + (c ? ' ' + c : ''); } };
  if (!/^https?:\/\//i.test(host)) host = 'http://' + host;
  if (!/^https?:\/\/.+/i.test(host)) { set('请填写完整的电脑地址', 'err'); return; }
  if (code && !/^\d{6}$/.test(code)) { set('配对码应为 6 位数字（或留空走一键允许）', 'err'); return; }
  const N = nativeHttp(); if (!N) { set('无原生网络能力', 'err'); return; }
  LS.save('lanpeer', { host, code });
  const btn = $('lanGo'); if (btn) btn.disabled = true;
  try {
    set('连接电脑中…');
    const ping = await N.request({ url: host + '/ping', method: 'GET', readTimeout: 6000 });
    if (!ping || ping.status !== 200) { set('电脑端无响应：检查地址、是否同一 WiFi、同步服务是否已开启', 'err'); return; }
    let pingObj = null; try { pingObj = JSON.parse(ping.data); } catch (e) {}
    const bundle = buildSyncBundle();
    const headers = { 'Content-Type': 'application/json' };
    if (code) headers['X-Sync-Code'] = code;
    set(code ? '同步中（合并数据）…' : '已发送请求，等待电脑端点击「允许」…');
    const r = await N.request({ url: host + '/sync', method: 'POST', headers, body: JSON.stringify({ bundle }), readTimeout: 90000 });
    if (!r || r.status !== 200) {
      const denied = r && r.status === 403;
      set(denied ? '电脑端已拒绝该同步请求' : ('同步被拒或超时（' + (r ? r.status : '无响应') + '）'), 'err'); return;
    }
    let resp; try { resp = JSON.parse(r.data); } catch (e) { set('电脑端返回解析失败', 'err'); return; }
    const res = applySyncResponse(resp);
    if (!res.ok) { set(res.reason, 'err'); return; }
    const u = parseHostPort(host);
    const identity = res.identity || (pingObj && pingObj.identity) || '';
    if (identity) upsertBinding({ identity, token: res.token || '', host: u.ip, port: u.port, pcName: res.pcName || '深空折韵', lastSyncAt: Date.now() });
    renderBoundList();
    set('同步完成 ✓ 已绑定该电脑' + (res.token ? '（之后同 WiFi 自动同步）' : ''), 'ok');
    toast('局域网同步完成');
  } catch (e) {
    set('连接失败：' + ((e && e.message) || e), 'err');
  } finally { if (btn) btn.disabled = false; }
}
/* ---- 自动静默同步（发现→按 identity 匹配已绑定→只带 token 头） ---- */
let _asTimer = null, _asInFlight = false, _asRetryTimer = null, _asRetryN = 0, _asMismatchNoticed = false, _applyingSync = false;
function scheduleAutoSync(delay) {
  if (!PREF.autoSync || _applyingSync) return;
  clearTimeout(_asTimer);
  _asTimer = setTimeout(() => autoSync('change'), delay || 20000); // 防抖 20s 合并多次变化
}
function asBackoff() {
  if (!PREF.autoSync) return;
  _asRetryN = Math.min(_asRetryN + 1, 5);
  const delay = Math.min(10 * 60 * 1000, 5000 * Math.pow(2, _asRetryN)); // 指数退避，上限 10 分钟
  clearTimeout(_asRetryTimer);
  _asRetryTimer = setTimeout(() => autoSync('retry'), delay);
}
async function autoSync(reason) {
  if (!PREF.autoSync) return;
  const manual = reason === 'manual';
  const binds = Object.values(loadBindings()).filter((b) => b && b.token);
  if (!binds.length) { if (manual) toast('尚未绑定电脑，请在下方配对后同步'); return; }
  if (_asInFlight) return;
  const N = nativeHttp(); if (!N) return;
  _asInFlight = true;
  try {
    const pcs = await discoverPCs(3000);
    let synced = 0, failed = false;
    for (const b of binds) {
      let pc = pcs.find((p) => p.identity && p.identity === b.identity);
      if (!pc && b.host) pc = { ip: b.host, port: b.port || 8790, identity: b.identity }; // IP 变了回退缓存地址
      if (!pc) continue; // 局域网内没有这台已绑定电脑，静默跳过
      const bundle = buildSyncBundle();
      let status = 0, resp = null;
      try {
        const r = await N.request({ url: 'http://' + pc.ip + ':' + pc.port + '/sync', method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Sync-Token': b.token }, body: JSON.stringify({ bundle }), readTimeout: 20000 });
        status = r ? r.status : 0; try { resp = r && r.data ? JSON.parse(r.data) : null; } catch (e) {}
      } catch (e) { failed = true; continue; }
      if (status === 200 && resp && resp.ok) {
        if (resp.identity && b.identity && resp.identity !== b.identity) { // 电脑切了本地账号 → 绝不自动灌数据
          if (!_asMismatchNoticed) { _asMismatchNoticed = true; toast('电脑当前登录的是另一个账号，已暂停自动同步'); }
          continue;
        }
        _applyingSync = true; let res; try { res = applySyncResponse(resp); } finally { _applyingSync = false; }
        if (res.ok) {
          upsertBinding({ identity: resp.identity || b.identity, token: resp.token || b.token, host: pc.ip, port: pc.port, lastSyncAt: Date.now(), pcName: res.pcName || b.pcName });
          if (res.skew > 5 * 60 * 1000) toast('手机与电脑时间相差较大，建议校准系统时间');
          synced++;
        } else failed = true;
      } else if (status === 403) {
        dropBinding(b.identity); // 令牌被电脑清除 → 降级，需重新配对
        if (manual) toast('电脑端已解绑该设备，请重新配对');
      } else failed = true;
    }
    if (failed) asBackoff(); else _asRetryN = 0;
    if (manual) { if (synced) { toast('已同步 ' + synced + ' 台电脑'); renderBoundList(); } else toast('未发现可同步的电脑（确认同一 WiFi、电脑端同步已开启）'); }
  } catch (e) { if (manual) toast('同步失败：' + ((e && e.message) || e)); else asBackoff(); }
  finally { _asInFlight = false; }
}
// 已绑定电脑列表渲染（弹层内）
function renderBoundList() {
  const box = $('lanBound'); if (!box) return;
  const list = Object.values(loadBindings()).sort((a, b) => (b.lastSyncAt || 0) - (a.lastSyncAt || 0));
  if (!list.length) { box.innerHTML = '<div class="lan-bound-empty">尚未绑定任何电脑</div>'; return; }
  box.innerHTML = '';
  list.forEach((b) => {
    const row = document.createElement('div'); row.className = 'lan-bound-item';
    const info = document.createElement('div'); info.className = 'lan-bound-info';
    const t = b.lastSyncAt ? new Date(b.lastSyncAt) : null;
    info.innerHTML = '<div class="lan-bound-name">' + esc(b.pcName || '深空折韵') + '</div><div class="lan-bound-sub">' + (b.token ? '已绑定 · 自动同步' : '未绑定令牌') + (t ? ' · 上次 ' + (t.getMonth() + 1) + '/' + t.getDate() + ' ' + String(t.getHours()).padStart(2, '0') + ':' + String(t.getMinutes()).padStart(2, '0') : '') + '</div>';
    const un = document.createElement('button'); un.className = 'lan-bound-un'; un.textContent = '解绑';
    un.addEventListener('click', () => { dropBinding(b.identity); renderBoundList(); toast('已解绑'); });
    row.append(info, un); box.appendChild(row);
  });
}
function openExportSync() {
  const bundle = buildSyncBundle();
  const json = bundleToJson(bundle);
  const overlay = $('importOverlay');
  overlay.classList.add('hidden');
  overlay.querySelector('.overlay-title').textContent = '导出同步包（复制到剪贴板）';
  const ta = document.createElement('textarea');
  ta.value = json;
  ta.style.cssText = 'width:100%;height:160px;background:#10141a;color:#e8edf4;border:1px solid #2a3340;border-radius:8px;padding:8px;font-size:11px;margin-bottom:10px;';
  overlayReplaceInput(ta);
  $('importOk').classList.remove('hidden');
  $('importOk').textContent = '复制';
  $('importCancel').textContent = '取消';
  $('importOk').onclick = async () => {
    try { await navigator.clipboard.writeText(json); toast('已复制同步包'); } catch { ta.select(); toast('请手动长按复制'); }
  };
  overlay.classList.remove('hidden');
}
function openImportSync() {
  const overlay = $('importOverlay');
  overlay.classList.add('hidden');
  overlay.querySelector('.overlay-title').textContent = '导入同步包（粘贴 JSON）';
  const ta = document.createElement('textarea');
  ta.value = '';
  ta.style.cssText = 'width:100%;height:160px;background:#10141a;color:#e8edf4;border:1px solid #2a3340;border-radius:8px;padding:8px;font-size:11px;margin-bottom:10px;';
  overlayReplaceInput(ta);
  $('importOk').classList.remove('hidden');
  $('importOk').textContent = '导入';
  $('importCancel').textContent = '取消';
  $('importOk').onclick = async () => {
    const bundle = parseBundle(ta.value);
    const r = importBundle(bundle);
    if (!r.ok) { toast(r.reason || '同步包解析失败'); return; }
    applySyncBundle(r);
    closeImportOverlay();
    toast(`同步完成：歌单 ${r.onlinePlaylists.length} 个，收藏 ${r.favorites.length} 首`);
  };
  overlay.classList.remove('hidden');
}
/* 分享导入：其他 App 分享的文本（歌单链接/ID）启动后消费 → 预填导入弹窗
   两条路径：① boot 拉取（冷启动带分享 Intent）② shareReceived 事件（运行中收到分享） */
function wireShareImport() {
  try {
    const Cap = window.Capacitor && window.Capacitor.Plugins;
    if (!Cap || !Cap.ShareRecv) return;
    if (Cap.ShareRecv.addListener) {
      Cap.ShareRecv.addListener('shareReceived', () => consumeSharedImport());
    }
  } catch (e) { /* 无原生分享能力静默 */ }
}
async function consumeSharedImport() {
  try {
    const Cap = window.Capacitor && window.Capacitor.Plugins;
    if (!Cap || !Cap.ShareRecv) return;
    const r = await Cap.ShareRecv.consumeSharedText();
    if (!r || !r.text) return;
    const text = String(r.text).trim();
    if (!text) return;
    // 校验是否像歌单输入（链接/ID），避免把闲聊文本当导入
    const looks = /https?:\/\//i.test(text) || /^\d{5,}$/.test(text) || /(歌单|playlist|share)/i.test(text);
    if (!looks) return;
    openImportOpl(); // 统一打开（含 importOk onclick 赋值）
    $('importInput').value = text;
    toast('检测到分享的歌单链接，已填入导入框');
  } catch (e) { /* 无原生分享能力时静默 */ }
}

function closeImportOverlay() {
  const overlay = $('importOverlay');
  overlay.classList.add('hidden');
  // 清理自定义内容（已下载列表等）
  overlay.querySelectorAll('.dl-file-list, .dl-file-item').forEach((x) => x.remove());
  const ta = overlay.querySelector('textarea');
  if (ta) {
    const inp = document.createElement('input');
    inp.id = 'importInput';
    inp.type = 'text';
    inp.placeholder = '网易云/酷狗/QQ 歌单链接或 ID、B站收藏夹链接（支持 t1.kugou.com 分享短链）';
    ta.replaceWith(inp);
  }
  $('importOk').classList.remove('hidden');
  $('importOk').textContent = '导入';
  $('importCancel').textContent = '取消';
  $('importOk').onclick = () => doImport($('importInput').value);
  overlay.querySelector('.overlay-title').textContent = '导入歌单';
}

/** 打开导入弹窗（歌单链接模式）。统一走 onclick 单一机制（H1 修复：不再 addEventListener 叠加） */
function openImportOpl() {
  closeImportOverlay();
  $('importOverlay').classList.remove('hidden');
  $('importInput').focus();
}

/* ================= 氛围背景（cover 模式：当前播放封面模糊铺底） ================= */
function setAmbient() {
  const el = $('appAmbient'), img = $('appAmbientImg');
  if (!el || !img) return;
  if (currentSkin() !== 'default' || currentBgMode() !== 'cover') return; // 皮肤/预设/自定义/纯色由 applyBackground 接管
  const url = (state.current && state.current.picUrl) ? state.current.picUrl : '';
  if (url) {
    if (img.dataset.url !== url) { img.dataset.url = url; img.src = url; }
    document.body.classList.add('ambient-on');
    el.classList.add('show');
  } else {
    img.removeAttribute('src');
    img.dataset.url = '';
    document.body.classList.remove('ambient-on');
    el.classList.remove('show');
  }
}

/* ================= UI 更新 ================= */
function updatePlayerBar() {
  $('playerBar').classList.remove('hidden');
  $('pbTitle').textContent = state.current ? state.current.title : '';
  $('pbArtist').textContent = state.current ? ((state.current.artist || '') + (state.current.online ? ' · ' + (SRC_NAMES[state.current.source] || '') : '')) : '';
  // 无封面歌曲 → 复位占位图（防残留上一首封面）；远程封面加载失败也回退占位图（防空破图）
  const pbCov = $('pbCoverImg');
  const newSrc = (state.current && state.current.picUrl) ? state.current.picUrl : PLACEHOLDER;
  if (pbCov.getAttribute('src') !== newSrc) {
    pbCov.classList.add('pb-fade');
    const swap = () => { pbCov.src = newSrc; pbCov.onerror = () => { pbCov.src = PLACEHOLDER; }; requestAnimationFrame(() => pbCov.classList.remove('pb-fade')); };
    setTimeout(swap, 130);
  }
  pbCov.onerror = () => { pbCov.src = PLACEHOLDER; };
  // 迷你条背景策略与歌单头部一致：当前封面放大模糊铺底
  $('playerBar').style.setProperty('--pb-img', 'url("' + pbCov.src.replace(/"/g, '') + '")');
  if (FM.active) updateHomeCards(); // 猜你喜欢卡封面随 FM 当前曲更新
  setAmbient();
  updateFavHeart();
}
function updatePlayBtn() {
  const pi = state.playing ? 'pause' : 'play';
  $('pbPlay').innerHTML = icon(pi, 20);
  $('ppPlay').innerHTML = icon(pi, 30);
}
function updateProgressUI() {
  $('ppCur').textContent = fmtDur(state.position);
  $('ppDur').textContent = fmtDur(state.duration);
  const pct = state.duration ? state.position / state.duration : 0;
  $('ppSeek').value = Math.round(pct * 1000);
}
function syncLyrBtn() { const b = $('ppLyricsBtn'); if (b) b.classList.toggle('active', !!PREF.lyrWin); }
function syncLyrLockBtn() { const b = $('ppActLyrLock'); if (!b) return; const locked = PREF.lyrLocked === 1; b.innerHTML = icon(locked ? 'lock' : 'unlock', 22); b.classList.toggle('active', locked); b.title = locked ? '歌词已锁定' : '歌词锁定'; }
const RATE_STEPS = [0.5, 0.75, 1, 1.25, 1.5, 2];
function showPlayerPage() {
  $('playerPage').classList.remove('hidden');
  document.body.classList.add('pp-open');
  syncLyrBtn();
  syncLyrLockBtn();
  startLyricLoop();
  // 底栏高亮跟随：详情页（播放页）打开时"详情"tab 亮起
  document.querySelectorAll('#bottomNav .nav-item').forEach((x) => x.classList.toggle('active', x.dataset.view === 'local'));
  const c = state.current;
  const src = (c && c.picUrl) ? c.picUrl : PLACEHOLDER;
  $('ppCoverImg').src = src;
  $('ppCoverImg').onerror = () => { $('ppCoverImg').src = PLACEHOLDER; };
  $('ppBgImg').src = src;
  $('ppBgImg').onerror = () => { $('ppBgImg').src = PLACEHOLDER; };
  $('ppTitle').textContent = c ? c.title : '';
  $('ppSongTitle').textContent = c ? c.title : '';
  $('ppSongArtist').textContent = c ? (c.artist || '') : '';
  // 音质标签动态化（真实 level；无级别不显示，替代原静态「无损/音效」占位）
  const qt = $('ppQTag');
  if (qt) {
    const n = c ? normQuality(c.level) : '';
    qt.textContent = n ? QUALITY_LABEL[n] : '';
    qt.classList.toggle('hidden', !n);
  }
  updatePlayBtn();
  renderQueue();
  renderPpLyrics();
}
function renderPpLyrics() {
  const cur = $('ppLyricCur');
  const next = $('ppLyricNext');
  if (!state.lrc || !state.lrc.length) {
    cur.textContent = state.current ? '（暂无歌词）' : '';
    next.textContent = '';
    return;
  }
  const idx = state.lrcIndex;
  cur.textContent = (idx >= 0 && idx < state.lrc.length) ? state.lrc[idx].text : '';
  next.textContent = (idx + 1 < state.lrc.length) ? state.lrc[idx + 1].text : '';
}

/* ================= 额外 UI 绑定（播放页互动区/占位按钮/五宫格播放） ================= */
function updateFavHeart() {
  const fv = !!(state.current && isFav(state.current.id));
  const big = $('ppActFav');
  if (big) { big.innerHTML = icon(fv ? 'heartFill' : 'heart', 22); big.style.color = fv ? '#ff5b6e' : ''; }
  const pb = $('pbFav');
  if (pb) { pb.innerHTML = icon(fv ? 'heartFill' : 'heart', 22); pb.classList.toggle('faved', fv); }
}
function downloadCurrent() {
  if (!state.current) { toast('暂无播放中的歌曲'); return; }
  if (state.current.demo) { toast('示例歌单·仅演示，暂不可播放'); return; }
  if (state.current.local) { toast('本地歌曲无需下载'); return; }
  startDownload(state.current);
}
function playFavList() {
  if (!state.favorites.length) { toast('还没有收藏'); return; }
  playList(state.favorites, 0);
}
// 系统伪歌单（我喜欢/已下载/最近播放）：复用歌单详情页（参考每日推荐）
function openSysPlaylist(id, name, songs) {
  if (!songs || !songs.length) { toast('还没有内容'); return; }
  // 补齐音质标签：老收藏/最近快照可能没存 level，按来源+设置补默认显示值
  const norm = songs.map((s) => (s && !s.level ? Object.assign({}, s, { level: qualityToLevel(s.source || 'netease', PREF.onlineQ) }) : s));
  const pl = { id: 'sys:' + id, name, source: 'local', cover: (norm.find((s) => s && s.picUrl) || {}).picUrl || '', songs: norm };
  openOpl(pl);
}
function openFavPlaylist() { openSysPlaylist('fav', '我喜欢', state.favorites.slice()); }
function openRecentPlaylist() { openSysPlaylist('recent', '最近播放', resolveRecent()); }
async function openDlPlaylist() {
  if (!DLR) { openDlList(); return; }
  try {
    const r = await DLR.listDownloaded();
    const files = (r && r.files) || [];
    const songs = files.map((f) => ({ id: 'dlfile:' + f.path, local: true, online: false, source: 'local', uri: f.url, title: f.name.replace(/\.[^.]+$/, ''), artist: '', album: '', duration: 0, picUrl: '' }));
    openSysPlaylist('dl', '已下载', songs);
  } catch (e) { openDlList(); }
}
function bindExtraUi() {
  const on = (id, fn) => { const el = $(id); if (el) el.addEventListener('click', fn); };
  // 播放页互动区（仅真实功能；未上线收进「更多」面板置灰）
  on('ppActLyrLock', async () => {
    const want = !(PREF.lyrLocked === 1);
    const ok = await applyLyrLocked(want);
    if (!ok) { toast('无法切换歌词锁定'); return; }
    syncLyrLockBtn();
    toast(want ? '桌面歌词已锁定' : '桌面歌词已解锁');
  });
  on('ppActDl', downloadCurrent);
  on('ppActFav', () => { if (state.current) { toggleFav(state.current); } else toast('暂无播放中的歌曲'); });
  on('ppActRate', () => {
    const cur = +PREF.rate || 1;
    let i = RATE_STEPS.indexOf(cur); if (i < 0) i = RATE_STEPS.indexOf(1);
    const next = RATE_STEPS[(i + 1) % RATE_STEPS.length];
    PREF.rate = next; savePrefs();
    playerSetRate(next);
    const seg = $('setRate'); if (seg) seg.querySelectorAll('.seg-item').forEach((x) => x.classList.toggle('active', String(+x.dataset.v || 1) === String(next)));
    toast(next === 1 ? '倍速：1.0x（常速）' : '倍速：' + next + 'x');
  });
  on('ppActMore', () => $('ppMoreSheet').classList.remove('hidden'));
  on('sheetCancel', () => $('ppMoreSheet').classList.add('hidden'));
  ['songMoreSheet', 'plSortSheet', 'oplMoreSheet'].forEach((sid) => {
    const ov = $(sid);
    if (ov) ov.addEventListener('click', (e) => {
      if (e.target === ov || e.target.dataset.closeSheet === sid) ov.classList.add('hidden');
    });
  });
  const gotoSetting = (segId) => {
    $('ppMoreSheet').classList.add('hidden');
    setView('me');
    setTimeout(() => { const el = $(segId); if (el) el.scrollIntoView({ block: 'center', behavior: 'smooth' }); }, 150);
  };
  on('sheetSleep', () => gotoSetting('setSleepTimer'));
  on('sheetRate', () => gotoSetting('setRate'));
  // 歌曲胶囊 → 展开全页歌词
  on('ppCapsule', () => { const a = $('ppLyricArea'); if (a) a.click(); });
  // 首页横幅「进入」→ 我的页
  on('btnBannerEnter', () => setView('me'));
  // 统计格：整卡点击进类歌单详情页（参考每日推荐）；我喜欢▶ 直接播放收藏
  on('statFav', openFavPlaylist);
  on('meStatFav', openFavPlaylist);
  on('statFavPlay', (e) => { e.stopPropagation(); playFavList(); });
  on('meStatFavPlay', (e) => { e.stopPropagation(); playFavList(); });
  on('statDl', () => openDlPlaylist());
  on('meStatDl', () => openDlPlaylist());
  on('statRecent', openRecentPlaylist);
  on('meStatRecent', openRecentPlaylist);
  on('statLib', () => { setView('opls'); setOplsTab('library'); });
  on('meStatLib', () => { setView('opls'); setOplsTab('library'); });
  // 用户头部 → 设置区
  on('meUserHeader', () => openSettings());
  // 歌单页/我的页顶部 4 图标（🔍👕📅☰）
  document.querySelectorAll('.me-top-icons .icon-btn').forEach((b) => {
    b.addEventListener('click', () => {
      const x = b.dataset.x;
      if (x === 'search') {
        setView('search');
        $('searchCapsule').classList.add('hidden');
        $('searchExpanded').classList.remove('hidden');
        $('searchInput').focus();
      }
      else if (x === 'settings') { openSettings(); }
      else if (x === 'skin') { openSettings(); }
    });
  });
}
// 打开设置页（记录来源，返回时回原页）
function openSettings() {
  state.settingsFrom = state.view === 'settings' ? (state.settingsFrom || 'me') : state.view;
  setView('settings');
  $('page').scrollTop = 0;
}

/* ================= 事件绑定 ================= */
function bindQualitySeg(el, key) {
  el.querySelectorAll('.seg-item').forEach((b) => {
    b.classList.toggle('active', PREF[key] === b.dataset.q);
    b.addEventListener('click', () => {
      PREF[key] = b.dataset.q;
      savePrefs();
      el.querySelectorAll('.seg-item').forEach((x) => x.classList.toggle('active', x === b));
      toast('音质已设为' + (b.textContent));
    });
  });
}
function bindSourceSeg() {
  const el = $('setSources');
  el.querySelectorAll('.seg-item').forEach((b) => {
    const src = b.dataset.src;
    b.classList.toggle('active', PREF.sources[src]);
    b.addEventListener('click', () => {
      const enabled = Object.values(PREF.sources).filter(Boolean).length;
      if (PREF.sources[src] && enabled <= 1) { toast('至少保留一个音源'); return; }
      PREF.sources[src] = !PREF.sources[src];
      b.classList.toggle('active', PREF.sources[src]);
      savePrefs();
      toast((PREF.sources[src] ? '已启用' : '已停用') + SRC_NAMES[src] + '音源');
    });
  });
}
function bindLyrTransSeg() {
  const el = $('setLyrTrans');
  if (!el) return;
  el.querySelectorAll('.seg-item').forEach((b) => {
    b.classList.toggle('active', (PREF.lyrTrans ? '1' : '0') === b.dataset.v);
    b.addEventListener('click', () => {
      PREF.lyrTrans = b.dataset.v === '1';
      savePrefs();
      el.querySelectorAll('.seg-item').forEach((x) => x.classList.toggle('active', x === b));
      toast('歌词翻译已' + (PREF.lyrTrans ? '开启' : '关闭'));
      // 立即重渲染歌词生效
      if (state.lrc.length) renderLyrics();
    });
  });
}
/* 播放倍速：设置 seg（0.5-2.0，对齐桌面 6 档），持久化并在切歌后重新下发 */
function bindRateSeg() {
  const el = $('setRate');
  if (!el) return;
  const cur = String(+PREF.rate || 1);
  el.querySelectorAll('.seg-item').forEach((x) => x.classList.toggle('active', x.dataset.v === cur));
  el.querySelectorAll('.seg-item').forEach((b) => {
    b.addEventListener('click', () => {
      PREF.rate = +b.dataset.v || 1;
      savePrefs();
      el.querySelectorAll('.seg-item').forEach((x) => x.classList.toggle('active', x === b));
      playerSetRate(PREF.rate);
      toast(PREF.rate === 1 ? '倍速：1.0x（常速）' : '倍速：' + PREF.rate + 'x');
    });
  });
}

/* 睡眠定时：关/15/30/60/自定义(1-360) 分，到点自动暂停（对齐桌面设置-定时） */
let sleepTimerId = null;
function bindSleepTimerSeg() {
  const el = $('setSleepTimer');
  if (!el) return;
  const apply = (min) => {
    clearTimeout(sleepTimerId);
    sleepTimerId = null;
    const presets = ['0', '15', '30', '60'];
    const customBtn = el.querySelector('.seg-item[data-v="custom"]');
    el.querySelectorAll('.seg-item').forEach((x) => {
      if (x.dataset.v === 'custom') return;
      x.classList.toggle('active', x.dataset.v === String(min) && presets.includes(String(min)));
    });
    if (customBtn) {
      const isCustom = !presets.includes(String(min)) && min > 0;
      customBtn.classList.toggle('active', isCustom);
      customBtn.textContent = isCustom ? min + '分' : '自定义';
    }
    if (min > 0) {
      sleepTimerId = setTimeout(() => { toast('睡眠定时到点，已暂停播放'); playerPause(); sleepTimerId = null; }, min * 60000);
      toast('睡眠定时：' + min + ' 分钟后暂停');
    } else {
      toast('睡眠定时已关闭');
    }
  };
  el.querySelectorAll('.seg-item').forEach((b) => {
    b.addEventListener('click', () => {
      if (b.dataset.v === 'custom') {
        const ov = $('sleepOverlay');
        if (!ov) { toast('自定义定时不可用'); return; }
        $('sleepInput').value = PREF.sleepMin > 0 && !['0', '15', '30', '60'].includes(String(PREF.sleepMin)) ? PREF.sleepMin : '';
        ov.classList.remove('hidden');
        $('sleepInput').focus();
        return;
      }
      PREF.sleepMin = +b.dataset.v;
      savePrefs();
      apply(+b.dataset.v);
    });
  });
  // 恢复上次选中态（含自定义分钟数）
  apply(PREF.sleepMin || 0);
}
function bindSleepOverlay() {
  const close = () => $('sleepOverlay').classList.add('hidden');
  if (!$('sleepOverlay')) return;
  $('sleepCancel').addEventListener('click', close);
  $('sleepOverlay').addEventListener('click', (e) => { if (e.target === $('sleepOverlay')) close(); });
  $('sleepOk').addEventListener('click', () => {
    const min = Math.floor(+$('sleepInput').value);
    if (!min || min < 1 || min > 360) { toast('请输入 1-360 的分钟数'); return; }
    PREF.sleepMin = min;
    savePrefs();
    close();
    bindSleepTimerSegApply(min);
  });
  $('sleepInput').addEventListener('keydown', (e) => { if (e.key === 'Enter') $('sleepOk').click(); });
}
// 睡眠弹窗确认后套用（复用 bindSleepTimerSeg 的 apply 逻辑：直接触发对应 seg 行为）
function bindSleepTimerSegApply(min) {
  clearTimeout(sleepTimerId);
  sleepTimerId = null;
  const el = $('setSleepTimer');
  if (el) {
    const customBtn = el.querySelector('.seg-item[data-v="custom"]');
    el.querySelectorAll('.seg-item').forEach((x) => { if (x.dataset.v !== 'custom') x.classList.remove('active'); });
    if (customBtn) { customBtn.classList.add('active'); customBtn.textContent = min + '分'; }
  }
  sleepTimerId = setTimeout(() => { toast('睡眠定时到点，已暂停播放'); playerPause(); sleepTimerId = null; }, min * 60000);
  toast('睡眠定时：' + min + ' 分钟后暂停');
}

/* ================= 歌单详情页内搜索（对齐 PC 歌单内搜索） ================= */
// 按关键词过滤 songs 并渲染；idx 始终取原数组索引（点击播放/批量定位依赖它）
function fillFiltered(listEl, songs, rowOpts) {
  const kw = String(state.detailFilter || '').trim().toLowerCase();
  let arr = kw ? songs.filter((s) => ((s.title || '') + ' ' + (s.artist || '') + ' ' + (s.album || '')).toLowerCase().includes(kw)) : songs;
  arr = arr.filter(filterMatches); // 详情页筛选 AND 叠加（对齐 PC visibleList 顺序 text→dl→src→q）
  if (rowOpts.plDetail && state.plSort) {
    arr = arr.slice();
    if (state.plSort === 'name') arr.sort((a, b) => String(a.title || '').localeCompare(String(b.title || ''), 'zh'));
    else if (state.plSort === 'artist') arr.sort((a, b) => String(a.artist || '').localeCompare(String(b.artist || ''), 'zh'));
    else if (state.plSort === 'dur') arr.sort((a, b) => (b.duration || 0) - (a.duration || 0));
  }
  listEl.innerHTML = '';
  const frag = document.createDocumentFragment();
  if (gridMode && rowOpts.grid !== false && arr.length) {
    listEl.className = listEl.className.replace(/\s*g-grid/, '') + ' g-grid';
    arr.forEach((s, i) => frag.appendChild(gridCard(s, songs, songs.indexOf(s))));
  } else {
    listEl.className = listEl.className.replace(/\s*g-grid/, '');
    arr.forEach((s, i) => frag.appendChild(songRow(s, Object.assign({ list: songs, idx: songs.indexOf(s) }, rowOpts))));
  }
  if (!arr.length && (kw || dFilterActive())) listEl.innerHTML = '<div class="hint">无匹配歌曲 — 试试清除筛选</div>';
  else listEl.appendChild(frag);
}

/* ================= 详情页筛选（对齐 PC filterPopup：三行单选、AND、无持久化、切视图重置） ================= */
const dFilter = { dl: 'all', src: 'all', q: 'all' };
function dFilterActive() { return dFilter.dl !== 'all' || dFilter.src !== 'all' || dFilter.q !== 'all'; }
function resetDFilter() { dFilter.dl = 'all'; dFilter.src = 'all'; dFilter.q = 'all'; }
function isDlSong(s) { return !!s.local; } // 已下载=入库本地曲（PC down=非 online 同义）
function filterMatches(s) {
  if (!s) return false;
  if (dFilter.dl === 'down' && !isDlSong(s)) return false;
  if (dFilter.dl === 'undown' && isDlSong(s)) return false;
  if (dFilter.src !== 'all') {
    if (dFilter.src === 'local') { if (!isDlSong(s)) return false; }
    else if (s.source !== dFilter.src || !s.online) return false;
  }
  if (dFilter.q !== 'all' && normQuality(s.level) !== dFilter.q) return false;
  return true;
}
function openFilterPopup() {
  const anyQ = (state.list || []).some((s) => s && normQuality(s.level));
  $('fpQLabel').classList.toggle('hidden', !anyQ);
  $('fpQ').classList.toggle('hidden', !anyQ);
  ['fpDl', 'fpSrc', 'fpQ'].forEach((id) => {
    const key = id === 'fpDl' ? 'dl' : id === 'fpSrc' ? 'src' : 'q';
    $(id).querySelectorAll('.seg-item').forEach((b) => b.classList.toggle('active', b.dataset.f === dFilter[key]));
  });
  $('filterOverlay').classList.remove('hidden');
}
function bindFilterPopup() {
  const bindRow = (id, key) => {
    $(id).querySelectorAll('.seg-item').forEach((b) => {
      b.addEventListener('click', () => {
        dFilter[key] = b.dataset.f;
        $(id).querySelectorAll('.seg-item').forEach((x) => x.classList.toggle('active', x === b));
        rerenderCurrentDetail();
      });
    });
  };
  bindRow('fpDl', 'dl'); bindRow('fpSrc', 'src'); bindRow('fpQ', 'q');
  $('fpReset').addEventListener('click', () => { resetDFilter(); rerenderCurrentDetail(); openFilterPopup(); });
  $('fpOk').addEventListener('click', () => $('filterOverlay').classList.add('hidden'));
  $('filterOverlay').addEventListener('click', (e) => { if (e.target === $('filterOverlay')) $('filterOverlay').classList.add('hidden'); });
}

/* ================= 详情页视图模式（对齐 PC gridMode：列表/封面墙两态，LS 持久化） ================= */
let gridMode = LS.load('grid', 0) === 1 ? 1 : 0;
function gridCard(s, list, idx) {
  const card = document.createElement('div');
  card.className = 'grid-card' + (state.current && state.current.id === s.id ? ' playing' : '');
  const cov = document.createElement('div');
  cov.className = 'gc-cover';
  if (s.picUrl) {
    const img = document.createElement('img');
    img.src = s.picUrl;
    img.onerror = () => img.remove();
    cov.appendChild(img);
  }
  const t = document.createElement('div'); t.className = 'gc-title'; t.textContent = s.title || '';
  const sub = document.createElement('div'); sub.className = 'gc-sub'; sub.textContent = s.artist || '';
  card.append(cov, t, sub);
  card.addEventListener('click', () => playFrom(s, list, idx));
  return card;
}
function rerenderCurrentDetail() {
  if (state.view === 'opldetail' && state.currentPl) openOpl(state.currentPl, true);
  else if (state.view === 'mylistdetail' && state.currentMylist) openMylist(state.currentMylist.id, true);
  else if (state.view === 'localdetail' && state.currentLocalDetail) openLocalDetail(state.currentLocalDetail.kind, state.currentLocalDetail.item, true);
}
function bindDhViewBtns() {
  const fb = $('btnDhFilter');
  if (fb) fb.addEventListener('click', openFilterPopup);
  const gb = $('btnDhGrid');
  if (gb) {
    gb.innerHTML = icon(gridMode ? 'list' : 'grid', 14) + (gridMode ? ' 列表' : ' 封面墙');
    gb.addEventListener('click', () => {
      gridMode = gridMode ? 0 : 1;
      LS.save('grid', gridMode);
      rerenderCurrentDetail();
    });
  }
}
function resetDetailFilter(inputId) {
  state.detailFilter = '';
  const f = $(inputId);
  if (f) f.value = '';
}
function bindDetailFilters() {
  const map = [
    ['oplDetailFilter', () => { if (state.currentPl) openOpl(state.currentPl, true); }],
    ['mylistDetailFilter', () => { if (state.currentMylist) openMylist(state.currentMylist.id, true); }],
    ['localDetailFilter', () => { const d = state.currentLocalDetail; if (d) openLocalDetail(d.kind, d.item, true); }]
  ];
  map.forEach(([id, rerender]) => {
    const el = $(id);
    if (!el) return;
    el.addEventListener('input', () => { state.detailFilter = el.value; rerender(); });
  });
}

/* ================= 搜索结果来源过滤（对齐 PC 来源分段） ================= */
function bindSearchSrcTabs() {
  const wrap = $('searchSrcTabs');
  if (!wrap) return;
  wrap.querySelectorAll('.home-source-tab').forEach((b) => {
    b.addEventListener('click', () => {
      state.searchSrcFilter = b.dataset.sfilter;
      wrap.querySelectorAll('.home-source-tab').forEach((x) => x.classList.toggle('active', x === b));
      renderSearchList();
    });
  });
}
function renderSearchList() {
  const listEl = $('searchList');
  if (!listEl) return;
  const f = state.searchSrcFilter || 'all';
  const arr = f === 'all' ? state.searchResults : state.searchResults.filter((s) => s.source === f);
  state.list = arr;
  listEl.innerHTML = '';
  arr.forEach((s, i) => listEl.appendChild(songRow(s, { list: arr, idx: i })));
  if (!arr.length) listEl.innerHTML = '<div class="hint">该来源无结果</div>';
}

/* ================= 全页歌词（对齐 PC 歌曲详情页：行点击跳转、全页滚动） ================= */
function closePlayerPage() {
  $('playerPage').classList.add('hidden');
  $('playerPage').classList.remove('lyric-full'); // 防全页歌词态残留到下次打开
  $('ppLyricFull').classList.add('hidden');
  document.body.classList.remove('pp-open');
  // 底栏高亮恢复到当前视图页（离开详情页）
  const navMap = { search: 'search', opls: 'opls', opldetail: 'opls', mylistdetail: 'opls', local: 'search', localdetail: 'search', me: 'me' };
  document.querySelectorAll('#bottomNav .nav-item').forEach((x) => x.classList.toggle('active', x.dataset.view === (navMap[state.view] || 'search')));
}
function bindFullLyric() {
  const page = $('playerPage'), area = $('ppLyricArea'), full = $('ppLyricFull');
  if (!page || !area || !full) return;
  area.addEventListener('click', () => {
    if (page.classList.contains('hidden')) return;
    page.classList.add('lyric-full');
    full.classList.remove('hidden');
    full.scrollTop = 0;
    const cur = full.querySelector('.lyric-line.cur');
    if (cur && cur.scrollIntoView) cur.scrollIntoView({ block: 'center' });
  });
  full.addEventListener('click', (e) => {
    if (e.target.closest('.lyric-line')) return; // 歌词行走 seek 逻辑
    page.classList.remove('lyric-full');
    full.classList.add('hidden');
  });
}

function bind() {
  // 点击空白处关闭弹层：overlay 点遮罩本体关闭；drawer 点其外部关闭（捕获阶段，避免误伤打开它的那次点击）
  document.addEventListener('click', (e) => {
    document.querySelectorAll('.overlay:not(.hidden)').forEach((ov) => { if (e.target === ov) ov.classList.add('hidden'); });
    document.querySelectorAll('.drawer:not(.hidden)').forEach((dr) => { if (!dr.contains(e.target)) dr.classList.add('hidden'); });
  }, true);
  $('searchBtn').addEventListener('click', doSearch);
  $('searchInput').addEventListener('keydown', (e) => { if (e.key === 'Enter') doSearch(); });
  // 搜索胶囊点击 → 展开搜索框
  const openSearch = () => {
    $('searchCapsule').classList.add('hidden');
    $('searchExpanded').classList.remove('hidden');
    $('searchInput').focus();
  };
  $('searchCapsule').addEventListener('click', openSearch);
  const hs = $('homeSearchBtn'); if (hs) hs.addEventListener('click', openSearch);
  const hset = $('homeSettingsBtn'); if (hset) hset.addEventListener('click', () => openSettings());
  // 首页顶部 tab 切换（乐库已迁走，仅剩推荐；保留兼容空实现）
  document.querySelectorAll('.home-top-tab').forEach((b) => {
    b.addEventListener('click', () => setHomeTab(b.dataset.htab));
  });
  // 歌单页 音乐/曲库 tab 切换
  document.querySelectorAll('#pageOpls .me-top-tab[data-otab]').forEach((b) => {
    b.addEventListener('click', () => setOplsTab(b.dataset.otab));
  });
  // 歌单页 三分类锚点胶囊 → 滚动到对应分区
  document.querySelectorAll('#pageOpls .pl-cap').forEach((b) => {
    b.addEventListener('click', () => gotoOplsSection(b.dataset.plcap));
  });
  // 滚动联动：滚到哪个分区，对应胶囊高亮
  let plSpyRaf = 0;
  const plSpy = () => {
    if (state.view !== 'opls' || oplsTab !== 'music') return;
    const page = $('page'); if (!page) return;
    const pr = page.getBoundingClientRect();
    let active = 'myPlSec';
    ['myPlSec', 'recentPlSec', 'tempPlSec'].forEach((sid) => {
      const el = $(sid); if (!el) return;
      if (el.getBoundingClientRect().top - pr.top <= 88) active = sid;
    });
    document.querySelectorAll('#pageOpls .pl-cap').forEach((c) => c.classList.toggle('active', c.dataset.plcap === active));
  };
  const pageEl = $('page');
  if (pageEl) pageEl.addEventListener('scroll', () => { if (plSpyRaf) return; plSpyRaf = requestAnimationFrame(() => { plSpyRaf = 0; plSpy(); }); }, { passive: true });
  // 边缘右滑返回：仅子页、从左边缘(<26px)起、横向位移主导且够长时触发
  if (pageEl) {
    let sx = 0, sy = 0, sTracking = false;
    const isSubView = () => ['opldetail', 'mylistdetail', 'localdetail', 'recentpls', 'plcat', 'settings', 'settingsub'].includes(state.view);
    pageEl.addEventListener('touchstart', (e) => {
      const t = e.touches[0];
      sTracking = t.clientX <= 26 && isSubView() && !state.batch.mode;
      sx = t.clientX; sy = t.clientY;
    }, { passive: true });
    pageEl.addEventListener('touchend', (e) => {
      if (!sTracking) { sTracking = false; return; }
      sTracking = false;
      const t = e.changedTouches[0];
      const dx = t.clientX - sx, dy = Math.abs(t.clientY - sy);
      if (dx > 70 && dy < 50) backFromDetail();
    }, { passive: true });
  }
  // 歌单页 分区"更多" → 完整列表页
  document.querySelectorAll('#pageOpls .pl-more').forEach((b) => {
    b.addEventListener('click', () => openPlCategory(b.dataset.plcat));
  });
  // 设置分类行 → 跳转子页
  const SETCAT_TITLE = { general: '常规', ui: '外观', src: '音源与音质', lyr: '歌词', account: '账号', data: '数据与维护' };
  document.querySelectorAll('.set-cat-row').forEach((r) => {
    r.addEventListener('click', () => {
      const cat = r.dataset.setcat;
      document.querySelectorAll('#pageSettingsSub .set-cat-body').forEach((b) => b.classList.toggle('hidden', b.dataset.setcat !== cat));
      setView('settingsub', { title: SETCAT_TITLE[cat] || '设置' });
      $('page').scrollTop = 0;
    });
  });
  const qk = (id, fn) => { const b = $(id); if (b) b.addEventListener('click', fn); };
  qk('btnClearCache', () => clearTempCaches());
  qk('dlMore', () => openDlPlaylist());
  // 我的页：点头像换头像（改名按钮由 applyMeProfile 绑定）
  applyMeProfile();
  qk('meAvatar', () => { const f = $('avatarPick'); if (f) f.click(); });
  const ap = $('avatarPick');
  if (ap) ap.addEventListener('change', () => {
    const file = ap.files && ap.files[0]; if (!file) return;
    const fr = new FileReader();
    fr.onload = () => {
      const img = new Image();
      img.onload = () => {
        const c = document.createElement('canvas'); const side = Math.min(img.width, img.height); const S = 200;
        c.width = S; c.height = S;
        const ctx = c.getContext('2d');
        ctx.drawImage(img, (img.width - side) / 2, (img.height - side) / 2, side, side, 0, 0, S, S);
        try { PREF.avatar = c.toDataURL('image/jpeg', 0.82); savePrefs(); applyMeProfile(); toast('头像已更新'); } catch (e) { toast('头像设置失败'); }
      };
      img.onerror = () => toast('图片读取失败');
      img.src = fr.result;
    };
    fr.readAsDataURL(file);
    ap.value = '';
  });
  // 我的页 hero 卡片：自定义背景图（等比缩到最长边 1000px 后存 dataURL）
  qk('btnHeroCard', () => { const f = $('heroPick'); if (f) f.click(); });
  const hp = $('heroPick');
  if (hp) hp.addEventListener('change', () => {
    const file = hp.files && hp.files[0]; if (!file) return;
    const fr = new FileReader();
    fr.onload = () => {
      const img = new Image();
      img.onload = () => {
        const max = 1000; let w = img.width, h = img.height;
        const scale = Math.min(1, max / Math.max(w, h));
        w = Math.round(w * scale); h = Math.round(h * scale);
        const c = document.createElement('canvas'); c.width = w; c.height = h;
        const ctx = c.getContext('2d'); ctx.drawImage(img, 0, 0, w, h);
        try { PREF.heroCard = c.toDataURL('image/jpeg', 0.82); savePrefs(); applyHeroCard(); toast('卡片背景已更新'); } catch (e) { toast('图片设置失败'); }
      };
      img.onerror = () => toast('图片读取失败');
      img.src = fr.result;
    };
    fr.readAsDataURL(file);
    hp.value = '';
  });
  // 首页卡片点击播放（猜你喜欢与卡片副标题共用混合池）
  $('cardGuess').addEventListener('click', () => startGuessFm());
  $('cardDaily').addEventListener('click', () => openDailyPlaylist());
  $('cardRecent').addEventListener('click', () => gotoOplsSection('recentPlSec'));
  // 音源胶囊标签切换
  document.querySelectorAll('.home-source-tab').forEach((b) => {
    b.addEventListener('click', () => {
      document.querySelectorAll('.home-source-tab').forEach((x) => x.classList.remove('active'));
      b.classList.add('active');
      const src = b.dataset.src;
      const ne = $('recNetease');
      const kg = $('recKugou');
      if (src === 'all') { if (ne) ne.style.display = ''; if (kg) kg.style.display = ''; }
      else if (src === 'netease') { if (ne) ne.style.display = ''; if (kg) kg.style.display = 'none'; }
      else if (src === 'kugou') { if (ne) ne.style.display = 'none'; if (kg) kg.style.display = ''; }
    });
  });
  // 迷你播放器按钮
  $('pbFav').addEventListener('click', (e) => { e.stopPropagation(); if (state.current) toggleFav(state.current); });
  $('pbQueue').addEventListener('click', (e) => { e.stopPropagation(); $('queuePanel').classList.remove('hidden'); updateQueueUI(); });
  $('btnImportOpl').addEventListener('click', () => { openImportOpl(); });
  $('importCancel').addEventListener('click', closeImportOverlay);
  $('btnExportSync').addEventListener('click', openExportSync);
  $('btnImportSync').addEventListener('click', openImportSync);
  if ($('btnLanSync')) $('btnLanSync').addEventListener('click', () => {
    const peer = LS.load('lanpeer', null);
    if (peer) { if ($('lanHost')) $('lanHost').value = peer.host || ''; if ($('lanCode')) $('lanCode').value = peer.code || ''; }
    const st = $('lanStatus'); if (st) { st.textContent = ''; st.className = 'lan-status'; }
    const asw = $('lanAutoSync'); if (asw) asw.checked = !!PREF.autoSync;
    renderBoundList();
    $('lanSheet').classList.remove('hidden');
  });
  if ($('lanClose')) $('lanClose').addEventListener('click', () => $('lanSheet').classList.add('hidden'));
  if ($('lanGo')) $('lanGo').addEventListener('click', pairSync);
  if ($('lanAutoSync')) $('lanAutoSync').addEventListener('change', (e) => {
    PREF.autoSync = e.target.checked ? 1 : 0; savePrefs();
    if (!PREF.autoSync) { clearTimeout(_asTimer); clearTimeout(_asRetryTimer); }
    else if (Object.values(loadBindings()).some((b) => b && b.token)) scheduleAutoSync(3000);
    toast(PREF.autoSync ? '已开启自动同步' : '已关闭自动同步');
  });
  if ($('lanNow')) $('lanNow').addEventListener('click', () => autoSync('manual'));
  if ($('lanScanBtn')) $('lanScanBtn').addEventListener('click', async () => {
    const box = $('lanFound'), btn = $('lanScanBtn');
    const LD = window.Capacitor && window.Capacitor.Plugins && window.Capacitor.Plugins.LanDiscovery;
    if (!LD) { if (box) box.innerHTML = '<div class="lan-found-empty">当前环境不支持自动扫描，请手动填地址</div>'; return; }
    if (btn) btn.disabled = true; if (box) box.innerHTML = '<div class="lan-found-empty">扫描中…</div>';
    try {
      const r = await LD.scan({ discPort: 41230, timeoutMs: 2500 });
      const devs = (r && r.devices) || [];
      if (!devs.length) { if (box) box.innerHTML = '<div class="lan-found-empty">未发现电脑：确认电脑端已开启同步、且连的是同一 WiFi</div>'; }
      else if (box) {
        box.innerHTML = '';
        devs.forEach((d) => {
          const it = document.createElement('button'); it.className = 'lan-found-item';
          it.textContent = (d.name || '深空折韵') + '  ' + d.ip + ':' + d.port;
          it.addEventListener('click', () => { if ($('lanHost')) $('lanHost').value = 'http://' + d.ip + ':' + d.port; box.querySelectorAll('.lan-found-item').forEach((x) => x.classList.remove('sel')); it.classList.add('sel'); });
          box.appendChild(it);
        });
      }
    } catch (e) { if (box) box.innerHTML = '<div class="lan-found-empty">扫描失败：' + ((e && e.message) || e) + '</div>'; }
    finally { if (btn) btn.disabled = false; }
  });
  if ($('btnManageAcc')) $('btnManageAcc').addEventListener('click', () => { renderAccManager(); $('accSheet').classList.remove('hidden'); });
  if ($('accSheetClose')) $('accSheetClose').addEventListener('click', () => $('accSheet').classList.add('hidden'));
  if ($('accCreateBtn')) $('accCreateBtn').addEventListener('click', () => { const id = createAccount(''); switchAccount(id); renderAccManager(); renderCurAccount(); toast('已新建账号，点顶部名字可改名'); });
  if ($('btnDlList')) $('btnDlList').addEventListener('click', openDlList);
  if ($('btnDlClear')) $('btnDlClear').addEventListener('click', () => {
    const hasTasks = Object.values(state.dlTasks).some((t) => ['queued', 'resolving', 'downloading', 'cover', 'tagging', 'error'].includes(t.status));
    if (!dlManage && !hasTasks) { toast('暂无可管理的下载任务'); return; }
    dlManage = !dlManage;
    $('btnDlClear').textContent = dlManage ? '完成' : '管理任务';
    renderDlTasks();
  });
  $('btnLocalRefresh').addEventListener('click', scanLocal);
  $('localSearch').addEventListener('input', () => { if (state.localTab === 'songs') renderLocalFiltered(); });
  $('topBack').addEventListener('click', backFromDetail);
  $('pbPlay').addEventListener('click', togglePlay);
  $('playerBar').addEventListener('click', (e) => { if (e.target.closest('button')) return; showPlayerPage(); });
  $('ppBack').addEventListener('click', () => {
    const page = $('playerPage');
    if (page.classList.contains('lyric-full')) { page.classList.remove('lyric-full'); $('ppLyricFull').classList.add('hidden'); return; }
    closePlayerPage();
  });
  $('ppPlay').addEventListener('click', togglePlay);
  $('ppNext').addEventListener('click', playNext);
  $('ppPrev').addEventListener('click', playPrev);
  $('ppMode').addEventListener('click', () => {
    state.mode = state.mode === 'order' ? 'repeat' : (state.mode === 'repeat' ? 'shuffle' : 'order');
    $('ppMode').innerHTML = icon(state.mode === 'order' ? 'modeOrder' : state.mode === 'repeat' ? 'modeRepeat' : 'modeShuffle', 22);
    if (state.mode === 'shuffle') rebuildShuffle();
    LS.save('mode', state.mode);
    toast('播放模式：' + (state.mode === 'order' ? '顺序' : state.mode === 'repeat' ? '单曲循环' : '随机'));
  });
  $('ppLyricsBtn').addEventListener('click', async () => {
    const want = PREF.lyrWin ? 0 : 1;
    const ok = await toggleLyrWin(!!want);
    if (ok) { PREF.lyrWin = want; savePrefs(); }
    const seg = $('setLyrWin');
    if (seg) seg.querySelectorAll('.seg-item').forEach((x) => x.classList.toggle('active', (+x.dataset.v ? 1 : 0) === (PREF.lyrWin ? 1 : 0)));
    syncLyrBtn();
    toast(PREF.lyrWin ? '桌面歌词已开启' : '桌面歌词已关闭');
  });
  $('btnCloseQueue').addEventListener('click', () => $('queuePanel').classList.add('hidden'));
  enableHandleDragSort($('mylistDetailList'), reorderMylistSongs); // 我的歌单内歌曲拖拽排序
  bindTagEditor();
  bindDupes();
  $('ppSeek').addEventListener('input', (e) => {
    const t = (+e.target.value / 1000) * state.duration;
    $('ppCur').textContent = fmtDur(t);
  });
  $('ppSeek').addEventListener('change', (e) => {
    const t = (+e.target.value / 1000) * state.duration;
    playerSeek(t);
  });
  document.querySelectorAll('#bottomNav .nav-item').forEach((b) => {
    b.addEventListener('click', () => {
      const v = b.dataset.view;
      const ppOpen = document.body.classList.contains('pp-open');
      if (v === 'local') {
        if (!ppOpen) { showPlayerPage(); }
        else { const pp = $('playerPage'); if (pp && pp.classList.contains('lyric-full')) { pp.classList.remove('lyric-full'); const fl = $('ppLyricFull'); if (fl) fl.classList.add('hidden'); } }
      } else {
        if (ppOpen) closePlayerPage(); // 底栏常驻后：切页即收起播放页
        if (v === 'search') { setView('search'); setHomeTab('recommend'); }
        else { setView(v); }
      }
    });
  });
  document.querySelectorAll('.home-tab').forEach((b) => {
    b.addEventListener('click', () => setHomeTab(b.dataset.homeTab));
  });
  document.querySelectorAll('.seg-item[data-local-tab]').forEach((b) => {
    b.addEventListener('click', () => {
      state.localTab = b.dataset.localTab;
      document.querySelectorAll('.seg-item[data-local-tab]').forEach((x) => x.classList.toggle('active', x === b));
      scanLocal();
    });
  });
  bindQualitySeg($('setOnlineQuality'), 'onlineQ');
  bindQualitySeg($('setDlQuality'), 'dlQ');
  bindLyrTransSeg();
  bindRateSeg();
  bindSleepTimerSeg();
  bindSleepOverlay();
  bindSourceSeg();
  bindMylistUi();
  bindAppearanceSegs();
  bindDetailFilters();
  bindSearchSrcTabs();
  bindFullLyric();
  // 批量操作条
  // 批量条图标注入（描边 SVG，图标在上文字在下）
  const bbIcons = { batchSelAll: 'multiSelect', batchPlay: 'play', batchFav: 'heart', batchDl: 'download', batchPl: 'list' };
  Object.entries(bbIcons).forEach(([id, ic]) => { const b = $(id); if (b) b.insertAdjacentHTML('afterbegin', icon(ic, 20)); });
  const bbx = $('batchCancel'); if (bbx) bbx.innerHTML = icon('close', 15);
  $('batchSelAll').addEventListener('click', batchSelectAll);
  $('batchPlay').addEventListener('click', () => batchPlaySelected());
  $('batchFav').addEventListener('click', () => batchFavSelected());
  $('batchDl').addEventListener('click', batchDlSelected);
  $('batchCancel').addEventListener('click', exitBatch);
}

/* ================= 启动 ================= */
(async function boot() {
  bind();
  try { bindExtraUi(); } catch (e) { console.log('[extra-ui] bind fail:', e); }
  applyAppearance(); // 应用用户外观设置（主题/皮肤）
  bindAmbientSettings(); // 氛围背景开关/强度/模糊（对齐 PC 设置-背景）
  bindProgressStyleSeg(); // 进度条样式（对齐 PC mp_progress_style）
  bindGuessFmSettings(); // 猜你喜欢续播/尝新设置
  bindLyrWinSeg(); // 桌面歌词悬浮窗开关
  // 悬浮窗控制条事件（上一首/播放暂停/下一首）+ 锁定状态回存
  {
    const P = window.Capacitor && window.Capacitor.Plugins;
    if (P && P.LyricsWin) {
      P.LyricsWin.addListener('ctrl', (d) => {
        const a = d && d.action;
        if (a === 'prev') playPrev();
        else if (a === 'toggle') togglePlay();
        else if (a === 'next') playNext();
        else if (a === 'lock') applyLyrLocked(!(PREF.lyrLocked === 1));
        else if (a === 'close') {
          PREF.lyrWin = 0;
          savePrefs();
          const seg = $('setLyrWin');
          if (seg) seg.querySelectorAll('.seg-item').forEach((b) => b.classList.toggle('active', (+b.dataset.v ? 1 : 0) === 0));
        }
      });
      P.LyricsWin.addListener('lock', (d) => {
        // 原生侧状态变化（悬浮窗短按解锁等）→ 同步 PREF 与设置页开关
        PREF.lyrLocked = d && d.locked ? 1 : 0;
        savePrefs();
        const seg = $('setLyrLock');
        if (seg) seg.querySelectorAll('.seg-item').forEach((b) => b.classList.toggle('active', (+b.dataset.v ? 1 : 0) === (PREF.lyrLocked ? 1 : 0)));
      });
    }
  }
  bindLyrWinStyle(); // 桌面歌词样式（字号/透明度/底色/双色）
  bindUpdateUi(); // 应用内检查更新
  // 网易云账号（扫码登录/退出/收藏夹导入）
  {
    const btn = $('accNeteaseBtn'), imp = $('accNeteaseImport');
    if (btn) btn.addEventListener('click', async () => {
      if (NE.loggedIn()) {
        if (confirm('退出网易云账号？')) { NE.logout(); addTombstone('acc:netease'); refreshAccountUI(); toast('已退出登录'); }
      } else openNeteaseLogin();
    });
    if (imp) imp.addEventListener('click', importMyPlaylists);
    const bbtn = $('accBiliBtn'), bimp = $('accBiliImport');
    if (bbtn) bbtn.addEventListener('click', () => {
      if (biliGetAcc()) {
        if (confirm('退出B站账号？')) { biliSetAcc(null); addTombstone('acc:bilibili'); refreshBiliUI(); toast('已退出B站账号'); }
      } else openBiliLogin();
    });
    if (bimp) bimp.addEventListener('click', importMyBiliFavs);
    const kbtn = $('accKgBtn'), kimp = $('accKgImport');
    if (kbtn) kbtn.addEventListener('click', () => {
      if (KG.loggedIn()) {
        if (confirm('退出酷狗账号？')) { KG.logout(); addTombstone('acc:kugou'); refreshKgUI(); toast('已退出酷狗账号'); }
      } else openKgLogin();
    });
    if (kimp) kimp.addEventListener('click', importMyKgPlaylists);
    // 账号管理二级弹层
    bindPullRefresh();
    const lc = $('loginCancel'), lr = $('loginRefresh');
    if (lc) lc.addEventListener('click', () => { stopLoginPoll(); $('loginOverlay').classList.add('hidden'); });
    if (lr) lr.addEventListener('click', () => {
      if (state.loginPlat === 'bili') openBiliLogin();
      else if (state.loginPlat === 'kugou') openKgLogin();
      else openNeteaseLogin();
    });
    // 已登录但缺 uid（旧版登录未存）→ accountInfo 补齐
    (async () => {
      if (NE.loggedIn() && !NE.getState().uid) {
        const info = await NE.accountInfo().catch(() => ({ ok: false }));
        if (info.ok) NE.setState(Object.assign(NE.getState(), { account: info.nickname, avatar: info.avatar, uid: info.uid }));
      }
      refreshAccountUI();
      refreshBiliUI();
      refreshKgUI();
      loadDaily();
    })();
  }
  bindFilterPopup(); // 详情页筛选弹层
  await initPlayer();
  renderOpls();
  renderFavs();
  renderRecent();
  renderDlTasks();
  renderHomeRecs();
  updateHomeCards();
  renderHomeSections();
  backfillKgCoversAll(); // 旧酷狗歌单封面后台补齐
  // 后台预扫本地媒体库（填充最近播放解析池；权限未给则静默忽略）
  if (MS) scanLocal().catch(() => {});
  // 恢复上次播放状态（播放条）；无历史歌也要复位封面（防空 src 破图）
  const last = LS.load('last', null);
  if (last && last.title) state.current = last;
  updatePlayerBar();
  // 恢复播放模式
  const mode = LS.load('mode', 'order');
  if (['order', 'repeat', 'shuffle'].includes(mode)) { state.mode = mode; $('ppMode').innerHTML = icon(mode === 'order' ? 'modeOrder' : mode === 'repeat' ? 'modeRepeat' : 'modeShuffle', 22); }
  consumeSharedImport(); // 分享导入：其他 App 分享歌单链接/ID → 预填导入框
  wireShareImport();     // 运行中收到分享（onNewIntent → shareReceived 事件）
  // 桌面歌词悬浮窗恢复（上次开着 → 重建悬浮窗）
  if (PREF.lyrWin) { (async () => { try { const P = window.Capacitor.Plugins; if (P && P.LyricsWin) { const r = await P.LyricsWin.canDrawOverlays(); if (r && r.ok) { await P.LyricsWin.show({ line1: (state.current && state.current.title) || '深空折韵', line2: '' }); try { P.LyricsWin.setStyle(lyrStylePayload()); if (PREF.lyrLocked) await P.LyricsWin.setLocked({ locked: true }); } catch (e) {} } } } catch (e) {} })(); }
  // v4 自动同步触发：启动后一次 + 回前台一次 + 播放中每 4 分钟兜底一次
  if (PREF.autoSync) setTimeout(() => autoSync('boot'), 5000);
  document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'visible' && PREF.autoSync) autoSync('resume'); });
  setInterval(() => { if (PREF.autoSync && state.playing) autoSync('playback'); }, 4 * 60 * 1000);
  console.log('[mobile] boot ok, player backend ready');
})();

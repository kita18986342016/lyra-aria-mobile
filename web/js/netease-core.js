// netease-core.js — 网易云官方 API 客户端（移动端 Web 移植自 PC core/netease.js）
// weapi/eapi 自加密直连 music.163.com；扫码登录、每日推荐、账号收藏夹、播放 URL
// 凭据 localStorage('mpm_netacc')：{cookie, csrf, account, avatar}
import { md5, aesCbcEncryptB64, aesEcbEncryptHex, rsaNoPaddingHex, strBytes, randomBytesHex } from './lib/nez-crypto.js';

const BASE = 'https://music.163.com';
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0 Safari/537.36';
const REFERER = 'https://music.163.com/';

const AES_KEY = '0CoJUm6Qyw8W8jud'; // presetKey 16B
const AES_IV = '0102030405060708';
const BASE62 = 'abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789';
const RSA_PUBLIC_KEY = `-----BEGIN PUBLIC KEY-----
MIGfMA0GCSqGSIb3DQEBAQUAA4GNADCBiQKBgQDgtQn2JZ34ZC28NWYpAUd98iZ3
7BUrX/aKzmFbt7clFSs6sXqHauqKWqdtLkF2KexO40H1YTX8z2lSgBBOAxLsvakl
V8k4cBFK9snQXE9/DDaFt6Rr7iVZMldczhC0JNgTz+SHXT6CBHuX3e9SdB1Ua44o
ncaTWz7OBGLbCiK45wIDAQAB
-----END PUBLIC KEY-----`;
const EAPI_KEY = 'e82ckenh8dichen8';
const EAPI_MSG_PREFIX = 'nobody';
const EAPI_MSG_SUFFIX = 'md5forencrypt';
const EAPI_URL_SUFFIX = '-36cd479b6b5-';

// ---------- 登录状态（localStorage 持久化，按账号命名空间隔离）----------
let NET_KEY = 'mpm_netacc';
let loginState = { cookie: '', csrf: '', account: null, avatar: null };
try { const saved = localStorage.getItem(NET_KEY); if (saved) loginState = Object.assign(loginState, JSON.parse(saved)); } catch {}
function persist() { try { localStorage.setItem(NET_KEY, JSON.stringify(loginState)); } catch {} }
function setScope(prefix) { NET_KEY = prefix ? ('mpm_' + prefix + 'netacc') : 'mpm_netacc'; try { const saved = localStorage.getItem(NET_KEY); loginState = saved ? Object.assign({ cookie: '', csrf: '', account: null, avatar: null }, JSON.parse(saved)) : { cookie: '', csrf: '', account: null, avatar: null }; } catch { loginState = { cookie: '', csrf: '', account: null, avatar: null }; } }
function setState(s) { loginState = Object.assign({ cookie: '', csrf: '', account: null, avatar: null }, s || {}); persist(); }
function getState() { return loginState; }
function loggedIn() { return /MUSIC_U=/.test(loginState.cookie || ''); }

// 客户端环境 cookie（防 8821 风控）
const ENV = (() => {
  const rndHex = (n) => { let o = ''; const H = '0123456789ABCDEF'; for (let i = 0; i < n; i++) o += H[Math.floor(Math.random() * 16)]; return o; };
  const rndLower = (n) => { let o = ''; const L = 'abcdefghijklmnopqrstuvwxyz0123456789'; for (let i = 0; i < n; i++) o += L[Math.floor(Math.random() * L.length)]; return o; };
  return {
    deviceId: rndHex(52), WNMCID: rndLower(6) + '.' + Date.now() + '.01.0', NMTID: '00O' + rndHex(38),
    os: 'pc', osver: 'Microsoft-Windows-10-Professional-build-19045-64bit', appver: '3.1.17.204416', channel: 'netease', WEVNSM: '1.0.0'
  };
})();
function cookieFor() {
  let c = loginState.cookie || '';
  const add = [];
  [['os', ENV.os], ['osver', ENV.osver], ['appver', ENV.appver], ['channel', ENV.channel], ['deviceId', ENV.deviceId], ['WNMCID', ENV.WNMCID], ['WEVNSM', ENV.WEVNSM], ['NMTID', ENV.NMTID]].forEach(([k, v]) => {
    if (!new RegExp('(^|;\\s*)' + k + '=').test(c)) add.push(k + '=' + v);
  });
  if (add.length) c = (c ? c + '; ' : '') + add.join('; ');
  if (loginState.csrf && !/__csrf=/.test(c)) c += '; __csrf=' + loginState.csrf;
  return c;
}
// Set-Cookie 清洗：只保留 name=value（属性污染会破坏会话识别）
function cleanSetCookie(c) {
  return String(c || '').split(';').map((s) => s.trim()).filter((s) => /^[^=;]+\=[^=;]+$/.test(s) && !/^(Max-Age|Expires|Path|Domain|HttpOnly|Secure|SameSite|Priority)/i.test(s)).join('; ');
}

// ---------- weapi/eapi 加密（照 PC revincx 实现）----------
function rsaEncrypt(secret) {
  const rev = strBytes(String(secret).split('').reverse().join(''));
  return rsaNoPaddingHex(RSA_PUBLIC_KEY, rev);
}
function weapi(object) {
  const text = JSON.stringify(object);
  const secret = Array.from({ length: 16 }, () => BASE62[Math.floor(Math.random() * 62)]).join('');
  const params = aesCbcEncryptB64(aesCbcEncryptB64(text, AES_KEY, AES_IV), secret, AES_IV);
  return { params, encSecKey: rsaEncrypt(secret) };
}
function eapi(url, object) {
  const text = JSON.stringify(object);
  const message = EAPI_MSG_PREFIX + url + EAPI_MSG_SUFFIX + text + EAPI_MSG_SUFFIX;
  const digest = md5(message);
  const data = url + EAPI_URL_SUFFIX + text + EAPI_URL_SUFFIX + digest;
  return { params: aesEcbEncryptHex(data, EAPI_KEY) };
}

// ---------- HTTP（NativeHttp 无 CORS）----------
function nh() { return window.Capacitor && window.Capacitor.Plugins && window.Capacitor.Plugins.NativeHttp; }
async function post(pathname, form, opts = {}) {
  const N = nh();
  if (!N) return { status: 0, json: null, raw: 'ERR 无原生 HTTP', cookie: '' };
  const body = Object.entries(form).map(([k, v]) => `${k}=${encodeURIComponent(v)}`).join('&');
  try {
    const r = await N.request({
      url: BASE + pathname, method: 'POST',
      headers: {
        'User-Agent': UA, Referer: REFERER,
        'Content-Type': 'application/x-www-form-urlencoded',
        Cookie: opts.cookie || ''
      },
      body, readTimeout: 20000
    });
    let j = null;
    try { j = JSON.parse(r.data); } catch { /* 非 JSON */ }
    const sc = (r.headers && r.headers['set-cookie']) || '';
    return { status: r.status, json: j, raw: r.data, cookie: sc.replace(/\n/g, '; ') };
  } catch (e) {
    return { status: 0, json: null, raw: 'ERR ' + ((e && e.message) || e), cookie: '' };
  }
}
async function weapiPost(url, data, cookie) {
  const enc = weapi(data);
  return post(url, { params: enc.params, encSecKey: enc.encSecKey }, { cookie });
}
async function eapiPost(url, data, cookie) {
  const enc = eapi(url, data);
  return post(url, { params: enc.params }, { cookie });
}

// ---------- 扫码登录 ----------
async function anonimous() {
  const r = await weapiPost('/api/register/anonimous', {}, cookieFor());
  const j = r.json || {};
  if (Number(j.code) !== 200 || !r.cookie) return { ok: false, code: j.code, msg: j.msg || j.message };
  loginState.cookie = cleanSetCookie(r.cookie);
  persist();
  return { ok: true };
}
async function qrCreate() {
  const r = await weapiPost('/weapi/login/qrcode/unikey', { type: 3 }, cookieFor());
  const unikey = (r.json && r.json.unikey) || (r.json && r.json.data && r.json.data.unikey);
  return { ok: !!unikey, unikey, qrurl: unikey ? `https://music.163.com/login?codekey=${unikey}` : '', msg: r.json && (r.json.msg || r.json.message) };
}
// code: 800 过期 / 801 等待 / 802 已扫待确认 / 803 成功
async function qrCheck(unikey) {
  const r = await weapiPost('/weapi/login/qrcode/client/login', { key: unikey, type: 3 }, cookieFor());
  const j = r.json || {};
  const code = Number(j.code);
  if (code === 803) {
    const sc = cleanSetCookie(r.cookie || j.cookie || '');
    loginState.cookie = sc;
    const m = /__csrf=([^;]+)/.exec(sc);
    if (m) loginState.csrf = m[1];
    persist();
    return { ok: true, code };
  }
  return { ok: false, code, msg: j.msg || j.message };
}

// ---------- 登录态检查 ----------
async function accountInfo() {
  const r = await weapiPost('/weapi/w/nuser/account/get', {}, cookieFor());
  const j = r.json || {};
  if (Number(j.code) !== 200 || !j.account) return { ok: false };
  return {
    ok: true, uid: j.account.id,
    nickname: j.profile && j.profile.nickname, avatar: j.profile && j.profile.avatarUrl
  };
}

// ---------- 每日推荐（游客态：明文公开端点，通用推荐）----------
async function guestDaily() {
  const url = 'https://music.163.com/api/v3/discovery/recommend/songs';
  const headers = { 'User-Agent': 'Mozilla/5.0 (Linux; Android 14) LyraAriaMobile', 'Cookie': 'NMTID=00O7', 'Referer': 'https://music.163.com/' };
  let j = null;
  try {
    const N = nh();
    if (N) { const r = await N.request({ url, method: 'POST', headers, readTimeout: 15000, trustAll: true }); j = JSON.parse(r.data); }
    else { const res = await fetch(url, { method: 'POST', headers }); j = await res.json(); }
  } catch { return { ok: false, songs: [] }; }
  const list = (j.data && j.data.dailySongs) || [];
  return {
    ok: j.code === 200 && list.length > 0, code: j.code, guest: true,
    songs: list.map((s) => ({
      id: String(s.id), name: s.name, artist: (s.ar || []).map((a) => a.name).join(' / '),
      album: s.al && s.al.name, picUrl: s.al && s.al.picUrl, duration: Math.round((s.dt || 0) / 1000),
      reason: s.recommendReason || ''
    }))
  };
}
// ---------- 每日推荐（需登录）----------
async function recommendSongs() {
  const r = await weapiPost('/api/v3/discovery/recommend/songs', {}, cookieFor());
  const list = (r.json && r.json.data && r.json.data.dailySongs) || [];
  return {
    ok: r.json && Number(r.json.code) === 200, code: r.json && r.json.code,
    songs: list.map((s) => ({
      id: String(s.id), name: s.name, artist: (s.ar || []).map((a) => a.name).join(' / '),
      album: s.al && s.al.name, picUrl: s.al && s.al.picUrl, duration: Math.round((s.dt || 0) / 1000)
    }))
  };
}

// ---------- 账号收藏夹（需登录）----------
// /weapi/playlist/mine 已失效（404）→ 改用 /weapi/user/playlist（uid）
async function myPlaylists(uid) {
  const r = await weapiPost('/weapi/user/playlist', {
    uid: String(uid), limit: 1000, offset: 0, includeVideo: true
  }, cookieFor());
  const list = (r.json && r.json.playlist) || [];
  return {
    ok: r.json && Number(r.json.code) === 200, code: r.json && r.json.code,
    playlists: list.map((p) => ({
      id: String(p.id), name: p.name, picUrl: p.coverImgUrl, playCount: p.playCount,
      trackCount: p.trackCount, creator: p.creator && p.creator.nickname
    }))
  };
}
async function playlistDetail(id) {
  const r = await post('/api/v6/playlist/detail', { id: String(id), n: '100000', s: '8' }, { cookie: cookieFor() });
  const pl = r.json && r.json.playlist;
  return { ok: !!pl, trackIds: ((pl && pl.trackIds) || []).map((t) => String(t.id)), name: pl && pl.name, cover: pl && pl.coverImgUrl, desc: pl && pl.description };
}
async function songDetail(ids) {
  const c = JSON.stringify(ids.map((id) => ({ id: Number(id) })));
  const r = await post('/api/v3/song/detail', { c }, { cookie: cookieFor() });
  const songs = (r.json && r.json.songs) || [];
  return songs.map((s) => ({
    id: String(s.id), name: s.name, artist: (s.ar || []).map((a) => a.name).join(' / '),
    album: s.al && s.al.name, picUrl: s.al && s.al.picUrl, duration: Math.round((s.dt || 0) / 1000)
  }));
}
async function playlistSongsAll(id, onProgress) {
  const d = await playlistDetail(id);
  if (!d.ok) return { ok: false, reason: '歌单获取失败' };
  const all = [];
  const CHUNK = 400;
  for (let i = 0; i < d.trackIds.length; i += CHUNK) {
    try {
      const songs = await songDetail(d.trackIds.slice(i, i + CHUNK));
      all.push(...songs);
    } catch { /* 单批失败继续 */ }
    if (onProgress) onProgress(all.length, d.trackIds.length);
  }
  return { ok: true, name: d.name, cover: d.cover, desc: d.desc, songs: all, total: d.trackIds.length };
}

// ---------- 播放 URL（eapi，登录态决定音质档）----------
async function songUrl(id, level = 'lossless') {
  const r = await eapiPost('/eapi/song/enhance/player/url/v1', {
    ids: `[${id}]`, level, encodeType: 'flac'
  }, cookieFor());
  const d = r.json && r.json.data && r.json.data[0];
  return { ok: !!(d && d.url), url: d && d.url, code: d && d.code, freeTrial: !!(d && d.freeTrialInfo) };
}

function logout() { setState({ cookie: '', csrf: '', account: null, avatar: null }); }

// ---------- 个性推荐歌单（匿名可用）----------
async function personalizedPlaylists(limit = 30) {
  const r = await weapiPost('/weapi/personalized/playlist', { limit, total: true, n: 1000 }, cookieFor());
  const list = (r.json && r.json.result) || [];
  return {
    ok: r.json && Number(r.json.code) === 200, code: r.json && r.json.code,
    playlists: list.map((p) => ({
      id: String(p.id), name: p.name, picUrl: p.picUrl, copywriter: p.copywriter,
      playCount: p.playCount, creator: p.creator && p.creator.nickname
    }))
  };
}

// 收藏（订阅）歌单
async function subscribePlaylist(id) {
  const r = await weapiPost('/weapi/playlist/subscribe', { pid: String(id), subscribe: 'true' }, cookieFor());
  return { ok: r.json && Number(r.json.code) === 200, code: r.json && r.json.code };
}

export { setState, getState, loggedIn, setScope, anonimous, qrCreate, qrCheck, accountInfo, guestDaily, recommendSongs, personalizedPlaylists, myPlaylists, playlistSongsAll, songUrl, logout, subscribePlaylist };

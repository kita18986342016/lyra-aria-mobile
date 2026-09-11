// kugou-core.js — 酷狗官方 API 客户端（移动端 Web 移植自 PC core/kugou.js）
// 扫码登录（web 签名）+ 自建歌单列表 + gcid 全量歌曲；播放/歌词仍走 leiz（与登录态无关）
import { md5 } from './lib/nez-crypto.js';

const KG_APPID = 1005;
const KG_CLIENTVER = 20489;
const KG_SALT = 'OIlwieks28dk2k092lksi2UIkp';          // android 签名盐
const KG_WEB_SALT = 'NVPh5oo715z5DIWAeQlhMDsWXXQV4hwt'; // web 签名盐（扫码用）
const KG_UA = 'Android15-1070-11083-46-0-DiscoveryDRADProtocol-wifi';
const KG_EXTRA_HEADERS = { 'kg-rc': '1', 'kg-thash': '5d816a0', 'kg-rec': '1', 'kg-rf': 'B9EDA08A64250DEFFBCADDEE00F8F25F' };

let KG_KEY = 'mpm_kgacc';
let loginState = { token: '', userid: '', mid: '', dfid: '', vipType: '', vipToken: '', dev: '', account: '' };
try { const saved = localStorage.getItem(KG_KEY); if (saved) loginState = Object.assign(loginState, JSON.parse(saved)); } catch {}
function persist() { try { localStorage.setItem(KG_KEY, JSON.stringify(loginState)); } catch {} }
function setScope(prefix) { KG_KEY = prefix ? ('mpm_' + prefix + 'kgacc') : 'mpm_kgacc'; try { const saved = localStorage.getItem(KG_KEY); loginState = saved ? Object.assign({ token: '', userid: '', mid: '', dfid: '', vipType: '', vipToken: '', dev: '', account: '' }, JSON.parse(saved)) : { token: '', userid: '', mid: '', dfid: '', vipType: '', vipToken: '', dev: '', account: '' }; } catch { loginState = { token: '', userid: '', mid: '', dfid: '', vipType: '', vipToken: '', dev: '', account: '' }; } }
function setState(s) { loginState = Object.assign({ token: '', userid: '', mid: '', dfid: '', vipType: '', vipToken: '', dev: '', account: '' }, s || {}); persist(); }
function getState() { return loginState; }
function loggedIn() { return !!(loginState.token && loginState.userid); }

function nh() { return window.Capacitor && window.Capacitor.Plugins && window.Capacitor.Plugins.NativeHttp; }

function kgGuidV4() {
  const e = () => ((65536 * (1 + Math.random())) | 0).toString(16).substring(1);
  return `${e()}${e()}-${e()}-${e()}-${e()}${e()}${e()}`;
}
// 与 MakcRe calculateMid 一致：MD5(guid) 按 16 进制数转十进制（左高右低）
function kgMid(guid) {
  const digest = md5(guid);
  let acc = 0n, base = 1n;
  for (let i = digest.length - 1; i >= 0; i--) { acc += BigInt(parseInt(digest.charAt(i), 16)) * base; base *= 16n; }
  return acc.toString();
}
const KG_DEV_POOL = '1234567890ABCDEFGHIJKLMNOPQRSTUVWXYZ';
function kgDev() {
  let out = '';
  for (let i = 0; i < 10; i++) out += KG_DEV_POOL[Math.floor(Math.random() * KG_DEV_POOL.length)];
  return out;
}
// 设备身份初始化/恢复
if (!loginState.mid || !loginState.dev) {
  loginState.mid = loginState.mid || kgMid(kgGuidV4());
  loginState.dev = loginState.dev || kgDev();
  persist();
}

function md5s(s) { return md5(s); }
// android 签名：MD5(盐 + 排序 key=value 串 + body + 盐)
function signAndroid(params, body = '') {
  const ps = Object.keys(params).sort()
    .map((k) => k + '=' + (typeof params[k] === 'object' ? JSON.stringify(params[k]) : params[k]))
    .join('');
  return md5s(KG_SALT + ps + (body || '') + KG_SALT);
}
// web 签名：MD5(盐 + 「k=v」串排序后 + 盐)（对拼接后字符串排序，非按 key）
function signWeb(params) {
  const ps = Object.keys(params).map((k) => k + '=' + params[k]).sort().join('');
  return md5s(KG_WEB_SALT + ps + KG_WEB_SALT);
}
function defaultParams(over = {}) {
  return Object.assign({
    dfid: loginState.dfid || '-',
    mid: loginState.mid,
    uuid: '-',
    appid: KG_APPID,
    clientver: KG_CLIENTVER,
    clienttime: Math.floor(Date.now() / 1000)
  }, over);
}

// web 签名 GET（扫码接口）
async function kugouWebGet(url) {
  const N = nh();
  if (N) {
    try {
      const r = await N.request({ url, method: 'GET', headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) Chrome/120.0', Referer: 'https://login-user.kugou.com/' }, readTimeout: 20000, trustAll: true });
      let j = null; try { j = JSON.parse(r.data); } catch {}
      return { status: r.status, json: j, raw: r.data };
    } catch (e) { return { status: 0, json: null, raw: 'ERR ' + ((e && e.message) || e) }; }
  }
  const ctrl = new AbortController();
  setTimeout(() => ctrl.abort(), 20000);
  try {
    const res = await fetch(url, { signal: ctrl.signal, headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) Chrome/120.0', Referer: 'https://login-user.kugou.com/' } });
    const raw = await res.text();
    let j = null; try { j = JSON.parse(raw); } catch {}
    return { status: res.status, json: j, raw };
  } catch (e) { return { status: 0, json: null, raw: 'ERR ' + ((e && e.message) || e) }; }
}

// android 签名 POST
async function kugouPost(host, path, params, bodyData) {
  const N = nh();
  const body = JSON.stringify(bodyData || {});
  const sign = signAndroid(params, body);
  const qs = Object.entries(params).map(([k, v]) => `${k}=${encodeURIComponent(v)}`).join('&');
  const url = `https://${host}${path}?${qs}&signature=${sign}`;
  const headers = {
    'User-Agent': KG_UA,
    'Content-Type': 'application/json;charset=UTF-8',
    dfid: params.dfid || '-',
    mid: params.mid || '',
    clienttime: String(params.clienttime),
    ...KG_EXTRA_HEADERS,
    ...(loginState.token ? { 'KG-Token': loginState.token } : {})
  };
  if (N) {
    try {
      const r = await N.request({ url, method: 'POST', headers, body, readTimeout: 20000, trustAll: true });
      let j = null; try { j = JSON.parse(r.data); } catch {}
      return { status: r.status, json: j, raw: r.data };
    } catch (e) { return { status: 0, json: null, raw: 'ERR ' + ((e && e.message) || e) }; }
  }
  const res = await fetch(url, { method: 'POST', headers, body });
  const raw = await res.text();
  let j = null; try { j = JSON.parse(raw); } catch {}
  return { status: res.status, json: j, raw };
}

// ---------- 扫码登录 ----------
async function qrCreate() {
  const params = defaultParams({
    appid: 1001,
    type: 1,
    plat: 4,
    qrcode_txt: `https://h5.kugou.com/apps/loginQRCode/html/index.html?appid=${KG_APPID}&`,
    srcappid: 2919
  });
  params.signature = signWeb(params);
  const qs = Object.entries(params).map(([k, v]) => `${k}=${encodeURIComponent(v)}`).join('&');
  const r = await kugouWebGet(`https://login-user.kugou.com/v2/qrcode?${qs}`);
  const key = r.json && r.json.data && r.json.data.qrcode;
  return { ok: !!key, key, qrurl: key ? `https://h5.kugou.com/apps/loginQRCode/html/index.html?qrcode=${key}` : '' };
}
// status: 0=过期 1=等待 2=待确认 4=成功
async function qrCheck(key) {
  const params = defaultParams({
    appid: 1005, plat: 4, srcappid: 2919, qrcode: key, dev: loginState.dev || 0
  });
  params.signature = signWeb(params);
  const qs = Object.entries(params).map(([k, v]) => `${k}=${encodeURIComponent(v)}`).join('&');
  const r = await kugouWebGet(`https://login-user.kugou.com/v2/get_userinfo_qrcode?${qs}`);
  const d = r.json && r.json.data;
  const status = Number(d && d.status);
  if (status === 4) {
    loginState.token = d.token || '';
    loginState.userid = String(d.userid || '');
    loginState.vipType = d.vip_type || '';
    loginState.vipToken = d.vip_token || '';
    loginState.account = d.user_name || d.nickname || d.username || loginState.account || '';
    loginState._dbg = 'keys=' + Object.keys(d).join(','); // 诊断埋点：昵称字段名排查
    persist();
    return { ok: true, status, nickname: loginState.account };
  }
  return { ok: false, status, msg: { 0: '二维码过期', 1: '等待扫码', 2: '已扫码待确认' }[status] || ('未知状态 ' + status) };
}

// ---------- 猜你喜欢（个人 FM 流，对齐酷狗 App"猜你喜欢"；登录后个性化，匿名给通用流）----------
// 协议（MakcRe personal_fm.js）：POST persnfm /v2/personal_recommend，android 签名，毫秒 clienttime
async function guessYouLike(feedback = {}) {
  const s = loginState;
  const dateTime = Date.now();
  const dataMap = {
    appid: KG_APPID,
    clienttime: dateTime,
    mid: s.mid,
    action: feedback.action || 'play',
    recommend_source_locked: 0,
    song_pool_id: 0,
    callerid: 0,
    m_type: 1,
    platform: 'ios',
    area_code: 1,
    remain_songcnt: 0,
    clientver: KG_CLIENTVER,
    is_overplay: 0,
    mode: 'normal',
    fakem: 'ca981cfc583a4c37f28d2d49000013c16a0a',
    key: signParamsKey(String(dateTime))
  };
  if (s.userid) { dataMap.userid = s.userid; dataMap.kguid = s.userid; }
  if (s.token) dataMap.token = s.token;
  if (s.vipType) dataMap.vip_type = s.vipType;
  if (feedback.hash) dataMap.hash = feedback.hash;
  if (feedback.playtime != null) dataMap.playtime = feedback.playtime;
  const body = JSON.stringify(dataMap);
  const sign = signAndroid(dataMap, body);
  const qs = Object.entries(dataMap).map(([k, v]) => `${k}=${encodeURIComponent(v)}`).join('&') + '&signature=' + sign;
  const N = nh();
  let j = null;
  try {
    if (N) {
      const r = await N.request({
        url: 'https://persnfm.service.kugou.com/v2/personal_recommend?' + qs, method: 'POST',
        headers: {
          'User-Agent': KG_UA, 'Content-Type': 'application/json;charset=UTF-8',
          dfid: s.dfid || '-', mid: s.mid || '', clienttime: String(dateTime),
          ...KG_EXTRA_HEADERS, ...(s.token ? { 'KG-Token': s.token } : {})
        },
        body, readTimeout: 20000, trustAll: true
      });
      j = JSON.parse(r.data);
    } else {
      const res = await fetch('https://persnfm.service.kugou.com/v2/personal_recommend?' + qs, {
        method: 'POST', headers: { 'User-Agent': KG_UA, 'Content-Type': 'application/json;charset=UTF-8', dfid: s.dfid || '-', mid: s.mid || '', clienttime: String(dateTime), ...KG_EXTRA_HEADERS, ...(s.token ? { 'KG-Token': s.token } : {}) }, body
      });
      j = await res.json();
    }
  } catch (e) { return { ok: false, reason: 'ERR ' + ((e && e.message) || e) }; }
  const d = j && (j.data || j);
  const list = (d && (d.song_list || d.songs || d.info)) || [];
  if (!Array.isArray(list) || !list.length) return { ok: false, reason: (j && (j.error_code || j.status)) || '无推荐数据', raw: JSON.stringify(j).slice(0, 200) };
  return {
    ok: true,
    songs: list.map((s2) => ({
      hash: s2.hash || s2.FileHash || '', name: s2.songname || s2.name || s2.filename || '',
      artist: Array.isArray(s2.singerinfo) ? s2.singerinfo.map((x) => x.name).join('、') : (s2.singername || s2.author_name || ''),
      album: s2.album_name || s2.remark || '',
      duration: s2.time_length || s2.duration || 0,
      cover: ((s2.trans_param && s2.trans_param.union_cover) || s2.cover || s2.img || '').replace('{size}', '400').replace(/^http:/, 'https:')
    })).filter((x) => x.hash)
  };
}

// ---------- 自建歌单（需登录）----------
async function myPlaylists(page = 1, pagesize = 100) {
  const s = loginState;
  if (!(s.token && s.userid)) return { ok: false, reason: '未登录' };
  const body = { userid: Number(s.userid), token: s.token, total_ver: 979, type: 2, page, pagesize };
  const params = defaultParams({ plat: 1, userid: Number(s.userid), token: s.token });
  const r = await kugouPost('cloudlist.service.kugou.com', '/v7/get_all_list', params, body);
  const j = r.json;
  const d = j && (j.data || j);
  const list = d && (d.list || d.info || d.lists || d.special);
  if (!Array.isArray(list)) return { ok: false, reason: '歌单列表获取失败' + (j && j.error_code ? '（' + j.error_code + '）' : '') };
  return {
    ok: true,
    playlists: list.map((p) => ({
      id: String(p.gcid || p.global_collection_id || p.specialid || p.id || ''),
      name: p.name || p.list_name || '',
      picUrl: String(p.imgurl || p.img || p.pic || '').replace('{size}', '480').replace(/^http:/, 'https:'),
      trackCount: Number(p.count || p.music_count || p.track_count || 0),
      creator: ''
    })).filter((x) => x.id)
  };
}

// gcid 分页拉全量歌曲（pubsongs get_other_list_file_nofilt，300×10）
async function collectAllSongs(globalCollectionId) {
  const all = [];
  const seen = new Set();
  const pageSize = 300;
  let beginIdx = 0;
  for (let page = 0; page < 10; page++) {
    const clienttime = Math.floor(Date.now() / 1000);
    const params = {
      dfid: '-', mid: loginState.mid, uuid: '-', appid: KG_APPID, clientver: KG_CLIENTVER, clienttime,
      area_code: 1, begin_idx: beginIdx, plat: 1, type: 1, mode: 1, personal_switch: 1,
      extend_fields: 'abtags,hot_cmt,popularization', pagesize: pageSize,
      global_collection_id: globalCollectionId
    };
    const paramsString = Object.keys(params).sort().map((k) => `${k}=${params[k]}`).join('');
    params.signature = md5s(KG_SALT + paramsString + '' + KG_SALT);
    const qs = Object.keys(params).map((k) => `${encodeURIComponent(k)}=${encodeURIComponent(params[k])}`).join('&');
    const N = nh();
    let j = null;
    try {
      if (N) {
        const r = await N.request({
          url: 'https://gateway.kugou.com/pubsongs/v2/get_other_list_file_nofilt?' + qs, method: 'GET',
          headers: { 'User-Agent': KG_UA, dfid: '-', clienttime: String(clienttime), ...KG_EXTRA_HEADERS }, readTimeout: 20000, trustAll: true
        });
        j = JSON.parse(r.data);
      } else {
        const res = await fetch('https://gateway.kugou.com/pubsongs/v2/get_other_list_file_nofilt?' + qs, { headers: { 'User-Agent': KG_UA, dfid: '-', clienttime: String(clienttime), ...KG_EXTRA_HEADERS } });
        j = await res.json();
      }
    } catch { break; }
    if (!j || !j.data || j.status === 0) break;
    const songs = Array.isArray(j.data.songs) ? j.data.songs : [];
    if (!songs.length) break;
    for (const s of songs) {
      if (!s.hash || seen.has(s.hash)) continue;
      seen.add(s.hash);
      const covRaw = (s.trans_param && s.trans_param.union_cover) || s.album_pic || s.salbum_pic || '';
      const _sg = s.singername || s.singer || '';
      let _nm = String(s.songname || s.name || '').trim();
      if (_sg && _nm.startsWith(_sg)) { const _st = _nm.slice(_sg.length).replace(/^[\s\-–—/、·&]+/, '').trim(); if (_st) _nm = _st; }
      all.push({
        hash: s.hash, name: _nm, singername: _sg,
        album: s.album_name || '', duration: s.duration || 0,
        pic: String(covRaw).replace('{size}', '480')
      });
    }
    beginIdx += pageSize;
    if (all.length >= (j.data.count || 0)) break;
  }
  return all;
}

function logout() {
  setState({ mid: loginState.mid, dev: loginState.dev }); // mid/dev 保留设备身份
}

// ---------- 主页推荐歌单（specialrec，匿名可用）----------
// body 内 key = MD5(appid+盐+clientver+clienttime)，android 签名覆盖整个 body
function signParamsKey(data) { return md5s(`${KG_APPID}${KG_SALT}${KG_CLIENTVER}${data}`); }
async function recommendPlaylists(categoryid = 0, page = 1, pagesize = 30) {
  const dateTime = Math.floor(Date.now() / 1000).toString();
  const body = {
    appid: KG_APPID,
    mid: loginState.mid,
    clientver: KG_CLIENTVER,
    platform: 'android',
    clienttime: dateTime,
    userid: Number(loginState.userid) || 0,
    module_id: 1,
    page,
    pagesize,
    key: signParamsKey(dateTime),
    special_recommend: {
      withtag: 1, withsong: 1, sort: 1, ugc: 1, is_selected: 0, withrecommend: 1, area_code: 1, categoryid
    },
    req_multi: 1,
    retrun_min: 5,
    return_special_falg: 1
  };
  const r = await kugouPost('specialrec.service.kugou.com', '/v2/special_recommend', defaultParams(), body);
  let list = (r.json && r.json.data && (r.json.data.special_list || r.json.data.info)) || [];
  if (!Array.isArray(list)) list = [];
  return {
    ok: r.json && Number(r.json.status) === 1, status: r.json && r.json.status,
    playlists: list.map((p) => ({
      gcid: p.global_collection_id, name: p.specialname || p.name || '',
      img: (p.imgurl || p.flexible_cover || p.img || '').replace('{size}', '400').replace(/^http:/, 'https:'),
      count: p.collectcount || p.list_init || 0, creator: p.nickname || ''
    })).filter((p) => p.gcid)
  };
}

// ---------- 每日推荐歌曲（需登录态）----------
async function recommendSongs() {
  const params = {
    appid: KG_APPID, clienttime: Math.floor(Date.now() / 1000), mid: loginState.mid,
    platform: 'android', userid: loginState.userid, dfid: loginState.dfid
  };
  const r = await kugouPost('everydayrec.service.kugou.com', '/everyday_song_recommend', params, {});
  const list = (r.json && r.json.data) || [];
  return {
    ok: r.json && Number(r.json.status) === 1, status: r.json && r.json.status,
    songs: list.map((s) => ({
      hash: s.hash, name: s.filename || s.songname || '', artist: s.singername || '',
      album: s.album_name || '', duration: s.duration || 0
    }))
  };
}

export { setState, getState, loggedIn, setScope, qrCreate, qrCheck, myPlaylists, collectAllSongs, recommendPlaylists, recommendSongs, guessYouLike, logout };

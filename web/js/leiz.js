// leiz.js — LeiZ 在线音乐 API 封装（移动端 Web 层）
// 桌面端走 IPC（main.js leizGet），移动端 Web 层直接 fetch。
// CORS 说明：跨域请求走 NativeHttp 插件（原生 HTTP 无 CORS），无原生环境回退 fetch。
// 统一走 httpGet() 以便一键切换。
import { md5 } from './lib/nez-crypto.js';

const LEIZ_BASE = 'https://api.bileizhen.top/api';
const LEIZ_KEY = 'lz_b4dd85599fe9c71b3e7ae241dae2cb2ac767b5954aa18b14';

// 可用原生 HTTP 时优先（NativeHttp 自研插件，无 CORS），否则 fetch
function useNativeHttp() {
  try {
    return !!(window.Capacitor && window.Capacitor.Plugins && window.Capacitor.Plugins.NativeHttp);
  } catch { return false; }
}

async function httpGet(url, extraHeaders) {
  const headers = Object.assign({ 'User-Agent': 'Mozilla/5.0 LyraAriaMobile/0.1' }, extraHeaders || {});
  if (useNativeHttp()) {
    const { NativeHttp } = window.Capacitor.Plugins;
    const r = await NativeHttp.request({ url, method: 'GET', headers, readTimeout: 20000 });
    return { status: r.status, body: typeof r.data === 'string' ? r.data : JSON.stringify(r.data) };
  }
  const ctrl = new AbortController();
  const to = setTimeout(() => ctrl.abort(), 20000);
  try {
    const res = await fetch(url, { signal: ctrl.signal, headers });
    return { status: res.status, body: await res.text() };
  } catch (e) {
    if (e && e.name === 'AbortError') return { status: 0, err: '请求超时' };
    return { status: 0, err: (e && e.message) || String(e) };
  } finally { clearTimeout(to); }
}

// 通用原生请求（POST/自定义头；B站合成触发用）。返回 {status}
async function httpRequest(url, method, headers) {
  if (useNativeHttp()) {
    const { NativeHttp } = window.Capacitor.Plugins;
    const r = await NativeHttp.request({ url, method, headers: headers || {}, readTimeout: 15000 });
    return { status: r.status };
  }
  const ctrl = new AbortController();
  const to = setTimeout(() => ctrl.abort(), 15000);
  try {
    const res = await fetch(url, { method, headers: headers || {}, signal: ctrl.signal });
    res.body && res.body.cancel && res.body.cancel().catch(() => {});
    return { status: res.status };
  } catch (e) {
    return { status: 0 };
  } finally { clearTimeout(to); }
}

export async function leizGet(pathWithQuery) {
  const sep = pathWithQuery.includes('?') ? '&' : '?';
  const url = LEIZ_BASE + pathWithQuery + sep + 'key=' + encodeURIComponent(LEIZ_KEY);
  const r = await httpGet(url);
  if (r.err || r.status === 0) return { ok: false, status: 0, message: r.err || '网络异常' };
  try {
    const j = JSON.parse(r.body);
    return { ok: r.status === 200 && j.success === true, status: r.status, data: j.data || null, message: j.message || null };
  } catch {
    return { ok: false, status: r.status, message: '响应解析失败' };
  }
}

export async function leizSearch(source, q) {
  return leizGet('/' + source + '/search?q=' + encodeURIComponent(q));
}

// ref: 网易云=song id；酷狗=分享链接或 hash
export async function leizResolve(source, ref, level) {
  const lv = typeof level === 'string' && level ? level : 'lossless';
  let p;
  if (source === 'netease') p = '/netease?id=' + encodeURIComponent(ref) + '&level=' + encodeURIComponent(lv);
  else p = /^https?:\/\//.test(ref) ? '/kugou?url=' + encodeURIComponent(ref) : '/kugou?hash=' + encodeURIComponent(ref);
  return leizGet(p);
}

export async function leizLyrics(source, ref, level) {
  const lv = typeof level === 'string' && level ? level : 'lossless';
  let p;
  if (source === 'netease') p = '/netease?type=lyrics&id=' + encodeURIComponent(ref) + '&level=' + encodeURIComponent(lv);
  else p = /^https?:\/\//.test(ref) ? '/kugou?type=lyrics&url=' + encodeURIComponent(ref) : '/kugou?type=lyrics&hash=' + encodeURIComponent(ref);
  return leizGet(p);
}

// 歌单：ref 可为链接或 id
export async function leizPlaylist(source, ref) {
  let p;
  if (source === 'netease') {
    p = /^https?:\/\//.test(ref) ? '/netease?type=playlist&url=' + encodeURIComponent(ref) : '/netease?type=playlist&id=' + encodeURIComponent(ref);
  } else {
    if (/^https?:\/\//.test(ref)) p = '/kugou?type=playlist&url=' + encodeURIComponent(ref);
    else {
      const num = String(ref).match(/\d{4,}/);
      p = num ? '/kugou?type=playlist&id=' + encodeURIComponent(num[0]) : '/kugou?type=playlist&url=' + encodeURIComponent(ref);
    }
  }
  return leizGet(p);
}

// ---------- B站扫码登录 + 我的收藏夹（cookie 显式管理，不走浏览器 Cookie） ----------
// 协议：passport.bilibili.com qrcode generate/poll；generate 下发会话 Cookie（poll 必须带同一 Cookie
// 才能拿到已确认状态，否则永远 86090）；成功后 Set-Cookie（SESSDATA/bili_jct/DedeUserID）
let biliQrSession = ''; // generate 的会话 cookie
export async function biliQrCreate() {
  const N = useNativeHttp() ? window.Capacitor.Plugins.NativeHttp : null;
  if (N) {
    const r = await N.request({ url: 'https://passport.bilibili.com/x/passport-login/web/qrcode/generate', method: 'GET', headers: BILI_HEADERS, readTimeout: 15000 });
    try {
      const j = JSON.parse(r.data);
      if (j.code !== 0 || !j.data) return { ok: false, reason: j.message || '二维码获取失败' };
      biliQrSession = ((r.headers && r.headers['set-cookie']) || '').split('\n').map((s) => s.split(';')[0].trim()).join('; ');
      return { ok: true, url: j.data.url, qrcodeKey: j.data.qrcode_key };
    } catch { return { ok: false, reason: '响应解析失败' }; }
  }
  const r = await httpGet('https://passport.bilibili.com/x/passport-login/web/qrcode/generate', BILI_HEADERS);
  if (r.err || r.status === 0) return { ok: false, reason: r.err || 'HTTP ' + r.status };
  try {
    const j = JSON.parse(r.body);
    if (j.code !== 0 || !j.data) return { ok: false, reason: j.message || '二维码获取失败' };
    return { ok: true, url: j.data.url, qrcodeKey: j.data.qrcode_key };
  } catch { return { ok: false, reason: '响应解析失败' }; }
}
// code: 86101 未扫 / 86090 已扫未确认 / 86038 过期 / 0 成功
export async function biliQrPoll(qrcodeKey) {
  const N = useNativeHttp() ? window.Capacitor.Plugins.NativeHttp : null;
  const pollHeaders = Object.assign({}, BILI_HEADERS, biliQrSession ? { Cookie: biliQrSession } : {});
  let sc = '', status = 0, body = '';
  if (N) {
    const r = await N.request({
      url: 'https://passport.bilibili.com/x/passport-login/web/qrcode/poll?qrcode_key=' + encodeURIComponent(qrcodeKey),
      method: 'GET', headers: pollHeaders, readTimeout: 15000
    });
    status = r.status; body = r.data; sc = (r.headers && r.headers['set-cookie']) || '';
  } else {
    const r = await httpGet('https://passport.bilibili.com/x/passport-login/web/qrcode/poll?qrcode_key=' + encodeURIComponent(qrcodeKey), pollHeaders);
    status = r.status; body = r.body;
  }
  try {
    const j = JSON.parse(body);
    const d = j.data || {};
    if (Number(d.code) === 0) {
      // 登录成功：cookie 从 Set-Cookie 收集
      const parts = sc.split('\n').map((s) => s.split(';')[0].trim()).filter((s) => /^(SESSDATA|bili_jct|DedeUserID)=/.test(s));
      const cookie = parts.join('; ');
      let mid = '';
      const m = /[?&]DedeUserID=(\d+)/.exec(d.url || '');
      if (m) mid = m[1];
      return { ok: true, cookie, mid, uname: d.uname || '' };
    }
    return { ok: false, code: Number(d.code) };
  } catch { return { ok: false, code: -1 }; }
}
let BILI_KEY = 'mpm_biliacc';
export function biliSetScope(prefix) { BILI_KEY = prefix ? ('mpm_' + prefix + 'biliacc') : 'mpm_biliacc'; }
export function biliGetAcc() {
  try { return JSON.parse(localStorage.getItem(BILI_KEY) || 'null'); } catch { return null; }
}
export function biliSetAcc(acc) {
  try { if (acc) localStorage.setItem(BILI_KEY, JSON.stringify(acc)); else localStorage.removeItem(BILI_KEY); } catch {}
}
// 登录者昵称/头像（poll 接口不返回 uname，用 nav 补）
export async function biliNav() {
  const acc = biliGetAcc();
  if (!acc || !acc.cookie) return { ok: false };
  const r = await httpGet('https://api.bilibili.com/x/web-interface/nav', Object.assign({}, BILI_HEADERS, { Cookie: acc.cookie }));
  try {
    const j = JSON.parse(r.body);
    if (j.code !== 0 || !j.data) return { ok: false };
    return { ok: true, uname: j.data.uname || '', face: j.data.face || '', mid: String(j.data.mid || acc.mid || '') };
  } catch { return { ok: false }; }
}
// 我创建的收藏夹列表（需登录 cookie）：[{fid, title, count}]
export async function biliMyFavs(mid) {
  const acc = biliGetAcc();
  if (!acc || !acc.cookie) return { ok: false, reason: '未登录B站账号' };
  const r = await httpGet('https://api.bilibili.com/x/v3/fav/folder/created/list-all?up_mid=' + encodeURIComponent(mid || acc.mid) + '&jsonp=jsonp', Object.assign({}, BILI_HEADERS, { Cookie: acc.cookie }));
  if (r.err || r.status === 0) return { ok: false, reason: r.err || 'HTTP ' + r.status };
  try {
    const j = JSON.parse(r.body);
    if (j.code !== 0 || !j.data) return { ok: false, reason: j.message || '收藏夹列表获取失败' };
    const list = (j.data.list || []).filter((f) => (f.media_count || 0) > 0).map((f) => ({ fid: String(f.id), title: f.title || '', count: f.media_count, cover: f.cover || '' }));
    return { ok: true, list };
  } catch { return { ok: false, reason: '响应解析失败' }; }
}

/* ================= B站音源（对齐 PC 一期：仅公开收藏夹导入 + 在线播放；不可搜索/下载/无歌词） ================= */
const BILI_UA = 'Mozilla/5.0 MusicPlayer/1.3.8';
const BILI_HEADERS = { 'User-Agent': BILI_UA, Referer: 'https://www.bilibili.com' };
const biliCache = new Map(); // bvid -> {url,bitrate,format,title,artist,duration,ts}（50min TTL，对齐 PC）
const BILI_CACHE_TTL = 50 * 60 * 1000;

async function biliGet(path) {
  const r = await httpGet('https://api.bilibili.com' + path, BILI_HEADERS);
  if (r.err || r.status === 0) return { ok: false, status: 0, message: r.err || '网络异常' };
  try {
    const j = JSON.parse(r.body);
    return { ok: j.code === 0, status: r.status, data: j.data, code: j.code, message: j.message || null };
  } catch {
    return { ok: false, status: r.status, message: '响应解析失败' };
  }
}

// 收藏夹导入：ref 可为 space.bilibili.com 链接（含 fid=）或纯数字 media_id；翻页上限 400（照 PC）
export async function biliFavlist(ref) {
  const s = String(ref || '').trim();
  const m = s.match(/fid=(\d{4,})/) || s.match(/^(\d{4,})$/);
  if (!m) return { ok: false, reason: '无法识别收藏夹（请粘贴 space.bilibili.com 的 favlist 链接）' };
  const mediaId = m[1];
  const first = await biliGet('/x/v3/fav/resource/list?media_id=' + mediaId + '&pn=1&ps=20&order=mtime&type=2');
  if (!first.ok || !first.data || !first.data.info) {
    return { ok: false, reason: first.code === -403 || first.code === -404 ? '收藏夹不存在或未公开（私密收藏夹请先设为公开）' : '收藏夹拉取失败（' + (first.message || 'HTTP ' + first.status) + '）' };
  }
  const info = first.data.info;
  const total = Math.min(Number(info.media_count) || 0, 400);
  const songs = [];
  const push = (v) => {
    if (!v || !v.bvid) return;
    songs.push({
      ref: v.bvid,
      title: String(v.title || '').replace(/【[^】]*】/g, '').trim() || String(v.title || '').trim(),
      artist: (v.upper && v.upper.name) || '未知UP主',
      album: '', duration: Number(v.duration) || 0, picUrl: v.cover || v.pic || ''
    });
  };
  for (const v of (first.data.medias || [])) push(v);
  const pages = Math.ceil(total / 20);
  for (let pn = 2; pn <= pages; pn++) {
    const r = await biliGet('/x/v3/fav/resource/list?media_id=' + mediaId + '&pn=' + pn + '&ps=20&order=mtime&type=2');
    const medias = r.ok && r.data ? r.data.medias : null;
    if (!medias || !medias.length) break;
    for (const v of medias) push(v);
  }
  if (!songs.length) return { ok: false, reason: '收藏夹为空' };
  return {
    ok: true,
    data: {
      name: info.title || 'B站收藏夹',
      cover: info.cover || (songs[0] && songs[0].picUrl) || '',
      desc: 'UP：' + ((info.upper && info.upper.name) || '') + ' · ' + songs.length + ' 个视频',
      songs,
      truncated: total < (Number(info.media_count) || 0)
    }
  };
}

// ---------- B站直连高音质（WBI 签名 + playurl DASH 分轨，摆脱 leiz 合成流） ----------
// mixinKeyEncTab（WBI 公开置换表）
const MIXIN_TAB = [46, 47, 18, 2, 53, 8, 23, 32, 15, 50, 10, 31, 58, 3, 45, 35, 27, 43, 5, 49,
  33, 9, 42, 19, 29, 28, 14, 39, 12, 38, 41, 13, 37, 48, 7, 16, 24, 55, 40, 61,
  26, 17, 0, 1, 60, 51, 30, 4, 22, 25, 54, 21, 56, 59, 6, 63, 57, 62, 11, 36, 20, 34, 44, 52];
let wbiKeys = { key: '', mixin: '', ts: 0 };
async function wbiMixinKey() {
  if (wbiKeys.mixin && Date.now() - wbiKeys.ts < 24 * 3600 * 1000) return wbiKeys.mixin;
  const acc = biliGetAcc();
  const headers = acc && acc.cookie ? Object.assign({}, BILI_HEADERS, { Cookie: acc.cookie }) : BILI_HEADERS;
  const r = await httpGet('https://api.bilibili.com/x/web-interface/nav', headers);
  const j = JSON.parse(r.body);
  const wbi = j.data && j.data.wbi_img;
  if (!wbi) throw new Error('nav 无 wbi_img');
  const get = (u) => (u.split('/').pop() || '').split('.')[0];
  const raw = get(wbi.img_url) + get(wbi.sub_url);
  let mixin = '';
  for (const i of MIXIN_TAB) if (raw[i] !== undefined) mixin += raw[i];
  wbiKeys = { key: raw, mixin: mixin.slice(0, 32), ts: Date.now() };
  return wbiKeys.mixin;
}
function wbiSign(params, mixinKey) {
  const p = Object.assign({}, params, { wts: Math.floor(Date.now() / 1000) });
  const qs = Object.keys(p).sort()
    .map((k) => `${encodeURIComponent(k)}=${encodeURIComponent(String(p[k]).replace(/[!'()*]/g, ''))}`)
    .join('&');
  const wRid = md5(qs + mixinKey);
  return qs + '&w_rid=' + wRid;
}
// 直连解析：view 取 cid → playurl(wbi) DASH 最高音轨（登录 cookie 提升 Hi-Res 档）
export async function biliDirectResolve(bvid) {
  if (!/^BV[0-9A-Za-z]{8,12}$/.test(String(bvid || ''))) return { ok: false, reason: '无效的 BV 号' };
  const acc = biliGetAcc();
  const headers = acc && acc.cookie ? Object.assign({}, BILI_HEADERS, { Cookie: acc.cookie }) : BILI_HEADERS;
  const mixinKey = await wbiMixinKey();
  // ① view：cid + 元数据
  const vr = await httpGet('https://api.bilibili.com/x/web-interface/view?bvid=' + encodeURIComponent(bvid), headers);
  const vj = JSON.parse(vr.body);
  if (vj.code !== 0 || !vj.data) return { ok: false, reason: vj.message || '视频信息获取失败' };
  const cid = vj.data.cid;
  // ② playurl（WBI 签名）
  const qs = wbiSign({ bvid, cid, qn: 0, fnval: 16 | 512, fourk: 1, platform: 'html5', high_quality: 1 }, mixinKey);
  const pr = await httpGet('https://api.bilibili.com/x/player/wbi/playurl?' + qs, headers);
  const pj = JSON.parse(pr.body);
  if (pj.code !== 0 || !pj.data) return { ok: false, reason: pj.message || '播放地址获取失败' };
  const dash = pj.data.dash;
  const tracks = [];
  if (dash && Array.isArray(dash.audio)) tracks.push(...dash.audio);
  if (dash && dash.flac && dash.flac.baseUrl) tracks.push(dash.flac); // Hi-Res（大会员）
  if (!tracks.length) return { ok: false, reason: '响应中没有音频轨' };
  const best = tracks.slice().sort((a, b) => (b.bandwidth || 0) - (a.bandwidth || 0))[0];
  const bitrate = Math.round((best.bandwidth || 0) / 1000);
  const level = best.id === 30251 || /flac/i.test(String(best.codec || '')) ? 'lossless' : best.id === 30280 ? 'high' : 'standard';
  const data = {
    url: best.baseUrl, bitrate, format: level === 'lossless' ? 'flac' : 'm4a', level,
    title: vj.data.title || '', artist: vj.data.owner ? vj.data.owner.name : '', duration: vj.data.duration || 0, ts: Date.now()
  };
  biliCache.set(bvid, data); // 与 leiz 兜底共享缓存（同结构）
  return { ok: true, data };
}

// 播放解析（照 PC LeiZ 兜底链路，移动端无自建直连）：解析拿 merged token → POST prepare 触发合成（202）
// → 轮询合并流至 200/206（约 10-20s，上限 90s）。解析结果缓存 50 分钟
export async function biliResolve(bvid) {
  if (!/^BV[0-9A-Za-z]{8,12}$/.test(String(bvid || ''))) return { ok: false, reason: '无效的 BV 号' };
  const cached = biliCache.get(bvid);
  if (cached && Date.now() - cached.ts < BILI_CACHE_TTL) return { ok: true, data: cached };
  const r = await leizGet('/bilibili?bvid=' + encodeURIComponent(bvid) + '&qn=16');
  if (!r.ok || !r.data) return { ok: false, reason: r.message || ('HTTP ' + r.status) };
  const d = r.data;
  const audioArr = (d.dash && d.dash.audio) || [];
  let best = null;
  for (const a of audioArr) if (!best || (a.bandwidth || 0) > (best.bandwidth || 0)) best = a;
  const bitrate = best ? Math.round((best.bandwidth || 0) / 1000) : 0;
  const fmt = best ? (/flac/i.test(String(best.codec || '')) || best.id === 30251 ? 'flac' : 'm4a') : 'mp4';
  if (!d.merged || !d.merged.url) return { ok: false, reason: '响应中没有可播放的流' };
  const abs = (u) => 'https://api.bileizhen.top' + u + (u.includes('?') ? '&' : '?') + 'key=' + encodeURIComponent(LEIZ_KEY);
  const url = abs(d.merged.url);
  await httpRequest(abs(d.merged.prepareUrl), 'POST', { 'User-Agent': BILI_UA }); // 触发合成（202；不触发则永远 425）
  for (let i = 0; i < 30; i++) {
    // Range 探测：200/206=就绪，425=合并中
    const st = await httpRequest(url + '&r=' + i, 'GET', { 'User-Agent': BILI_UA, Range: 'bytes=0-0' });
    if (st.status === 200 || st.status === 206) {
      const data = { url, bitrate, format: fmt, title: d.partTitle || d.title || '', artist: d.owner || '', duration: d.duration || 0, ts: Date.now() };
      biliCache.set(bvid, data);
      return { ok: true, data };
    }
    await new Promise((resolve) => setTimeout(resolve, 3000));
  }
  return { ok: false, reason: '音视频合并超时，请稍后重试' };
}

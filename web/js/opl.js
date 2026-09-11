// opl.js — 在线歌单：URL 识别 / 酷狗分享短链解析（fetch 版）/ 歌单对象构建
// 自桌面端 main.js kugouResolveShare + renderer/app.js doImportOnlinePlaylist 提取

import { leizGet, leizPlaylist } from './leiz.js';

// 跟随重定向拿最终 URL（fetch 默认跟随会隐藏最终地址，需手动跟）
async function followRedirect(rawUrl, maxHops = 5) {
  let url = rawUrl;
  for (let i = 0; i < maxHops; i++) {
    const ctrl = new AbortController();
    const to = setTimeout(() => ctrl.abort(), 15000);
    let res;
    try {
      res = await fetch(url, { redirect: 'manual', signal: ctrl.signal, headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) Chrome/120' } });
    } catch (e) {
      clearTimeout(to);
      return { url, error: true };
    }
    clearTimeout(to);
    if (res.status >= 300 && res.status < 400 && res.headers.get('location')) {
      const loc = res.headers.get('location');
      url = loc.startsWith('http') ? loc : new URL(loc, url).href;
      continue;
    }
    return { url, error: false };
  }
  return { url, error: false };
}

// 酷狗分享短链解析：t1.kugou.com / share 页 → 最终 URL → 转 https → LeiZ 全量（失败回退分享页 100 首逻辑已由桌面端承担；移动端直接走 LeiZ）
export async function kugouResolveShare(rawUrl) {
  try {
    const { url } = await followRedirect(rawUrl);
    const lzUrl = url.replace(/^http:/i, 'https:');
    const lz = await leizGet('/kugou?type=playlist&url=' + encodeURIComponent(lzUrl));
    if (lz.ok && lz.data && Array.isArray(lz.data.songs) && lz.data.songs.length) {
      const songs = lz.data.songs.filter((s) => s && s.hash).map((s) => ({
        id: 'online:kugou:' + s.hash,
        online: true, source: 'kugou', ref: s.hash,
        title: s.name || s.song_name || '', artist: s.artists || s.author_name || '',
        duration: Math.round((s.duration || s.timelength || 0) / (s.duration ? 1 : 1000)),
        album: s.album || s.album_id || '', picUrl: s.picUrl || '', level: '128'
      }));
      if (songs.length) return { ok: true, name: lz.data.name || '', cover: lz.data.cover || '', songs };
    }
    return { ok: false, reason: '分享解析失败（网络异常或链接无效）' };
  } catch (e) {
    return { ok: false, reason: (e && e.message) || '分享解析失败' };
  }
}

// 输入 URL/id → { type:'share', url } 或 { type:'playlist', source, ref }
export function parsePlaylistInput(raw) {
  const s = String(raw || '').trim();
  if (!s) return null;
  if (/t1\.kugou\.com|kugou\.com\/share|wwwapi\.kugou\.com/i.test(s)) return { type: 'share', url: s };
  if (/163cn\.tv|music\.163\.com|netease/i.test(s)) {
    const m = s.match(/playlist\?(?:[^#]*&)?id=(\d+)/) || s.match(/playlist\/(\d+)/) || s.match(/^(\d{5,15})$/) || s.match(/id=(\d+)/);
    return { type: 'playlist', source: 'netease', ref: m ? m[1] : s };
  }
  if (/y\.qq\.com|qqmusic/i.test(s)) {
    return { type: 'error', reason: 'QQ 音乐歌单已不再支持导入。' };
  }
  if (/kugou\.com|gcid_/i.test(s)) {
    if (/songlist\/gcid_|gcid_/.test(s) && !/plist\/list\//.test(s)) {
      return { type: 'error', reason: '酷狗 gcid 歌单链接暂无法解析。请用酷狗客户端「分享→复制链接」得到 m.kugou.com/plist/list/数字 链接，或直接粘贴数字 ID。' };
    }
    const mp = s.match(/plist\/list\/(\d+)/);
    return { type: 'playlist', source: 'kugou', ref: mp ? mp[1] : s };
  }
  if (/^\d{5,15}$/.test(s)) return { type: 'playlist', source: 'netease', ref: s };
  return { type: 'error', reason: '无法识别歌单链接（支持网易云 / 酷狗 / B站收藏夹）' };
}

// 导入歌单（playlist 类型）→ 歌单对象
export async function importPlaylist(source, ref) {
  const r = await leizPlaylist(source, ref);
  if (!r.ok || !r.data) return { ok: false, reason: (r && r.message) || '歌单导入失败' };
  const d = r.data;
  const songs = [];
  for (const it of (Array.isArray(d.songs) ? d.songs : [])) {
    if (!it) continue;
    const songRef = source === 'netease' ? String(it.id || '') : String(it.hash || it.id || '');
    if (!songRef) continue;
    songs.push({
      id: 'online:' + source + ':' + songRef,
      online: true, source, ref: songRef,
      title: it.name || '', artist: it.artists || '', album: it.album || '',
      duration: it.duration || 0, picUrl: it.picUrl || '', level: source === 'netease' ? 'lossless' : '128'
    });
  }
  if (!songs.length) return { ok: false, reason: '歌单为空或解析失败' };
  return {
    ok: true,
    pl: {
      id: (source === 'netease' ? 'n' : 'k') + ':' + (source === 'netease' ? ref : (String(ref).match(/gcid_(\w+)/) || [null, ref])[1]),
      name: d.name || '在线歌单', source, cover: d.cover || d.picUrl || (songs.find((s) => s && s.picUrl) || {}).picUrl || '', desc: d.desc || '', songs
    }
  };
}

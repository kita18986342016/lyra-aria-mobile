// lrc.js — 歌词解析纯逻辑（自桌面端 renderer/app.js 提取，双端共用）
// parseLrc / parseNeteaseWordLines / parseKrcWord

export const META_RE = /^(词|曲|作词|作曲|编曲|制作人|监制|制作|混音|混录|录音|母带|词曲|原唱|翻唱|和声|吉他|贝斯|鼓手|键盘|弦乐|OP|SP|出品|发行|企划|统筹|文案|封面|设计|版权|Written by|Composer|Lyrics by|Written-By|Music by|Composed by|Produced by|Arranged by|Composed by|Produced by|Arranged by)\s*[:：]/i;

// LRC：[mm:ss.xxx] 行 → [{t(秒), text}]
export function parseLrc(text) {
  const lines = [];
  const re = /\[(\d{1,2}):(\d{1,2})(?:[.:](\d{1,3}))?\]/g;
  for (const raw of String(text || '').split(/\r?\n/)) {
    const matches = [...raw.matchAll(re)];
    if (!matches.length) continue;
    const lyric = raw.replace(re, '').trim();
    if (!lyric || META_RE.test(lyric)) continue;
    for (const m of matches) {
      const min = +m[1], sec = +m[2];
      const fracStr = m[3] || '0';
      const frac = fracStr.length === 1 ? +fracStr / 10 : (fracStr.length === 2 ? +fracStr / 100 : +fracStr / 1000);
      lines.push({ t: min * 60 + sec + frac, text: lyric });
    }
  }
  lines.sort((a, b) => a.t - b.t);
  return lines;
}

// 网易云逐字 JSON 行：{"t":毫秒,"c":[{"tx":"字","t":毫秒?}]} → [{t(秒), chars:[{ch,t(秒)}]}]
export function parseNeteaseWordLines(text) {
  const segs = [];
  for (const raw of String(text || '').split(/\r?\n/)) {
    const m = raw.match(/^\{"t":(\d+),"c":(\[.*\])}$/);
    if (!m) continue;
    try {
      const chars = JSON.parse(m[2]);
      const joined = chars.map((c) => c.tx || '').join('').trim();
      if (!joined || META_RE.test(joined)) continue;
      const items = [];
      let base = +m[1] / 1000;
      let prevT = base;
      for (const c of chars) {
        const ch = (c.tx || '').replace(/\s+/g, ' ') || ' ';
        const ct = c.t !== undefined ? +c.t / 1000 : base;
        items.push({ ch, t: Math.max(prevT, ct) });
        base = ct;
        prevT = Math.max(prevT, ct);
      }
      if (items.length) segs.push({ t: +m[1] / 1000, chars: items });
    } catch { /* 忽略坏行 */ }
  }
  return segs;
}

// 酷狗 KRC 逐字时间轴：[(毫秒,持续毫秒)<字偏移,字持续>字 → [{t(秒), chars:[{ch,t(秒)}]}]
export function parseKrcWord(text) {
  const segs = [];
  for (const raw of String(text || '').split(/\r?\n/)) {
    const tm = raw.match(/^\[(\d+),(\d+)\]([\s\S]*)$/);
    if (!tm) continue;
    const t0 = (+tm[1]) / 1000;
    const chars = [];
    const cre = /<(\d+),(\d+)(?:,\d+)?>([^<]*)/g;
    let m;
    while ((m = cre.exec(tm[3])) !== null) {
      chars.push({ ch: (m[3].replace(/\s+/g, ' ') || ' '), t: t0 + (+m[1]) / 1000 });
    }
    if (chars.length) segs.push({ t: t0, chars });
  }
  return segs;
}

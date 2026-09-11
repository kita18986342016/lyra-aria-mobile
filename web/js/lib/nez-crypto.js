// nez-crypto.js — 网易云 weapi/eapi 加密原语（Web 版，仅需加密方向）
// AES-128-CBC/ECB(PKCS7) + RSA/NO_PADDING(BigInt modPow) + MD5
// 算法标准实现，无外部依赖

// ---------- MD5 ----------
function md5(str) {
  const rl = (n, c) => (n << c) | (n >>> (32 - c));
  const au = (x, y) => { const l = (x & 0xffff) + (y & 0xffff); return (((x >> 16) + (y >> 16) + (l >> 16)) << 16) | (l & 0xffff); };
  const cm = (q, a, b, x, s, t) => au(rl(au(au(a, q), au(x, t)), s), b);
  const ff = (a, b, c, d, x, s, t) => cm((b & c) | (~b & d), a, b, x, s, t);
  const gg = (a, b, c, d, x, s, t) => cm((b & d) | (c & ~d), a, b, x, s, t);
  const hh = (a, b, c, d, x, s, t) => cm(b ^ c ^ d, a, b, x, s, t);
  const ii = (a, b, c, d, x, s, t) => cm(c ^ (b | ~d), a, b, x, s, t);
  const utf8 = unescape(encodeURIComponent(str));
  const n = utf8.length;
  const words = [];
  for (let i = 0; i < n; i++) words[i >> 2] = (words[i >> 2] || 0) | (utf8.charCodeAt(i) << ((i % 4) * 8));
  words[n >> 2] = (words[n >> 2] || 0) | (0x80 << ((n % 4) * 8));
  const len = (((n + 8) >> 6) + 1) * 16;
  for (let i = 0; i < len; i++) words[i] = words[i] || 0;
  words[len - 2] = n * 8;
  let a = 1732584193, b = -271733879, c = -1732584194, d = 271733878;
  for (let i = 0; i < len; i += 16) {
    const [oa, ob, oc, od] = [a, b, c, d];
    a = ff(a, b, c, d, words[i], 7, -680876936); d = ff(d, a, b, c, words[i + 1], 12, -389564586);
    c = ff(c, d, a, b, words[i + 2], 17, 606105819); b = ff(b, c, d, a, words[i + 3], 22, -1044525330);
    a = ff(a, b, c, d, words[i + 4], 7, -176418897); d = ff(d, a, b, c, words[i + 5], 12, 1200080426);
    c = ff(c, d, a, b, words[i + 6], 17, -1473231341); b = ff(b, c, d, a, words[i + 7], 22, -45705983);
    a = ff(a, b, c, d, words[i + 8], 7, 1770035416); d = ff(d, a, b, c, words[i + 9], 12, -1958414417);
    c = ff(c, d, a, b, words[i + 10], 17, -42063); b = ff(b, c, d, a, words[i + 11], 22, -1990404162);
    a = ff(a, b, c, d, words[i + 12], 7, 1804603682); d = ff(d, a, b, c, words[i + 13], 12, -40341101);
    c = ff(c, d, a, b, words[i + 14], 17, -1502002290); b = ff(b, c, d, a, words[i + 15], 22, 1236535329);
    a = gg(a, b, c, d, words[i + 1], 5, -165796510); d = gg(d, a, b, c, words[i + 6], 9, -1069501632);
    c = gg(c, d, a, b, words[i + 11], 14, 643717713); b = gg(b, c, d, a, words[i], 20, -373897302);
    a = gg(a, b, c, d, words[i + 5], 5, -701558691); d = gg(d, a, b, c, words[i + 10], 9, 38016083);
    c = gg(c, d, a, b, words[i + 15], 14, -660478335); b = gg(b, c, d, a, words[i + 4], 20, -405537848);
    a = gg(a, b, c, d, words[i + 9], 5, 568446438); d = gg(d, a, b, c, words[i + 14], 9, -1019803690);
    c = gg(c, d, a, b, words[i + 3], 14, -187363961); b = gg(b, c, d, a, words[i + 8], 20, 1163531501);
    a = gg(a, b, c, d, words[i + 13], 5, -1444681467); d = gg(d, a, b, c, words[i + 2], 9, -51403784);
    c = gg(c, d, a, b, words[i + 7], 14, 1735328473); b = gg(b, c, d, a, words[i + 12], 20, -1926607734);
    a = hh(a, b, c, d, words[i + 5], 4, -378558); d = hh(d, a, b, c, words[i + 8], 11, -2022574463);
    c = hh(c, d, a, b, words[i + 11], 16, 1839030562); b = hh(b, c, d, a, words[i + 14], 23, -35309556);
    a = hh(a, b, c, d, words[i + 1], 4, -1530992060); d = hh(d, a, b, c, words[i + 4], 11, 1272893353);
    c = hh(c, d, a, b, words[i + 7], 16, -155497632); b = hh(b, c, d, a, words[i + 10], 23, -1094730640);
    a = hh(a, b, c, d, words[i + 13], 4, 681279174); d = hh(d, a, b, c, words[i], 11, -358537222);
    c = hh(c, d, a, b, words[i + 3], 16, -722521979); b = hh(b, c, d, a, words[i + 6], 23, 76029189);
    a = hh(a, b, c, d, words[i + 9], 4, -640364487); d = hh(d, a, b, c, words[i + 12], 11, -421815835);
    c = hh(c, d, a, b, words[i + 15], 16, 530742520); b = hh(b, c, d, a, words[i + 2], 23, -995338651);
    a = ii(a, b, c, d, words[i], 6, -198630844); d = ii(d, a, b, c, words[i + 7], 10, 1126891415);
    c = ii(c, d, a, b, words[i + 14], 15, -1416354905); b = ii(b, c, d, a, words[i + 5], 21, -57434055);
    a = ii(a, b, c, d, words[i + 12], 6, 1700485571); d = ii(d, a, b, c, words[i + 3], 10, -1894986606);
    c = ii(c, d, a, b, words[i + 10], 15, -1051523); b = ii(b, c, d, a, words[i + 1], 21, -2054922799);
    a = ii(a, b, c, d, words[i + 8], 6, 1873313359); d = ii(d, a, b, c, words[i + 15], 10, -30611744);
    c = ii(c, d, a, b, words[i + 6], 15, -1560198380); b = ii(b, c, d, a, words[i + 13], 21, 1309151649);
    a = ii(a, b, c, d, words[i + 4], 6, -145523070); d = ii(d, a, b, c, words[i + 11], 10, -1120210379);
    c = ii(c, d, a, b, words[i + 2], 15, 718787259); b = ii(b, c, d, a, words[i + 9], 21, -343485551);
    a = au(a, oa); b = au(b, ob); c = au(c, oc); d = au(d, od);
  }
  const hex = (num) => { let s = ''; for (let j = 0; j < 4; j++) s += ((num >> (j * 8 + 4)) & 15).toString(16) + ((num >> (j * 8)) & 15).toString(16); return s; };
  return hex(a) + hex(b) + hex(c) + hex(d);
}

// ---------- AES-128（仅加密，PKCS7）----------
const SBOX = [
  0x63,0x7c,0x77,0x7b,0xf2,0x6b,0x6f,0xc5,0x30,0x01,0x67,0x2b,0xfe,0xd7,0xab,0x76,
  0xca,0x82,0xc9,0x7d,0xfa,0x59,0x47,0xf0,0xad,0xd4,0xa2,0xaf,0x9c,0xa4,0x72,0xc0,
  0xb7,0xfd,0x93,0x26,0x36,0x3f,0xf7,0xcc,0x34,0xa5,0xe5,0xf1,0x71,0xd8,0x31,0x15,
  0x04,0xc7,0x23,0xc3,0x18,0x96,0x05,0x9a,0x07,0x12,0x80,0xe2,0xeb,0x27,0xb2,0x75,
  0x09,0x83,0x2c,0x1a,0x1b,0x6e,0x5a,0xa0,0x52,0x3b,0xd6,0xb3,0x29,0xe3,0x2f,0x84,
  0x53,0xd1,0x00,0xed,0x20,0xfc,0xb1,0x5b,0x6a,0xcb,0xbe,0x39,0x4a,0x4c,0x58,0xcf,
  0xd0,0xef,0xaa,0xfb,0x43,0x4d,0x33,0x85,0x45,0xf9,0x02,0x7f,0x50,0x3c,0x9f,0xa8,
  0x51,0xa3,0x40,0x8f,0x92,0x9d,0x38,0xf5,0xbc,0xb6,0xda,0x21,0x10,0xff,0xf3,0xd2,
  0xcd,0x0c,0x13,0xec,0x5f,0x97,0x44,0x17,0xc4,0xa7,0x7e,0x3d,0x64,0x5d,0x19,0x73,
  0x60,0x81,0x4f,0xdc,0x22,0x2a,0x90,0x88,0x46,0xee,0xb8,0x14,0xde,0x5e,0x0b,0xdb,
  0xe0,0x32,0x3a,0x0a,0x49,0x06,0x24,0x5c,0xc2,0xd3,0xac,0x62,0x91,0x95,0xe4,0x79,
  0xe7,0xc8,0x37,0x6d,0x8d,0xd5,0x4e,0xa9,0x6c,0x56,0xf4,0xea,0x65,0x7a,0xae,0x08,
  0xba,0x78,0x25,0x2e,0x1c,0xa6,0xb4,0xc6,0xe8,0xdd,0x74,0x1f,0x4b,0xbd,0x8b,0x8a,
  0x70,0x3e,0xb5,0x66,0x48,0x03,0xf6,0x0e,0x61,0x35,0x57,0xb9,0x86,0xc1,0x1d,0x9e,
  0xe1,0xf8,0x98,0x11,0x69,0xd9,0x8e,0x94,0x9b,0x1e,0x87,0xe9,0xce,0x55,0x28,0xdf,
  0x8c,0xa1,0x89,0x0d,0xbf,0xe6,0x42,0x68,0x41,0x99,0x2d,0x0f,0xb0,0x54,0xbb,0x16
];
const xtime = (b) => ((b << 1) ^ ((b & 0x80) ? 0x11b : 0)) & 0xff;

const RCON = [0x01, 0x02, 0x04, 0x08, 0x10, 0x20, 0x40, 0x80, 0x1b, 0x36];
function aesExpandKey(keyBytes) {
  const w = [];
  for (let i = 0; i < 4; i++) w.push([keyBytes[4 * i], keyBytes[4 * i + 1], keyBytes[4 * i + 2], keyBytes[4 * i + 3]]);
  for (let i = 4; i < 44; i++) {
    let t = w[i - 1].slice();
    if (i % 4 === 0) {
      t = [SBOX[t[1]] ^ RCON[i / 4 - 1], SBOX[t[2]], SBOX[t[3]], SBOX[t[0]]];
    }
    w.push([w[i - 4][0] ^ t[0], w[i - 4][1] ^ t[1], w[i - 4][2] ^ t[2], w[i - 4][3] ^ t[3]]);
  }
  return w;
}

function aesEncryptBlock(block, w) {
  // state 按列主序：state[r][c] = block[c*4+r]
  const s = [[0,0,0,0],[0,0,0,0],[0,0,0,0],[0,0,0,0]];
  for (let r = 0; r < 4; r++) for (let c = 0; c < 4; c++) s[r][c] = block[c * 4 + r];
  const addRK = (rk) => { for (let c = 0; c < 4; c++) for (let r = 0; r < 4; r++) s[r][c] ^= rk[c][r]; };
  addRK(w.slice(0, 4));
  for (let round = 1; round <= 10; round++) {
    for (let r = 0; r < 4; r++) for (let c = 0; c < 4; c++) s[r][c] = SBOX[s[r][c]];
    for (let r = 1; r < 4; r++) s[r] = s[r].slice(r).concat(s[r].slice(0, r)); // 行左移
    if (round < 10) {
      for (let c = 0; c < 4; c++) {
        const a0 = s[0][c], a1 = s[1][c], a2 = s[2][c], a3 = s[3][c];
        const t = a0 ^ a1 ^ a2 ^ a3;
        s[0][c] ^= t ^ xtime(a0 ^ a1);
        s[1][c] ^= t ^ xtime(a1 ^ a2);
        s[2][c] ^= t ^ xtime(a2 ^ a3);
        s[3][c] ^= t ^ xtime(a3 ^ a0);
      }
    }
    addRK(w.slice(round * 4, round * 4 + 4));
  }
  const out = [];
  for (let c = 0; c < 4; c++) for (let r = 0; r < 4; r++) out.push(s[r][c]);
  return out;
}

function pkcs7Pad(bytes) {
  const pad = 16 - (bytes.length % 16);
  return bytes.concat(new Array(pad).fill(pad));
}

function aesEncryptBytes(plainBytes, keyBytes, ivBytes, mode) {
  const w = aesExpandKey(keyBytes);
  const data = pkcs7Pad(plainBytes);
  const out = [];
  let prev = ivBytes ? ivBytes.slice() : new Array(16).fill(0);
  for (let i = 0; i < data.length; i += 16) {
    let blk = data.slice(i, i + 16);
    if (mode === 'cbc') blk = blk.map((b, j) => b ^ prev[j]);
    const enc = aesEncryptBlock(blk, w);
    out.push(...enc);
    prev = mode === 'cbc' ? enc : enc.slice();
  }
  return out;
}

const strBytes = (s) => Array.from(new TextEncoder().encode(s));
const bytesToB64 = (bytes) => btoa(bytes.map((b) => String.fromCharCode(b)).join(''));
const bytesToHex = (bytes) => bytes.map((b) => b.toString(16).padStart(2, '0')).join('');

function aesCbcEncryptB64(text, key, iv) {
  return bytesToB64(aesEncryptBytes(strBytes(text), strBytes(key), strBytes(iv), 'cbc'));
}
function aesEcbEncryptHex(text, key) {
  return bytesToHex(aesEncryptBytes(strBytes(text), strBytes(key), null, 'ecb')).toUpperCase();
}

// ---------- RSA（NO_PADDING，BigInt）----------
const bytesToBig = (b) => b.reduce((acc, x) => acc * 256n + BigInt(x), 0n);

// 从 SPKI PEM 提取 modulus/exponent（1024 位 RSA 结构固定：02 81 81 00 + 128B 模数）
function rsaKeyFromPem(pem) {
  const der = Array.from(atob(pem.replace(/-----[^-]+-----/g, '').replace(/\s+/g, '')), (c) => c.charCodeAt(0));
  let idx = der.indexOf(0x02);
  while (!(der[idx] === 0x02 && der[idx + 1] === 0x81 && der[idx + 2] === 0x81 && der[idx + 3] === 0x00)) {
    idx = der.indexOf(0x02, idx + 1);
    if (idx < 0) throw new Error('RSA 公钥解析失败');
  }
  const modBytes = der.slice(idx + 4, idx + 4 + 128);
  const eStart = idx + 4 + 128;
  const eLen = der[eStart + 1];
  const expBytes = der.slice(eStart + 2, eStart + 2 + eLen);
  return { n: bytesToBig(modBytes), e: bytesToBig(expBytes) };
}

function modPow(b, e, m) {
  let r = 1n;
  b %= m;
  while (e > 0n) {
    if (e & 1n) r = r * b % m;
    b = b * b % m;
    e >>= 1n;
  }
  return r;
}

// 网易 weapi 用：reverse(secret) 前补零至 128 字节 → RSA no padding → hex
function rsaNoPaddingHex(keyPem, messageBytes) {
  const { n, e } = rsaKeyFromPem(keyPem);
  const padded = new Array(128).fill(0);
  const off = 128 - messageBytes.length;
  for (let i = 0; i < messageBytes.length; i++) padded[off + i] = messageBytes[i];
  const m = bytesToBig(padded);
  const c = modPow(m, e, n);
  return c.toString(16).padStart(256, '0');
}

function randomBytesHex(n) {
  const a = new Uint8Array(n);
  crypto.getRandomValues(a);
  return bytesToHex(Array.from(a));
}

export { md5, aesCbcEncryptB64, aesEcbEncryptHex, rsaNoPaddingHex, strBytes, randomBytesHex };

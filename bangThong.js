import admin, { firestore } from "./firebase.js";

// =====================================================================
// BĂNG THÔNG — đếm, khóa 2 bậc, chặn bot, giới hạn theo IP
//
// Vì sao cần: gói free của Render tính băng thông ra (outbound) theo THÁNG;
// vượt là bị dừng dịch vụ (hoặc tính tiền nếu đã gắn thẻ). File này giúp:
//   1. ĐẾM mọi byte server gửi đi, chia theo nhóm (html, ảnh, pdf, podcast,
//      tts...) và theo người / bot. Số đếm được lưu lên Firestore (collection
//      "bangthong", mỗi tháng 1 tài liệu) nên không mất khi server ngủ/khởi động lại.
//   2. KHÓA 2 BẬC theo số đã dùng trong tháng (đo bằng app, chỉnh được):
//        - Bậc 1 "hạn chế"  (mặc định 2,5 GB): tắt các phần nặng (pdf, podcast,
//          radio cũ), siết hạn mức IP/TTS, chặn bot kể cả bot "tốt" (trừ bot xem
//          trước link Facebook/Zalo...).
//        - Bậc 2 "khóa"     (mặc định 3,5 GB): mọi người chỉ thấy 1 trang
//          "tạm nghỉ" rất nhẹ (~1 KB). Khu quản lý vẫn vào được để mở khóa.
//   3. CHẶN bot thu thập dữ liệu xấu, trả "ok" ngay cho ping giữ server thức.
//   4. GIỚI HẠN theo IP (rộng rãi) cho các đường dẫn nặng.
//   5. Phục vụ /robots.txt và trang quản lý /quanly/bang-thong.
//
// CÁCH GẮN VÀO server.js (chi tiết ở hướng dẫn kèm theo):
//   - bangThongEarly: app.use(...) NGAY SAU `const app = express()` và TRƯỚC
//     compression(), để đếm đúng số byte ĐÃ NÉN thực sự gửi ra.
//   - registerBangThongRoutes(app, { requireAdmin, csrfCheck }): gọi SAU khi đã
//     có session + csrfCookie + express.urlencoded (cạnh các route /quanly khác).
//   - flushBangThong(): thêm vào hàm shutdown() để ghi nốt số đếm khi SIGTERM.
// =====================================================================

const GB = 1024 * 1024 * 1024;
const MB = 1024 * 1024;
const COLLECTION = "bangthong";
const CONFIG_DOC = "cau-hinh";
const FLUSH_MS = 2 * 60 * 1000; // ghi lên Firestore tối đa 1 lần / 2 phút (khi có thay đổi)

function numEnv(name, def) {
  const n = Number(String(process.env[name] || "").replace(",", "."));
  return Number.isFinite(n) && n > 0 ? n : def;
}

// Ngưỡng khóa (GB, đo bằng app). Có thể chỉnh trong trang quản lý (lưu Firestore,
// ưu tiên hơn biến môi trường). Mặc định đặt thấp hơn hạn mức thật của Render vì số
// đo của app thường nhỏ hơn số Render tính (không gồm phần TCP/TLS) —
// nên dùng nút "Hiệu chỉnh" ở trang quản lý để khớp số Render báo.
const cfg = {
  softGB: numEnv("BW_SOFT_GB", 2.5),
  hardGB: numEnv("BW_HARD_GB", 3.5),
  moKhoaDen: 0 // mốc thời gian (ms) tới lúc đó coi như "mở khóa tạm"
};

// Nhóm đường dẫn "nặng": áp giới hạn theo IP.
const NANG = new Set(["anh", "pdf", "podcast", "radio", "tts"]);

const TEN_NHOM = {
  html: "Trang (HTML)",
  anh: "Ảnh",
  tinh: "File giao diện (css, js)",
  pdf: "PDF qua server",
  podcast: "Podcast qua server",
  radio: "Phát thanh qua server",
  tts: "Giọng đọc (TTS)",
  api: "API",
  quanly: "Khu quản lý",
  ping: "Ping giữ server thức",
  chan: "Phản hồi chặn (403/429/503)",
  khac: "Khác"
};

// ---------------------------------------------------------------------
// Số đếm
// ---------------------------------------------------------------------
function newTally() {
  return { total: 0, cat: {}, day: {} };
}

function addTally(t, cat, bot, bytes, day) {
  t.total += bytes;
  const c = t.cat[cat] || (t.cat[cat] = { nguoiB: 0, nguoiN: 0, botB: 0, botN: 0 });
  if (bot) {
    c.botB += bytes;
    c.botN += 1;
  } else {
    c.nguoiB += bytes;
    c.nguoiN += 1;
  }
  t.day[day] = (t.day[day] || 0) + bytes;
}

function mergeTally(into, from) {
  into.total += from.total;
  for (const [k, v] of Object.entries(from.cat)) {
    const c = into.cat[k] || (into.cat[k] = { nguoiB: 0, nguoiN: 0, botB: 0, botN: 0 });
    c.nguoiB += v.nguoiB;
    c.nguoiN += v.nguoiN;
    c.botB += v.botB;
    c.botN += v.botN;
  }
  for (const [d, n] of Object.entries(from.day)) into.day[d] = (into.day[d] || 0) + n;
}

const monthKey = () => new Date().toISOString().slice(0, 7); // UTC, "2026-11"
const dayKey = () => new Date().toISOString().slice(0, 10); // UTC, "2026-11-02"

let thang = monthKey();
let base = newTally(); // đã có sẵn trên Firestore lúc nạp
let live = newTally(); // phát sinh từ lúc server chạy (tháng này)
let pending = newTally(); // chưa ghi lên Firestore
let offsetBytes = 0; // chênh lệch hiệu chỉnh theo số Render báo
let imgs = new Map(); // khóa ảnh -> { n, b, m }
let dirtyImgs = false;
let loaded = false;
let dangTai = null;
let canhBaoFirestore = false;

const tongDem = () => base.total + live.total;
const tongHieuDung = () => tongDem() + offsetBytes;

// ---------------------------------------------------------------------
// Cấp độ khóa
// ---------------------------------------------------------------------
export function capDoBangThong() {
  if (Date.now() < cfg.moKhoaDen) return "mo";
  const t = tongHieuDung();
  if (t >= cfg.hardGB * GB) return "khoa";
  if (t >= cfg.softGB * GB) return "han-che";
  return "mo";
}

let capDoCuoi = "mo";
function ghiLogDoiCapDo() {
  const cur = capDoBangThong();
  if (cur !== capDoCuoi) {
    console.warn(
      `[băng thông] đổi cấp độ: ${capDoCuoi} -> ${cur} (đã dùng ${(tongHieuDung() / GB).toFixed(2)} GB; ngưỡng ${cfg.softGB} / ${cfg.hardGB} GB)`
    );
    capDoCuoi = cur;
  }
}

export function trangThaiBangThong() {
  return { thang, capDo: capDoBangThong(), daDungGB: tongHieuDung() / GB, softGB: cfg.softGB, hardGB: cfg.hardGB };
}

// ---------------------------------------------------------------------
// Phân loại bot theo User-Agent
//   "ping"  : dịch vụ giữ server thức / health check
//   "tot"   : bot tìm kiếm + bot xem trước link (Facebook, Zalo...)
//   "xau"   : bot thu thập dữ liệu / công cụ gọi tự động -> luôn chặn
//   "nguoi" : còn lại
// ---------------------------------------------------------------------
const PING_RE = /uptime|pingdom|cron-job|healthcheck|statuscake|betterstack|site24x7|better ?uptime|render\//i;
const BOT_TOT_RE =
  /googlebot|google-inspectiontool|googleother|adsbot-google|bingbot|bingpreview|duckduckbot|facebookexternalhit|facebot|twitterbot|slackbot|telegrambot|linkedinbot|whatsapp|zalo|discordbot|skypeuripreview|applebot/i;
const BOT_XAU_RE =
  /gptbot|oai-searchbot|chatgpt-user|ccbot|claudebot|claude-web|anthropic-ai|perplexity|bytespider|amazonbot|ahrefs|semrush|mj12bot|dotbot|petalbot|blexbot|dataforseo|serpstat|seznambot|yandex|baiduspider|sogou|imagesift|diffbot|scrapy|python-requests|python-urllib|aiohttp|httpx|go-http-client|libwww-perl|apache-httpclient|java\/|curl\/|wget|httrack|masscan|zgrab|nikto|sqlmap|nmap|headlesschrome|phantomjs|node-fetch|axios\/|undici/i;
const BOT_CHUNG_RE = /\bbot\b|bot\/|crawl|spider|scrap|slurp|fetcher/i;

export function phanLoaiBot(ua) {
  const s = String(ua || "");
  if (PING_RE.test(s)) return "ping";
  if (BOT_TOT_RE.test(s)) return "tot";
  if (BOT_XAU_RE.test(s) || BOT_CHUNG_RE.test(s)) return "xau";
  if (s.trim().length < 8) return "xau"; // không có UA / UA quá ngắn: gần như chắc chắn là công cụ tự động
  return "nguoi";
}

// ---------------------------------------------------------------------
// Phân loại đường dẫn + IP
// ---------------------------------------------------------------------
export function phanLoaiDuong(path) {
  if (path.startsWith("/anh-ngoai") || path.startsWith("/anh/")) return "anh";
  if (path.startsWith("/public/")) return "tinh";
  if (path.startsWith("/pdf/")) return "pdf";
  if (path.startsWith("/podcast/")) return "podcast";
  if (path.startsWith("/radio/")) return "radio";
  if (path === "/tts") return "tts";
  if (path === "/quanly" || path.startsWith("/quanly/")) return "quanly";
  if (path.startsWith("/api/")) return "api";
  return null;
}

function catTuNoiDung(res) {
  const ct = String(res.getHeader("content-type") || "").toLowerCase();
  if (ct.includes("text/html")) return "html";
  if (ct.startsWith("image/")) return "anh";
  if (ct.startsWith("audio/") || ct.startsWith("video/") || ct.includes("mpegurl")) return "podcast";
  return "khac";
}

function layIp(req) {
  if (process.env.TRUST_CLOUDFLARE === "1" && req.headers["cf-connecting-ip"]) {
    return normIp(String(req.headers["cf-connecting-ip"]));
  }
  return normIp(String(req.ip || req.socket?.remoteAddress || "?"));
}

// IPv6: gom theo /64 (1 người dùng đổi được rất nhiều địa chỉ trong cùng /64).
function normIp(ip) {
  if (ip.startsWith("::ffff:")) return ip.slice(7);
  if (ip.includes(":")) return ip.split(":").slice(0, 4).join(":");
  return ip;
}

// ---------------------------------------------------------------------
// Giới hạn theo IP (rộng rãi — nhiều người dùng 4G chung 1 IP)
// ---------------------------------------------------------------------
function gioiHan(level) {
  const han = level === "han-che";
  const k = han ? 0.5 : 1;
  return {
    cuaSoMs: 10 * 60 * 1000,
    req10p: {
      anh: Math.round(numEnv("BW_IP_ANH", 800) * k),
      tts: Math.round(numEnv("BW_IP_TTS", 500) * k),
      pdf: Math.round(numEnv("BW_IP_PDF", 300) * k),
      podcast: Math.round(numEnv("BW_IP_PODCAST", 120) * k),
      radio: Math.round(numEnv("BW_IP_RADIO", 60) * k)
    },
    mbNgay: Math.round(numEnv("BW_IP_MB_NGAY", 300) * (han ? 0.4 : 1)),
    ttsNgay: Math.round(numEnv("BW_IP_TTS_NGAY", 400) * (han ? 0.25 : 1))
  };
}

const cuaSo = new Map(); // `${ip}|${cat}` -> { het, n }
function demCuaSo(ip, cat, ms) {
  const key = `${ip}|${cat}`;
  const now = Date.now();
  let w = cuaSo.get(key);
  if (!w || w.het <= now) {
    w = { het: now + ms, n: 0 };
    cuaSo.set(key, w);
  }
  w.n += 1;
  return w;
}

const ipNgay = new Map(); // ip -> { day, bytes, n, nang, tts, ua, loai }
function ipRec(ip) {
  const day = dayKey();
  let r = ipNgay.get(ip);
  if (!r || r.day !== day) {
    r = { day, bytes: 0, n: 0, nang: 0, tts: 0, ua: "", loai: "nguoi" };
    ipNgay.set(ip, r);
  }
  return r;
}

setInterval(() => {
  const now = Date.now();
  for (const [k, w] of cuaSo) if (w.het <= now) cuaSo.delete(k);
  const today = dayKey();
  for (const [ip, r] of ipNgay) if (r.day !== today) ipNgay.delete(ip);
  if (ipNgay.size > 3000) {
    const giu = [...ipNgay.entries()].sort((a, b) => b[1].bytes - a[1].bytes).slice(0, 1500);
    ipNgay.clear();
    for (const [ip, r] of giu) ipNgay.set(ip, r);
  }
}, 5 * 60 * 1000).unref();

// ---------------------------------------------------------------------
// Đếm byte của từng phản hồi
// Phải gắn TRƯỚC compression() — khi đó compression gọi res.write/res.end đã được
// bọc ở đây bằng dữ liệu ĐÃ NÉN, nên số đếm = số byte thực gửi ra mạng.
// ---------------------------------------------------------------------
function doDai(chunk, enc) {
  if (chunk == null || typeof chunk === "function") return 0;
  if (typeof chunk === "string") return Buffer.byteLength(chunk, typeof enc === "string" ? enc : "utf8");
  return chunk.byteLength != null ? chunk.byteLength : chunk.length || 0;
}

function dinhKemDemByte(req, res, info) {
  let body = 0;
  const w = res.write;
  const e = res.end;
  res.write = function (chunk, enc) {
    body += doDai(chunk, enc);
    return w.apply(this, arguments);
  };
  res.end = function (chunk, enc) {
    body += doDai(chunk, enc);
    return e.apply(this, arguments);
  };
  res.once("close", () => {
    try {
      const khongBody = req.method === "HEAD" || res.statusCode === 204 || res.statusCode === 304;
      const hdr = typeof res._header === "string" ? res._header.length : 300;
      ghiNhan(req, res, info, (khongBody ? 0 : body) + hdr);
    } catch (err) {
      console.warn("bangThong: lỗi khi đếm byte:", err.message);
    }
  });
}

function ghiNhan(req, res, info, bytes) {
  kiemTraThang();
  const cat = info.cat || phanLoaiDuong(req.path) || catTuNoiDung(res);
  const day = dayKey();
  addTally(live, cat, info.bot, bytes, day);
  addTally(pending, cat, info.bot, bytes, day);

  const r = ipRec(info.ip);
  r.bytes += bytes;
  r.n += 1;
  if (NANG.has(cat)) r.nang += bytes;
  r.ua = info.ua.slice(0, 90);
  r.loai = info.botKind;

  if (cat === "anh") ghiAnh(req, res, bytes);
  ghiLogDoiCapDo();
}

function ghiAnh(req, res, bytes) {
  if (res.statusCode !== 200 && res.statusCode !== 206) return;
  const ngoai = req.path.startsWith("/anh-ngoai");
  const k = (ngoai ? String((req.query && req.query.u) || "") : req.originalUrl.split("?")[0]).slice(0, 400);
  if (!k) return;
  let it = imgs.get(k);
  if (!it) {
    it = { n: 0, b: 0, m: 0 };
    imgs.set(k, it);
  }
  it.n += 1;
  it.b += bytes;
  if (bytes > it.m) it.m = bytes;
  dirtyImgs = true;
  if (imgs.size > 600) {
    const giu = [...imgs.entries()].sort((a, b) => b[1].b - a[1].b).slice(0, 400);
    imgs = new Map(giu);
  }
}

// ---------------------------------------------------------------------
// Phản hồi chặn
// ---------------------------------------------------------------------
function giayDenThangSau() {
  const d = new Date();
  const next = Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + 1, 1);
  return Math.max(60, Math.round((next - d.getTime()) / 1000));
}

function chan(res, info, status, text, opts = {}) {
  info.cat = "chan";
  res.status(status);
  res.setHeader("Cache-Control", "no-store"); // quan trọng: đừng để CDN/trình duyệt nhớ lệnh chặn
  res.setHeader("X-Robots-Tag", "noindex");
  if (opts.retryAfter) res.setHeader("Retry-After", String(opts.retryAfter));
  if (opts.header) res.setHeader(opts.header[0], opts.header[1]);
  res.type("text/plain; charset=utf-8").send(text);
}

const TRANG_TAM_NGHI = `<!DOCTYPE html><html lang="vi"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="robots" content="noindex"><title>Tạm nghỉ</title><style>body{margin:0;min-height:100vh;display:grid;place-items:center;font:16px/1.6 system-ui,"Segoe UI",Arial,sans-serif;background:#f7f3ee;color:#2a1f18;padding:24px;text-align:center}main{max-width:460px}h1{font-size:1.25rem;margin:0 0 .6rem;color:#a62626}p{margin:.4rem 0;color:#5c4a3c}</style></head><body><main><h1>Thư viện điện tử đang tạm nghỉ</h1><p>Lượng truy cập trong tháng đã chạm mức giới hạn băng thông của máy chủ, nên trang sẽ hoạt động lại vào đầu tháng sau.</p><p>Xin lỗi bạn vì sự bất tiện này.</p></main></body></html>`;

function trangTamNghi(res, info) {
  info.cat = "chan";
  res.status(503);
  res.setHeader("Cache-Control", "no-store");
  res.setHeader("Retry-After", String(giayDenThangSau()));
  res.setHeader("X-Robots-Tag", "noindex");
  res.type("text/html; charset=utf-8").send(TRANG_TAM_NGHI);
}

// Trả true nếu đã chặn (nơi gọi không gọi next nữa).
function kiemTraNang(res, info, cat, level) {
  const lim = gioiHan(level);

  if (level === "han-che" && (cat === "pdf" || cat === "podcast" || cat === "radio")) {
    chan(res, info, 503, "Tính năng này tạm dừng để tiết kiệm băng thông. Vui lòng thử lại vào đầu tháng sau.", {
      retryAfter: 3600
    });
    return true;
  }
  if (level === "han-che" && cat === "tts") {
    chan(res, info, 429, "Giọng máy chủ tạm nghỉ để tiết kiệm băng thông. Hãy dùng giọng đọc của trình duyệt.", {
      retryAfter: 3600,
      header: ["X-Het-Han-Muc", "tts"]
    });
    return true;
  }

  const w = demCuaSo(info.ip, cat, lim.cuaSoMs);
  if (w.n > lim.req10p[cat]) {
    chan(res, info, 429, "Bạn gửi yêu cầu quá nhiều trong thời gian ngắn. Vui lòng chờ ít phút.", {
      retryAfter: Math.max(30, Math.round((w.het - Date.now()) / 1000))
    });
    return true;
  }

  const r = ipRec(info.ip);
  if (r.nang >= lim.mbNgay * MB) {
    chan(res, info, 429, "Địa chỉ mạng của bạn đã dùng nhiều dữ liệu hôm nay. Vui lòng quay lại vào ngày mai.", {
      retryAfter: 3600
    });
    return true;
  }

  if (cat === "tts") {
    if (r.tts >= lim.ttsNgay) {
      chan(res, info, 429, "Đã hết hạn mức nghe bằng giọng máy chủ hôm nay. Hãy dùng giọng đọc của trình duyệt.", {
        retryAfter: 3600,
        header: ["X-Het-Han-Muc", "tts"]
      });
      return true;
    }
    r.tts += 1;
  }
  return false;
}

// ---------------------------------------------------------------------
// robots.txt
// ---------------------------------------------------------------------
const BOT_CAM = [
  "GPTBot", "ChatGPT-User", "OAI-SearchBot", "CCBot", "ClaudeBot", "Claude-Web", "anthropic-ai",
  "PerplexityBot", "Bytespider", "Amazonbot", "AhrefsBot", "SemrushBot", "MJ12bot", "DotBot",
  "PetalBot", "BLEXBot", "DataForSeoBot", "serpstatbot", "SeznamBot", "YandexBot", "Baiduspider",
  "Sogou", "ImagesiftBot", "Diffbot"
];

const ROBOTS_TXT =
  [
    "User-agent: *",
    "Disallow: /quanly",
    "Disallow: /tts",
    "Disallow: /pdf/",
    "Disallow: /podcast/",
    "Disallow: /radio/",
    "Disallow: /anh-ngoai",
    "Disallow: /tai-ve/",
    "Disallow: /api/",
    "Disallow: /debug/",
    "Disallow: /gop-y",
    "Crawl-delay: 10",
    "",
    ...BOT_CAM.flatMap((b) => [`User-agent: ${b}`, "Disallow: /", ""])
  ].join("\n") + "\n";

// ---------------------------------------------------------------------
// MIDDLEWARE chính — gắn sớm nhất có thể (trước compression)
// ---------------------------------------------------------------------
export function bangThongEarly(req, res, next) {
  kiemTraThang();
  const path = req.path;
  const ua = String(req.headers["user-agent"] || "");
  const botKind = phanLoaiBot(ua);
  const info = { cat: phanLoaiDuong(path), bot: botKind !== "nguoi", botKind, ip: layIp(req), ua };
  dinhKemDemByte(req, res, info);

  if (path === "/health") return next();

  if (path === "/robots.txt") {
    res.setHeader("Cache-Control", "public, max-age=86400");
    return res.type("text/plain; charset=utf-8").send(ROBOTS_TXT);
  }

  // Ping giữ server thức vào trang chủ: trả "ok" ngay, KHÔNG dựng cả trang.
  if (path === "/" && (req.query.ping || botKind === "ping")) {
    info.cat = "ping";
    res.setHeader("Cache-Control", "no-store");
    return res.type("text/plain; charset=utf-8").send("ok");
  }

  if (botKind === "xau") return chan(res, info, 403, "Truy cập bị từ chối.");

  const level = capDoBangThong();
  const laQuanLy = path === "/quanly" || path.startsWith("/quanly/");

  if (level === "khoa") {
    if (laQuanLy || path === "/public/style.css") return next(); // để quản trị còn vào mở khóa
    return trangTamNghi(res, info);
  }
  if (laQuanLy) return next();

  if (level === "han-che" && botKind === "tot") {
    return chan(res, info, 503, "Tạm ngừng thu thập để tiết kiệm băng thông.", { retryAfter: 3600 });
  }

  if (info.cat && NANG.has(info.cat) && kiemTraNang(res, info, info.cat, level)) return;
  next();
}

// ---------------------------------------------------------------------
// Firestore: nạp / ghi
// ---------------------------------------------------------------------
function canhBaoMotLan(err) {
  if (canhBaoFirestore) return;
  canhBaoFirestore = true;
  console.warn("bangThong: chưa dùng được Firestore (số đếm tạm giữ trong RAM) -", err.message);
}

async function taiCauHinh() {
  try {
    const snap = await firestore.collection(COLLECTION).doc(CONFIG_DOC).get();
    if (!snap.exists) return;
    const d = snap.data() || {};
    const s = Number(d.softGB);
    const h = Number(d.hardGB);
    if (Number.isFinite(s) && Number.isFinite(h) && s > 0 && h > s) {
      cfg.softGB = s;
      cfg.hardGB = h;
    }
    const m = Number(d.moKhoaDen);
    if (Number.isFinite(m) && m > cfg.moKhoaDen) cfg.moKhoaDen = m;
  } catch (err) {
    canhBaoMotLan(err);
  }
}

async function taiThang(key) {
  const snap = await firestore.collection(COLLECTION).doc(key).get();
  if (key !== thang) return; // trong lúc chờ đã sang tháng khác
  const d = snap.exists ? snap.data() || {} : {};
  const t = newTally();
  t.total = Number(d.total) || 0;
  for (const [c, v] of Object.entries(d.byCat || {})) {
    t.cat[c] = {
      nguoiB: Number(v.nguoiB) || 0,
      nguoiN: Number(v.nguoiN) || 0,
      botB: Number(v.botB) || 0,
      botN: Number(v.botN) || 0
    };
  }
  for (const [day, n] of Object.entries(d.byDay || {})) t.day[day] = Number(n) || 0;
  base = t;
  offsetBytes = Number(d.offsetBytes) || 0;
  for (const it of Array.isArray(d.topImages) ? d.topImages : []) {
    if (!it || !it.k) continue;
    const cur = imgs.get(it.k);
    if (cur) {
      cur.n += Number(it.n) || 0;
      cur.b += Number(it.b) || 0;
      cur.m = Math.max(cur.m, Number(it.m) || 0);
    } else {
      imgs.set(it.k, { n: Number(it.n) || 0, b: Number(it.b) || 0, m: Number(it.m) || 0 });
    }
  }
  loaded = true;
  ghiLogDoiCapDo();
}

function taiBanDau() {
  if (dangTai) return dangTai;
  dangTai = (async () => {
    try {
      await taiCauHinh();
      await taiThang(thang);
    } catch (err) {
      canhBaoMotLan(err);
    } finally {
      dangTai = null;
    }
  })();
  return dangTai;
}

async function ghi(key, t, topImages) {
  const inc = (n) => admin.firestore.FieldValue.increment(n);
  const data = { month: key, total: inc(t.total), updatedAt: new Date().toISOString() };
  const byCat = {};
  for (const [c, v] of Object.entries(t.cat)) {
    byCat[c] = { nguoiB: inc(v.nguoiB), nguoiN: inc(v.nguoiN), botB: inc(v.botB), botN: inc(v.botN) };
  }
  if (Object.keys(byCat).length) data.byCat = byCat;
  const byDay = {};
  for (const [d, n] of Object.entries(t.day)) byDay[d] = inc(n);
  if (Object.keys(byDay).length) data.byDay = byDay;
  if (topImages) data.topImages = topImages;
  await firestore.collection(COLLECTION).doc(key).set(data, { merge: true });
}

function topAnhDeLuu() {
  return [...imgs.entries()]
    .sort((a, b) => b[1].b - a[1].b)
    .slice(0, 60)
    .map(([k, v]) => ({ k, n: v.n, b: v.b, m: v.m }));
}

let dangGhi = null;
/** Ghi số đếm chưa lưu lên Firestore. An toàn khi gọi nhiều lần; dùng trong shutdown() của server. */
export function flushBangThong() {
  if (dangGhi) return dangGhi;
  dangGhi = (async () => {
    try {
      if (!loaded) await taiBanDau(); // chưa đọc được số cũ thì chưa ghi (tránh đè danh sách ảnh)
      if (!loaded) return;
      if (pending.total <= 0 && !dirtyImgs) return;
      const t = pending;
      const key = thang;
      const coAnh = dirtyImgs;
      pending = newTally();
      dirtyImgs = false;
      try {
        await ghi(key, t, coAnh ? topAnhDeLuu() : null);
      } catch (err) {
        mergeTally(pending, t); // ghi lỗi -> giữ lại để lần sau ghi tiếp
        if (coAnh) dirtyImgs = true;
        canhBaoMotLan(err);
      }
    } finally {
      dangGhi = null;
    }
  })();
  return dangGhi;
}

let lanKiemThangCuoi = 0;
function kiemTraThang() {
  const now = Date.now();
  if (now - lanKiemThangCuoi < 30 * 1000) return;
  lanKiemThangCuoi = now;
  const k = monthKey();
  if (k === thang) return;

  // Sang tháng mới: ghi nốt phần chưa lưu của tháng cũ rồi làm sổ mới.
  const keyCu = thang;
  const conLai = pending;
  if (conLai.total > 0) ghi(keyCu, conLai, null).catch((err) => canhBaoMotLan(err));
  thang = k;
  base = newTally();
  live = newTally();
  pending = newTally();
  offsetBytes = 0;
  imgs = new Map();
  dirtyImgs = false;
  loaded = false;
  console.log(`[băng thông] sang tháng ${k}, bắt đầu đếm lại từ 0`);
  taiBanDau();
}

setInterval(() => {
  flushBangThong().catch(() => {});
}, FLUSH_MS).unref();
taiBanDau();

// ---------------------------------------------------------------------
// Trang quản lý
// ---------------------------------------------------------------------
const fmtGio = (ms) =>
  new Date(ms).toLocaleString("vi-VN", { timeZone: "Asia/Ho_Chi_Minh", hour12: false });

const THONG_BAO = {
  "mo-khoa": ["ok", "Đã mở khóa tạm thời."],
  "khoa-lai": ["ok", "Đã bật lại khóa theo ngưỡng."],
  nguong: ["ok", "Đã lưu ngưỡng mới."],
  "hieu-chinh": ["ok", "Đã hiệu chỉnh số đo theo số Render báo."],
  "loi-nguong": ["loi", "Ngưỡng không hợp lệ: cần bậc 1 lớn hơn 0,1 GB, bậc 2 lớn hơn bậc 1 và không quá 1000 GB."],
  "loi-so": ["loi", "Số nhập vào không hợp lệ."],
  "chua-tai": ["loi", "Chưa đọc xong số liệu tháng từ Firestore, hãy thử lại sau ít giây."],
  "loi-ghi": ["loi", "Không lưu được lên Firestore. Số liệu vẫn còn trong bộ nhớ của server, thử lại sau."]
};

function layDuLieuTrang(tb) {
  const tat = newTally();
  mergeTally(tat, base);
  mergeTally(tat, live);

  const theoNhom = Object.entries(tat.cat)
    .map(([ma, v]) => ({
      ma,
      ten: TEN_NHOM[ma] || ma,
      nguoiB: v.nguoiB,
      botB: v.botB,
      nguoiN: v.nguoiN,
      botN: v.botN,
      tong: v.nguoiB + v.botB
    }))
    .sort((a, b) => b.tong - a.tong);

  let tongNguoi = 0;
  let tongBot = 0;
  theoNhom.forEach((n) => {
    tongNguoi += n.nguoiB;
    tongBot += n.botB;
  });

  const theoNgay = Object.entries(tat.day)
    .sort((a, b) => a[0].localeCompare(b[0]))
    .slice(-14)
    .map(([ngay, bytes]) => ({ ngay, bytes }));

  const anhNang = [...imgs.entries()]
    .sort((a, b) => b[1].b - a[1].b)
    .slice(0, 30)
    .map(([k, v]) => ({ k, n: v.n, b: v.b, m: v.m, href: /^https?:\/\//i.test(k) ? k : null }));

  const ipNang = [...ipNgay.entries()]
    .sort((a, b) => b[1].bytes - a[1].bytes)
    .slice(0, 10)
    .map(([ip, r]) => ({ ip, bytes: r.bytes, n: r.n, loai: r.loai, ua: r.ua }));

  const dangMoKhoa = Date.now() < cfg.moKhoaDen;
  const lim = gioiHan(capDoBangThong());
  const t = THONG_BAO[tb];

  return {
    thang,
    daTai: loaded,
    capDo: capDoBangThong(),
    tongDem: tongDem(),
    offset: offsetBytes,
    tong: tongHieuDung(),
    softGB: cfg.softGB,
    hardGB: cfg.hardGB,
    dangMoKhoa,
    moKhoaDen: dangMoKhoa ? fmtGio(cfg.moKhoaDen) : "",
    theoNhom,
    tongNguoi,
    tongBot,
    theoNgay,
    anhNang,
    ipNang,
    gioiHan: lim,
    thongBao: t ? { loai: t[0], noiDung: t[1] } : null
  };
}

const soThuc = (v) => parseFloat(String(v == null ? "" : v).trim().replace(",", "."));

async function luuCauHinh() {
  await firestore
    .collection(COLLECTION)
    .doc(CONFIG_DOC)
    .set(
      { softGB: cfg.softGB, hardGB: cfg.hardGB, moKhoaDen: cfg.moKhoaDen, updatedAt: new Date().toISOString() },
      { merge: true }
    );
}

/**
 * Gắn các route quản lý. Gọi SAU session + csrfCookie + express.urlencoded.
 *   registerBangThongRoutes(app, { requireAdmin, csrfCheck });
 */
export function registerBangThongRoutes(app, { requireAdmin, csrfCheck }) {
  app.get("/quanly/bang-thong", requireAdmin, (req, res) => {
    try {
      res.setHeader("Cache-Control", "no-store");
      res.render("admin-bangthong", layDuLieuTrang(String(req.query.tb || "")));
    } catch (err) {
      console.error("GET /quanly/bang-thong error:", err);
      res.status(500).send("Không hiển thị được trang băng thông");
    }
  });

  // Mở khóa tạm (gio = 1 | 6 | 24 | 72) hoặc bật lại khóa (gio = 0).
  app.post("/quanly/bang-thong/mo-khoa", requireAdmin, csrfCheck, async (req, res) => {
    const gio = Number(req.body && req.body.gio);
    if (![0, 1, 6, 24, 72].includes(gio)) return res.redirect("/quanly/bang-thong?tb=loi-so");
    cfg.moKhoaDen = gio === 0 ? 0 : Date.now() + gio * 3600 * 1000;
    ghiLogDoiCapDo();
    try {
      await luuCauHinh();
      res.redirect(`/quanly/bang-thong?tb=${gio === 0 ? "khoa-lai" : "mo-khoa"}`);
    } catch (err) {
      canhBaoMotLan(err);
      res.redirect("/quanly/bang-thong?tb=loi-ghi");
    }
  });

  app.post("/quanly/bang-thong/nguong", requireAdmin, csrfCheck, async (req, res) => {
    const s = soThuc(req.body && req.body.softGB);
    const h = soThuc(req.body && req.body.hardGB);
    if (!Number.isFinite(s) || !Number.isFinite(h)) return res.redirect("/quanly/bang-thong?tb=loi-so");
    if (s < 0.1 || h <= s || h > 1000) return res.redirect("/quanly/bang-thong?tb=loi-nguong");
    cfg.softGB = s;
    cfg.hardGB = h;
    ghiLogDoiCapDo();
    try {
      await luuCauHinh();
      res.redirect("/quanly/bang-thong?tb=nguong");
    } catch (err) {
      canhBaoMotLan(err);
      res.redirect("/quanly/bang-thong?tb=loi-ghi");
    }
  });

  // Đặt "tổng đã dùng" bằng đúng số Render đang báo (Dashboard > Metrics > Bandwidth).
  app.post("/quanly/bang-thong/hieu-chinh", requireAdmin, csrfCheck, async (req, res) => {
    const v = soThuc(req.body && req.body.renderGB);
    if (!Number.isFinite(v) || v < 0 || v > 100000) return res.redirect("/quanly/bang-thong?tb=loi-so");
    if (!loaded) return res.redirect("/quanly/bang-thong?tb=chua-tai");
    offsetBytes = Math.round(v * GB) - tongDem();
    ghiLogDoiCapDo();
    try {
      await firestore.collection(COLLECTION).doc(thang).set({ offsetBytes }, { merge: true });
      res.redirect("/quanly/bang-thong?tb=hieu-chinh");
    } catch (err) {
      canhBaoMotLan(err);
      res.redirect("/quanly/bang-thong?tb=loi-ghi");
    }
  });
}
import axios from "axios";
import * as cheerio from "cheerio";
import { createSwrCache } from "./swrCache.js";

// =====================================================================
// Phát thanh đề xuất — lấy bản tin MỚI NHẤT từ các đài/trang khác.
//
// Cách làm (giống "Bài đọc đề xuất", nhưng cho âm thanh):
//   1. Mở trang danh sách chuyên mục -> lấy tiêu đề, link bài, ảnh của vài
//      bản tin đầu (mới nhất nằm trên cùng).
//   2. Mở từng trang bài -> tìm link file mp3 + giờ phát.
//   3. Trang chủ cho thẻ <audio> phát THẲNG từ máy chủ của đài (KHÔNG tải về
//      đĩa của mình) và luôn có nút "Xem trên ..." dẫn về bài gốc để ghi nguồn.
//
// Cache RAM kiểu "trả bản cũ ngay, làm mới ở nền" (swrCache) + bản dự phòng
// trên Firestore. File này KHÔNG ghi gì xuống đĩa nên không làm nodemon restart.
//
// Thêm nguồn mới: thêm 1 object vào RADIO_SOURCES (xem mẫu bên dưới). Nếu
// trang đó có HTML khác NBTV thì chỉnh listSelectors cho đúng.
// =====================================================================

const RADIO_SOURCES = [
  {
    id: "nbtv-thoi-su",
    name: "Thời sự Phát thanh",
    org: "Đài PT-TH Ninh Bình (NBTV)",
    // Đúng trang bạn đang xem trên trình duyệt; khoanh vùng khối #audio_cat_267
    // (= Thời sự Phát thanh) để không lẫn sang Podcast, Phóng sự, ...
    listUrl: "https://nbtv.vn/phat-thanh",
    // Chỉ chấp nhận link/ảnh/mp3 thuộc các tên miền này (chống bị dẫn đi nơi lạ).
    allowedHosts: ["nbtv.vn", "cdn.nbtv.vn"],
    maxItems: 3, // số bản tin hiển thị
    scanItems: 10, // đọc tối đa bấy nhiêu bài trong danh sách rồi SẮP XẾP theo độ mới, lấy maxItems bài đầu
    listSelectors: {
      item: "#audio_cat_267 .audio_list .item",
      link: ".name a",
      thumb: ".thumb img"
    },
    // Kênh phát thanh TRỰC TIẾP (luồng HLS .m3u8) + lịch phát sóng trong ngày,
    // đều nằm sẵn trong HTML trang /phat-thanh.
    live: {
      playerSelector: "#audio_player", // thẻ có data-src="...playlist.m3u8"
      scheduleItemSelector: "#schedule_audio_item .item", // mỗi chương trình có data-current/data-after (giây UNIX)
      allowedHosts: ["mediatech.vn"],
      // Dự phòng nếu lần đọc không thấy link trong trang (lấy từ trang NBTV ngày 06/10/2026).
      fallbackSrc: "https://live.mediatech.vn/live/285391a08f01f83458793b293c5e9517265/playlist.m3u8"
    }
  }
];

const HTTP_TIMEOUT = 10000;
const CACHE_TTL_MS = 10 * 60 * 1000; // 10 phút mới hỏi lại đài 1 lần
const UA = "Mozilla/5.0 (compatible; ThuVienXuanGiang/2.0; +radio)";

function hostOk(source, url) {
  try {
    const h = new URL(url).hostname.toLowerCase();
    return source.allowedHosts.some((a) => h === a || h.endsWith("." + a));
  } catch {
    return false;
  }
}

function absUrl(href, base) {
  try {
    return new URL(href, base).href;
  } catch {
    return null;
  }
}

function toProxiedImage(rawUrl) {
  return rawUrl ? `/anh-ngoai?u=${encodeURIComponent(rawUrl)}` : null;
}

async function getHtml(url) {
  const { data } = await axios.get(url, {
    timeout: HTTP_TIMEOUT,
    responseType: "text",
    headers: {
      "User-Agent": UA,
      "Accept-Language": "vi,en;q=0.8",
      // Xin bản mới, tránh nhận bản đã cache sẵn ở CDN/proxy giữa đường.
      "Cache-Control": "no-cache",
      Pragma: "no-cache"
    }
  });
  return String(data || "");
}

// Độ "mới" của 1 bài, dùng để sắp xếp (số lớn = mới hơn).
// Ưu tiên giờ đăng nằm trong tên ảnh thumb: _HHMMSSDDMMYYYY.jpg
//   vd _09004906102026.jpg = 09:00:49 ngày 06/10/2026.
// Không có thì dùng số mã bài ở cuối link (-114274.html), không có nữa thì 0.
// (Thứ tự trên trang NBTV KHÔNG hoàn toàn theo thời gian, nên không tin thứ tự đó.)
export function doMoi(thumbUrl, link) {
  const t = String(thumbUrl || "").match(/_(\d{2})(\d{2})(\d{2})(\d{2})(\d{2})(\d{4})\.[a-z]+(?:\?.*)?$/i);
  if (t) {
    const [, hh, mi, ss, dd, mo, yyyy] = t;
    const ms = Date.UTC(+yyyy, +mo - 1, +dd, +hh, +mi, +ss);
    if (!Number.isNaN(ms)) return ms;
  }
  const id = String(link || "").match(/-(\d+)\.html/);
  return id ? Number(id[1]) : 0;
}

// ---- Đọc trang danh sách -> [{ title, link, thumb }] (đã sắp mới nhất trước, cắt còn maxItems) ----
export function parseList(html, source) {
  const $ = cheerio.load(html);
  const sel = source.listSelectors;
  const found = [];
  const seen = new Set();

  $(sel.item).each((idx, el) => {
    if (found.length >= (source.scanItems || source.maxItems)) return false;
    const a = $(el).find(sel.link).first();
    const href = a.attr("href");
    const link = href ? absUrl(href, source.listUrl) : null;
    if (!link || seen.has(link) || !hostOk(source, link)) return;
    seen.add(link);

    const title = a.text().replace(/\s+/g, " ").trim() || a.attr("title") || "";
    const imgSrc = $(el).find(sel.thumb).first().attr("src");
    const thumb = imgSrc ? absUrl(imgSrc, source.listUrl) : null;
    if (title) {
      found.push({
        title,
        link,
        thumb: thumb && hostOk(source, thumb) ? thumb : null,
        moi: doMoi(thumb, link),
        thuTu: idx
      });
    }
  });

  found.sort((x, y) => y.moi - x.moi || x.thuTu - y.thuTu);
  return found.slice(0, source.maxItems).map(({ title, link, thumb }) => ({ title, link, thumb }));
}

// ---- Đọc trang bài -> { mp3, publishedAt, image } ----
export function parseArticle(html, source, pageUrl) {
  const $ = cheerio.load(html);

  // Thứ tự ưu tiên: thẻ audio/source -> og:audio -> bất kỳ link .mp3/.m4a trong trang.
  const candidates = [
    $("audio").attr("src"),
    $("audio source").attr("src"),
    $('meta[property="og:audio"]').attr("content")
  ].filter(Boolean);
  const m = html.match(/https?:\/\/[^\s"'<>\\]+?\.(?:mp3|m4a)(?:\?[^\s"'<>\\]*)?/i);
  if (m) candidates.push(m[0]);

  let mp3 = null;
  for (const c of candidates) {
    const u = absUrl(c.trim(), pageUrl);
    if (u && /\.(mp3|m4a)(\?|$)/i.test(u) && hostOk(source, u)) {
      mp3 = u;
      break;
    }
  }

  // "Thứ 5, 01.10.2026 | 21:39:41"
  let publishedAt = "";
  const d = $.root().text().match(/(\d{2})\.(\d{2})\.(\d{4})\s*\|\s*(\d{2}:\d{2})(?::\d{2})?/);
  if (d) publishedAt = `${d[4]} ${d[1]}/${d[2]}/${d[3]}`;

  const bigImg = html.match(/https?:\/\/[^\s"'<>]+\/audio\/large\/[^\s"'<>]+\.(?:jpg|jpeg|png)/i);
  return { mp3, publishedAt, image: bigImg ? bigImg[0] : null };
}

// ---- Đọc phần TRỰC TIẾP: link luồng + lịch phát sóng trong ngày ----
export function parseLive(html, source) {
  const cfg = source.live;
  if (!cfg) return null;
  const $ = cheerio.load(html);

  const liveHostOk = (u) => {
    try {
      const h = new URL(u).hostname.toLowerCase();
      return cfg.allowedHosts.some((a) => h === a || h.endsWith("." + a));
    } catch {
      return false;
    }
  };

  let src = $(cfg.playerSelector).first().attr("data-src") || "";
  if (!/\.m3u8/i.test(src)) {
    const m = html.match(/https?:\/\/live\.[^\s"'<>\\]+?playlist\.m3u8/i);
    src = m ? m[0] : "";
  }
  if (!src || !liveHostOk(src)) src = cfg.fallbackSrc;
  if (!liveHostOk(src)) return null;

  const clean = (t) => String(t || "").replace(/\s+/g, " ").replace(/^[\s:]+|[\s:]+$/g, "");
  const schedule = [];
  $(cfg.scheduleItemSelector).each((_, el) => {
    const from = Number($(el).attr("data-current"));
    const to = Number($(el).attr("data-after"));
    const title = clean($(el).find(".program_title").text());
    if (!from || !to || !title) return;
    schedule.push({ from, to, title, desc: clean($(el).find(".program_desc").text()) });
  });
  schedule.sort((a, b) => a.from - b.from);

  return { src, pageUrl: source.listUrl, org: source.org, schedule };
}

// Chương trình đang phát / sắp phát — tính MỖI LẦN gọi (không cache) để luôn đúng giờ.
export function programNow(schedule, nowSec = Math.floor(Date.now() / 1000)) {
  const list = schedule || [];
  const i = list.findIndex((p) => nowSec >= p.from && nowSec < p.to);
  if (i === -1) return { now: null, next: null };
  const pick = (p) => (p ? { title: p.title, desc: p.desc } : null);
  return { now: pick(list[i]), next: pick(list[i + 1]) };
}

async function loadSource(source) {
  const html = await getHtml(source.listUrl); // 1 lần tải trang dùng cho cả danh sách lẫn trực tiếp
  const list = parseList(html, source);
  const live = parseLive(html, source);

  const items = await Promise.all(
    list.map(async (it) => {
      try {
        const info = parseArticle(await getHtml(it.link), source, it.link);
        return {
          title: it.title,
          link: it.link, // bài gốc trên trang đài (để ghi nguồn / bấm xem)
          mp3: info.mp3, // null nếu không tìm thấy file -> giao diện chỉ hiện nút xem bài gốc
          publishedAt: info.publishedAt,
          thumb: toProxiedImage(it.thumb || info.image)
        };
      } catch (err) {
        console.warn(`radio.js: không đọc được bài ${it.link} -`, err.message);
        return { title: it.title, link: it.link, mp3: null, publishedAt: "", thumb: toProxiedImage(it.thumb) };
      }
    })
  );

  console.log(`[radio] ${source.name}: ${items.length} bản tin, mới nhất: "${items[0]?.title || "-"}", mp3: ${items.filter((i) => i.mp3).length}/${items.length}`);
  return { id: source.id, name: source.name, org: source.org, url: source.listUrl, items, live };
}

async function loadAll() {
  const results = await Promise.all(
    RADIO_SOURCES.map((s) =>
      loadSource(s).catch((err) => {
        console.warn(`radio.js: nguồn "${s.name}" lỗi -`, err.message);
        return null;
      })
    )
  );
  const ok = results.filter(Boolean);
  const channels = ok.filter((r) => r.items.length).map(({ live, ...ch }) => ch);
  const live = ok.map((r) => r.live).find(Boolean) || null;
  return { live, channels };
}

const radioCache = createSwrCache({
  name: "radio.js",
  ttlMs: CACHE_TTL_MS,
  load: loadAll,
  fallback: { live: null, channels: [] },
  isEmpty: (v) => !v || (!v.live && (!v.channels || v.channels.length === 0)),
  persistKey: "radio-latest-v3"
});

/**
 * Trả về { live, channels }:
 *  - live: { src, pageUrl, org, now: {title, desc}|null, next: {title, desc}|null } hoặc null
 *  - channels: [{ id, name, org, url, items: [{ title, link, mp3, publishedAt, thumb }] }]
 */
export async function getRadioLatest() {
  const data = await radioCache.get();
  if (!data) return { live: null, channels: [] };
  let live = null;
  if (data.live) {
    const { schedule, ...rest } = data.live;
    live = { ...rest, ...programNow(schedule) }; // "đang phát" tính theo giờ hiện tại, không bị cache cũ
  }
  return { live, channels: data.channels || [] };
}

// =====================================================================
// CẦU NỐI cho luồng trực tiếp (HLS) — dùng khi trình duyệt (Chrome...) bị
// máy chủ của đài chặn nghe trực tiếp (lỗi CORS / chặn theo Referer).
//   Trình duyệt -> /radio/live/hls (server mình) -> live.mediatech.vn
// Server tải danh sách phát (.m3u8) rồi sửa đường dẫn các đoạn âm thanh để
// cũng đi qua server mình. Chỉ cho phép tên miền trong allowedHosts của live,
// và link gốc lấy từ cache chứ không nhận từ người xem -> không bị lợi dụng
// làm proxy cho trang khác.
// =====================================================================
const LIVE_HOSTS = RADIO_SOURCES.flatMap((s) => (s.live && s.live.allowedHosts) || []);

function liveHostOk(url) {
  try {
    const u = new URL(url);
    if (u.protocol !== "https:" && u.protocol !== "http:") return false;
    const h = u.hostname.toLowerCase();
    return LIVE_HOSTS.some((a) => h === a || h.endsWith("." + a));
  } catch {
    return false;
  }
}

// Đổi mọi đường dẫn trong file .m3u8 thành đường dẫn qua server mình.
export function rewriteM3u8(text, baseUrl, sid = "") {
  const sidPart = sid ? `&sid=${encodeURIComponent(sid)}` : "";
  const proxy = (u) => {
    const abs = absUrl(u, baseUrl);
    return abs ? `/radio/live/hls?u=${encodeURIComponent(abs)}${sidPart}` : u;
  };
  return String(text)
    .split(/\r?\n/)
    .map((line) => {
      const t = line.trim();
      if (!t) return line;
      if (t.startsWith("#")) return line.replace(/URI="([^"]+)"/g, (_m, u) => `URI="${proxy(u)}"`);
      return proxy(t);
    })
    .join("\n");
}

// ---- Giới hạn số người nghe trực tiếp CÙNG LÚC qua cầu nối (tiết kiệm băng thông gói free) ----
// Mỗi người nghe có 1 mã phiên (sid) do trình duyệt tạo. Trong lúc nghe, trình duyệt cứ vài giây
// hỏi lại danh sách phát -> coi là "đang nghe" nếu có yêu cầu trong LISTENER_WINDOW_MS gần nhất.
// Đổi giới hạn bằng biến môi trường RADIO_MAX_LISTENERS (mặc định 10).
const MAX_LIVE_LISTENERS = Math.max(1, Number(process.env.RADIO_MAX_LISTENERS) || 10);
const LISTENER_WINDOW_MS = 40 * 1000;

export function createListenerGate(max, windowMs, now = () => Date.now()) {
  const seen = new Map();
  const prune = () => {
    const t = now();
    for (const [k, v] of seen) if (t - v > windowMs) seen.delete(k);
  };
  return {
    /** true = cho qua. Người mới chỉ được vào khi canRegister và còn chỗ; người đang nghe luôn được qua. */
    admit(id, canRegister) {
      prune();
      if (seen.has(id)) {
        seen.set(id, now());
        return true;
      }
      if (!canRegister || seen.size >= max) return false;
      seen.set(id, now());
      return true;
    },
    count() {
      prune();
      return seen.size;
    }
  };
}
const liveGate = createListenerGate(MAX_LIVE_LISTENERS, LISTENER_WINDOW_MS);

/** Express handler: app.get("/radio/live/hls", serveLiveHls) */
export async function serveLiveHls(req, res) {
  try {
    let target = req.query.u ? String(req.query.u) : "";
    if (!target) {
      const data = await radioCache.get();
      target = (data && data.live && data.live.src) || "";
    }
    if (!target || !liveHostOk(target)) return res.status(400).send("Địa chỉ không hợp lệ");

    const sidRaw = String(req.query.sid || "");
    const sid = /^[A-Za-z0-9_-]{6,40}$/.test(sidRaw) ? sidRaw : "";
    const listenerId = sid || `ip:${req.ip}`;
    const isPlaylist = /\.m3u8/i.test(target);
    if (!liveGate.admit(listenerId, isPlaylist)) {
      res.setHeader("Retry-After", "30");
      res.setHeader("Cache-Control", "no-store");
      return res.status(429).json({ error: "full", max: MAX_LIVE_LISTENERS });
    }

    const headers = { "User-Agent": UA, Referer: "https://nbtv.vn/", Origin: "https://nbtv.vn" };

    if (isPlaylist) {
      const { data } = await axios.get(target, { timeout: HTTP_TIMEOUT, responseType: "text", headers });
      res.setHeader("Content-Type", "application/vnd.apple.mpegurl");
      res.setHeader("Cache-Control", "no-store"); // danh sách phát trực tiếp đổi liên tục
      return res.send(rewriteM3u8(data, target, sid));
    }

    const up = await axios.get(target, { timeout: HTTP_TIMEOUT, responseType: "stream", headers });
    res.setHeader("Content-Type", up.headers["content-type"] || "audio/mpeg");
    if (up.headers["content-length"]) res.setHeader("Content-Length", up.headers["content-length"]);
    res.setHeader("Cache-Control", "public, max-age=60");
    req.on("close", () => up.data.destroy());
    up.data.on("error", () => res.destroy());
    up.data.pipe(res);
  } catch (err) {
    const code = err.response && err.response.status; // mã đài trả về (vd 403 = đài chặn máy chủ của mình)
    console.warn(`radio.js: cầu nối trực tiếp lỗi - ${err.message}${code ? ` (đài trả mã ${code})` : ""}`);
    if (!res.headersSent) res.status(502).send(`Không lấy được luồng trực tiếp${code ? ` (đài trả mã ${code})` : ""}`);
  }
}
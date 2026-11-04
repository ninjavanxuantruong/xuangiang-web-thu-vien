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
// PHÁT TRỰC TIẾP: bản cũ có "cầu nối" cho luồng HLS của đài đi qua server mình
// (/radio/live/hls). Cầu nối này gửi TOÀN BỘ âm thanh qua băng thông Render nên
// đã BỎ. Giờ chỉ lấy tên chương trình "đang phát / tiếp theo" từ lịch phát sóng
// và đưa người nghe sang trang của đài bằng 1 nút mở link ngoài.
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
    // Lịch phát sóng trong ngày (có sẵn trong HTML trang /phat-thanh) — chỉ để
    // hiện "đang phát / tiếp theo"; KHÔNG còn phát luồng qua server mình.
    live: {
      scheduleItemSelector: "#schedule_audio_item .item" // mỗi chương trình có data-current/data-after (giây UNIX)
    }
  }
];

const HTTP_TIMEOUT = 10000;
const CACHE_TTL_MS = 10 * 60 * 1000; // 10 phút mới hỏi lại đài 1 lần
const UA = "Mozilla/5.0 (compatible; ThuVienXuanGiang/2.0; +radio)";

// Ảnh bìa bản tin chỉ hiện ô nhỏ 64px -> xin proxy ảnh bản thu nhỏ (tham số w).
// Proxy ảnh ở server.js bỏ qua tham số này nếu chưa hỗ trợ — không gây lỗi.
const THUMB_WIDTH = 160;

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
  return rawUrl ? `/anh-ngoai?u=${encodeURIComponent(rawUrl)}&w=${THUMB_WIDTH}` : null;
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

// ---- Đọc lịch phát sóng trong ngày -> { pageUrl, org, schedule } ----
// Không còn link luồng (src): người nghe được dẫn sang pageUrl để nghe trực tiếp tại đài.
export function parseLive(html, source) {
  const cfg = source.live;
  if (!cfg) return null;
  const $ = cheerio.load(html);

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

  return { pageUrl: source.listUrl, org: source.org, schedule };
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
  const html = await getHtml(source.listUrl); // 1 lần tải trang dùng cho cả danh sách lẫn lịch phát sóng
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
  // Chỉ lịch phát sóng mà không có bản tin nào thì vẫn coi là "rỗng" để sớm thử lại.
  isEmpty: (v) => !v || !v.channels || v.channels.length === 0,
  persistKey: "radio-latest-v4" // đổi từ v3: dạng dữ liệu "live" đã đổi (không còn src)
});

/**
 * Trả về { live, channels }:
 *  - live: { pageUrl, org, now: {title, desc}|null, next: {title, desc}|null } hoặc null
 *          (pageUrl = trang của đài để người nghe bấm mở nghe trực tiếp)
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
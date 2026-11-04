import fetch from "node-fetch";

/**
 * Lịch công tác tuần — đọc từ 1 Google Doc (secret LICH_TUAN_DOC_URL).
 *
 * Định dạng file Doc mong muốn (mỗi tuần sửa nội dung trong CÙNG 1 file):
 *
 *   Thứ hai
 *   28/9/2026
 *   - 08h30: Nội dung buổi 1 ... (đ/c Bí thư, đ/c Phó Bí thư TT).
 *   - 14h: Nội dung buổi 2 ...
 *   Thứ ba
 *   29/9/2026
 *   - 08h: ...
 *   ...
 *   Thứ bảy
 *   03/10/2026
 *   - Trực lãnh đạo: Đ/c Định - Bí thư Đảng ủy.
 *   - Trực ban: Đ/c Đoàn - CVP Đảng ủy.
 *
 * Quy tắc đọc (chịu được cả kiểu nhiều mục dính trên cùng 1 dòng):
 *  - Tiêu đề ngày = "Thứ hai/ba/tư/năm/sáu/bảy" hoặc "Chủ nhật" + ngày
 *    dạng d/m/yyyy (có thể xuống dòng, cách tab, dấu phẩy... ở giữa).
 *  - Mục có giờ = bắt đầu bằng giờ + dấu hai chấm: "08h:", "08h30:", "14h:".
 *  - Dòng không có giờ (vd "Trực lãnh đạo: ...") là 1 mục không có giờ.
 *  - Cuối mục, phần "(đ/c ...)" được tách riêng làm dòng "thành phần dự".
 *
 * Trả về: { days: [{ weekday, short, date: "2026-09-28", label: "28/9/2026",
 *                    items: [{ time, text, who }] }], updatedAt }
 * Lỗi/không cấu hình -> { days: [], error } (không ném lỗi ra ngoài).
 */

const CACHE_TTL_OK_MS = 5 * 60 * 1000; // 5 phút khi đọc thành công
const CACHE_TTL_ERR_MS = 60 * 1000; // 1 phút khi lỗi (tránh gọi dồn dập)

let cache = null; // { data, time, ttl }
let inflight = null; // gộp các request đến cùng lúc thành 1 lần tải

const WEEKDAY_SHORT = {
  "thứ hai": "T2",
  "thứ ba": "T3",
  "thứ tư": "T4",
  "thứ năm": "T5",
  "thứ sáu": "T6",
  "thứ bảy": "T7",
  "chủ nhật": "CN"
};

const HEADING_RE =
  /(Thứ\s+(?:hai|ba|tư|năm|sáu|bảy)|Chủ\s+nhật)[\s,\-–:]*(\d{1,2})\s*\/\s*(\d{1,2})\s*\/\s*(\d{4})/giu;

// Giờ + dấu hai chấm: 08h: | 08h30: | 8h05: | 14 giờ 30:
const TIME_RE = /(?<!\d)(\d{1,2})\s*(?:h|giờ)\s*(\d{2})?\s*:/giu;

const TRIM_JUNK_RE = /^[\s\-–•*·]+|[\s\-–•*·]+$/g;

function chuanHoaKhoangTrang(s) {
  return s.replace(/\s+/g, " ").trim();
}

function lamSachMuc(s) {
  return chuanHoaKhoangTrang(s).replace(TRIM_JUNK_RE, "").trim();
}

function inHoaChuDau(s) {
  return s ? s.charAt(0).toUpperCase() + s.slice(1) : s;
}

// Tách "(đ/c ...)" ở cuối mục ra làm thành phần dự.
function tachThanhPhan(text) {
  const m = text.match(/\s*\((đ\/c[^)]*)\)\s*\.?\s*$/iu);
  if (!m) return { text, who: "" };
  return {
    text: text.slice(0, m.index).trim(),
    who: inHoaChuDau(chuanHoaKhoangTrang(m[1]))
  };
}

function dinhDangGio(h, m) {
  return `${String(parseInt(h, 10)).padStart(2, "0")}h${m || ""}`;
}

function themMuc(items, time, rawText) {
  const cleaned = lamSachMuc(rawText);
  if (!cleaned) return;
  const { text, who } = tachThanhPhan(cleaned);
  const finalText = text || cleaned;
  items.push({ time, text: finalText, who: text ? who : "" });
}

// Tách nội dung của 1 ngày thành các mục.
function tachCacMuc(noiDung) {
  const items = [];
  const lines = noiDung.split(/\r?\n|\t/);

  for (const rawLine of lines) {
    const line = chuanHoaKhoangTrang(rawLine);
    if (!line) continue;

    const markers = [...line.matchAll(TIME_RE)];

    if (markers.length === 0) {
      themMuc(items, "", line); // mục không có giờ (vd "Trực ban: ...")
      continue;
    }

    // Phần đứng trước giờ đầu tiên (nếu có chữ thật) là 1 mục không giờ.
    themMuc(items, "", line.slice(0, markers[0].index));

    markers.forEach((mk, i) => {
      const start = mk.index + mk[0].length;
      const end = i + 1 < markers.length ? markers[i + 1].index : line.length;
      themMuc(items, dinhDangGio(mk[1], mk[2]), line.slice(start, end));
    });
  }

  return items;
}

function taoNgayISO(d, m, y) {
  const day = parseInt(d, 10);
  const month = parseInt(m, 10);
  const year = parseInt(y, 10);
  const dt = new Date(Date.UTC(year, month - 1, day));
  if (dt.getUTCFullYear() !== year || dt.getUTCMonth() !== month - 1 || dt.getUTCDate() !== day) {
    return null; // ngày không hợp lệ (vd 31/2)
  }
  return `${year}-${String(month).padStart(2, "0")}-${String(day).padStart(2, "0")}`;
}

/** Đọc văn bản thuần của Doc -> danh sách ngày. Xuất riêng để dễ kiểm thử. */
export function parseLichTuan(rawText) {
  const text = String(rawText || "")
    .replace(/^\uFEFF/, "")
    .normalize("NFC");

  const headings = [...text.matchAll(HEADING_RE)];
  const days = [];
  const seen = new Set();

  headings.forEach((h, i) => {
    const date = taoNgayISO(h[2], h[3], h[4]);
    if (!date || seen.has(date)) return;
    seen.add(date);

    const start = h.index + h[0].length;
    const end = i + 1 < headings.length ? headings[i + 1].index : text.length;
    const weekday = inHoaChuDau(chuanHoaKhoangTrang(h[1]).toLowerCase());

    days.push({
      weekday,
      short: WEEKDAY_SHORT[weekday.toLowerCase()] || "",
      date,
      label: `${parseInt(h[2], 10)}/${parseInt(h[3], 10)}/${h[4]}`,
      items: tachCacMuc(text.slice(start, end))
    });
  });

  days.sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : 0));
  return days;
}

// Link chia sẻ Doc (.../document/d/<ID>/edit?usp=sharing) -> link tải văn bản thuần.
function taoLinkTai(url) {
  const m = String(url || "").match(/docs\.google\.com\/document\/d\/([A-Za-z0-9_-]+)/);
  if (!m) return null;
  return `https://docs.google.com/document/d/${m[1]}/export?format=txt`;
}

async function taiVaDoc() {
  const docUrl = process.env.LICH_TUAN_DOC_URL;
  if (!docUrl) throw new Error("Chưa cấu hình LICH_TUAN_DOC_URL");

  const exportUrl = taoLinkTai(docUrl);
  if (!exportUrl) throw new Error("LICH_TUAN_DOC_URL không phải link Google Doc hợp lệ");

  const res = await fetch(exportUrl, { redirect: "follow" });
  if (!res.ok) throw new Error(`Tải Google Doc thất bại: ${res.status}`);

  const contentType = res.headers.get("content-type") || "";
  const body = await res.text();

  // Doc chưa chia sẻ công khai -> Google trả trang đăng nhập (HTML) thay vì văn bản.
  if (/text\/html/i.test(contentType) || /^\s*<(!doctype|html)/i.test(body)) {
    throw new Error('Google Doc chưa chia sẻ ở chế độ "Bất kỳ ai có đường liên kết"');
  }

  return {
    days: parseLichTuan(body),
    updatedAt: new Date().toISOString()
  };
}

export async function getLichTuan() {
  if (cache && Date.now() - cache.time < cache.ttl) return cache.data;
  if (inflight) return inflight;

  inflight = (async () => {
    try {
      const data = await taiVaDoc();
      cache = { data, time: Date.now(), ttl: CACHE_TTL_OK_MS };
      return data;
    } catch (err) {
      console.error("lichTuan.js lỗi:", err.message);
      // Có bản cũ thì dùng tạm, còn hơn làm trống cả khối.
      if (cache && cache.data && cache.data.days.length > 0) {
        cache = { data: cache.data, time: Date.now(), ttl: CACHE_TTL_ERR_MS };
        return cache.data;
      }
      const data = { days: [], error: err.message };
      cache = { data, time: Date.now(), ttl: CACHE_TTL_ERR_MS };
      return data;
    } finally {
      inflight = null;
    }
  })();

  return inflight;
}
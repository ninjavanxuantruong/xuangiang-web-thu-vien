import fetch from "node-fetch";
import { parse } from "csv-parse/sync";

// ====== Cache dùng chung cho MỌI Google Sheet đọc qua file này ======
// Kiểu "trả bản cũ ngay, làm mới ở nền":
//   - Còn hạn (5 phút)  -> trả ngay.
//   - Hết hạn           -> VẪN trả ngay bản cũ, đồng thời tải lại ở nền; người xem
//                          không phải chờ Google Sheets.
//   - Nhiều nơi gọi cùng lúc cùng 1 sheet (trang chủ gọi getDocuments() nhiều
//     lần) -> chỉ 1 lượt tải thật, các lượt còn lại chờ chung kết quả.
//   - Tải lỗi           -> giữ bản cũ, thử lại sau 1 phút. Tải treo quá 15 giây
//                          thì bỏ (trước đây có thể treo vô thời hạn).
const CACHE_TTL_MS = 5 * 60 * 1000; // 5 phút
const RETRY_AFTER_ERROR_MS = 60 * 1000; // lỗi thì thử lại sau 1 phút
const FETCH_TIMEOUT_MS = 15 * 1000;
const cache = new Map(); // key: "parsed:"+url hoặc "raw:"+url -> { data, time }
const inFlight = new Map(); // key -> Promise đang tải

async function fetchCsvText(url) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
  try {
    const res = await fetch(url, { signal: controller.signal });
    if (!res.ok) {
      throw new Error(`Fetch failed: ${res.status} ${res.statusText}`);
    }
    return await res.text();
  } finally {
    clearTimeout(timer);
  }
}

function refreshSheet(key, loader, label) {
  if (inFlight.has(key)) return inFlight.get(key);

  const task = (async () => {
    try {
      const data = await loader();
      cache.set(key, { data, time: Date.now() });
      return data;
    } catch (err) {
      console.error(`sheets.js ${label} error:`, err.message);
      const hit = cache.get(key);
      if (hit) {
        // Có bản cũ: giữ lại, coi như sẽ hết hạn sau RETRY_AFTER_ERROR_MS để thử lại.
        hit.time = Date.now() - CACHE_TTL_MS + RETRY_AFTER_ERROR_MS;
        return hit.data;
      }
      return []; // chưa từng tải được: mảng rỗng (không cache, lần sau thử lại)
    }
  })().finally(() => inFlight.delete(key));

  inFlight.set(key, task);
  return task;
}

function getSheetCached(key, loader, label) {
  const hit = cache.get(key);
  if (hit) {
    if (Date.now() - hit.time >= CACHE_TTL_MS) refreshSheet(key, loader, label); // làm mới ở nền
    return Promise.resolve(hit.data);
  }
  return refreshSheet(key, loader, label); // lần đầu tiên: phải chờ
}

/**
 * Đọc CSV từ 1 link Google Sheet đã publish (File > Share > Publish to web > CSV)
 * và parse thành mảng object, dùng dòng đầu tiên làm tên cột.
 */
export async function fetchSheet(url) {
  if (!url) return [];
  return getSheetCached(
    "parsed:" + url,
    async () => {
      const csvText = await fetchCsvText(url);
      return parse(csvText, {
        columns: true,
        skip_empty_lines: true,
        trim: true
      });
    },
    "fetchSheet"
  );
}

/**
 * Đọc CSV nhưng KHÔNG coi dòng nào là tiêu đề — dùng cho những sheet không
 * có dòng tiêu đề cố định (ví dụ sheet Danh nhân của bạn: dòng 1-3 trống,
 * dữ liệu bắt đầu từ dòng 4). Trả về mảng các mảng giá trị theo đúng thứ
 * tự cột, tự động bỏ qua các dòng hoàn toàn trống ở bất kỳ vị trí nào.
 */
export async function fetchSheetRaw(url) {
  if (!url) return [];
  return getSheetCached(
    "raw:" + url,
    async () => {
      const csvText = await fetchCsvText(url);
      const rows = parse(csvText, {
        columns: false,
        skip_empty_lines: true,
        trim: true
      });
      // Bỏ các dòng mà mọi ô đều trống (dòng 1-3 trống trong ví dụ của bạn)
      return rows.filter((row) => row.some((cell) => cell && String(cell).trim() !== ""));
    },
    "fetchSheetRaw"
  );
}

/**
 * Chuyển link chia sẻ Google Drive dạng .../file/d/<id>/view
 * thành link tải trực tiếp .../uc?export=download&id=<id>
 */
function convertDriveLink(link) {
  if (!link) return link;
  const match = link.match(/\/d\/([^/]+)\//);
  if (match && match[1]) {
    return `https://drive.google.com/uc?export=download&id=${match[1]}`;
  }
  return link;
}

/**
 * Lấy toàn bộ danh sách tài liệu từ Google Sheet (PDF_SHEET_URL trong .env).
 * Giữ nguyên các cột đang dùng trong sheet hiện tại của bạn:
 *   type | name | url | summaryD | summaryE | summaryF | faceLink (G) | NguonTrang (H)
 *
 * faceLink / NguonTrang là link + tên nguồn tin bên ngoài dùng cho phần
 * "Bài đọc đề xuất" (newsFinder.js sẽ đọc 2 cột này), KHÔNG cần sheet mới.
 */
/**
 * Lấy toàn bộ danh sách tài liệu từ Google Sheet (PDF_SHEET_URL trong .env).
 * Cột đang dùng: type | name | url | summaryD | summaryE | summaryF
 * (Cột faceLink/NguonTrang cho "Bài đọc đề xuất" đã tách sang sheet riêng —
 * xem getSuggestedSources(), SUGGESTED_SHEET_URL trong .env.)
 */
export async function getDocuments() {
  const url = process.env.PDF_SHEET_URL;
  const records = await fetchSheet(url);

  return records
    .map((r) => {
      let link = r.url || r.URL || r.link || "";
      if (link.includes("drive.google.com/file")) {
        link = convertDriveLink(link);
      }
      return {
        type: r.type || r.Type || r.loai || "Khác",
        name: r.name || r.Name || "Untitled",
        url: link,
        summaryD: r.summaryD || r.D || r.tomtat1 || "",
        summaryE: r.summaryE || r.E || r.tomtat2 || "",
        summaryF: r.summaryF || r.F || r.tomtat3 || ""
      };
    })
    .filter((item) => item.url);
}

/**
 * Danh sách nguồn tin bên ngoài duy nhất (bỏ trùng link) để đưa cho
 * newsFinder.js đi tìm bài mới nhất + ảnh của từng nguồn.
 */
/**
 * Danh sách nguồn tin cho "Bài đọc đề xuất" — đọc từ 1 Google Sheet RIÊNG
 * (SUGGESTED_SHEET_URL trong .env), tách hẳn khỏi sheet tài liệu chính.
 * Chỉ cần 2 cột: name (tên nguồn) | link (link nguồn).
 * Chưa cấu hình SUGGESTED_SHEET_URL -> trả về mảng rỗng, để server.js tự
 * ẩn hẳn khối "Bài đọc đề xuất" khi không có nguồn nào.
 */
export async function getSuggestedSources() {
  const url = process.env.SUGGESTED_SHEET_URL;
  if (!url) return [];

  const records = await fetchSheet(url);
  const seen = new Set();
  const sources = [];

  for (const r of records) {
    const link = r.link || r.Link || r.url || r.URL || "";
    const name = r.name || r.Name || r.ten || r.Ten || "";
    if (!link) continue;
    if (seen.has(link)) continue;
    seen.add(link);
    sources.push({ link, name: name || link });
  }

  return sources;
}
/**
 * Danh sách loại tài liệu (dùng cho khối "Danh mục tài liệu" ở trang chủ).
 */
export async function getDocumentTypes() {
  const docs = await getDocuments();
  return [...new Set(docs.map((d) => d.type))];
}

/**
 * Danh sách khảo sát để hiện thêm dưới form "Góp ý xây dựng Đảng" (nếu có).
 * Đọc từ 1 Google Sheet RIÊNG (SURVEY_SHEET_URL trong .env) — chỉ cần 2 cột:
 *   cột 1 = tên khảo sát | cột 2 = link khảo sát
 * Sheet trống hoặc chưa cấu hình SURVEY_SHEET_URL -> trả về mảng rỗng, để
 * server.js tự ẩn hẳn khối khảo sát khi không có nội dung nào.
 */
export async function getSurveys() {
  const url = process.env.SURVEY_SHEET_URL;
  if (!url) return [];

  const records = await fetchSheet(url);

  return records
    .map((r) => {
      const values = Object.values(r);
      return {
        name: r.name || r.Name || r.tenKhaoSat || r["tên khảo sát"] || values[0] || "",
        link: r.link || r.Link || r.linkKhaoSat || r["link khảo sát"] || values[1] || ""
      };
    })
    .filter((s) => s.name && s.link);
}
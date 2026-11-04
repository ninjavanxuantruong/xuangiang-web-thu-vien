import fs from "fs";
import fsp from "fs/promises";
import path from "path";
import { pipeline } from "stream/promises";
import { Transform } from "stream";
import fetch from "node-fetch";
import { fileURLToPath } from "url";
import { getDocuments } from "./sheets.js";

// =====================================================================
// Cache PDF ra đĩa (thư mục pdf-cache/<id>.pdf)
//
//  - Người đầu tiên mở 1 PDF: server tải từ Drive MỘT lần, lưu ra đĩa.
//  - Mọi người sau: phục vụ thẳng từ đĩa bằng res.sendFile -> Express tự hỗ
//    trợ HTTP Range (pdf.js chỉ xin các trang đang xem), ETag, 304.
//  - 30 người bấm cùng lúc khi file chưa có -> chỉ 1 lần tải từ Drive.
//  - CHỈ phục vụ file có trong sheet Tài liệu (không còn là "proxy Drive mở").
//  - Kiểm tra đúng là PDF (Drive đôi khi trả trang HTML thay vì file).
//  - Có trần dung lượng: đầy thì xóa file lâu không ai mở nhất.
//  - Đây chỉ là cache: mất file thì lần mở sau tự tải lại từ Drive.
// =====================================================================

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const CACHE_DIR = path.join(__dirname, "pdf-cache");

if (!fs.existsSync(CACHE_DIR)) {
  fs.mkdirSync(CACHE_DIR, { recursive: true });
}

// Biến môi trường đọc lúc GỌI (server.js nạp .env sau khi import chạy xong)
function maxCacheBytes() {
  const mb = parseInt(process.env.PDF_CACHE_MAX_MB || "200", 10);
  return (Number.isFinite(mb) && mb > 0 ? mb : 200) * 1024 * 1024;
}
function maxFileBytes() {
  const mb = parseInt(process.env.PDF_MAX_FILE_MB || "100", 10);
  return (Number.isFinite(mb) && mb > 0 ? mb : 100) * 1024 * 1024;
}
function refreshAfterMs() {
  // Nếu bạn thay file trên Drive nhưng giữ nguyên ID, sau chừng này ngày
  // server sẽ tải lại bản mới (hoặc xóa tay ở trang quản lý cho tức thì).
  const d = parseInt(process.env.PDF_CACHE_REFRESH_DAYS || "7", 10);
  return (Number.isFinite(d) && d > 0 ? d : 7) * 24 * 60 * 60 * 1000;
}

const DOWNLOAD_TIMEOUT_MS = 90 * 1000;
const ID_PATTERN = /^[A-Za-z0-9_-]{10,120}$/; // chặn ký tự lạ (../ ...) trong tên file

class PdfCacheError extends Error {
  constructor(message, status = 502) {
    super(message);
    this.name = "PdfCacheError";
    this.status = status;
  }
}

// ----- ID file Drive -----
function driveIdFromUrl(url) {
  const s = String(url || "");
  const byId = s.match(/[?&]id=([A-Za-z0-9_-]+)/);
  if (byId) return byId[1];
  const byPath = s.match(/\/d\/([A-Za-z0-9_-]+)/);
  if (byPath) return byPath[1];
  return null;
}

async function isAllowedFileId(id) {
  const docs = await getDocuments(); // đã có cache 5 phút trong sheets.js
  return docs.some((d) => driveIdFromUrl(d.url) === id);
}

function pathFor(id) {
  return path.join(CACHE_DIR, `${id}.pdf`);
}

async function statOrNull(p) {
  try {
    return await fsp.stat(p);
  } catch {
    return null;
  }
}

// Lần mở gần nhất (RAM). Mất khi khởi động lại -> dùng mtime thay thế.
const lastUsed = new Map(); // tên file -> timestamp

export function isPdfCached(id) {
  if (!id || !ID_PATTERN.test(id)) return false;
  return fs.existsSync(pathFor(id));
}

// ----- Tải từ Drive -----
async function tryDownload(url, tmpPath) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), DOWNLOAD_TIMEOUT_MS);
  try {
    const res = await fetch(url, { signal: controller.signal, redirect: "follow" });
    if (res.status === 404) throw new PdfCacheError("Drive báo không tìm thấy file", 404);
    if (!res.ok) throw new PdfCacheError(`Drive trả lỗi ${res.status}`, 502);

    const max = maxFileBytes();
    const declared = Number(res.headers.get("content-length") || 0);
    if (declared > max) throw new PdfCacheError("File PDF quá lớn để lưu tạm", 413);

    let bytes = 0;
    const counter = new Transform({
      transform(chunk, _enc, cb) {
        bytes += chunk.length;
        if (bytes > max) cb(new PdfCacheError("File PDF quá lớn để lưu tạm", 413));
        else cb(null, chunk);
      }
    });
    await pipeline(res.body, counter, fs.createWriteStream(tmpPath));

    // Đúng là PDF? (chuỗi %PDF- phải nằm trong 1KB đầu). Nếu Drive trả trang
    // HTML (xác nhận virus / hết lượt tải) thì bỏ, KHÔNG lưu vào cache.
    const fh = await fsp.open(tmpPath, "r");
    try {
      const head = Buffer.alloc(1024);
      const { bytesRead } = await fh.read(head, 0, 1024, 0);
      if (!head.subarray(0, bytesRead).includes("%PDF-")) {
        throw new PdfCacheError("Drive không trả về file PDF (có thể bị giới hạn lượt tải)", 502);
      }
    } finally {
      await fh.close();
    }
  } catch (err) {
    await fsp.unlink(tmpPath).catch(() => {});
    if (err instanceof PdfCacheError) throw err;
    throw new PdfCacheError(
      `Không tải được PDF từ Drive: ${err.name === "AbortError" ? "quá thời gian" : err.message}`,
      502
    );
  } finally {
    clearTimeout(timer);
  }
}

async function downloadPdf(id, tmpPath) {
  // Địa chỉ 1 dùng được với file nhỏ. File lớn (>~25MB) Drive trả trang xác
  // nhận -> thử địa chỉ 2 có kèm confirm=t.
  const urls = [
    `https://drive.google.com/uc?export=download&id=${id}`,
    `https://drive.usercontent.google.com/download?id=${id}&export=download&confirm=t`
  ];
  let lastErr;
  for (const url of urls) {
    try {
      await tryDownload(url, tmpPath);
      return;
    } catch (err) {
      lastErr = err;
      if (err.status === 404 || err.status === 413) break; // thử địa chỉ khác cũng vô ích
    }
  }
  throw lastErr;
}

// ----- Dọn khi đầy -----
async function listCacheFiles() {
  const names = await fsp.readdir(CACHE_DIR).catch(() => []);
  const files = [];
  for (const name of names) {
    if (!name.endsWith(".pdf")) continue;
    const full = path.join(CACHE_DIR, name);
    const st = await statOrNull(full);
    if (st) files.push({ name, full, size: st.size, mtimeMs: st.mtimeMs });
  }
  return files;
}

let pruning = false;

// Xóa file lâu không ai mở nhất cho tới khi còn ≤ 90% trần. KHÔNG xóa file
// vừa tải xong (protectName) dù nó một mình đã vượt trần.
async function pruneIfNeeded(protectName) {
  if (pruning) return;
  pruning = true;
  try {
    const max = maxCacheBytes();
    const files = await listCacheFiles();
    let total = files.reduce((sum, f) => sum + f.size, 0);
    if (total <= max) return;

    const target = max * 0.9;
    files.sort(
      (a, b) => (lastUsed.get(a.name) || a.mtimeMs) - (lastUsed.get(b.name) || b.mtimeMs)
    );
    for (const f of files) {
      if (total <= target) break;
      if (f.name === protectName) continue;
      try {
        await fsp.unlink(f.full);
        lastUsed.delete(f.name);
        total -= f.size;
      } catch {
        /* bỏ qua */
      }
    }
  } finally {
    pruning = false;
  }
}

// Dọn file tạm bị bỏ dở (server tắt giữa lúc đang tải)
(async () => {
  const names = await fsp.readdir(CACHE_DIR).catch(() => []);
  for (const name of names) {
    if (!name.endsWith(".tmp")) continue;
    const full = path.join(CACHE_DIR, name);
    const st = await statOrNull(full);
    if (st && Date.now() - st.mtimeMs > 60 * 60 * 1000) fsp.unlink(full).catch(() => {});
  }
})();

// ----- Bảo đảm file có trên đĩa (gộp các yêu cầu trùng) -----
const inFlight = new Map(); // id -> Promise<đường dẫn file>

async function ensureCached(id) {
  const file = pathFor(id);
  const st = await statOrNull(file);
  const fresh = st && Date.now() - st.mtimeMs < refreshAfterMs();

  if (fresh) {
    lastUsed.set(`${id}.pdf`, Date.now());
    return file;
  }
  if (inFlight.has(id)) return inFlight.get(id);

  const task = (async () => {
    const tmp = `${file}.${process.pid}.${Date.now()}.tmp`;
    try {
      await downloadPdf(id, tmp);
      await fsp.rename(tmp, file);
      lastUsed.set(`${id}.pdf`, Date.now());
      pruneIfNeeded(`${id}.pdf`).catch(() => {});
      return file;
    } catch (err) {
      // Có bản cũ (đã quá hạn làm mới) -> dùng tạm bản cũ còn hơn báo lỗi
      if (st) {
        console.warn(`pdfCache: làm mới ${id} thất bại (${err.message}), dùng bản cũ`);
        lastUsed.set(`${id}.pdf`, Date.now());
        return file;
      }
      throw err;
    }
  })();

  inFlight.set(id, task);
  try {
    return await task;
  } finally {
    inFlight.delete(id);
  }
}

/**
 * Handler cho route GET /pdf/:id
 */
export async function servePdf(req, res) {
  const id = String(req.params.id || "");
  if (!ID_PATTERN.test(id)) return res.status(400).send("Mã tài liệu không hợp lệ");

  try {
    let allowed;
    try {
      allowed = await isAllowedFileId(id);
    } catch (err) {
      console.error("pdfCache: không đọc được danh sách tài liệu -", err.message);
      return res.status(503).send("Chưa đọc được danh sách tài liệu, vui lòng thử lại sau");
    }
    if (!allowed) return res.status(404).send("Không tìm thấy tài liệu");

    const filePath = await ensureCached(id);

    res.sendFile(
      filePath,
      {
        acceptRanges: true, // Range -> pdf.js chỉ tải các trang đang xem
        cacheControl: false, // tự đặt bên dưới
        headers: {
          "Content-Type": "application/pdf",
          "Content-Disposition": "inline",
          "Cache-Control": "public, max-age=3600",
          "Access-Control-Allow-Origin": "*"
        }
      },
      (err) => {
        if (!err) return;
        // Người dùng đóng tab giữa chừng: bình thường, không phải lỗi
        if (err.code === "ECONNABORTED" || err.message === "Request aborted") return;
        console.error("pdfCache: sendFile lỗi -", err.message);
        if (!res.headersSent) res.status(503).send("Không đọc được file, vui lòng thử lại");
      }
    );
  } catch (err) {
    const status = err instanceof PdfCacheError ? err.status : 500;
    console.error("pdfCache:", err.message);
    if (!res.headersSent) res.status(status).send("Không tải được PDF");
  }
}

// ====== Dành cho trang quản lý ======
export async function getPdfCacheStats() {
  const files = await listCacheFiles();
  let names = {};
  try {
    const docs = await getDocuments();
    docs.forEach((d) => {
      const id = driveIdFromUrl(d.url);
      if (id) names[id] = d.name;
    });
  } catch {
    names = {};
  }
  const items = files
    .map((f) => {
      const id = f.name.replace(/\.pdf$/, "");
      return { id, name: names[id] || "", bytes: f.size, savedAt: new Date(f.mtimeMs).toISOString() };
    })
    .sort((a, b) => b.bytes - a.bytes);
  return {
    files: files.length,
    bytes: files.reduce((sum, f) => sum + f.size, 0),
    maxBytes: maxCacheBytes(),
    items
  };
}

/** Xóa 1 file (truyền id) hoặc toàn bộ (không truyền id). */
export async function clearPdfCache(id) {
  if (id) {
    if (!ID_PATTERN.test(id)) return { removed: 0 };
    await fsp.unlink(pathFor(id)).catch(() => {});
    lastUsed.delete(`${id}.pdf`);
    return { removed: 1 };
  }
  const files = await listCacheFiles();
  for (const f of files) {
    await fsp.unlink(f.full).catch(() => {});
    lastUsed.delete(f.name);
  }
  return { removed: files.length };
}

/** Dung lượng đĩa còn trống nơi đặt cache (nếu hệ thống hỗ trợ). */
export async function getDiskInfo() {
  try {
    const st = await fsp.statfs(CACHE_DIR);
    return { freeBytes: st.bavail * st.bsize, totalBytes: st.blocks * st.bsize };
  } catch {
    return null;
  }
}
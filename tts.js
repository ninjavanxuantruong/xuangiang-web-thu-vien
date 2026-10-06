import fs from "fs";
import fsp from "fs/promises";
import path from "path";
import crypto from "crypto";
import fetch from "node-fetch";
import { fileURLToPath } from "url";
import { normalizeText } from "./viet-normalizer.js"; // giữ nguyên file gốc, không đổi

export { normalizeText };

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const CACHE_DIR = path.join(__dirname, "audio-cache");

if (!fs.existsSync(CACHE_DIR)) {
  fs.mkdirSync(CACHE_DIR, { recursive: true });
}

// ====== Cấu hình ======
// Endpoint Google Dịch không chính thức chỉ nhận ~200 ký tự/lần. Trước đây
// server tự cắt (slice) phần dư một cách âm thầm -> mất chữ mà giao diện vẫn
// tô sáng như đã đọc xong. Nay câu quá dài bị TỪ CHỐI (413) để client biết
// mà tách nhỏ lại; client (public/main.js) luôn tách ≤ 190 ký tự trước khi gọi.
export const MAX_TEXT_LENGTH = 200;

const GOOGLE_TIMEOUT_MS = 10000;
const MAX_CONCURRENT_GOOGLE = 3; // tối đa 3 request đồng thời ra Google
const MAX_QUEUE_LENGTH = 40; // hàng chờ dài hơn mức này -> báo "bận"
const GAP_BETWEEN_CALLS_MS = 120; // nghỉ nhẹ sau mỗi lần gọi, tránh dồn dập

// Đọc biến môi trường lúc GỌI (không đọc ở đầu file) vì server.js nạp .env
// bằng dotenv SAU khi các import đã chạy xong.
function rateLimitPerMinute() {
  const n = parseInt(process.env.TTS_RATE_PER_MIN || "40", 10);
  return Number.isFinite(n) && n > 0 ? n : 40;
}
function cacheMaxBytes() {
  const mb = parseInt(process.env.AUDIO_CACHE_MAX_MB || "250", 10);
  return (Number.isFinite(mb) && mb > 0 ? mb : 250) * 1024 * 1024;
}

// ====== Lỗi có mã trạng thái, để server.js trả đúng cho client ======
export class TtsError extends Error {
  constructor(message, status = 503, retryAfter = 0) {
    super(message);
    this.name = "TtsError";
    this.status = status; // 400 / 413 / 429 / 503
    this.retryAfter = retryAfter; // giây (dùng cho 429)
  }
}

// ====== Băm / đường dẫn cache ======
function prepareText(text) {
  // NFC: chữ Việt có dấu tổ hợp rời (NFD) sẽ dài gấp nhiều lần và cho hash
  // khác nhau cho cùng 1 câu.
  return String(text || "").normalize("NFC").trim();
}

function hashText(text) {
  return crypto.createHash("sha256").update(text).digest("hex");
}

function cachePathFor(text) {
  return path.join(CACHE_DIR, `${hashText(text)}.mp3`);
}

// ====== Giới hạn tần suất theo IP (chỉ tính khi PHẢI gọi Google) ======
// Yêu cầu trúng cache không tốn gì nên không bị tính vào giới hạn.
const rateBuckets = new Map(); // ip -> [timestamps]

function consumeRateLimit(ip) {
  const now = Date.now();
  const windowMs = 60 * 1000;
  const limit = rateLimitPerMinute();
  const key = ip || "unknown";

  const list = (rateBuckets.get(key) || []).filter((t) => now - t < windowMs);
  if (list.length >= limit) {
    const retryAfter = Math.max(1, Math.ceil((windowMs - (now - list[0])) / 1000));
    rateBuckets.set(key, list);
    throw new TtsError("Bạn đang yêu cầu giọng đọc quá nhanh, vui lòng thử lại sau ít giây", 429, retryAfter);
  }
  list.push(now);
  rateBuckets.set(key, list);
}

// Dọn các IP lâu không hoạt động cho khỏi phình bộ nhớ
setInterval(() => {
  const now = Date.now();
  for (const [ip, list] of rateBuckets) {
    const fresh = list.filter((t) => now - t < 60 * 1000);
    if (fresh.length === 0) rateBuckets.delete(ip);
    else rateBuckets.set(ip, fresh);
  }
}, 5 * 60 * 1000).unref();

// ====== Hàng chờ: tối đa N request đồng thời ra Google ======
let activeGoogleCalls = 0;
const waiting = []; // các resolve đang chờ tới lượt

function acquireSlot() {
  if (activeGoogleCalls < MAX_CONCURRENT_GOOGLE) {
    activeGoogleCalls++;
    return Promise.resolve();
  }
  if (waiting.length >= MAX_QUEUE_LENGTH) {
    return Promise.reject(new TtsError("Máy chủ giọng đọc đang bận, vui lòng thử lại sau", 429, 5));
  }
  return new Promise((resolve) => waiting.push(resolve));
}

function releaseSlot() {
  setTimeout(() => {
    const next = waiting.shift();
    if (next) next(); // chuyển luôn slot cho người chờ (activeGoogleCalls giữ nguyên)
    else activeGoogleCalls--;
  }, GAP_BETWEEN_CALLS_MS);
}

// ====== Gọi Google TTS ======
async function fetchFromGoogleTTS(text) {
  const url = `https://translate.google.com/translate_tts?ie=UTF-8&q=${encodeURIComponent(
    text
  )}&tl=vi&client=tw-ob`;

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), GOOGLE_TIMEOUT_MS);

  try {
    const response = await fetch(url, {
      signal: controller.signal,
      headers: {
        "User-Agent":
          "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/119 Safari/537.36",
        Referer: "https://translate.google.com/",
        Accept: "*/*"
      }
    });

    if (!response.ok) {
      throw new TtsError(`Google TTS trả lỗi ${response.status}`, 503);
    }
    const buffer = Buffer.from(await response.arrayBuffer());
    // Google đôi khi trả 200 kèm trang HTML (bị chặn/captcha) -> không được cache
    if (buffer.length < 100) throw new TtsError("Google TTS trả dữ liệu rỗng", 503);
    return buffer;
  } catch (err) {
    if (err instanceof TtsError) throw err;
    throw new TtsError(`Không gọi được Google TTS: ${err.name === "AbortError" ? "quá thời gian" : err.message}`, 503);
  } finally {
    clearTimeout(timer);
  }
}

// ====== Theo dõi dung lượng cache + xóa file ít dùng nhất khi đầy ======
let cacheBytes = null; // null = chưa quét
let pruning = false;

async function scanCacheDir() {
  const names = await fsp.readdir(CACHE_DIR).catch(() => []);
  const files = [];
  for (const name of names) {
    if (!name.endsWith(".mp3")) continue;
    const full = path.join(CACHE_DIR, name);
    try {
      const st = await fsp.stat(full);
      files.push({ full, size: st.size, mtimeMs: st.mtimeMs });
    } catch {
      /* file vừa bị xóa, bỏ qua */
    }
  }
  return files;
}

async function ensureCacheBytes() {
  if (cacheBytes !== null) return cacheBytes;
  const files = await scanCacheDir();
  cacheBytes = files.reduce((sum, f) => sum + f.size, 0);
  return cacheBytes;
}

// Lượt nghe gần nhất được ghi bằng mtime (atime thường bị hệ thống tắt).
async function pruneIfNeeded() {
  if (pruning) return;
  const max = cacheMaxBytes();
  if (cacheBytes === null || cacheBytes <= max) return;

  pruning = true;
  try {
    const files = await scanCacheDir();
    files.sort((a, b) => a.mtimeMs - b.mtimeMs); // cũ nhất trước
    let total = files.reduce((sum, f) => sum + f.size, 0);
    const target = max * 0.9; // dọn xuống 90% trần để khỏi dọn liên tục

    for (const f of files) {
      if (total <= target) break;
      try {
        await fsp.unlink(f.full);
        total -= f.size;
      } catch {
        /* bỏ qua */
      }
    }
    cacheBytes = total;
  } finally {
    pruning = false;
  }
}

// Ghi ra file tạm rồi đổi tên -> không bao giờ có file mp3 dở dang bị phục vụ
async function saveToCache(filePath, buffer) {
  const tmp = `${filePath}.${process.pid}.${Date.now()}.tmp`;
  await fsp.writeFile(tmp, buffer);
  await fsp.rename(tmp, filePath);
  await ensureCacheBytes();
  cacheBytes += buffer.length;
  pruneIfNeeded().catch(() => {});
}

// ====== Gộp các yêu cầu trùng: nhiều người cùng xin 1 câu -> 1 lần gọi Google ======
const inFlight = new Map(); // hash -> Promise<Buffer>

/**
 * Lấy audio cho 1 đoạn văn bản (đã ≤ MAX_TEXT_LENGTH ký tự).
 *
 *   - Trúng cache đĩa -> trả ngay, không tính giới hạn tần suất.
 *   - Đang có người khác xin đúng câu này -> chờ chung kết quả.
 *   - Chưa có -> kiểm tra giới hạn theo IP, xếp hàng (tối đa 3 request đồng
 *     thời), gọi Google, lưu cache.
 *   - Câu quá dài -> ném TtsError 413 (KHÔNG cắt cụt âm thầm như bản cũ).
 *
 * options.ip: địa chỉ IP người xin (để giới hạn tần suất).
 */
export async function getAudioForText(text, options = {}) {
  const cleaned = prepareText(text);
  if (!cleaned) throw new TtsError("Thiếu nội dung để đọc", 400);
  if (cleaned.length > MAX_TEXT_LENGTH) {
    throw new TtsError(`Đoạn văn quá dài (${cleaned.length} > ${MAX_TEXT_LENGTH} ký tự), cần tách nhỏ`, 413);
  }

  const filePath = cachePathFor(cleaned);

  // 1) Trúng cache đĩa
  try {
    const buffer = await fsp.readFile(filePath);
    const now = new Date();
    fsp.utimes(filePath, now, now).catch(() => {}); // đánh dấu "vừa được nghe"
    return { buffer, contentType: "audio/mpeg" };
  } catch {
    /* chưa có file -> đi tiếp */
  }

  // 2) Đang có người xin đúng câu này
  const key = hashText(cleaned);
  if (inFlight.has(key)) {
    const buffer = await inFlight.get(key);
    return { buffer, contentType: "audio/mpeg" };
  }

  // 3) Phải gọi Google thật -> tính giới hạn tần suất theo IP
  consumeRateLimit(options.ip);

  const task = (async () => {
    await acquireSlot();
    try {
      const buffer = await fetchFromGoogleTTS(cleaned);
      await saveToCache(filePath, buffer);
      return buffer;
    } finally {
      releaseSlot();
    }
  })();

  inFlight.set(key, task);
  try {
    const buffer = await task;
    return { buffer, contentType: "audio/mpeg" };
  } finally {
    inFlight.delete(key);
  }
}

// ====== Dành cho trang quản lý (đợt sau) ======
export async function getAudioCacheStats() {
  const files = await scanCacheDir();
  const bytes = files.reduce((sum, f) => sum + f.size, 0);
  cacheBytes = bytes;
  return { files: files.length, bytes, maxBytes: cacheMaxBytes() };
}

export async function clearAudioCache() {
  const files = await scanCacheDir();
  let removed = 0;
  for (const f of files) {
    try {
      await fsp.unlink(f.full);
      removed++;
    } catch {
      /* bỏ qua */
    }
  }
  cacheBytes = 0;
  return { removed };
}
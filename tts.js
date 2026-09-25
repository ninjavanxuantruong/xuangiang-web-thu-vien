import fs from "fs";
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

function hashText(text) {
  return crypto.createHash("sha256").update(text).digest("hex");
}

function cachePathFor(text) {
  return path.join(CACHE_DIR, `${hashText(text)}.mp3`);
}

async function fetchFromGoogleTTS(text) {
  // Endpoint không chính thức của Google Dịch — giới hạn ~200 ký tự/lần,
  // client (reader.ejs) đã tự chia văn bản thành đoạn nhỏ trước khi gọi.
  const trimmed = text.trim().slice(0, 200);
  const url = `https://translate.google.com/translate_tts?ie=UTF-8&q=${encodeURIComponent(
    trimmed
  )}&tl=vi&client=tw-ob`;

  const response = await fetch(url, {
    headers: {
      "User-Agent":
        "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/119 Safari/537.36",
      Referer: "https://translate.google.com/",
      Accept: "*/*"
    }
  });

  if (!response.ok) {
    throw new Error(`Google TTS fetch failed: ${response.status}`);
  }

  return Buffer.from(await response.arrayBuffer());
}

/**
 * Lấy audio cho 1 đoạn văn bản — tự động cache ra đĩa (thư mục audio-cache/)
 * theo hash nội dung, KHÔNG theo tên tài liệu:
 *
 *   - Lần đầu bất kỳ ai nghe đúng đoạn văn này -> gọi Google TTS, lưu file mp3.
 *   - Từ lần 2 trở đi (bất kỳ ai, ở bất kỳ tài liệu nào trùng đoạn văn) ->
 *     trả thẳng file đã cache, không gọi TTS nữa -> gần như tức thì.
 *   - Sửa nội dung tài liệu -> hash khác -> tự tạo cache mới, không cần
 *     dọn dẹp hay thao tác gì thêm.
 *
 * Nếu Google TTS lỗi/bị chặn, ném lỗi ra ngoài để server.js trả 503 và
 * client tự chuyển sang giọng đọc mặc định của trình duyệt (speechSynthesis)
 * — không có cơ chế fallback giọng đọc nào ở phía server.
 */
export async function getAudioForText(text) {
  const cleaned = (text || "").trim();
  if (!cleaned) throw new Error("Thiếu nội dung để đọc");

  const filePath = cachePathFor(cleaned);

  if (fs.existsSync(filePath)) {
    return { buffer: fs.readFileSync(filePath), contentType: "audio/mpeg" };
  }

  const buffer = await fetchFromGoogleTTS(cleaned);
  fs.writeFileSync(filePath, buffer);
  return { buffer, contentType: "audio/mpeg" };
}

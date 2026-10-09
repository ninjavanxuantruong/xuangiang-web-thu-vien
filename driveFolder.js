import axios from "axios";

// =====================================================================
// Lấy danh sách ẢNH trong 1 thư mục Google Drive (dùng cho mục Danh nhân & Địa điểm).
// Dùng đúng cách podcast.js đang lấy danh sách file trong folder: Drive API v3 + API key
// (YOUTUBE_API_KEY hoặc GOOGLE_API_KEY), nên thư mục phải để chế độ "Bất kỳ ai có đường liên kết".
// Cache 30 phút trong RAM (đỡ tốn quota, đỡ chậm); lỗi thì giữ danh sách cũ nếu có.
// =====================================================================

const API_KEY = process.env.YOUTUBE_API_KEY || process.env.GOOGLE_API_KEY || "";
const SAFE_ID = /^[\w-]{10,}$/;
const IMAGE_EXT = /\.(jpe?g|png|gif|webp|bmp|avif|heic)$/i;
const MAX_IMAGES = 40; // tối đa bấy nhiêu ảnh / thư mục (tránh bài dài lê thê)
const OK_TTL_MS = 30 * 60 * 1000;
const FAIL_TTL_MS = 2 * 60 * 1000;

/**
 * Lấy ID thư mục từ link dạng:
 *   https://drive.google.com/drive/folders/<ID>?usp=sharing
 *   https://drive.google.com/drive/u/0/folders/<ID>
 *   https://drive.google.com/folderview?id=<ID>
 * Không phải link thư mục thì trả null (link file ảnh / link trang web vẫn xử lý như cũ).
 */
export function layIdThuMucDrive(url) {
  if (!url || !/drive\.google\.com/i.test(url)) return null;
  let m = String(url).match(/\/folders\/([A-Za-z0-9_-]+)/);
  if (m) return m[1];
  m = String(url).match(/(?:folderview|embeddedfolderview)\?[^#]*\bid=([A-Za-z0-9_-]+)/);
  return m ? m[1] : null;
}

function laAnh(f) {
  return (f.mimeType || "").startsWith("image/") || IMAGE_EXT.test(f.name || "");
}

const cache = new Map(); // folderId -> { files, time, ttl }
const inFlight = new Map();

async function goiDrive(folderId) {
  if (!API_KEY) throw new Error("Thiếu YOUTUBE_API_KEY / GOOGLE_API_KEY (dùng chung cho Drive API)");
  const files = [];
  let pageToken;
  do {
    const { data } = await axios.get("https://www.googleapis.com/drive/v3/files", {
      timeout: 15000,
      params: {
        q: `'${folderId}' in parents and trashed = false`,
        fields: "nextPageToken,files(id,name,mimeType)",
        pageSize: 100,
        pageToken,
        key: API_KEY
      }
    });
    files.push(...(data.files || []).filter((f) => laAnh(f) && SAFE_ID.test(f.id || "")));
    pageToken = data.nextPageToken;
  } while (pageToken && files.length < MAX_IMAGES * 2);

  // Sắp theo tên file (1, 2, ..., 10 chứ không phải 1, 10, 2) để ảnh đầu = ảnh đại diện mong muốn.
  files.sort((a, b) => String(a.name).localeCompare(String(b.name), "vi", { numeric: true }));
  return files.slice(0, MAX_IMAGES).map((f) => ({ id: f.id, name: f.name }));
}

/** Trả về [{ id, name }] các ảnh trong thư mục (theo tên file). Không bao giờ ném lỗi — lỗi thì trả []. */
export async function layAnhTrongThuMuc(folderId) {
  if (!folderId || !SAFE_ID.test(folderId)) return [];

  const hit = cache.get(folderId);
  if (hit && Date.now() - hit.time < hit.ttl) return hit.files;
  if (inFlight.has(folderId)) return inFlight.get(folderId);

  const task = (async () => {
    try {
      const files = await goiDrive(folderId);
      cache.set(folderId, { files, time: Date.now(), ttl: files.length ? OK_TTL_MS : FAIL_TTL_MS });
      return files;
    } catch (err) {
      const status = err.response && err.response.status;
      console.warn(
        `driveFolder.js: không đọc được thư mục ${folderId} -`,
        err.message + (status ? ` (Drive trả ${status}: kiểm tra thư mục đã để "Bất kỳ ai có đường liên kết" và Drive API đã bật cho API key)` : "")
      );
      const old = hit ? hit.files : []; // có bản cũ thì dùng tạm
      cache.set(folderId, { files: old, time: Date.now(), ttl: FAIL_TTL_MS });
      return old;
    }
  })().finally(() => inFlight.delete(folderId));

  inFlight.set(folderId, task);
  return task;
}

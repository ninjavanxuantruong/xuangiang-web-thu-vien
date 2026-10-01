import fs from "fs";
import fsp from "fs/promises";
import path from "path";
import axios from "axios";
import { fileURLToPath } from "url";

// =====================================================================
// Podcast — lấy file mp3 MỚI NHẤT trong 1 folder Google Drive công khai
// (bạn xoá file cũ, thả file mới vào folder đó mỗi ngày), tự tải về lưu
// đĩa (podcast-cache/), tự xoá bản cũ khi phát hiện có file mới hơn.
//
// Dùng chung API key Google đã cấu hình cho Youtube (YOUTUBE_API_KEY) —
// chỉ cần bật thêm "Google Drive API" trong cùng project Google Cloud,
// không cần tạo key mới. Folder Drive phải để "Bất kỳ ai có đường liên
// kết -> Người xem" thì API key mới đọc được (không cần OAuth).
// =====================================================================

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const CACHE_DIR = path.join(__dirname, "podcast-cache");
const STATE_FILE = path.join(CACHE_DIR, "current.json");

if (!fs.existsSync(CACHE_DIR)) {
  fs.mkdirSync(CACHE_DIR, { recursive: true });
}

const API_KEY = process.env.YOUTUBE_API_KEY || process.env.GOOGLE_API_KEY || "";
// Lấy từ link folder bạn gửi: .../folders/14h_esBeKYTDWozhKfTf9fKnrf7Q2wSst
const FOLDER_ID = process.env.PODCAST_DRIVE_FOLDER_ID || "14h_esBeKYTDWozhKfTf9fKnrf7Q2wSst";

const CACHE_TTL_MS = 10 * 60 * 1000; // 10 phút mới hỏi lại Drive 1 lần (đỡ tốn quota)
const DOWNLOAD_TIMEOUT_MS = 120 * 1000;

let memCache = null;
let memCacheTime = 0;

function docThongTinDaLuu() {
  try {
    return JSON.parse(fs.readFileSync(STATE_FILE, "utf8"));
  } catch {
    return null;
  }
}
function ghiThongTinDaLuu(state) {
  fs.writeFileSync(STATE_FILE, JSON.stringify(state, null, 2), "utf8");
}

// Hỏi Drive: trong folder này, file audio nào MỚI TẠO GẦN ĐÂY NHẤT?
async function layFileMoiNhatTuDrive() {
  if (!API_KEY) throw new Error("Thiếu YOUTUBE_API_KEY (dùng chung cho Drive API)");

  const { data } = await axios.get("https://www.googleapis.com/drive/v3/files", {
    timeout: 15000,
    params: {
      q: `'${FOLDER_ID}' in parents and trashed = false`,
      orderBy: "createdTime desc",
      fields: "files(id,name,mimeType,size,createdTime,modifiedTime)",
      pageSize: 10,
      key: API_KEY
    }
  });

  const files = (data.files || []).filter(
    (f) => (f.mimeType || "").startsWith("audio/") || /\.mp3$/i.test(f.name || "")
  );
  if (files.length === 0) throw new Error("Folder Drive không có file mp3 nào");

  return files[0]; // mới nhất
}

// Tải file mp3 về đĩa, ghi đè/xoá bản cũ nếu có.
async function taiVeVaLuuDia(fileMeta) {
  const tenFileAnToan = `podcast-${fileMeta.id}.mp3`;
  const duongDanMoi = path.join(CACHE_DIR, tenFileAnToan);

  const url = `https://www.googleapis.com/drive/v3/files/${fileMeta.id}?alt=media&key=${API_KEY}`;
  const resp = await axios.get(url, {
    responseType: "stream",
    timeout: DOWNLOAD_TIMEOUT_MS
  });

  await new Promise((resolve, reject) => {
    const ghi = fs.createWriteStream(duongDanMoi);
    resp.data.pipe(ghi);
    ghi.on("finish", resolve);
    ghi.on("error", reject);
    resp.data.on("error", reject);
  });

  // Xoá các file podcast cũ khác (đúng ý "xoá đi ghi lại hàng ngày") —
  // giữ lại đúng 1 file mp3 duy nhất trong cache.
  const daCo = await fsp.readdir(CACHE_DIR);
  await Promise.all(
    daCo
      .filter((ten) => ten.startsWith("podcast-") && ten.endsWith(".mp3") && ten !== tenFileAnToan)
      .map((ten) => fsp.unlink(path.join(CACHE_DIR, ten)).catch(() => {}))
  );

  const state = {
    fileId: fileMeta.id,
    name: fileMeta.name,
    modifiedTime: fileMeta.modifiedTime,
    sizeBytes: Number(fileMeta.size || 0),
    localFileName: tenFileAnToan,
    updatedAt: new Date().toISOString()
  };
  ghiThongTinDaLuu(state);
  return state;
}

/**
 * Trả về thông tin podcast mới nhất + đảm bảo file đã có sẵn trên đĩa để
 * phát ngay. Có cache 10 phút (không hỏi Drive liên tục); nếu Drive lỗi
 * tạm thời thì dùng tạm bản đang có trên đĩa (không làm mất tiếng đang phát).
 */
export async function getLatestPodcast() {
  if (memCache && Date.now() - memCacheTime < CACHE_TTL_MS) return memCache;

  const daLuu = docThongTinDaLuu();

  try {
    const moiNhat = await layFileMoiNhatTuDrive();

    let state = daLuu;
    const canTaiLai = !daLuu || daLuu.fileId !== moiNhat.id || daLuu.modifiedTime !== moiNhat.modifiedTime;

    if (canTaiLai) {
      console.log("podcast.js: có file mới, đang tải về -", moiNhat.name);
      state = await taiVeVaLuuDia(moiNhat);
    }

    memCache = tuStateSangKetQua(state);
    memCacheTime = Date.now();
    return memCache;
  } catch (err) {
    console.warn("podcast.js: lỗi lấy file mới từ Drive -", err.message);
    // Drive lỗi tạm thời -> vẫn phát được bản đang có sẵn trên đĩa (nếu có).
    if (daLuu) {
      memCache = tuStateSangKetQua(daLuu);
      memCacheTime = Date.now();
      return memCache;
    }
    return null;
  }
}

function tuStateSangKetQua(state) {
  return {
    title: (state.name || "Podcast").replace(/\.mp3$/i, ""),
    updatedAt: state.updatedAt || state.modifiedTime,
    sizeMB: state.sizeBytes ? Math.round((state.sizeBytes / (1024 * 1024)) * 10) / 10 : null,
    localPath: path.join(CACHE_DIR, state.localFileName)
  };
}

/** Đường dẫn file mp3 đang cache trên đĩa — dùng cho route stream audio. */
export function getCachedPodcastPath() {
  const state = docThongTinDaLuu();
  if (!state) return null;
  const p = path.join(CACHE_DIR, state.localFileName);
  return fs.existsSync(p) ? p : null;
}
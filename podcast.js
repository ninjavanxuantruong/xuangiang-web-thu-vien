import fs from "fs";
import fsp from "fs/promises";
import path from "path";
import axios from "axios";
import { pipeline } from "stream/promises";
import { fileURLToPath } from "url";
import { createSwrCache } from "./swrCache.js";

// =====================================================================
// Podcast — lấy TẤT CẢ file âm thanh (mp3, m4a...) trong 1 folder Google
// Drive công khai. Bài MỚI NHẤT nằm đầu danh sách. Trang chủ hiện trình
// phát có danh sách bài, bấm bài nào nghe bài đó, hết bài tự sang bài kế.
//
// Cách làm việc:
//   - Danh sách bài: hỏi Drive tối đa 1 lần/10 phút (cache RAM kiểu "trả bản
//     cũ ngay, làm mới ở nền" + bản dự phòng trên Firestore và trên đĩa).
//   - File âm thanh: KHÔNG tải hết về cùng lúc (folder có thể có hàng chục
//     bài). Bài mới nhất được tải sẵn; các bài khác tải về đĩa (podcast-
//     cache/) ngay lần đầu có người bấm nghe, các lần sau phát thẳng từ đĩa
//     (có tua được). Đĩa chỉ giữ tối đa PODCAST_MAX_CACHED_FILES bài / 
//     PODCAST_MAX_CACHED_MB dung lượng, bài lâu không ai nghe bị xoá trước.
//
// Dùng chung API key Google đã cấu hình cho Youtube (YOUTUBE_API_KEY) —
// chỉ cần bật thêm "Google Drive API" trong cùng project Google Cloud.
// Folder Drive phải để "Bất kỳ ai có đường liên kết -> Người xem".
//
// Biến môi trường tuỳ chọn:
//   PODCAST_DRIVE_FOLDER_ID    mã folder Drive (mặc định: folder hiện tại)
//   PODCAST_MAX_TRACKS         tối đa bao nhiêu bài hiện trên trang (mặc định 100)
//   PODCAST_MAX_CACHED_FILES   tối đa bao nhiêu bài giữ trên đĩa (mặc định 8)
//   PODCAST_MAX_CACHED_MB      tối đa dung lượng giữ trên đĩa, MB (mặc định 400)
//   PODCAST_PREFETCH           tải sẵn bao nhiêu bài mới nhất (mặc định 1)
// =====================================================================

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const CACHE_DIR = path.join(__dirname, "podcast-cache");
const LIST_FILE = path.join(CACHE_DIR, "list.json");

if (!fs.existsSync(CACHE_DIR)) {
  fs.mkdirSync(CACHE_DIR, { recursive: true });
}
// Dọn các file tải dở còn sót lại từ lần chạy trước (bị tắt giữa chừng).
try {
  for (const name of fs.readdirSync(CACHE_DIR)) {
    if (name.endsWith(".part")) fs.unlinkSync(path.join(CACHE_DIR, name));
  }
} catch {
  /* bỏ qua */
}

function intEnv(name, fallback) {
  const n = parseInt(process.env[name] || "", 10);
  return Number.isFinite(n) && n > 0 ? n : fallback;
}

const API_KEY = process.env.YOUTUBE_API_KEY || process.env.GOOGLE_API_KEY || "";
// Lấy từ link folder bạn gửi: .../folders/14h_esBeKYTDWozhKfTf9fKnrf7Q2wSst
const FOLDER_ID = process.env.PODCAST_DRIVE_FOLDER_ID || "14h_esBeKYTDWozhKfTf9fKnrf7Q2wSst";

const LIST_TTL_MS = 10 * 60 * 1000; // 10 phút mới hỏi lại Drive 1 lần (đỡ tốn quota)
const DOWNLOAD_TIMEOUT_MS = 120 * 1000;
const MAX_TRACKS = intEnv("PODCAST_MAX_TRACKS", 100);
const MAX_CACHED_FILES = intEnv("PODCAST_MAX_CACHED_FILES", 8);
const MAX_CACHED_BYTES = intEnv("PODCAST_MAX_CACHED_MB", 400) * 1024 * 1024;
const PREFETCH_COUNT = intEnv("PODCAST_PREFETCH", 1);

const AUDIO_EXT = /\.(mp3|m4a|aac|wav|ogg|oga|opus)$/i;
const SAFE_ID = /^[\w-]{10,}$/;

function laFileAmThanh(f) {
  return (f.mimeType || "").startsWith("audio/") || AUDIO_EXT.test(f.name || "");
}
function layDuoiFile(name) {
  const m = AUDIO_EXT.exec(name || "");
  return m ? m[0].toLowerCase() : ".mp3";
}
function duongDanTrenDia(track) {
  return path.join(CACHE_DIR, `podcast-${track.id}${track.ext}`);
}

// ---------------------------------------------------------------------
// Danh sách bài từ Drive
// ---------------------------------------------------------------------
async function layDanhSachTuDrive() {
  if (!API_KEY) throw new Error("Thiếu YOUTUBE_API_KEY (dùng chung cho Drive API)");

  const files = [];
  let pageToken;
  do {
    const { data } = await axios.get("https://www.googleapis.com/drive/v3/files", {
      timeout: 15000,
      params: {
        q: `'${FOLDER_ID}' in parents and trashed = false`,
        orderBy: "createdTime desc", // bài mới nhất lên đầu
        fields: "nextPageToken,files(id,name,mimeType,size,createdTime,modifiedTime)",
        pageSize: 100,
        pageToken,
        key: API_KEY
      }
    });
    files.push(...(data.files || []).filter((f) => laFileAmThanh(f) && SAFE_ID.test(f.id || "")));
    pageToken = data.nextPageToken;
  } while (pageToken && files.length < MAX_TRACKS);

  return files.slice(0, MAX_TRACKS);
}

function docDanhSachDaLuu() {
  try {
    const files = JSON.parse(fs.readFileSync(LIST_FILE, "utf8"));
    return Array.isArray(files) ? files : null;
  } catch {
    return null;
  }
}
function ghiDanhSachDaLuu(files) {
  try {
    const noiDung = JSON.stringify(files);
    // Nội dung không đổi thì không ghi lại (tránh kích hoạt nodemon/restart không cần thiết).
    try {
      if (fs.readFileSync(LIST_FILE, "utf8") === noiDung) return;
    } catch {
      /* chưa có file -> ghi mới */
    }
    fs.writeFileSync(LIST_FILE, noiDung, "utf8");
  } catch (err) {
    console.warn("podcast.js: không ghi được danh sách dự phòng -", err.message);
  }
}

function taoKetQua(files) {
  const tracks = files.map((f) => {
    const sizeBytes = Number(f.size || 0);
    return {
      id: f.id,
      title: (f.name || "Podcast").replace(AUDIO_EXT, ""),
      ext: layDuoiFile(f.name),
      sizeBytes,
      sizeMB: sizeBytes ? Math.round((sizeBytes / (1024 * 1024)) * 10) / 10 : null,
      createdTime: f.createdTime || f.modifiedTime || null,
      src: `/podcast/audio/${f.id}`
    };
  });
  const dau = tracks[0];
  // Giữ các trường cũ (title, updatedAt, sizeMB) của bài mới nhất để chỗ nào
  // còn dùng kiểu cũ vẫn chạy được.
  return {
    title: dau ? dau.title : "",
    updatedAt: dau ? dau.createdTime : null,
    sizeMB: dau ? dau.sizeMB : null,
    tracks,
    count: tracks.length
  };
}

async function taiDanhSach() {
  try {
    const files = await layDanhSachTuDrive();
    ghiDanhSachDaLuu(files);
    const ketQua = taoKetQua(files);
    // Tải sẵn bài mới nhất để người nghe đầu tiên không phải chờ.
    for (const track of ketQua.tracks.slice(0, PREFETCH_COUNT)) {
      taiVeDia(track).catch((err) => console.warn("podcast.js: tải sẵn bài mới lỗi -", err.message));
    }
    return ketQua;
  } catch (err) {
    console.warn("podcast.js: lỗi lấy danh sách từ Drive -", err.message);
    // Drive lỗi tạm thời -> dùng danh sách đã lưu trên đĩa (nếu có).
    const daLuu = docDanhSachDaLuu();
    if (daLuu) return taoKetQua(daLuu);
    throw err;
  }
}

// Bản cũ trả ngay, làm mới ở nền; bản dự phòng lưu cả trên Firestore để vừa
// khởi động lại là có danh sách ngay.
const danhSachCache = createSwrCache({
  name: "podcast.js",
  ttlMs: LIST_TTL_MS,
  load: taiDanhSach,
  fallback: null,
  isEmpty: (v) => !v,
  persistKey: "podcast-list"
});

/**
 * Trả về { title, updatedAt, sizeMB, tracks: [...], count } hoặc null nếu chưa
 * lấy được gì. tracks[0] là bài mới nhất; mỗi bài có { id, title, sizeMB,
 * createdTime, src } — src là địa chỉ để thẻ <audio> phát.
 */
export function getLatestPodcast() {
  return danhSachCache.get();
}

// ---------------------------------------------------------------------
// File âm thanh trên đĩa
// ---------------------------------------------------------------------
const dangTai = new Map(); // id -> Promise<đường dẫn> (gộp các lượt tải trùng)

function fileTrenDiaHopLe(track, p) {
  try {
    const st = fs.statSync(p);
    if (!st.isFile() || st.size === 0) return false;
    return !track.sizeBytes || st.size === track.sizeBytes;
  } catch {
    return false;
  }
}

// Giữ đĩa gọn: chỉ giữ tối đa MAX_CACHED_FILES bài / MAX_CACHED_BYTES, ưu tiên
// bài vừa được nghe gần đây (mtime được "chạm" mỗi lần phát).
async function donDepCache(giuLai) {
  const names = (await fsp.readdir(CACHE_DIR)).filter((n) => n.startsWith("podcast-") && !n.endsWith(".part"));
  const infos = (
    await Promise.all(
      names.map(async (n) => {
        const p = path.join(CACHE_DIR, n);
        const st = await fsp.stat(p).catch(() => null);
        return st ? { p, size: st.size, t: st.mtimeMs } : null;
      })
    )
  ).filter(Boolean);

  infos.sort((a, b) => (a.p === giuLai ? -1 : b.p === giuLai ? 1 : b.t - a.t));
  let soFile = 0;
  let soByte = 0;
  for (const info of infos) {
    const giu = info.p === giuLai || (soFile < MAX_CACHED_FILES && soByte + info.size <= MAX_CACHED_BYTES);
    if (giu) {
      soFile++;
      soByte += info.size;
    } else {
      await fsp.unlink(info.p).catch(() => {});
    }
  }
}

function chamFile(p) {
  const now = new Date();
  fsp.utimes(p, now, now).catch(() => {});
}

// Đảm bảo bài này có trên đĩa; trả về đường dẫn file. Nhiều người cùng bấm
// 1 bài mới thì chỉ tải 1 lần. Tải về file tạm .part rồi mới đổi tên, nên
// không bao giờ phát nhầm file dở dang.
function taiVeDia(track) {
  const dich = duongDanTrenDia(track);
  if (fileTrenDiaHopLe(track, dich)) {
    chamFile(dich);
    return Promise.resolve(dich);
  }
  if (dangTai.has(track.id)) return dangTai.get(track.id);

  const tam = dich + ".part";
  const task = (async () => {
    try {
      console.log("podcast.js: đang tải về -", track.title);
      const url = `https://www.googleapis.com/drive/v3/files/${track.id}?alt=media&key=${API_KEY}`;
      const resp = await axios.get(url, { responseType: "stream", timeout: DOWNLOAD_TIMEOUT_MS });
      await pipeline(resp.data, fs.createWriteStream(tam));

      const st = await fsp.stat(tam);
      if (st.size === 0 || (track.sizeBytes && st.size !== track.sizeBytes)) {
        throw new Error(`File tải về không đủ (${st.size}/${track.sizeBytes || "?"} byte)`);
      }
      await fsp.rename(tam, dich);
      donDepCache(dich).catch(() => {});
      return dich;
    } catch (err) {
      await fsp.unlink(tam).catch(() => {});
      throw err;
    }
  })().finally(() => dangTai.delete(track.id));

  dangTai.set(track.id, task);
  return task;
}

/**
 * Đường dẫn file âm thanh của 1 bài (tải từ Drive về đĩa nếu chưa có). Chỉ
 * nhận bài NẰM TRONG DANH SÁCH hiện tại; id lạ trả null -> route trả 404.
 * Ném lỗi nếu tải từ Drive thất bại.
 */
export async function getPodcastTrackFile(id) {
  if (!SAFE_ID.test(String(id || ""))) return null;
  const list = await getLatestPodcast();
  const track = list && list.tracks ? list.tracks.find((t) => t.id === id) : null;
  if (!track) return null;
  return taiVeDia(track);
}

/** Đường dẫn file của bài MỚI NHẤT đang có trên đĩa — giữ cho route cũ /podcast/audio. */
export function getCachedPodcastPath() {
  const files = docDanhSachDaLuu();
  if (!files || files.length === 0) return null;
  const [dau] = taoKetQua(files).tracks;
  const p = duongDanTrenDia(dau);
  return fileTrenDiaHopLe(dau, p) ? p : null;
}
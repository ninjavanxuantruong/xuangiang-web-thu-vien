import axios from "axios";
import { createSwrCache } from "./swrCache.js";
import { fetchSheet } from "./sheets.js";

// ====== ĐỔI SANG YOUTUBE DATA API v3 CHÍNH THỨC (thay vì RSS + cào HTML để
// suy channelId) — xem giải thích đầy đủ trong youtube.js. Với module này,
// API còn giúp bỏ hẳn bước "tải trang kênh về tìm channelId trong HTML",
// vì API có endpoint resolve thẳng từ @handle hoặc /user/ sang channelId. ======

const API_KEY = process.env.YOUTUBE_API_KEY || "";
const CACHE_TTL_MS = 30 * 60 * 1000; // 30 phút cho danh sách video
const CACHE_INFO_TTL_MS = 24 * 60 * 60 * 1000; // 24h cho thông tin kênh đã suy ra (ít đổi)
const HTTP_TIMEOUT = 10000;


const cacheChannelInfo = new Map(); // link kênh -> { channelId, uploadsPlaylistId, channelTitle, time }

// Nhận diện link kênh thuộc dạng nào để biết cách hỏi API: theo ID trực
// tiếp (/channel/UC...), theo @handle (kiểu mới, phổ biến nhất hiện nay),
// hoặc theo username kiểu cũ (/user/...). Link dạng /c/TenTuyChinh không
// có cách resolve chính thức qua API — nếu gặp, thử coi như handle (đôi
// khi trùng), không chắc luôn đúng.
function nhanDienLinkKenh(url) {
  const idMatch = (url || "").match(/\/channel\/(UC[0-9A-Za-z_-]{22})/);
  if (idMatch) return { kieu: "id", giaTri: idMatch[1] };

  const handleMatch = (url || "").match(/youtube\.com\/@([A-Za-z0-9._-]+)/);
  if (handleMatch) return { kieu: "handle", giaTri: handleMatch[1] };

  const userMatch = (url || "").match(/youtube\.com\/user\/([A-Za-z0-9._-]+)/);
  if (userMatch) return { kieu: "username", giaTri: userMatch[1] };

  const cMatch = (url || "").match(/youtube\.com\/c\/([A-Za-z0-9._-]+)/);
  if (cMatch) return { kieu: "handle", giaTri: cMatch[1] }; // thử tạm coi như handle

  return null;
}

async function suyRaThongTinKenh(url) {
  const cached = cacheChannelInfo.get(url);
  if (cached && Date.now() - cached.time < CACHE_INFO_TTL_MS) return cached;

  const nhanDien = nhanDienLinkKenh(url);
  if (!nhanDien) {
    console.warn(
      "channelVideos: không nhận diện được dạng link kênh:", url,
      "— nên dùng link dạng youtube.com/@ten-kenh hoặc youtube.com/channel/UC..."
    );
    return null;
  }

  const params = { part: "contentDetails,snippet", key: API_KEY };
  if (nhanDien.kieu === "id") params.id = nhanDien.giaTri;
  else if (nhanDien.kieu === "handle") params.forHandle = `@${nhanDien.giaTri}`;
  else if (nhanDien.kieu === "username") params.forUsername = nhanDien.giaTri;

  const { data } = await axios.get("https://www.googleapis.com/youtube/v3/channels", {
    timeout: HTTP_TIMEOUT,
    params
  });

  const item = data.items?.[0];
  if (!item) return null;

  const info = {
    channelId: item.id,
    uploadsPlaylistId: item.contentDetails?.relatedPlaylists?.uploads || null,
    channelTitle: item.snippet?.title || null,
    time: Date.now()
  };
  cacheChannelInfo.set(url, info);
  return info;
}

async function layVideoMoiNhatCuaKenh(row) {
  const tenKenh = row["Tên kênh"] || row.TenKenh || row.name || row.Name || row.ten || "";
  const linkKenh = row["Link kênh"] || row.LinkKenh || row.link || row.Link || row.url || "";
  if (!linkKenh) return null;

  const info = await suyRaThongTinKenh(linkKenh.trim());
  if (!info || !info.uploadsPlaylistId) {
    console.warn("channelVideos: không lấy được thông tin kênh cho", linkKenh);
    return null;
  }

  const { data } = await axios.get("https://www.googleapis.com/youtube/v3/playlistItems", {
    timeout: HTTP_TIMEOUT,
    params: { part: "snippet", playlistId: info.uploadsPlaylistId, maxResults: 1, key: API_KEY }
  });

  const item = data.items?.[0];
  const videoId = item?.snippet?.resourceId?.videoId;
  if (!videoId) return null;

  return {
    channelName: tenKenh.trim() || info.channelTitle || "Kênh Youtube",
    title: item.snippet.title,
    link: `https://www.youtube.com/watch?v=${videoId}`,
    videoId,
    publishedAt: item.snippet.publishedAt,
    thumbnail:
      item.snippet.thumbnails?.high?.url ||
      item.snippet.thumbnails?.default?.url ||
      `https://i.ytimg.com/vi/${videoId}/hqdefault.jpg`
  };
}

async function loadChannelLatestVideos() {
  if (!API_KEY) {
    console.warn("channelVideos: thiếu biến môi trường YOUTUBE_API_KEY.");
    return [];
  }

  const sheetUrl = process.env.CHANNELS_SHEET_URL;
  if (!sheetUrl) {
    console.warn("channelVideos: thiếu biến môi trường CHANNELS_SHEET_URL — chưa cấu hình sheet danh sách kênh.");
    return [];
  }

  const rows = await fetchSheet(sheetUrl);
  const results = await Promise.all(
    rows.map((row) =>
      layVideoMoiNhatCuaKenh(row).catch((err) => {
        console.warn(
          "channelVideos: lỗi lấy video cho 1 kênh -",
          err.response?.data?.error?.message || err.message
        );
        return null;
      })
    )
  );

  return results.filter(Boolean);
}

// Trả bản cũ ngay khi hết hạn và làm mới ở nền (xem swrCache.js). Lần làm mới
// lỗi/rỗng thì giữ danh sách cũ thay vì xoá trắng khối video.
const channelVideosCache = createSwrCache({
  name: "channelVideos",
  ttlMs: CACHE_TTL_MS,
  load: loadChannelLatestVideos,
  fallback: [],
  isEmpty: (v) => !v || v.length === 0,
  persistKey: "channel-videos"
});

/**
 * Trả về danh sách video mới nhất, MỖI KÊNH 1 VIDEO, theo đúng thứ tự
 * kênh khai trong Google Sheet (biến môi trường CHANNELS_SHEET_URL).
 * Luôn trả mảng (rỗng nếu lỗi/thiếu cấu hình), không ném lỗi ra ngoài.
 */
export function getChannelLatestVideos() {
  return channelVideosCache.get();
}
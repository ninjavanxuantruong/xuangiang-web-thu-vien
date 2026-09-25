import axios from "axios";

// ====== ĐỔI SANG YOUTUBE DATA API v3 CHÍNH THỨC (thay vì đọc feed RSS) ======
// RSS/cào HTML hay bị Youtube coi là bot, báo lỗi 404/500 chập chờn khi gọi
// từ IP datacenter (Replit) — không có cách nào sửa triệt để vì đó không
// phải kênh chính thức để lấy dữ liệu. API chính thức của Google (cần API
// key miễn phí) thì ổn định, được hỗ trợ lâu dài, không bị chặn kiểu này.

// Danh sách kênh Youtube muốn hiển thị video mới nhất ở trang chủ.
const CHANNELS = [{ id: "UC0c_ed67QTu-exXUetL11nA", name: "Xuân Giang Ngày Mới" }];

const MAX_VIDEOS = 6;
const CACHE_TTL_MS = 15 * 60 * 1000; // 15 phút
const HTTP_TIMEOUT = 10000;
const API_KEY = process.env.YOUTUBE_API_KEY || "";

let cache = null;
let cacheTime = 0;
const uploadsPlaylistCache = new Map(); // channelId -> playlistId (ít đổi, cache luôn trong bộ nhớ)

async function layUploadsPlaylistId(channelId) {
  if (uploadsPlaylistCache.has(channelId)) return uploadsPlaylistCache.get(channelId);

  const { data } = await axios.get("https://www.googleapis.com/youtube/v3/channels", {
    timeout: HTTP_TIMEOUT,
    params: { part: "contentDetails", id: channelId, key: API_KEY }
  });

  const playlistId = data.items?.[0]?.contentDetails?.relatedPlaylists?.uploads || null;
  if (playlistId) uploadsPlaylistCache.set(channelId, playlistId);
  return playlistId;
}

async function fetchChannelVideos(channel) {
  const uploadsId = await layUploadsPlaylistId(channel.id);
  if (!uploadsId) {
    throw new Error("Không lấy được playlist uploads — kiểm tra lại channelId hoặc YOUTUBE_API_KEY");
  }

  const { data } = await axios.get("https://www.googleapis.com/youtube/v3/playlistItems", {
    timeout: HTTP_TIMEOUT,
    params: { part: "snippet", playlistId: uploadsId, maxResults: MAX_VIDEOS, key: API_KEY }
  });

  return (data.items || [])
    .map((item) => {
      const videoId = item.snippet?.resourceId?.videoId;
      if (!videoId) return null;
      return {
        videoId,
        title: item.snippet.title,
        link: `https://www.youtube.com/watch?v=${videoId}`,
        publishedAt: item.snippet.publishedAt,
        channelName: channel.name,
        thumbnail:
          item.snippet.thumbnails?.high?.url ||
          item.snippet.thumbnails?.default?.url ||
          `https://i.ytimg.com/vi/${videoId}/hqdefault.jpg`
      };
    })
    .filter(Boolean);
}

/**
 * Trả về danh sách video mới nhất, gộp từ tất cả kênh trong CHANNELS,
 * sắp theo ngày đăng mới nhất. Luôn trả mảng (rỗng nếu lỗi hết), không
 * bao giờ ném lỗi ra cho route gọi nó.
 */
export async function getLatestVideos() {
  if (cache && Date.now() - cacheTime < CACHE_TTL_MS) return cache;

  if (!API_KEY) {
    console.warn("youtube.js: thiếu biến môi trường YOUTUBE_API_KEY.");
    cache = [];
    cacheTime = Date.now();
    return cache;
  }

  const results = await Promise.all(
    CHANNELS.map((channel) =>
      fetchChannelVideos(channel).catch((err) => {
        console.warn(
          "youtube.js: lỗi lấy video kênh", channel.name, "-",
          err.response?.data?.error?.message || err.message
        );
        return [];
      })
    )
  );

  const all = results.flat();
  all.sort((a, b) => new Date(b.publishedAt) - new Date(a.publishedAt));

  cache = all.slice(0, MAX_VIDEOS);
  cacheTime = Date.now();
  return cache;
}
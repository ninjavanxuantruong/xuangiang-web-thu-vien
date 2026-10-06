// worldNews.js
// Phần "Báo chí quốc tế" — mỗi nguồn trong Google Sheet (cột A = tên báo,
// cột B = link) mỗi NGÀY chỉ lấy 1 lần (đỡ tốn API AI + đỡ tải các trang
// báo liên tục). Có 2 CHẾ ĐỘ, chọn tự động theo domain của link:
//
//   A) "Việt Nam trong cái nhìn thế giới" — domain đã có luật riêng trong
//      worldNewsRules.js (hiện chỉ KBS World, link tìm kiếm "vietnam"):
//        1. Quét danh sách bài từ link đã cho.
//        2. Lọc: tiêu đề phải chứa "vietnam"/biến thể, và KHÔNG chứa từ
//           khóa nhạy cảm (lọc thô, rẻ — trước khi tốn công tải cả bài +
//           gọi AI).
//        3. Lấy bài khớp đầu tiên.
//
//   B) "Điểm báo quốc tế" — mọi domain KHÁC (Reuters, Guardian, Diplomat,
//      Vox, TechCrunch, The Verge...), link chỉ cần là trang chủ/chuyên
//      mục của báo đó, KHÔNG cần liên quan Việt Nam:
//        1. Lấy đúng bài NỔI BẬT/MỚI NHẤT của báo đó — tái dùng thẳng
//           getSuggestedPost() đang chạy cho "Bài đọc đề xuất"
//           (newsFinder.js), khỏi phải viết luật quét riêng cho từng báo.
//        2. Vẫn lọc tiêu đề theo từ khóa nhạy cảm như chế độ A (không có
//           lọc gì thì rủi ro cao hơn vì không còn giới hạn quanh chủ đề
//           Việt Nam nữa).
//
//   Cả 2 chế độ sau đó đi chung 1 đường: tải toàn văn bài viết, gọi AI
//   dịch + tóm tắt (lớp lọc nhạy cảm thứ 2, chắc chắn hơn, nằm trong
//   aiSummarize.js). Cache 24h nếu thành công; nếu lỗi/rỗng thì GIỮ
//   NGUYÊN bài cũ tốt nhất đã có (nếu có) và chỉ thử lại sau vài giờ,
//   không để trống oan.

import axios from "axios";
import * as cheerio from "cheerio";
import crypto from "crypto";
import { fetchSheetRaw } from "./sheets.js";
import { findWorldNewsRule } from "./worldNewsRules.js";
import { getSuggestedPost } from "./newsFinder.js";
import { extractArticleText } from "./articleText.js";
import { summarizeAndMaybeTranslate } from "./aiSummarize.js";
import { getFallbackImage } from "./fallback-images.js";
import { getOrRefresh, peek } from "./firestoreCache.js";

const HTTP_TIMEOUT = 15000;
const HEADERS = {
  "User-Agent":
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/119 Safari/537.36",
  Accept: "text/html,application/xhtml+xml,application/xml;q=0.9,image/webp,*/*;q=0.8",
  "Accept-Language": "vi-VN,vi;q=0.9,en-US;q=0.8,en;q=0.7"
};

const CACHE_KEY = "the-gioi";

// Giữ lại danh sách mới nhất đã lấy được trong RAM (đồng bộ), để
// getWorldNewsById() tra cứu ngay không cần đọc lại Firestore — chỉ dùng
// để tra cứu, KHÔNG dùng để quyết định có refresh hay không (việc đó do
// firestoreCache.js lo theo "ngày cache" trên Firestore).
let lastList = [];

function slugFor(link) {
  return crypto.createHash("md5").update(link).digest("hex").slice(0, 12);
}

function isVietnamRelatedTitle(title) {
  return /vi[eệê]t[\s-]?nam|vietnamese/i.test(title || "");
}

// Lọc thô ở tiêu đề — lớp lọc RẺ, chạy trước khi tải cả bài + gọi AI.
// Lớp lọc chắc chắn hơn (đọc cả nội dung) nằm trong aiSummarize.js.
const SENSITIVE_TITLE_RE = new RegExp(
  [
    

    "one-party",
    
    "communist regime"
    

  ].join("|"),
  "i"
);

async function fetchListing(sourceLink) {
  const rule = findWorldNewsRule(sourceLink);
  if (!rule) {
    console.warn("worldNews: chưa có luật riêng (worldNewsRules.js) cho", sourceLink);
    return [];
  }
  const resp = await axios.get(sourceLink, { timeout: HTTP_TIMEOUT, headers: HEADERS });
  const $ = cheerio.load(resp.data);
  return rule($, sourceLink);
}

async function buildArticle(sourceName, sourceLink, item) {
  const articleText = (await extractArticleText(item.link).catch(() => "")) || item.summary || "";
  const ai = await summarizeAndMaybeTranslate(item.title, articleText || item.title);

  // Không gọi được AI (thiếu key/hết hạn mức/lỗi mạng/model trả rỗng) ->
  // lý do CHI TIẾT đã được aiSummarize.js in ra console ngay phía trên.
  if (!ai) throw new Error("gọi AI thất bại (xem chi tiết ở dòng log 'aiSummarize:' ngay phía trên)");

  // AI tự đánh giá đây là chủ đề nhạy cảm -> chủ động không hiển thị,
  // không tính là lỗi.
  if (ai.skip) return null;

  return {
    id: slugFor(item.link),
    sourceName,
    sourceLink,
    title: ai.titleVi || item.title,
    link: item.link,
    image: item.image || getFallbackImage(item.link, sourceName),
    dateMs: item.dateMs,
    summaryVi: ai.summaryVi,
    author: ai.author || ""
  };
}

/**
 * Chế độ A — "Việt Nam trong cái nhìn thế giới": quét danh sách theo luật
 * riêng của domain, lọc tiêu đề có "vietnam" và không nhạy cảm.
 */
async function pickFromVietnamListing(sourceLink) {
  const listing = await fetchListing(sourceLink);
  const candidate = listing.find(
    (it) => isVietnamRelatedTitle(it.title) && !SENSITIVE_TITLE_RE.test(it.title)
  );
  if (!candidate) throw new Error("Không có bài nào phù hợp trong danh sách vừa quét");
  return candidate;
}

/**
 * Chế độ B — "Điểm báo quốc tế": lấy đúng bài nổi bật/mới nhất của báo đó
 * (không lọc theo Việt Nam), tái dùng getSuggestedPost() của
 * newsFinder.js — cùng máy đang chạy cho "Bài đọc đề xuất".
 */
async function pickFromLatestArticle(sourceName, sourceLink) {
  const post = await getSuggestedPost({ name: sourceName, link: sourceLink });
  if (!post.found) {
    throw new Error("Không xác định được bài cụ thể (newsFinder.getSuggestedPost không tìm ra)");
  }
  if (SENSITIVE_TITLE_RE.test(post.title)) {
    throw new Error("Tiêu đề rơi vào nhóm chủ đề nhạy cảm, chủ động bỏ qua");
  }
  // getSuggestedPost() không lấy toàn văn/ngày đăng (chỉ cần ảnh+tiêu đề+
  // link để dẫn ra ngoài cho "Bài đọc đề xuất") — ảnh đã là link đã qua
  // proxy hoặc ảnh dự phòng sẵn, dateMs để trống vì không có.
  return { title: post.title, link: post.link, image: post.image, dateMs: null, summary: "" };
}

// Lấy bài mới cho ĐÚNG 1 nguồn. Trả về bài viết nếu thành công, hoặc null
// nếu lỗi/AI đánh giá nhạy cảm (KHÔNG ném lỗi ra ngoài — để 1 nguồn hỏng
// không làm hỏng cả Promise.all của các nguồn khác).
async function refreshSource(sourceName, sourceLink) {
  try {
    const rule = findWorldNewsRule(sourceLink);
    const candidate = rule
      ? await pickFromVietnamListing(sourceLink)
      : await pickFromLatestArticle(sourceName, sourceLink);

    const article = await buildArticle(sourceName, sourceLink, candidate);
    if (!article) throw new Error("AI đánh giá bài này thuộc chủ đề nhạy cảm nên chủ động bỏ qua");
    return article;
  } catch (err) {
    console.warn("worldNews: refresh lỗi cho", sourceName, "-", err.message);
    return null;
  }
}

async function getSources() {
  const url = process.env.WORLD_NEWS_SHEET_URL;
  const rows = await fetchSheetRaw(url);
  // Cột A = tên báo, cột B = link (đã tự lọc theo "vietnam" sẵn trong link)
  return rows
    .map((r) => ({ name: String(r[0] || "").trim(), link: String(r[1] || "").trim() }))
    .filter((s) => s.name && s.link);
}

// Dò lại TOÀN BỘ các nguồn 1 lượt — đây là "việc nặng" chỉ người đầu tiên
// trong ngày phải chờ (xem getOrRefresh trong firestoreCache.js).
async function buildAllWorldNews(sources) {
  // Bài cũ của lần cache gần nhất (có thể là hôm qua) — dùng để "vá" cho
  // đúng nguồn nào hôm nay bị lỗi, giữ nguyên logic "không để trống oan"
  // như bản cũ, nhưng giờ áp cho từng nguồn bên trong 1 lần refresh cả khối.
  const oldList = (await peek(CACHE_KEY)) || [];
  const oldBySourceLink = new Map(oldList.map((a) => [a.sourceLink, a]));

  const results = await Promise.all(
    sources.map(async (source) => {
      const fresh = await refreshSource(source.name, source.link);
      return fresh || oldBySourceLink.get(source.link) || null;
    })
  );

  return results.filter(Boolean);
}

/**
 * PHIÊN BẢN CHO TRANG CHỦ — cache CHUNG cả khối "Báo chí quốc tế" 1
 * lần/ngày trên Firestore:
 *   - Người đầu tiên vào sau 5h sáng: chờ dò + tóm tắt AI hết các nguồn
 *     (đúng lúc màn splash đang che).
 *   - Người vào sau trong ngày: đọc thẳng bản đã lưu, gần như tức thì.
 */
export async function getWorldNewsFast() {
  const sources = await getSources();
  const list = await getOrRefresh(CACHE_KEY, () => buildAllWorldNews(sources));
  lastList = list;
  return list;
}

export function getWorldNewsById(id) {
  return lastList.find((a) => a.id === id) || null;
}
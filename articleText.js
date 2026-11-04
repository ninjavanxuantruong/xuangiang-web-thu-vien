// articleText.js
// Trích văn bản chính (toàn bộ các đoạn <p>) của 1 trang bài báo, dùng cho
// phần "Việt Nam trong cái nhìn thế giới" (worldNews.js) — khác với
// newsFinder.js chỉ cần lấy ảnh + tiêu đề, ở đây cần cả nội dung để đưa
// cho AI dịch/tóm tắt.
//
// Vì mỗi báo có cấu trúc trang bài viết khác nhau, dùng cách "thử lần
// lượt" một số khu vực nội dung phổ biến, chọn khu vực cho ra văn bản dài
// nhất/hợp lý nhất — không cần viết riêng cho từng domain như
// worldNewsRules.js (chỉ cần đúng "khu vực chứa bài", không cần chính xác
// tuyệt đối như khi bóc danh sách).

import axios from "axios";
import * as cheerio from "cheerio";

const HTTP_TIMEOUT = 15000;
const HEADERS = {
  "User-Agent":
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/119 Safari/537.36",
  Accept: "text/html,application/xhtml+xml,application/xml;q=0.9,image/webp,*/*;q=0.8",
  "Accept-Language": "vi-VN,vi;q=0.9,en-US;q=0.8,en;q=0.7"
};

// Khu vực nội dung hay gặp trên các trang báo — thử theo thứ tự, dừng lại
// sớm nếu khu vực nào đã cho văn bản đủ dài (khỏi cần thử hết cho nhanh).
const CANDIDATE_SELECTORS = [
  "article",
  ".RichTextStoryBody",
  ".Page-content",
  ".article-body",
  ".view_cont",
  ".view_body",
  "#container",
  "main"
];

const ENOUGH_LENGTH = 500;

export async function extractArticleText(link) {
  const resp = await axios.get(link, { timeout: HTTP_TIMEOUT, headers: HEADERS });
  const $ = cheerio.load(resp.data);
  $("script, style, nav, header, footer, aside, form, .ad, [class*='banner']").remove();

  let bestText = "";
  for (const sel of CANDIDATE_SELECTORS) {
    const $el = $(sel).first();
    if ($el.length === 0) continue;
    const paragraphs = $el
      .find("p")
      .map((_, p) => $(p).text().trim())
      .get()
      .filter(Boolean);
    const text = paragraphs.join("\n\n");
    if (text.length > bestText.length) bestText = text;
    if (bestText.length > ENOUGH_LENGTH) break;
  }

  if (!bestText) {
    const paragraphs = $("body p")
      .map((_, p) => $(p).text().trim())
      .get()
      .filter(Boolean);
    bestText = paragraphs.join("\n\n");
  }

  return bestText.trim();
}

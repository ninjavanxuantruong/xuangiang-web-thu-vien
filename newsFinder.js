import axios from "axios";
import * as cheerio from "cheerio";
import Parser from "rss-parser";
import { getFallbackImage } from "./fallback-images.js";
import { findSiteRule } from "./siteRules.js";
import { getOrRefresh } from "./firestoreCache.js";

const rssParser = new Parser();
// 8s: đủ rộng cho các trang chính thống (dangcongsan.vn, qdnd.vn,
// tapchicongsan.org.vn...) vốn phản hồi chậm hơn báo thường — 5s cũ khiến
// các nguồn này liên tục timeout, rơi vào nhánh lỗi -> không có ảnh thật.
// Không ảnh hưởng tốc độ tải trang vì mọi nguồn được gọi song song
// (Promise.all/nền), không có nguồn nào chặn nguồn khác.
const HTTP_TIMEOUT = 8000;
const HEADERS = {
  "User-Agent":
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/119 Safari/537.36"
};

/**
 * Lấy đúng URL ảnh thật từ 1 thẻ <img> — nhiều trang dùng kỹ thuật tải ảnh
 * chậm (lazy-load): thuộc tính "src" chỉ là ảnh giữ chỗ rỗng/mờ, ảnh THẬT
 * nằm ở data-src/data-original — nên phải ưu tiên các thuộc tính này
 * TRƯỚC "src", không phải ngược lại (đây là nguyên nhân ảnh bị vỡ ở bản
 * trước). Đồng thời lọc bớt các mẫu ảnh giữ chỗ phổ biến.
 */
function pickImageSrc($el) {
  const candidates = [
    $el.attr("data-src"),
    $el.attr("data-original"),
    $el.attr("data-lazy-src"),
    $el.attr("src")
  ];

  for (const src of candidates) {
    if (!src) continue;
    if (src.startsWith("data:")) continue; // ảnh nhúng base64
    if (/\.(svg|ico)(\?|$)/i.test(src)) continue; // icon/logo nhỏ
    if (/(blank|placeholder|pixel|loading|spacer|transparent|1x1)/i.test(src)) continue; // ảnh giữ chỗ
    return src;
  }
  return null;
}

/**
 * BƯỚC 1: Tìm ra link bài viết MỚI NHẤT của 1 trang, theo thứ tự ưu tiên
 * đáng tin cậy giảm dần — không đoán class CSS ngay từ đầu.
 */
async function findFeedUrl(siteUrl) {
  const commonPaths = ["/rss", "/feed", "/rss.xml", "/feed.xml", "/rss/home.rss", "/rss/tin-moi-nhat.rss"];

  const attempts = commonPaths.map(async (path) => {
    const testUrl = new URL(path, siteUrl).href;
    const resp = await axios.get(testUrl, { timeout: HTTP_TIMEOUT, headers: HEADERS });
    const body = typeof resp.data === "string" ? resp.data : "";
    if (body.includes("<rss") || body.includes("<feed")) return testUrl;
    throw new Error("Không phải RSS hợp lệ");
  });

  const found = await Promise.any(attempts).catch(() => null);
  if (found) return found;

  try {
    const resp = await axios.get(siteUrl, { timeout: HTTP_TIMEOUT, headers: HEADERS });
    const $ = cheerio.load(resp.data);
    const href = $('link[type="application/rss+xml"], link[type="application/atom+xml"]').first().attr("href");
    if (href) return new URL(href, siteUrl).href;
  } catch {
    // bỏ qua, chuyển sang bước sitemap
  }

  return null;
}

async function getLatestFromRSS(feedUrl) {
  const feed = await rssParser.parseURL(feedUrl);
  const item = feed.items && feed.items[0];
  if (!item) return null;
  return { title: item.title || null, link: item.link };
}

const IGNORED_HREF_RE = /^(#|javascript:|mailto:|tel:)/i;
const NON_ARTICLE_HINT_RE = /\/(tag|tags|category|chuyen-de|chu-de|search|tim-kiem|rss|feed)(\/|$)/i;

function isUsableHref(href, siteUrl, siteHost) {
  if (!href) return false;
  if (IGNORED_HREF_RE.test(href)) return false;
  if (NON_ARTICLE_HINT_RE.test(href)) return false;
  try {
    const abs = new URL(href, siteUrl);
    const linkHost = abs.hostname.replace(/^www\./, "");
    if (linkHost !== siteHost) return false;
    return true;
  } catch {
    return false;
  }
}

function findTitleNear($link, $img, maxClimb = 3) {
  const titleAttr = $link.attr("title");
  if (titleAttr && titleAttr.trim()) return titleAttr.trim();

  let $scope = $link;
  for (let i = 0; i <= maxClimb; i++) {
    const heading = $scope.find("h1,h2,h3,h4").first().text().trim();
    if (heading) return heading;
    const parent = $scope.parent();
    if (!parent || parent.length === 0) break;
    $scope = parent;
  }

  const alt = $img && $img.attr("alt");
  if (alt && alt.trim()) return alt.trim();

  const linkText = $link.text().trim();
  if (linkText) return linkText;

  return null;
}

function resolveFinalHost(resp, fallbackSiteUrl) {
  const finalUrl = resp?.request?.res?.responseUrl || fallbackSiteUrl;
  try {
    return new URL(finalUrl).hostname.replace(/^www\./, "");
  } catch {
    return new URL(fallbackSiteUrl).hostname.replace(/^www\./, "");
  }
}

async function getLatestByGenericScan(siteUrl) {
  const resp = await axios.get(siteUrl, { timeout: HTTP_TIMEOUT, headers: HEADERS });
  const $ = cheerio.load(resp.data);
  const siteHost = resolveFinalHost(resp, siteUrl);
  const baseUrl = resp?.request?.res?.responseUrl || siteUrl;

  const images = $("img").toArray();
  for (const imgEl of images) {
    const $img = $(imgEl);
    if (!pickImageSrc($img)) continue;

    // Bỏ qua ảnh nằm trong header/nav/footer — logo, avatar tài khoản
    // đang đăng nhập, hoặc menu, KHÔNG phải ảnh bài viết.
    if ($img.closest("header, nav, footer").length > 0) continue;

    // Bỏ qua logo dù không nằm trong header/nav/footer.
    const altText = ($img.attr("alt") || "").toLowerCase();
    if (altText.includes("logo")) continue;

    let $node = $img.parent();
    let $link = $node.is("a") ? $node : $node.find("a[href]").first();
    let depth = 0;
    while ((!$link || $link.length === 0 || !isUsableHref($link.attr("href"), baseUrl, siteHost)) && depth < 4) {
      $node = $node.parent();
      if (!$node || $node.length === 0) break;
      $link = $node.is("a") ? $node : $node.find("a[href]").first();
      depth++;
    }
    if (!$link || $link.length === 0) continue;

    const href = $link.attr("href");
    if (!isUsableHref(href, baseUrl, siteHost)) continue;

    const title = findTitleNear($link, $img);
    if (!title) continue;

    return { title, link: new URL(href, baseUrl).href };
  }
  return null;
}

async function findLatestArticleLink(siteUrl) {
  const rule = findSiteRule(siteUrl);
  if (rule) {
    try {
      const resp = await axios.get(siteUrl, { timeout: HTTP_TIMEOUT, headers: HEADERS });
      const $ = cheerio.load(resp.data);
      const result = rule($, siteUrl);
      if (result) return result;
      console.warn("newsFinder: luật riêng cho", siteUrl, "không khớp HTML hiện tại (site có thể đã đổi giao diện)");
    } catch (err) {
      console.warn("newsFinder: lỗi chạy luật riêng cho", siteUrl, "-", err.message);
    }
    return null;
  }

  const feedUrl = await findFeedUrl(siteUrl);
  if (feedUrl) {
    try {
      const latest = await getLatestFromRSS(feedUrl);
      if (latest) return latest;
    } catch (err) {
      console.warn("newsFinder: lỗi đọc RSS", feedUrl, err.message);
    }
  }

  try {
    const latest = await getLatestByGenericScan(siteUrl);
    if (latest) return latest;
  } catch (err) {
    console.warn("newsFinder: lỗi quét chung", siteUrl, err.message);
  }

  return null;
}

async function extractArticleMeta(articleUrl) {
  const resp = await axios.get(articleUrl, { timeout: HTTP_TIMEOUT, headers: HEADERS });
  const $ = cheerio.load(resp.data);

  const title =
    $('meta[property="og:title"]').attr("content") ||
    $('meta[name="twitter:title"]').attr("content") ||
    $("title").first().text() ||
    "";

  let image =
    $('meta[property="og:image"]').attr("content") ||
    $('meta[name="twitter:image"]').attr("content") ||
    null;

  if (!image) {
    $('script[type="application/ld+json"]').each((i, el) => {
      if (image) return;
      try {
        const data = JSON.parse($(el).contents().text());
        const items = Array.isArray(data) ? data : [data];
        for (const item of items) {
          const type = item && item["@type"] ? String(item["@type"]).toLowerCase() : "";
          if (type.includes("article")) {
            const img = item.image;
            if (typeof img === "string") image = img;
            else if (Array.isArray(img) && img.length > 0) image = img[0];
            else if (img && img.url) image = img.url;
          }
        }
      } catch {
        // JSON-LD lỗi cú pháp trên trang nguồn, bỏ qua
      }
    });
  }

  if (!image) {
    const $firstImg = $("article img, .content img, .fck_detail img, img").first();
    image = pickImageSrc($firstImg);
  }

  if (image && image.startsWith("/")) {
    image = new URL(image, articleUrl).href;
  }

  return { title: title.trim(), image };
}

async function getAnyImageFromPage(siteUrl) {
  const resp = await axios.get(siteUrl, { timeout: HTTP_TIMEOUT, headers: HEADERS });
  const $ = cheerio.load(resp.data);

  let found = null;
  $("img").each((i, el) => {
    if (found) return;
    const src = pickImageSrc($(el));
    if (src) found = src;
  });

  if (!found) return null;
  return found.startsWith("/") ? new URL(found, siteUrl).href : found;
}

function toProxiedImage(rawUrl) {
  if (!rawUrl) return null;
  return `/anh-ngoai?u=${encodeURIComponent(rawUrl)}`;
}

const IMAGE_EXTENSION_RE = /\.(jpe?g|png|webp|gif)(\?|$)/i;

function normalizeImageLink(link) {
  const githubBlobMatch = link.match(/^https:\/\/github\.com\/([^/]+)\/([^/]+)\/blob\/(.+)$/);
  if (githubBlobMatch) {
    const [, user, repo, rest] = githubBlobMatch;
    return `https://raw.githubusercontent.com/${user}/${repo}/${rest}`;
  }
  return link;
}

export async function extractImagesFromPage(rawLink, maxImages = 6) {
  const link = normalizeImageLink(rawLink);
  if (IMAGE_EXTENSION_RE.test(link)) return [link];

  try {
    const resp = await axios.get(link, { timeout: HTTP_TIMEOUT, headers: HEADERS });
    const $ = cheerio.load(resp.data);
    const found = [];
    const seen = new Set();

    $("article img, .content img, .fck_detail img, img").each((i, el) => {
      if (found.length >= maxImages) return;
      const src = pickImageSrc($(el));
      if (!src) return;

      const absolute = src.startsWith("/") ? new URL(src, link).href : src;
      if (seen.has(absolute)) return;
      seen.add(absolute);
      found.push(absolute);
    });

    return found;
  } catch (err) {
    console.warn("extractImagesFromPage: lỗi lấy ảnh từ", link, "-", err.message);
    return [];
  }
}

// Lấy bài mới nhất của ĐÚNG 1 nguồn — KHÔNG tự cache ở đây nữa (cache đã
// chuyển lên tầng "cả danh sách/ngày" ở getSuggestedPostsCached() bên
// dưới). worldNews.js cũng gọi thẳng hàm này cho chế độ "Điểm báo quốc
// tế", tự lo cache theo ngày riêng của nó.
export async function getSuggestedPost(source) {
  let result;
  try {
    const latest = await findLatestArticleLink(source.link);
    if (!latest) throw new Error("Không tìm được bài viết mới nhất");

    const meta = await extractArticleMeta(latest.link);
    const image =
      toProxiedImage(meta.image) ||
      toProxiedImage(await getAnyImageFromPage(latest.link).catch(() => null)) ||
      toProxiedImage(await getAnyImageFromPage(source.link).catch(() => null)) ||
      getFallbackImage(source.link, source.name);

    result = {
      title: latest.title || meta.title || source.name,
      link: latest.link,
      image,
      name: source.name,
      found: true
    };
  } catch (err) {
    console.warn("newsFinder: không xác định được bài cụ thể cho", source.link, "-", err.message);
    const anyImage = await getAnyImageFromPage(source.link).catch(() => null);
    result = {
      title: source.name,
      link: source.link,
      image: toProxiedImage(anyImage) || getFallbackImage(source.link, source.name),
      name: source.name,
      found: false
    };
  }

  return result;
}

export async function getSuggestedPosts(sources) {
  return Promise.all(sources.map((source) => getSuggestedPost(source)));
}

/**
 * PHIÊN BẢN DÙNG CHO TRANG CHỦ — cả danh sách "Bài đọc đề xuất" được coi
 * là 1 khối, cache CHUNG 1 lần/ngày trên Firestore (xem firestoreCache.js):
 *   - Người đầu tiên vào sau 5h sáng mỗi ngày: phải chờ dò hết các nguồn
 *     (vài giây tới vài chục giây tuỳ số nguồn) — đúng lúc màn splash
 *     đang che nên không lộ ra ngoài.
 *   - Mọi người vào sau trong cùng ngày: đọc thẳng bản đã lưu, gần như
 *     tức thì, không gọi lại các trang báo ngoài nữa.
 * getSuggestedPost() ở trên tự bắt lỗi cho từng nguồn (không bao giờ ném
 * lỗi ra ngoài) nên danh sách trả về luôn đủ số nguồn, chỉ khác found:
 * true/false — không cần thêm cơ chế giữ-bài-cũ riêng ở đây.
 */
export async function getSuggestedPostsCached(sources) {
  return getOrRefresh("bai-doc-de-xuat", () => getSuggestedPosts(sources));
}

export function sortSuggestedPosts(posts) {
  return [...posts].sort((a, b) => Number(Boolean(b.found)) - Number(Boolean(a.found)));
}
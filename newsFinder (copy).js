import axios from "axios";
import * as cheerio from "cheerio";
import Parser from "rss-parser";
import { getFallbackImage } from "./fallback-images.js";
import { findSiteRule } from "./siteRules.js";

const rssParser = new Parser();
// 12s: qdnd.vn và 1 vài trang chính thống khác không phản hồi GÌ trong 8s
// (dấu hiệu bị tường lửa/Cloudflare chặn request không giống trình duyệt
// thật, không phải do mạng chậm đơn thuần) — nới thêm thời gian + thêm
// header Accept/Accept-Language giống trình duyệt thật hơn để giảm khả
// năng bị nhận diện là bot. Không ảnh hưởng tốc độ tải trang vì mọi nguồn
// được gọi song song (nền), không có nguồn nào chặn nguồn khác.
const HTTP_TIMEOUT = 12000;
const HEADERS = {
  "User-Agent":
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/119 Safari/537.36",
  Accept: "text/html,application/xhtml+xml,application/xml;q=0.9,image/webp,*/*;q=0.8",
  "Accept-Language": "vi-VN,vi;q=0.9,en-US;q=0.8,en;q=0.7"
};

// Cache trong bộ nhớ để không phải gọi lại các trang ngoài liên tục
// (trang chủ load nhiều lần/phút nếu nhiều người cùng xem).
const memoryCache = new Map();
const CACHE_TTL_MS = 30 * 60 * 1000; // 30 phút

function getCached(key) {
  const hit = memoryCache.get(key);
  if (hit && Date.now() - hit.time < CACHE_TTL_MS) return hit.value;
  return null;
}
function setCached(key, value) {
  memoryCache.set(key, { value, time: Date.now() });
}

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

  // Thử TẤT CẢ đường dẫn phổ biến CÙNG LÚC (không tuần tự) — lấy cái nào
  // phản hồi hợp lệ trước tiên, nhanh hơn nhiều lần so với thử lần lượt.
  const attempts = commonPaths.map(async (path) => {
    const testUrl = new URL(path, siteUrl).href;
    const resp = await axios.get(testUrl, { timeout: HTTP_TIMEOUT, headers: HEADERS });
    const body = typeof resp.data === "string" ? resp.data : "";
    if (body.includes("<rss") || body.includes("<feed")) return testUrl;
    throw new Error("Không phải RSS hợp lệ");
  });

  const found = await Promise.any(attempts).catch(() => null);
  if (found) return found;

  // Không có đường dẫn phổ biến nào khớp -> tìm thẻ <link rel="alternate"> trong <head>
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
// Loại các link chắc chắn KHÔNG phải bài viết cụ thể (trang chuyên mục,
// tìm kiếm, RSS...) dù có vẻ hợp lệ về mặt kỹ thuật.
const NON_ARTICLE_HINT_RE = /\/(tag|tags|category|chuyen-de|chu-de|search|tim-kiem|rss|feed)(\/|$)/i;

function isUsableHref(href, siteUrl, siteHost) {
  if (!href) return false;
  if (IGNORED_HREF_RE.test(href)) return false;
  if (NON_ARTICLE_HINT_RE.test(href)) return false;
  try {
    const abs = new URL(href, siteUrl);
    const linkHost = abs.hostname.replace(/^www\./, "");
    if (linkHost !== siteHost) return false; // loại link mạng xã hội, quảng cáo, site khác
    return true;
  } catch {
    return false;
  }
}

// Tìm tiêu đề cho 1 link: ưu tiên thuộc tính title (thường là tiêu đề đầy
// đủ, chuẩn nhất) -> chữ trong thẻ heading (h1-h4) ở phạm vi lân cận, mở
// rộng dần lên tối đa 3 cấp cha (nhiều site để ảnh và tiêu đề là 2 khối
// anh em cùng cấp chứ không lồng nhau) -> alt của ảnh -> chữ của chính link.
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

// BỘ QUÉT CHUNG — thay cho việc đoán mò 1 danh sách class CSS cố định.
// Rút ra từ điểm chung quan sát được ở nhiều trang tin thực tế (nhandan.vn,
// cand.vn, dangcongsan.vn, qdnd.vn, baochinhphu.vn, tapchicongsan.org.vn,
// vnanet.vn...): khối "bài viết" luôn có 1 ẢNH đi kèm 1 LINK hợp lệ ở rất
// gần nhau trong cây HTML. Nên thay vì đoán class, ta:
//   1. Duyệt các thẻ <img> theo đúng thứ tự xuất hiện trong HTML
//   2. Với ảnh THẬT đầu tiên (bỏ qua icon/ảnh giữ chỗ), tìm thẻ <a href>
//      hợp lệ gần nhất — thường chính là thẻ cha bọc ảnh, nếu không thì
//      lùi dần lên tối đa 4 cấp cha
//   3. Suy ra tiêu đề theo findTitleNear() ở trên
// Ảnh đầu tiên tìm được link+tiêu đề hợp lệ -> coi là bài mới nhất.
// Domain gốc bạn cấu hình đôi khi CHUYỂN HƯỚNG (redirect) sang 1 domain
// khác lúc tải trang thật (ví dụ cand.com.vn -> cand.vn) — nếu so sánh
// domain link với domain GÕ VÀO BAN ĐẦU sẽ loại nhầm mọi link thật của
// trang. Lấy domain SAU KHI ĐÃ CHUYỂN HƯỚNG XONG (axios tự theo dõi
// redirect và ghi lại URL cuối cùng ở request.res.responseUrl).
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
  // Base để ghép link tương đối ("/bai-viet.html") -> dùng URL SAU KHI đã
  // chuyển hướng xong, không phải URL gõ vào ban đầu (cùng lý do domain ở
  // trên) — nếu axios không cho biết URL cuối thì lùi về siteUrl gốc.
  const baseUrl = resp?.request?.res?.responseUrl || siteUrl;

  const images = $("img").toArray();
  for (const imgEl of images) {
    const $img = $(imgEl);
    if (!pickImageSrc($img)) continue; // icon/ảnh giữ chỗ -> bỏ qua, thử ảnh tiếp theo

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
  // 1) Luật riêng cho domain này (nếu có) — dùng ĐÚNG luật, không thử gì
  // khác nữa (kể cả khi luật chạy lỗi/không khớp), tránh lấy nhầm 1 bài
  // không mong muốn từ site đã biết là khó đoán qua bộ quét chung.
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

  // 2) Không có luật riêng -> thử RSS/Atom (rẻ, đáng tin khi có).
  const feedUrl = await findFeedUrl(siteUrl);
  if (feedUrl) {
    try {
      const latest = await getLatestFromRSS(feedUrl);
      if (latest) return latest;
    } catch (err) {
      console.warn("newsFinder: lỗi đọc RSS", feedUrl, err.message);
    }
  }

  // 3) Không có RSS -> bộ quét chung.
  try {
    const latest = await getLatestByGenericScan(siteUrl);
    if (latest) return latest;
  } catch (err) {
    console.warn("newsFinder: lỗi quét chung", siteUrl, err.message);
  }

  return null;
}

/**
 * BƯỚC 2: Mở đúng trang bài viết vừa tìm được, lấy tiêu đề + ảnh theo
 * chuẩn Open Graph / Twitter Card / JSON-LD (schema.org NewsArticle) —
 * không đoán CSS class trên trang bài viết, vì hầu hết CMS báo chí tự
 * sinh các thẻ này cho SEO.
 */
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

/**
 * Phương án cuối cùng khi không xác định được bài mới nhất cụ thể nào cả:
 * lấy tạm 1 ảnh bất kỳ ngay trên trang chủ của nguồn đó (thường vẫn là ảnh
 * tin tức nào đó của họ) — thà có ảnh liên quan còn hơn ảnh mặc định chung
 * chung, và không cần bạn tự chuẩn bị ảnh dự phòng nữa.
 */
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

// Đưa ảnh lấy từ trang ngoài đi qua proxy của chính server mình
// (route /anh-ngoai trong server.js) thay vì trỏ thẳng URL gốc.
// Lý do: server mình VỪA fetch thành công trang đó (nên chắc chắn ảnh tồn
// tại), nhưng khi trình duyệt người xem tự tải trực tiếp URL ảnh gốc có
// thể bị chặn hotlink/kiểm tra Referer của 1 số trang -> ra icon ảnh vỡ dù
// server đã tìm thấy ảnh đúng. Qua proxy thì trình duyệt luôn tải từ domain
// của mình, không còn phụ thuộc chính sách của trang nguồn nữa.
function toProxiedImage(rawUrl, sourceName) {
  if (!rawUrl) return null;
  const nameParam = sourceName ? `&name=${encodeURIComponent(sourceName)}` : "";
  return `/anh-ngoai?u=${encodeURIComponent(rawUrl)}${nameParam}`;
}

const IMAGE_EXTENSION_RE = /\.(jpe?g|png|webp|gif)(\?|$)/i;

// Link ảnh trên GitHub dạng xem trực tiếp (blob) không phải là ảnh thật —
// tự đổi sang link raw để lấy đúng file ảnh.
function normalizeImageLink(link) {
  const githubBlobMatch = link.match(/^https:\/\/github\.com\/([^/]+)\/([^/]+)\/blob\/(.+)$/);
  if (githubBlobMatch) {
    const [, user, repo, rest] = githubBlobMatch;
    return `https://raw.githubusercontent.com/${user}/${repo}/${rest}`;
  }
  return link;
}

// Các khu vực THƯỜNG chứa đúng nội dung bài viết (không phải menu/quảng
// cáo/footer) — thử LẦN LƯỢT theo thứ tự, khu vực nào có ảnh thì DÙNG
// ĐÚNG khu vực đó, không quét toàn trang nữa. Chỉ khi KHÔNG khu vực nào
// khớp mới lùi về quét toàn trang (thà có ảnh không hoàn hảo còn hơn
// không có ảnh nào).
const SELECTOR_KHU_VUC_NOI_DUNG = [
  "article",
  ".content",
  ".fck_detail",
  ".entry-content",
  ".post-content",
  ".detail-content",
  ".news-content",
  ".article-content",
  ".content-detail"
];

// Từ khoá điển hình của banner/quảng cáo/logo — kiểm tra trên cả src ảnh,
// alt, class của ảnh, VÀ href của link bao quanh nó (banner thường được
// bọc trong 1 thẻ <a> dẫn tới trang đăng ký/quảng cáo khác, không liên
// quan gì tới nội dung bài viết).
const TU_KHOA_BANNER = [
  "banner", "quangcao", "quang-cao", "advertis", "sponsor", "sponsored",
  "dang-ky", "dangky", "đăng-ký", "the-thu-vien", "thethuvien",
  "logo", "icon-", "download-app", "tai-app", "zalo-oa", "subscribe"
];

function coPhaiBanner($el, absoluteUrl) {
  const alt = ($el.attr("alt") || "").toLowerCase();
  const className = ($el.attr("class") || "").toLowerCase();
  const src = absoluteUrl.toLowerCase();

  const $lienKet = $el.closest("a");
  const href = ($lienKet.attr("href") || "").toLowerCase();

  const gopChuoi = `${alt} ${className} ${src} ${href}`;
  return TU_KHOA_BANNER.some((tu) => gopChuoi.includes(tu));
}

/**
 * Lấy TẤT CẢ ảnh hợp lý trên 1 trang (dùng cho mục Danh nhân & Địa điểm —
 * mỗi link cột D trở đi là 1 bài viết, lấy hết ảnh trong bài đó gộp lại).
 * Nếu link đã là 1 file ảnh trực tiếp (ví dụ ảnh raw GitHub) -> dùng luôn,
 * không cần "bóc" trang.
 */
export async function extractImagesFromPage(rawLink, maxImages = 6) {
  const link = normalizeImageLink(rawLink);
  if (IMAGE_EXTENSION_RE.test(link)) return [link];

  try {
    const resp = await axios.get(link, { timeout: HTTP_TIMEOUT, headers: HEADERS });
    const $ = cheerio.load(resp.data);

    // Thử từng khu vực nội dung theo thứ tự ưu tiên, DÙNG NGAY khu vực
    // đầu tiên có ít nhất 1 ảnh hợp lệ (không phải banner) — không gộp
    // chung với "toàn trang" nữa.
    let $vungQuet = null;
    for (const selector of SELECTOR_KHU_VUC_NOI_DUNG) {
      const $khoi = $(selector).first();
      if ($khoi.length > 0 && $khoi.find("img").length > 0) {
        $vungQuet = $khoi;
        break;
      }
    }
    // Không khu vực nào khớp -> lùi về toàn trang (thà có còn hơn không).
    const $anhCanQuet = $vungQuet ? $vungQuet.find("img") : $("img");

    const found = [];
    const seen = new Set();

    $anhCanQuet.each((i, el) => {
      if (found.length >= maxImages) return;
      const $el = $(el);
      const src = pickImageSrc($el);
      if (!src) return;

      const absolute = src.startsWith("/") ? new URL(src, link).href : src;
      if (seen.has(absolute)) return;
      if (coPhaiBanner($el, absolute)) return;

      seen.add(absolute);
      found.push(absolute);
    });

    return found;
  } catch (err) {
    console.warn("extractImagesFromPage: lỗi lấy ảnh từ", link, "-", err.message);
    return [];
  }
}

/**
 * Lấy 1 bài đề xuất cho 1 nguồn (source = { link, name }).
 * Luôn trả về kết quả hợp lệ — nếu không lấy được gì thì fallback về
 * ảnh đại diện tự sinh (SVG, không phụ thuộc file trên đĩa) + tên nguồn,
 * không bao giờ ném lỗi ra ngoài.
 *
 * Trường `found`: true khi xác định được ĐÚNG bài viết mới nhất (dùng để
 * ưu tiên hiển thị các nguồn này lên đầu ở server.js); false khi phải lùi
 * về trang chủ của nguồn làm link mặc định.
 */
export async function getSuggestedPost(source) {
  const cacheKey = `post:${source.link}`;
  const cached = getCached(cacheKey);
  if (cached) return cached;

  let result;
  try {
    const latest = await findLatestArticleLink(source.link);
    if (!latest) throw new Error("Không tìm được bài viết mới nhất");

    const meta = await extractArticleMeta(latest.link);
    const image =
      toProxiedImage(meta.image, source.name) ||
      toProxiedImage(await getAnyImageFromPage(latest.link).catch(() => null), source.name) ||
      toProxiedImage(await getAnyImageFromPage(source.link).catch(() => null), source.name) ||
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
    // Chưa xác định được bài cụ thể -> link mặc định là trang chủ nguồn,
    // nhưng VẪN cố lấy 1 ảnh bất kỳ ngay trên trang đó để hiện thay vì bỏ
    // trống — đây là phần bạn yêu cầu "phải làm được".
    const anyImage = await getAnyImageFromPage(source.link).catch(() => null);
    result = {
      title: source.name,
      link: source.link,
      image: toProxiedImage(anyImage, source.name) || getFallbackImage(source.link, source.name),
      name: source.name,
      found: false
    };
  }

  setCached(cacheKey, result);
  return result;
}

/**
 * Lấy bài đề xuất cho nhiều nguồn cùng lúc (chạy song song, CHỜ kết quả thật).
 * Dùng khi bạn chấp nhận trang chờ lâu hơn để có dữ liệu mới nhất ngay lần đầu.
 */
export async function getSuggestedPosts(sources) {
  return Promise.all(sources.map((source) => getSuggestedPost(source)));
}

/**
 * PHIÊN BẢN NHANH — dùng cho trang chủ để không bao giờ bị "treo" chờ mạng:
 *   - Nguồn nào đã có trong cache (đã từng lấy thành công trước đó) -> trả ngay.
 *   - Nguồn nào CHƯA có cache -> trả tạm ảnh dự phòng + tên nguồn ngay lập tức,
 *     đồng thời âm thầm đi lấy bài thật ở NỀN (không chờ). Lần tải trang SAU
 *     (thường chỉ vài giây tới vài chục giây sau) sẽ tự động thấy tin thật,
 *     không cần bạn làm gì thêm.
 */
export function getSuggestedPostsFast(sources) {
  return sources.map((source) => {
    const cacheKey = `post:${source.link}`;
    const cached = getCached(cacheKey);
    if (cached) return cached;

    // Âm thầm đi lấy bài thật ở nền — không await, không chặn trang chủ.
    getSuggestedPost(source).catch(() => {});

    return {
      title: source.name,
      link: source.link,
      image: getFallbackImage(source.link, source.name),
      name: source.name,
      found: false
    };
  });
}

/**
 * Sắp xếp lại: nguồn nào đã xác định được ĐÚNG bài viết mới nhất (found:
 * true) lên trước, nguồn nào phải dùng link mặc định (found: false) xuống
 * sau — giữ nguyên thứ tự tương đối trong từng nhóm.
 */
export function sortSuggestedPosts(posts) {
  return [...posts].sort((a, b) => Number(Boolean(b.found)) - Number(Boolean(a.found)));
}
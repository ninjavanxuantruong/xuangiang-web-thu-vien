import { getRecentErrors, clearErrorLog } from "./errorLog.js";
import express from "express";
import session from "express-session";
import dotenv from "dotenv";
import path from "path";
import { fileURLToPath } from "url";
import fetch from "node-fetch";
import crypto from "crypto";
import dns from "dns";
import net from "net";

dotenv.config();

import { getDocuments, getDocumentTypes, getSuggestedSources, getSurveys } from "./sheets.js";
import { getSuggestedPostsCached, sortSuggestedPosts } from "./newsFinder.js";
import { getXaNews } from "./xaNews.js";
import admin, { firestore } from "./firebase.js";
import { getAudioForText, normalizeText, getAudioCacheStats, clearAudioCache } from "./tts.js";
import { getLatestVideos } from "./youtube.js";
import { getChannelLatestVideos } from "./channelVideos.js";
import { requireAdmin, checkAdminPassword } from "./adminAuth.js";
import { getWordParagraphs, stripHtml } from "./docReader.js";
import { getNhanVatList, buildNhanVatArticle } from "./nhanvat.js";
import { getFallbackSvgMarkup } from "./fallback-images.js";
import { summarizeDocument } from "./summarizer.js";

import { getMosaicZones } from "./mosaicFeed.js";
import { getWorldNewsFast, getWorldNewsById } from "./worldNews.js";

import { getLichTuan } from "./lichTuan.js";
import { csrfCookie, csrfCheck } from "./csrf.js";
import { clearRamCache } from "./firestoreCache.js";
import { servePdf, getPdfCacheStats, clearPdfCache, getDiskInfo } from "./pdfCache.js";
import { listWordCache, deleteWordCache } from "./wordCache.js";
import { getLatestPodcast, getCachedPodcastPath } from "./podcast.js";
// ====== Chống chết tiến trình vì 1 lỗi lẻ ======
// Node bản mới THOÁT LUÔN khi gặp lỗi không ai bắt (vd: 1 luồng tải ảnh/PDF
// bị ngắt giữa chừng lúc đông người). Ở đây chỉ ghi log (hiện ở trang
// /quanly/nhat-ky-loi) rồi để server chạy tiếp; lỗi nặng thật sự thì nền tảng
// (Render) vẫn tự khởi động lại như trước.
process.on("unhandledRejection", (reason) => {
  console.error("unhandledRejection:", reason);
});
process.on("uncaughtException", (err) => {
  console.error("uncaughtException:", err);
});

// ====== Nén gzip/brotli (gói "compression") ======
// Nạp "mềm": chưa cài gói thì server vẫn chạy bình thường, chỉ chưa nén.
// Cài: npm install compression
let compression = null;
try {
  ({ default: compression } = await import("compression"));
} catch {
  console.warn("Chưa cài gói 'compression' nên trang chưa được nén. Chạy: npm install compression");
}

// ====== Khoá bí mật của phiên đăng nhập quản lý ======
// Lấy từ biến môi trường SESSION_SECRET. Nếu quên khai báo thì dùng khoá NGẪU
// NHIÊN mỗi lần khởi động (an toàn, chỉ là phiên đăng nhập quản lý bị đăng xuất
// khi server khởi động lại) — KHÔNG còn dùng chuỗi mặc định ai cũng biết.
const SESSION_SECRET =
  process.env.SESSION_SECRET ||
  (() => {
    console.warn("Chưa đặt SESSION_SECRET — dùng khoá ngẫu nhiên tạm thời (đăng nhập quản lý sẽ mất khi server khởi động lại).");
    return crypto.randomBytes(32).toString("hex");
  })();

const app = express();
 // Chạy sau proxy (Replit/Render...): để req.ip là IP thật của người dùng, không phải IP proxy
 app.set("trust proxy", 1);
if (compression) app.use(compression()); // đặt TRƯỚC static và mọi route
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// ====== View engine ======
app.set("view engine", "ejs");
app.set("views", path.join(__dirname, "views"));

// ====== Static files ======
// Trình duyệt giữ file tĩnh vài phút thay vì hỏi lại server ở MỌI lần tải trang
// (200 người × hàng chục file css/js/ảnh mỗi lượt). Sửa file xong tối đa
// vài phút là mọi người thấy bản mới (bạn tự tải lại cứng bằng Ctrl+F5 là thấy ngay).
app.use("/public", express.static(path.join(__dirname, "public"), { maxAge: "10m" }));
app.use("/anh", express.static(path.join(__dirname, "anh"), { maxAge: "1h" }));

// ====== Middleware ======
app.use(express.urlencoded({ extended: true }));
app.use(express.json());

// Session chỉ dùng để nhớ đã nhập đúng mật khẩu khu quản lý chưa
// (req.session.isAdmin) — KHÔNG dùng cho người xem thường, trang chính
// hoàn toàn mở, không cần đăng nhập.
app.use(
  session({
    secret: SESSION_SECRET,
    resave: false,
    saveUninitialized: false,
    cookie: {
      maxAge: 30 * 24 * 60 * 60 * 1000 // 30 ngày
    }
  })
);
app.use(csrfCookie);
// ====== Health check ======
app.get("/health", (req, res) => {
  res.json({ status: "ok", time: new Date().toISOString() });
});

// ====== Utils ======
function convertYouTubeLink(inputUrl) {
  try {
    const u = new URL(inputUrl);
    let videoId = null;
    if (u.searchParams.get("v")) videoId = u.searchParams.get("v");
    if (!videoId && u.hostname.includes("youtu.be")) videoId = u.pathname.split("/")[1];
    if (!videoId && u.pathname.includes("/shorts/")) videoId = u.pathname.split("/shorts/")[1];
    if (!videoId) return null;
    return `https://www.youtube.com/embed/${videoId}`;
  } catch {
    return null;
  }
}

function extractDriveFileId(url) {
  const byId = url.match(/id=([^&]+)/);
  if (byId) return byId[1];
  const byPath = url.match(/\/d\/([^/]+)\//);
  if (byPath) return byPath[1];
  return null;
}

// Tự dò xem 1 link Drive là file Word hay PDF, dựa vào Content-Type trả về.
// Không dò được (mạng lỗi, Drive chặn preview file lớn...) -> mặc định PDF
// để giữ hành vi an toàn như trước, không làm vỡ trang.
async function detectFileKind(directUrl) {
  // Drive chậm/treo thì bỏ sau 8 giây, tránh giữ request của người xem mãi.
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 8000);
  try {
    const response = await fetch(directUrl, { method: "HEAD", signal: controller.signal });
    const contentType = (response.headers.get("content-type") || "").toLowerCase();
    if (contentType.includes("wordprocessingml") || contentType.includes("msword")) return "word";
    if (contentType.includes("pdf")) return "pdf";
  } catch (err) {
    console.warn("detectFileKind: không dò được loại file, mặc định PDF -", err.message);
  } finally {
    clearTimeout(timer);
  }
  return "pdf";
}

// Xuất dữ liệu dạng bảng ra file CSV (thêm BOM để Excel đọc đúng tiếng Việt)
function toCsv(rows) {
  return rows
    .map((row) =>
      row
        .map((cell) => {
          const str = String(cell ?? "");
          return /[",\n]/.test(str) ? `"${str.replace(/"/g, '""')}"` : str;
        })
        .join(",")
    )
    .join("\n");
}

function sendCsv(res, filename, rows) {
  const csv = "\uFEFF" + toCsv(rows);
  res.setHeader("Content-Type", "text/csv; charset=utf-8");
  res.setHeader("Content-Disposition", `attachment; filename="${filename}"`);
  res.send(csv);
}

// Xoá hàng loạt kết quả của 1 truy vấn Firestore (chia nhỏ theo lô 450 để
// không vượt giới hạn 500 thao tác/batch của Firestore).
async function batchDeleteQuery(query) {
  const snapshot = await query.get();
  if (snapshot.empty) return 0;

  const docs = snapshot.docs;
  const batchSize = 450;
  let deleted = 0;

  for (let i = 0; i < docs.length; i += batchSize) {
    const batch = firestore.batch();
    docs.slice(i, i + batchSize).forEach((doc) => batch.delete(doc.ref));
    await batch.commit();
    deleted += Math.min(batchSize, docs.length - i);
  }
  return deleted;
}

// Ghi nhận lượt truy cập — GOM TRONG RAM rồi cứ ~30 giây ghi 1 lần lên
// Firestore (dùng "tăng nguyên tử" FieldValue.increment, không cần đọc trước).
// Lý do: mọi người cùng ghi vào 1 tài liệu "truycap/<tháng>"; Firestore chỉ
// chịu tốt cỡ 1 lượt ghi/giây/tài liệu, nên lúc đông người ghi từng lượt sẽ
// nghẽn và làm chậm cả trang chủ. Gom lại thì chỉ còn ~2 lượt ghi/phút.
// Vẫn đếm 1 lượt/ngày/phiên trình duyệt như cũ.
const VISIT_FLUSH_MS = 30 * 1000;
let pendingVisits = new Map(); // "YYYY-MM-DD" -> số lượt chưa ghi

// Các dịch vụ ping giữ server không ngủ không tính là người xem thật.
// Ngoài ra thêm ?ping=1 vào địa chỉ ping cũng được bỏ qua.
const PING_USER_AGENT = /uptime|pingdom|cron-job|healthcheck|statuscake|betterstack|site24x7|better ?uptime|render\//i;

function recordVisit(req, res) {
  try {
    if (req.query && req.query.ping) return;
    if (PING_USER_AGENT.test(String(req.headers["user-agent"] || ""))) return;

    const today = new Date().toISOString().split("T")[0]; // YYYY-MM-DD
    // Nhớ "đã đếm hôm nay" bằng 1 cookie nhỏ (giống cách csrf.js làm) thay vì
    // session: session phải lưu trong RAM cho TỪNG khách, vài ngàn khách/ngày
    // sẽ phình bộ nhớ dần; cookie thì không tốn RAM server.
    const m = String(req.headers.cookie || "").match(/(?:^|;\s*)xg_lv=(\d{4}-\d{2}-\d{2})/);
    if (m && m[1] === today) return; // đã đếm hôm nay rồi

    res.cookie("xg_lv", today, {
      httpOnly: true,
      sameSite: "lax",
      secure: Boolean(req.secure || req.headers["x-forwarded-proto"] === "https"),
      maxAge: 36 * 60 * 60 * 1000
    });
    pendingVisits.set(today, (pendingVisits.get(today) || 0) + 1);
  } catch (err) {
    console.error("recordVisit error:", err.message);
  }
}

async function flushVisits() {
  if (pendingVisits.size === 0) return;
  const batch = pendingVisits;
  pendingVisits = new Map();

  // Gom theo tháng (mỗi tháng 1 tài liệu Firestore).
  const byMonth = new Map();
  for (const [day, n] of batch) {
    const month = day.slice(0, 7);
    const entry = byMonth.get(month) || { total: 0, days: {} };
    entry.total += n;
    entry.days[day] = (entry.days[day] || 0) + n;
    byMonth.set(month, entry);
  }

  await Promise.all(
    [...byMonth].map(async ([month, entry]) => {
      try {
        const data = { month, total: admin.firestore.FieldValue.increment(entry.total) };
        for (const [day, n] of Object.entries(entry.days)) {
          data[`byDay.${day}`] = admin.firestore.FieldValue.increment(n);
        }
        await firestore.collection("truycap").doc(month).set(data, { merge: true });
      } catch (err) {
        console.error("flushVisits error:", err.message);
        // Ghi lỗi -> trả lại số lượt của tháng này để lần sau ghi tiếp, không mất.
        for (const [day, n] of Object.entries(entry.days)) {
          pendingVisits.set(day, (pendingVisits.get(day) || 0) + n);
        }
      }
    })
  );
}
setInterval(flushVisits, VISIT_FLUSH_MS).unref();

// Render/Replit gửi SIGTERM khi deploy hoặc khởi động lại -> ghi nốt số lượt
// còn trong RAM trước khi thoát (chờ tối đa 5 giây).
let shuttingDown = false;
async function shutdown(signal) {
  if (shuttingDown) return;
  shuttingDown = true;
  console.log(`${signal}: ghi nốt lượt truy cập rồi thoát...`);
  await Promise.race([flushVisits().catch(() => {}), new Promise((resolve) => setTimeout(resolve, 5000))]);
  process.exit(0);
}
process.on("SIGTERM", () => shutdown("SIGTERM"));
process.on("SIGINT", () => shutdown("SIGINT"));

// ====== API: bài đọc đề xuất mới nhất (client tự gọi lại để cập nhật,
// không cần người dùng F5 trang) ======
app.get("/api/bai-doc-de-xuat", async (req, res) => {
  try {
    const sources = await getSuggestedSources();
    // Không cắt bớt nữa — hiện đủ mọi nguồn đã cấu hình trong sheet.
    // Nguồn nào chưa xác định được bài viết cụ thể (found: false) thì BỎ
    // HẲN, không hiện link mặc định nữa.
    const suggestedPosts = sortSuggestedPosts(await getSuggestedPostsCached(sources)).filter((p) => p.found);
    res.json({ suggestedPosts });
  } catch (err) {
    console.error("GET /api/bai-doc-de-xuat error:", err);
    res.status(500).json({ suggestedPosts: [] });
  }
});

// ====== DEBUG TẠM THỜI: xem trực tiếp kết quả/lỗi thật của xaNews.js
// trên trình duyệt, không cần mò log server. Xoá route này sau khi đã
// xác định và sửa xong lỗi.
// (Đã chuyển nguồn tin từ site xã sang fanpage Facebook qua Graph API —
// xem lý do trong xaNews.js — nên các bước debug cũng đổi theo.) ======
app.get("/debug/xa-news", async (req, res) => {
  const debug = { steps: [] };

  // BƯỚC 1: kiểm tra đã có FB_PAGE_ACCESS_TOKEN chưa (biến môi trường bắt
  // buộc để gọi Graph API), không lộ giá trị thật ra ngoài — chỉ báo có/
  // không và độ dài để tự kiểm tra có dán nhầm khoảng trắng, thiếu ký tự...
  const token = process.env.FB_PAGE_ACCESS_TOKEN || "";
  debug.steps.push({
    step: "kiem-tra-bien-moi-truong",
    coFB_PAGE_ACCESS_TOKEN: Boolean(token),
    doDaiToken: token.length,
    FB_PAGE_ID: process.env.FB_PAGE_ID || "xuangiangngaymoi (mặc định)"
  });

  // BƯỚC 2: gọi thẳng Graph API xem trả lỗi gì (nếu có) — ví dụ token hết
  // hạn, thiếu quyền pages_read_engagement, sai Page ID...
  if (token) {
    try {
      const axios = (await import("axios")).default;
      const pageId = process.env.FB_PAGE_ID || "xuangiangngaymoi";
      const resp = await axios.get(`https://graph.facebook.com/v21.0/${pageId}/posts`, {
        timeout: 8000,
        params: {
          fields: "message,full_picture,permalink_url,created_time",
          limit: 10,
          access_token: token
        }
      });
      debug.steps.push({
        step: "goi-graph-api",
        ok: true,
        soLuongBaiTraVe: Array.isArray(resp.data?.data) ? resp.data.data.length : 0,
        mauBaiDauTien: resp.data?.data?.[0] || null
      });
    } catch (err) {
      debug.steps.push({
        step: "goi-graph-api",
        ok: false,
        httpStatus: err.response ? err.response.status : null,
        loiTuFacebook: err.response?.data?.error || err.message
      });
    }
  }

  // BƯỚC 3: chạy đúng hàm getXaNews() thật đang dùng cho trang chủ.
  try {
    const news = await getXaNews();
    debug.steps.push({ step: "getXaNews", ok: true, soLuong: news.length, news });
  } catch (err) {
    debug.steps.push({ step: "getXaNews", ok: false, loi: err.message, stack: err.stack });
  }

  res.json(debug);
});

// ====== Trang chủ ======
// ====== DEBUG TẠM THỜI cho channelVideos.js — xoá sau khi ổn định ======
app.get("/debug/channel-videos", async (req, res) => {
  const debug = { steps: [] };

  const sheetUrl = process.env.CHANNELS_SHEET_URL || "";
  debug.steps.push({
    step: "kiem-tra-bien-moi-truong",
    coCHANNELS_SHEET_URL: Boolean(sheetUrl),
    doDaiUrl: sheetUrl.length
  });

  try {
    const videos = await getChannelLatestVideos();
    debug.steps.push({ step: "getChannelLatestVideos", ok: true, soLuong: videos.length, videos });
  } catch (err) {
    debug.steps.push({ step: "getChannelLatestVideos", ok: false, loi: err.message, stack: err.stack });
  }

  res.json(debug);
});

app.get("/", async (req, res) => {
  // Gửi khung sườn + splash NGAY, trước khi đụng tới bất kỳ dữ liệu nào,
  // để splash thật sự che màn hình trắng trong lúc chờ.
  res.status(200);
  res.setHeader("Content-Type", "text/html; charset=utf-8");
  // Đếm lượt truy cập NGAY (không chờ Firestore) và TRƯỚC khi gửi byte đầu
  // tiên — để cookie kịp được đặt cùng phản hồi.
  recordVisit(req, res);
  req.app.render("home-shell", {}, (err, shellHtml) => {
    if (!err) {
      res.write(shellHtml);
      // Có nén gzip thì dữ liệu bị giữ lại chờ đủ gói mới gửi -> phải "xả" ngay,
      // để khung + màn splash tới trình duyệt tức thì như trước.
      if (typeof res.flush === "function") res.flush();
    }
  });

  try {
    // Trước đây các khối được lấy NỐI ĐUÔI nhau (khối sau chờ khối trước xong),
    // nên lúc cache trống thì thời gian = TỔNG của tất cả. Giờ cả 9 khối cùng
    // chạy song song -> thời gian = khối CHẬM NHẤT. Mỗi khối phụ tự bắt lỗi
    // (lỗi thì trang vẫn lên, chỉ thiếu khối đó); lỗi ở dữ liệu lõi (danh sách
    // tài liệu) vẫn đi xuống catch bên dưới như cũ.
    const settle = (fn, fallback, label) =>
      Promise.resolve()
        .then(fn)
        .catch((err) => {
          console.error(label, err.message);
          return fallback;
        });

    const coreP = Promise.all([getDocuments(), getDocumentTypes(), getSuggestedSources()]);
    coreP.catch(() => {}); // lỗi lõi sẽ được ném ra ở lệnh await Promise.all bên dưới

    // Không cắt bớt nữa — hiện đủ mọi nguồn đã cấu hình trong sheet, và nguồn
    // nào đã xác định được đúng bài viết (found: true) hiện lên trước. Nguồn
    // nào CHƯA xác định được bài viết cụ thể thì bỏ hẳn, không hiện.
    const suggestedP = settle(
      () =>
        coreP
          .then(([, , sources]) => getSuggestedPostsCached(sources))
          .then((posts) => sortSuggestedPosts(posts).filter((p) => p.found)),
      [],
      "Lấy bài đọc đề xuất lỗi:"
    );
    const surveysP = settle(() => getSurveys(), [], "Lấy danh sách khảo sát lỗi:");
    const latestVideosP = settle(() => getLatestVideos(), [], "Lấy video Youtube lỗi:");
    const xaNewsP = settle(() => getXaNews(), [], "Lấy tin tức xã lỗi:");
    const channelVideosP = settle(() => getChannelLatestVideos(), [], "Lấy video theo danh sách kênh lỗi:");
    // Không giới hạn số lượng — trang chủ hiện HẾT danh sách, chạy vòng tròn (marquee).
    const nhanVatP = settle(() => getNhanVatList(), [], "Lấy danh sách Danh nhân & Địa điểm lỗi:");
    const mosaicP = settle(
      () => getMosaicZones(),
      { taiLieu: [], danhNhan: [], videoXa: [], tinXa: [], baiDeXuat: [], videoDeXuat: [], tinTheGioi: [] },
      "Lấy dữ liệu mosaic lỗi:"
    );
    const worldNewsP = settle(() => getWorldNewsFast(), [], "Lấy tin thế giới lỗi:");
    const podcastP = settle(() => getLatestPodcast(), null, "Lấy podcast lỗi:");

    const [
      [docs, types],
      suggestedPosts,
      surveys,
      latestVideos,
      xaNews,
      channelVideos,
    nhanVatPreview,
    mosaicZones,
    worldNews,
    podcast
    ] = await Promise.all([
    coreP,
    suggestedP,
    surveysP,
    latestVideosP,
    xaNewsP,
    channelVideosP,
    nhanVatP,
    mosaicP,
    worldNewsP,
    podcastP
    ]);

    // "Tài liệu nổi bật": lấy văn bản ĐẦU TIÊN của MỖI loại (vì bạn luôn
    // chèn văn bản mới lên đầu nhóm loại đó trong sheet — dòng đầu = mới nhất).
    const featuredDocs = types
      .map((type) => docs.find((d) => d.type === type))
      .filter(Boolean);

  req.app.render(
    "home-content",
    { types, featuredDocs, suggestedPosts, latestVideos, xaNews, channelVideos, nhanVatPreview, mosaicZones, worldNews, surveys, podcast },
  (err, contentHtml) => {
    res.end(err ? "<p>Không tải được trang chủ</p></body></html>" : contentHtml);
  }
);
} catch (err) {
console.error("GET / error:", err);
// Đầu trang (splash) đã gửi rồi nên không đổi được mã trạng thái nữa,
// chỉ có thể đóng trang hợp lệ.
res.end("<p>Không tải được trang chủ</p></body></html>");
}
});

// ====== Danh mục tài liệu theo loại ======
app.get("/loai/:type", async (req, res) => {
  try {
    const { type } = req.params;
    const docs = await getDocuments();
    const filtered = docs.filter((d) => d.type === type);
    res.render("category", { type, docs: filtered });
  } catch (err) {
    console.error("GET /loai/:type error:", err);
    res.status(500).send("Không tải được danh mục tài liệu");
  }
});

// ====== Mindmap nghiên cứu văn bản ======
app.get("/mindmap/:name", async (req, res) => {
  try {
    const { name } = req.params;
    const docs = await getDocuments();
    const doc = docs.find((d) => d.name === name);
    if (!doc) return res.status(404).send("Không tìm thấy văn bản");

    const summaries = [doc.summaryD, doc.summaryE, doc.summaryF].filter(Boolean);
    res.render("mindmap", { doc, summaries });
  } catch (err) {
    console.error("GET /mindmap/:name error:", err);
    res.status(500).send("Không tải được mindmap");
  }
});

// ====== Trang đọc tài liệu — tự nhận diện Word / PDF / Youtube ======
app.get("/doc/:name", async (req, res) => {
  try {
    const { name } = req.params;
    const docs = await getDocuments();
    const doc = docs.find((d) => d.name === name);
    if (!doc) return res.status(404).send("Không tìm thấy tài liệu");

    const url = doc.url;

    // 1) Youtube — nhúng video, không qua cơ chế đọc văn bản
    if (url.includes("youtube.com") || url.includes("youtu.be")) {
      const embedUrl = convertYouTubeLink(url);
      if (!embedUrl) return res.status(400).send("Không lấy được video ID từ link YouTube");
      return res.render("youtube-embed", { name: doc.name, link: embedUrl });
    }

    // 2) Văn bản gốc trên Google Docs -> xuất thẳng ra .docx rồi đọc bằng mammoth
    //    (KHÔNG ép qua PDF như bản cũ -> hiển thị cuộn dọc như bài báo)
    if (url.includes("docs.google.com/document")) {
      const match = url.match(/\/d\/([^/]+)\//);
      const fileId = match && match[1] ? match[1] : null;
      if (!fileId) return res.status(400).send("Không xác định được tài liệu Google Docs");

      const docxUrl = `https://docs.google.com/document/d/${fileId}/export?format=docx`;
      const textBlocks = await getWordParagraphs(docxUrl);
      const summary = summarizeDocument(textBlocks.map(stripHtml));
      return res.render("reader", { doc: { name: doc.name, type: "word" }, textBlocks, summary });
    }

    // 3) File tải lên Google Drive -> chưa biết Word hay PDF, tự dò bằng Content-Type
    const fileId = extractDriveFileId(url);
    const directUrl = fileId ? `https://drive.google.com/uc?export=download&id=${fileId}` : url;
    const kind = await detectFileKind(directUrl);

    if (kind === "word") {
      const textBlocks = await getWordParagraphs(directUrl);
      const summary = summarizeDocument(textBlocks.map(stripHtml));
      return res.render("reader", { doc: { name: doc.name, type: "word" }, textBlocks, summary });
    }

    // Mặc định coi là PDF — hiển thị cuộn nhiều trang liên tiếp (không lật trang)
    const pdfUrl = fileId ? `/pdf/${fileId}` : directUrl;
    return res.render("reader", { doc: { name: doc.name, type: "pdf" }, pdfUrl });
  } catch (err) {
    console.error("GET /doc/:name error:", err);
    res.status(500).send("Không thể hiển thị tài liệu");
  }
});
// ====== Tải về tài liệu gốc — dùng chung cho nút "Tải về" ở trang đọc
// và ở danh mục. Google Docs -> chuyển hướng sang link xuất .docx; file
// Drive -> dò Word/PDF rồi chuyển hướng đúng chỗ (PDF dùng /pdf/:id đã
// có sẵn, tận dụng cache đĩa).
app.get("/tai-ve/:name", async (req, res) => {
  try {
    const { name } = req.params;
    const docs = await getDocuments();
    const doc = docs.find((d) => d.name === name);
    if (!doc) return res.status(404).send("Không tìm thấy tài liệu");

    const url = doc.url;
    if (url.includes("youtube.com") || url.includes("youtu.be")) {
      return res.status(400).send("Video Youtube không tải về được");
    }

    if (url.includes("docs.google.com/document")) {
      const match = url.match(/\/d\/([^/]+)\//);
      const fileId = match && match[1] ? match[1] : null;
      if (!fileId) return res.status(400).send("Không xác định được tài liệu");
      return res.redirect(`https://docs.google.com/document/d/${fileId}/export?format=docx`);
    }

    const fileId = extractDriveFileId(url);
    const directUrl = fileId ? `https://drive.google.com/uc?export=download&id=${fileId}` : url;
    const kind = await detectFileKind(directUrl);

    if (kind === "pdf" && fileId) return res.redirect(`/pdf/${fileId}`);
    return res.redirect(directUrl);
  } catch (err) {
    console.error("GET /tai-ve/:name error:", err);
    res.status(500).send("Không tải được tài liệu");
  }
});

// ====== PDF (Drive) — lưu tạm ra đĩa (xem pdfCache.js) ======
// Người đầu tiên mở 1 PDF: server tải từ Drive 1 lần rồi lưu lại; mọi người sau
// được phục vụ thẳng từ đĩa (có hỗ trợ tải từng phần cho trình xem PDF). Chỉ
// phục vụ các file có trong sheet Tài liệu, không còn là "proxy Drive mở".
app.get("/pdf/:id", servePdf);
app.get("/podcast/audio", (req, res) => {
  const filePath = getCachedPodcastPath();
  if (!filePath) return res.status(404).send("Chưa có file podcast");
  res.setHeader("Content-Type", "audio/mpeg");
  res.sendFile(filePath); // Express tự hỗ trợ HTTP Range -> tua được
});

// ====== Proxy ảnh lấy từ trang ngoài (Bài đọc đề xuất) ======
// Lý do cần proxy: server mình vừa fetch thành công trang nguồn nên biết
// ảnh tồn tại, nhưng nếu để trình duyệt người xem tự tải thẳng URL gốc,
// 1 số trang chặn theo Referer (hotlink protection) -> ra ảnh vỡ dù ảnh có
// thật. Qua proxy này, trình duyệt luôn tải ảnh từ chính domain của mình.
//
// Nếu chính proxy này cũng lỗi (server ảnh nguồn tạm thời sập, chặn IP,
// timeout...) -> KHÔNG trả trang lỗi (khiến <img> hiện icon vỡ), mà trả
// luôn 1 ảnh SVG dự phòng đẹp — người xem không bao giờ thấy ảnh vỡ nữa,
// kể cả khi trang nguồn đang có vấn đề ở đúng thời điểm đó.
//
// CHỐNG QUÁ TẢI / LẠM DỤNG (bản này):
//   - Giữ ảnh đã tải trong RAM (tối đa ~40MB, 6 giờ): 200 người xem cùng 1
//     ảnh chỉ tốn 1 lượt tải ra ngoài, các trang trả thẳng từ RAM.
//   - Cùng 1 ảnh đang tải dở thì các yêu cầu sau chờ chung, không tải lại.
//   - Tối đa IMG_MAX_CONCURRENT ảnh tải cùng lúc; hàng chờ đầy thì trả ảnh dự
//     phòng ngay (server không bị nghẹt).
//   - Timeout 10 giây, ảnh tối đa 5MB, chỉ nhận đúng ảnh (không nhận SVG).
//   - Nguồn vừa lỗi thì nhớ 60 giây, không dồn dập thử lại.
//   - Chặn địa chỉ nội bộ (localhost, 10.x, 192.168.x, 169.254.x...) và kiểm
//     tra lại sau mỗi lần chuyển hướng — không ai dùng được server làm cổng
//     vào mạng nội bộ.
const IMG_TIMEOUT_MS = 10 * 1000;
const IMG_MAX_BYTES = 5 * 1024 * 1024;
const IMG_CACHE_TTL_MS = 6 * 60 * 60 * 1000;
const IMG_CACHE_MAX_BYTES = 40 * 1024 * 1024;
const IMG_CACHE_MAX_ITEMS = 300;
const IMG_FAIL_TTL_MS = 60 * 1000;
const IMG_MAX_REDIRECTS = 3;
const IMG_MAX_CONCURRENT = 8;
const IMG_MAX_QUEUE = 100;

const imgCache = new Map(); // href -> { buf, type, time }  (thứ tự chèn = cũ -> mới)
let imgCacheBytes = 0;
const imgFailUntil = new Map(); // href -> thời điểm được thử lại
const imgInFlight = new Map(); // href -> Promise đang tải

function imgCacheGet(href) {
  const hit = imgCache.get(href);
  if (!hit) return null;
  if (Date.now() - hit.time > IMG_CACHE_TTL_MS) {
    imgCache.delete(href);
    imgCacheBytes -= hit.buf.length;
    return null;
  }
  // Đưa xuống cuối = "vừa dùng", để khi đầy thì bỏ ảnh lâu không ai xem trước.
  imgCache.delete(href);
  imgCache.set(href, hit);
  return hit;
}

function imgCacheSet(href, entry) {
  const old = imgCache.get(href);
  if (old) {
    imgCache.delete(href);
    imgCacheBytes -= old.buf.length;
  }
  imgCache.set(href, { ...entry, time: Date.now() });
  imgCacheBytes += entry.buf.length;
  while ((imgCacheBytes > IMG_CACHE_MAX_BYTES || imgCache.size > IMG_CACHE_MAX_ITEMS) && imgCache.size > 1) {
    const oldestKey = imgCache.keys().next().value;
    imgCacheBytes -= imgCache.get(oldestKey).buf.length;
    imgCache.delete(oldestKey);
  }
}

let imgActive = 0;
const imgQueue = [];
function acquireImgSlot() {
  if (imgActive < IMG_MAX_CONCURRENT) {
    imgActive++;
    return Promise.resolve(true);
  }
  if (imgQueue.length >= IMG_MAX_QUEUE) return Promise.resolve(false); // quá tải -> bỏ qua
  return new Promise((resolve) => imgQueue.push(resolve));
}
function releaseImgSlot() {
  const next = imgQueue.shift();
  if (next) next(true); // chuyển luôn suất cho người đang chờ
  else imgActive--;
}

function isPrivateIp(ip) {
  if (net.isIPv4(ip)) {
    const [a, b] = ip.split(".").map(Number);
    return (
      a === 0 || a === 10 || a === 127 ||
      (a === 100 && b >= 64 && b <= 127) ||
      (a === 169 && b === 254) ||
      (a === 172 && b >= 16 && b <= 31) ||
      (a === 192 && b === 168) ||
      a >= 224
    );
  }
  if (net.isIPv6(ip)) {
    const v = ip.toLowerCase();
    if (v === "::1" || v === "::") return true;
    if (v.startsWith("fc") || v.startsWith("fd") || v.startsWith("fe80")) return true;
    if (v.startsWith("::ffff:")) return isPrivateIp(v.slice(7)); // IPv4 dạng IPv6
    return false;
  }
  return true; // không nhận ra -> coi là không an toàn
}

async function assertPublicUrl(u) {
  if (u.protocol !== "http:" && u.protocol !== "https:") throw new Error("Giao thức không hợp lệ");
  const host = u.hostname.replace(/^\[|\]$/g, "").toLowerCase();
  if (host === "localhost" || host.endsWith(".localhost") || host.endsWith(".local") || host.endsWith(".internal")) {
    throw new Error("Địa chỉ nội bộ bị chặn");
  }
  if (net.isIP(host)) {
    if (isPrivateIp(host)) throw new Error("Địa chỉ nội bộ bị chặn");
    return;
  }
  const addrs = await dns.promises.lookup(host, { all: true });
  if (!addrs.length || addrs.some((a) => isPrivateIp(a.address))) throw new Error("Địa chỉ nội bộ bị chặn");
}

async function downloadImage(src) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), IMG_TIMEOUT_MS);
  try {
    let url = new URL(src);
    for (let hop = 0; hop <= IMG_MAX_REDIRECTS; hop++) {
      await assertPublicUrl(url);
      const response = await fetch(url.href, {
        signal: controller.signal,
        redirect: "manual", // tự theo dõi chuyển hướng để kiểm tra từng chặng
        headers: {
          "User-Agent":
            "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/119 Safari/537.36",
          Accept: "image/avif,image/webp,image/*,*/*;q=0.8",
          Referer: `${url.protocol}//${url.host}/`
        }
      });

      if (response.status >= 300 && response.status < 400) {
        const location = response.headers.get("location");
        response.body?.destroy?.();
        if (!location) throw new Error("Chuyển hướng thiếu địa chỉ");
        url = new URL(location, url);
        continue;
      }
      if (!response.ok) {
        response.body?.destroy?.();
        throw new Error(`Fetch failed: ${response.status}`);
      }

      const type = (response.headers.get("content-type") || "").split(";")[0].trim().toLowerCase();
      const isImage =
        (type.startsWith("image/") && type !== "image/svg+xml") ||
        type === "application/octet-stream" ||
        type === "binary/octet-stream";
      if (!isImage) {
        response.body?.destroy?.();
        throw new Error(`Không phải ảnh hợp lệ (${type || "không rõ loại"})`);
      }
      if (Number(response.headers.get("content-length") || 0) > IMG_MAX_BYTES) {
        response.body?.destroy?.();
        throw new Error("Ảnh quá lớn");
      }

      const chunks = [];
      let total = 0;
      for await (const chunk of response.body) {
        total += chunk.length;
        if (total > IMG_MAX_BYTES) {
          response.body.destroy?.();
          throw new Error("Ảnh quá lớn");
        }
        chunks.push(chunk);
      }
      return { buf: Buffer.concat(chunks), type: type || "image/jpeg" };
    }
    throw new Error("Quá nhiều lần chuyển hướng");
  } finally {
    clearTimeout(timer);
  }
}

// Trả { buf, type } hoặc null (lỗi/quá tải -> nơi gọi trả ảnh SVG dự phòng).
async function getExternalImage(href) {
  const hit = imgCacheGet(href);
  if (hit) return hit;

  const retryAt = imgFailUntil.get(href);
  if (retryAt && retryAt > Date.now()) return null;
  if (imgInFlight.has(href)) return imgInFlight.get(href);

  const task = (async () => {
    const gotSlot = await acquireImgSlot();
    if (!gotSlot) return null; // quá tải: không ghi nhớ là "nguồn lỗi"
    try {
      const img = await downloadImage(href);
      imgCacheSet(href, img);
      return img;
    } catch (err) {
      console.warn("Proxy ảnh ngoài lỗi:", href, "-", err.message);
      if (imgFailUntil.size > 500) {
        const now = Date.now();
        for (const [k, until] of imgFailUntil) if (until <= now) imgFailUntil.delete(k);
      }
      imgFailUntil.set(href, Date.now() + IMG_FAIL_TTL_MS);
      return null;
    } finally {
      releaseImgSlot();
    }
  })().finally(() => imgInFlight.delete(href));

  imgInFlight.set(href, task);
  return task;
}

app.get("/anh-ngoai", async (req, res) => {
  const src = req.query.u;
  const name = String(req.query.name || "").slice(0, 200);
  if (!src || typeof src !== "string") return res.status(400).send("Thiếu tham số u");

  let target;
  try {
    target = new URL(src);
  } catch {
    return res.status(400).send("Địa chỉ ảnh không hợp lệ");
  }

  try {
    const img = await getExternalImage(target.href);
    if (img) {
      res.setHeader("Access-Control-Allow-Origin", "*");
      res.setHeader("Content-Type", img.type);
      res.setHeader("Cache-Control", "public, max-age=21600"); // 6 giờ, ảnh tin tức ít khi đổi
      return res.send(img.buf);
    }
  } catch (err) {
    console.warn("Proxy ảnh ngoài lỗi:", src, "-", err.message);
  }

  const svg = getFallbackSvgMarkup(src, name);
  res.setHeader("Content-Type", "image/svg+xml");
  res.setHeader("Cache-Control", "no-store"); // đừng cache ảnh lỗi tạm thời -> lần sau thử tải lại ảnh thật
  res.status(200).send(svg);
});

// ====== Danh nhân & Địa điểm ======
app.get("/nguoi-va-dat", async (req, res) => {
  try {
    const items = await getNhanVatList();
    res.render("nhanvat-list", { items });
  } catch (err) {
    console.error("GET /nguoi-va-dat error:", err);
    res.status(500).send("Không tải được danh sách Danh nhân & Địa điểm");
  }
});

app.get("/nguoi-va-dat/:name", async (req, res) => {
  try {
    const { name } = req.params;
    const article = await buildNhanVatArticle(name);
    if (!article) return res.status(404).send("Không tìm thấy nội dung");
    res.render("nhanvat-article", { article });
  } catch (err) {
    console.error("GET /nguoi-va-dat/:name error:", err);
    res.status(500).send("Không tải được bài viết");
  }
});
app.get("/tin-the-gioi/:id", (req, res) => {
  const article = getWorldNewsById(req.params.id);
  if (!article) return res.redirect("/");
  res.render("tin-the-gioi-article", { article });
});

// ====== TTS (đọc trang) — có cache audio ra đĩa, tự động theo nội dung ======
 // ====== TTS (đọc trang) — cache audio ra đĩa, có giới hạn tần suất theo IP ======
 app.get("/tts", async (req, res) => {
   const q = String(req.query.q || "").trim();
   if (!q) return res.status(400).send("Thiếu tham số q");

   try {
     const { buffer, contentType } = await getAudioForText(q, { ip: req.ip });
     res.setHeader("Content-Type", contentType);
     // Cùng 1 câu luôn ra cùng 1 audio -> cho trình duyệt giữ lại 7 ngày
     res.setHeader("Cache-Control", "public, max-age=604800, immutable");
     res.setHeader("Access-Control-Allow-Origin", "*");
     res.send(buffer);
   } catch (err) {
     // 400 thiếu nội dung | 413 câu quá dài | 429 quá nhanh/đang bận | 503 Google TTS hỏng
     const status = err.status || 503;
     if (status === 429 && err.retryAfter) res.setHeader("Retry-After", String(err.retryAfter));
     if (status >= 500) console.error("TTS error:", err.message);
     res.status(status).send(err.message || "Không lấy được audio TTS");
   }
 });

app.post("/api/normalize", (req, res) => {
  const { text } = req.body || {};
  if (!text || !text.trim()) return res.status(400).json({ error: "Thiếu text" });
  const [normalized, logs] = normalizeText(text);
  res.json({ normalized, logs });
});
function todayStr() {
  return new Date().toISOString().split("T")[0];
}
function newCaptcha(req) {
  const a = Math.floor(Math.random() * 8) + 1;
  const b = Math.floor(Math.random() * 8) + 1;
  req.session.gopYCauHoi = a + b;
  return { a, b };
}

// ====== Góp ý của nhân dân (công khai, có thể ẩn danh) ======
app.get("/gop-y", async (req, res) => {
  const { a, b } = newCaptcha(req);
  const locked = req.session.gopYDaGuiNgay === todayStr();
  let surveys = [];
  try {
    surveys = await getSurveys();
  } catch (err) {
    console.error("GET /gop-y: lỗi lấy danh sách khảo sát -", err.message);
  }
  res.render("gop-y", { a, b, error: null, success: false, locked, surveys });
});

  app.post("/gop-y", csrfCheck, async (req, res) => {
  const { hoTen, diaChi, noiDung, dapAn } = req.body;

  let surveys = [];
  try {
    surveys = await getSurveys();
  } catch (err) {
    console.error("POST /gop-y: lỗi lấy danh sách khảo sát -", err.message);
  }

  // Đã gửi trong hôm nay rồi -> khoá form, không cho gửi thêm, kể cả cố
  // tình POST thẳng bỏ qua giao diện đã disable.
  if (req.session.gopYDaGuiNgay === todayStr()) {
    const { a, b } = newCaptcha(req);
    return res.render("gop-y", { a, b, error: null, success: false, locked: true, surveys });
  }

  if (!noiDung || !noiDung.trim()) {
    const { a, b } = newCaptcha(req);
    return res.render("gop-y", { a, b, error: "Vui lòng nhập nội dung góp ý.", success: false, locked: false, surveys });
  }
  if (parseInt(dapAn, 10) !== req.session.gopYCauHoi) {
    const { a, b } = newCaptcha(req);
    return res.render("gop-y", { a, b, error: "Câu trả lời chưa đúng, vui lòng thử lại.", success: false, locked: false, surveys });
  }

  try {
    const thoiGian = new Date().toISOString();
    await firestore.collection("gopy").add({
      hoTen: (hoTen || "").trim(),
      diaChi: (diaChi || "").trim(),
      noiDung: noiDung.trim(),
      thoiGian,
      thang: thoiGian.slice(0, 7),
      nam: thoiGian.slice(0, 4)
    });

    req.session.gopYDaGuiNgay = todayStr(); // khoá gửi thêm trong hôm nay

    const { a, b } = newCaptcha(req);
    res.render("gop-y", { a, b, error: null, success: true, locked: true, surveys });
  } catch (err) {
    console.error("POST /gop-y error:", err);
    const { a, b } = newCaptcha(req);
    res.render("gop-y", { a, b, error: "Có lỗi khi gửi góp ý, vui lòng thử lại sau.", success: false, locked: false, surveys });
  }
});

// ====== Quản lý Góp ý (Ban Xây dựng Đảng) ======
app.get("/quanly/gop-y", requireAdmin, async (req, res) => {
  const thang = req.query.thang || new Date().toISOString().slice(0, 7);
  const nam = req.query.nam || thang.slice(0, 4);

  let items = [];
  try {
    const thangSnap = await firestore
      .collection("gopy")
      .where("thang", "==", thang)
      .orderBy("thoiGian", "desc")
      .limit(200)
      .get();
    items = thangSnap.docs.map((d) => ({ id: d.id, ...d.data() }));
  } catch (err) {
    console.error("GET /quanly/gop-y error (danh sách tháng):", err.message);
    return res.status(500).send("Không tải được danh sách góp ý");
  }

  // Thống kê theo năm là phần THÊM — nếu lỗi (vd thiếu index Firestore)
  // thì vẫn hiện được danh sách góp ý phía trên, chỉ riêng phần thống kê
  // hiện số 0, không kéo sập cả trang.
  let countByMonth = {};
  let totalNam = 0;
  try {
    const namSnap = await firestore.collection("gopy").where("nam", "==", nam).get();
    namSnap.forEach((doc) => {
      const t = doc.data().thang;
      if (t) countByMonth[t] = (countByMonth[t] || 0) + 1;
    });
    totalNam = namSnap.size;
  } catch (err) {
    console.error(
      "GET /quanly/gop-y error (thống kê năm — có thể do THIẾU INDEX Firestore, xem link trong lỗi gốc nếu có):",
      err.message
    );
  }

  res.render("admin-feedback", { items, thang, nam, countByMonth, totalNam });
});
app.get("/quanly/gop-y/xuat", requireAdmin, async (req, res) => {
  try {
    const { thang, nam } = req.query;
    let query;
    if (thang) query = firestore.collection("gopy").where("thang", "==", thang);
    else if (nam) query = firestore.collection("gopy").where("nam", "==", nam);
    else return res.status(400).send("Thiếu tháng hoặc năm cần xuất");

    const snapshot = await query.orderBy("thoiGian", "desc").get();
    const rows = [["Thời gian", "Họ tên", "Địa chỉ", "Nội dung"]];
    snapshot.forEach((doc) => {
      const d = doc.data();
      rows.push([d.thoiGian, d.hoTen || "(Ẩn danh)", d.diaChi || "", d.noiDung]);
    });

    sendCsv(res, `gop-y-${thang || nam}.csv`, rows);
  } catch (err) {
    console.error("GET /quanly/gop-y/xuat error:", err);
    res.status(500).send("Không xuất được file");
  }
});

  app.post("/quanly/gop-y/xoa", requireAdmin, csrfCheck, async (req, res) => {
  try {
    const { thang, nam } = req.body;
    let query;
    if (thang) query = firestore.collection("gopy").where("thang", "==", thang);
    else if (nam) query = firestore.collection("gopy").where("nam", "==", nam);
    else return res.status(400).send("Thiếu tháng hoặc năm cần xoá");

    await batchDeleteQuery(query);
    res.redirect(`/quanly/gop-y${thang ? `?thang=${thang}` : ""}`);
  } catch (err) {
    console.error("POST /quanly/gop-y/xoa error:", err);
    res.status(500).send("Không xoá được góp ý");
  }
});

// ====== Khu quản lý Ban Xây dựng Đảng (gate bằng mật khẩu) ======
app.get("/quanly", (req, res) => {
  if (req.session.isAdmin) return res.redirect("/quanly/thong-ke");
  res.render("admin-gate", { error: null });
});

  app.post("/quanly", csrfCheck, (req, res) => {
  const { password } = req.body;
  if (checkAdminPassword(password)) {
    req.session.isAdmin = true;
    return res.redirect("/quanly/thong-ke");
  }
  res.render("admin-gate", { error: "Sai mật khẩu" });
});

app.get("/quanly/thoat", (req, res) => {
  req.session.isAdmin = false;
  res.redirect("/");
});

app.get("/quanly/thong-ke", requireAdmin, async (req, res) => {
  try {
    const monthKey = req.query.thang || new Date().toISOString().slice(0, 7);
    const docSnap = await firestore.collection("truycap").doc(monthKey).get();
    const stats = docSnap.exists ? docSnap.data() : { month: monthKey, byDay: {}, total: 0 };
    res.render("admin-dashboard", { stats, monthKey });
  } catch (err) {
    console.error("GET /quanly/thong-ke error:", err);
    res.status(500).send("Không tải được thống kê");
  }
});

app.get("/quanly/thong-ke/xuat", requireAdmin, async (req, res) => {
  try {
    const monthKey = req.query.thang || new Date().toISOString().slice(0, 7);
    const docSnap = await firestore.collection("truycap").doc(monthKey).get();
    const stats = docSnap.exists ? docSnap.data() : { byDay: {} };

    const rows = [["Ngày", "Lượt truy cập"]];
    Object.entries(stats.byDay || {})
      .sort((a, b) => a[0].localeCompare(b[0]))
      .forEach(([day, count]) => rows.push([day, count]));

    sendCsv(res, `luot-truy-cap-${monthKey}.csv`, rows);
  } catch (err) {
    console.error("GET /quanly/thong-ke/xuat error:", err);
    res.status(500).send("Không xuất được file");
  }
});

  app.post("/quanly/thong-ke/xoa", requireAdmin, csrfCheck, async (req, res) => {
  try {
    const { thang, nam } = req.body;
    if (thang) {
      await firestore.collection("truycap").doc(thang).delete();
    } else if (nam) {
      const monthIds = Array.from({ length: 12 }, (_, i) => `${nam}-${String(i + 1).padStart(2, "0")}`);
      await Promise.all(monthIds.map((id) => firestore.collection("truycap").doc(id).delete().catch(() => {})));
    } else {
      return res.status(400).send("Thiếu tháng hoặc năm cần xoá");
    }
    res.redirect("/quanly/thong-ke");
  } catch (err) {
    console.error("POST /quanly/thong-ke/xoa error:", err);
    res.status(500).send("Không xoá được thống kê");
  }
});
// ====== Khu 3: đọc & xoá bộ nhớ đệm (cache) tin tức để làm lại từ đầu ======
app.get("/quanly/bo-nho-dem", requireAdmin, async (req, res) => {
  try {
    const [snapshot, pdfStats, audioStats, disk, wordItems] = await Promise.all([
      firestore.collection("cache").get(),
      getPdfCacheStats().catch(() => null),
      getAudioCacheStats().catch(() => null),
      getDiskInfo().catch(() => null),
      listWordCache().catch(() => [])
    ]);
    const items = snapshot.docs.map((d) => {
      const data = d.data();
      const list = Array.isArray(data.data) ? data.data : null;
      return {
        key: d.id,
        dayKey: data.dayKey || "",
        updatedAt: data.updatedAt || "",
        soLuong: list ? list.length : null,
        // Đọc được NỘI DUNG thật (tiêu đề từng mục), không chỉ con số.
        mauNoiDung: list
          ? list.slice(0, 30).map((it) => it.title || it.name || JSON.stringify(it).slice(0, 60))
          : null
      };
    });
    res.render("admin-cache", { items, pdfStats, audioStats, disk, wordItems });
  } catch (err) {
    console.error("GET /quanly/bo-nho-dem error:", err);
    res.status(500).send("Không tải được danh sách bộ nhớ đệm");
  }
});

// Xoá PDF đã lưu tạm trên đĩa (1 file theo id, hoặc tất cả nếu không có id)
app.post("/quanly/bo-nho-dem/xoa-pdf", requireAdmin, csrfCheck, async (req, res) => {
  try {
    await clearPdfCache(req.body.id || undefined);
    res.redirect("/quanly/bo-nho-dem");
  } catch (err) {
    console.error("POST /quanly/bo-nho-dem/xoa-pdf error:", err);
    res.status(500).send("Không xoá được PDF đã lưu");
  }
});

// Xoá toàn bộ giọng đọc (TTS) đã lưu trên đĩa
app.post("/quanly/bo-nho-dem/xoa-audio", requireAdmin, csrfCheck, async (req, res) => {
  try {
    await clearAudioCache();
    res.redirect("/quanly/bo-nho-dem");
  } catch (err) {
    console.error("POST /quanly/bo-nho-dem/xoa-audio error:", err);
    res.status(500).send("Không xoá được giọng đọc đã lưu");
  }
});

// Xoá văn bản Word đã lưu trên Firestore (1 tài liệu theo key, hoặc tất cả nếu không có key)
app.post("/quanly/bo-nho-dem/xoa-word", requireAdmin, csrfCheck, async (req, res) => {
  try {
    await deleteWordCache(req.body.key || undefined);
    res.redirect("/quanly/bo-nho-dem");
  } catch (err) {
    console.error("POST /quanly/bo-nho-dem/xoa-word error:", err);
    res.status(500).send("Không xoá được văn bản Word đã lưu");
  }
});

  app.post("/quanly/bo-nho-dem/xoa", requireAdmin, csrfCheck, async (req, res) => {
  try {
    const { key } = req.body;
    if (key) {
      await firestore.collection("cache").doc(key).delete(); // xoá đúng 1 khối
    } else {
      await batchDeleteQuery(firestore.collection("cache")); // xoá hết, làm lại từ đầu
    }
    clearRamCache(key || undefined); // xoá luôn bản đang giữ trong RAM, để lần tải sau lấy mới thật sự
    res.redirect("/quanly/bo-nho-dem");
  } catch (err) {
    console.error("POST /quanly/bo-nho-dem/xoa error:", err);
    res.status(500).send("Không xoá được bộ nhớ đệm");
  }
});
app.get("/api/lich-tuan", async (req, res) => {
  const data = await getLichTuan(); // không bao giờ ném lỗi, lỗi thì trả days rỗng
  res.set("Cache-Control", "public, max-age=60");
  res.json({ days: data.days });
});

app.get("/quanly/nhat-ky-loi", requireAdmin, (req, res) => {
  res.render("admin-errors", { errors: getRecentErrors() });
});

app.post("/quanly/nhat-ky-loi/xoa", requireAdmin, csrfCheck, (req, res) => {
  clearErrorLog();
  res.redirect("/quanly/nhat-ky-loi");
});
// ====== 404 ======
app.use((req, res) => {
  res.status(404).send("Không tìm thấy trang");
});

// Lỗi đồng bộ trong route/middleware: ghi log, trả trang lỗi gọn thay vì để
// trình duyệt treo hoặc lộ chi tiết lỗi.
app.use((err, req, res, next) => {
  console.error("Lỗi chưa bắt trong route:", req.method, req.originalUrl, "-", err && err.stack ? err.stack : err);
  if (res.headersSent) return next(err);
  res.status(500).send("Có lỗi xảy ra, vui lòng thử lại sau");
});

const PORT = process.env.PORT || 3000;
const server = app.listen(PORT, () => {
  console.log(`✅ Server đang chạy tại http://localhost:${PORT}`);
});
// Bộ cân bằng tải của Render/Replit giữ kết nối rảnh khoảng 60 giây; Node mặc
// định chỉ giữ 5 giây nên thỉnh thoảng bị đóng đúng lúc có request mới đi tới
// -> người dùng gặp lỗi 502 ngẫu nhiên. Nới ra cho lớn hơn.
server.keepAliveTimeout = 65 * 1000;
server.headersTimeout = 66 * 1000;
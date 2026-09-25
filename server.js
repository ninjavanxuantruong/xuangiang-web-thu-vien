import express from "express";
import session from "express-session";
import dotenv from "dotenv";
import path from "path";
import { fileURLToPath } from "url";
import fetch from "node-fetch";

dotenv.config();

import { getDocuments, getDocumentTypes, getSuggestedSources, getSurveys } from "./sheets.js";
import { getSuggestedPostsCached, sortSuggestedPosts } from "./newsFinder.js";
import { getXaNews } from "./xaNews.js";
import admin, { firestore } from "./firebase.js";
import { getAudioForText, normalizeText } from "./tts.js";
import { getLatestVideos } from "./youtube.js";
import { getChannelLatestVideos } from "./channelVideos.js";
import { requireAdmin, checkAdminPassword } from "./adminAuth.js";
import { getWordParagraphs, stripHtml } from "./docReader.js";
import { getNhanVatList, buildNhanVatArticle } from "./nhanvat.js";
import { getFallbackSvgMarkup } from "./fallback-images.js";
import { summarizeDocument } from "./summarizer.js";

import { getMosaicZones } from "./mosaicFeed.js";
import { getWorldNewsFast, getWorldNewsById } from "./worldNews.js";
const app = express();
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// ====== View engine ======
app.set("view engine", "ejs");
app.set("views", path.join(__dirname, "views"));

// ====== Static files ======
app.use("/public", express.static(path.join(__dirname, "public")));
app.use("/anh", express.static(path.join(__dirname, "anh")));

// ====== Middleware ======
app.use(express.urlencoded({ extended: true }));
app.use(express.json());

// Session chỉ dùng để nhớ đã nhập đúng mật khẩu khu quản lý chưa
// (req.session.isAdmin) — KHÔNG dùng cho người xem thường, trang chính
// hoàn toàn mở, không cần đăng nhập.
app.use(
  session({
    secret: process.env.SESSION_SECRET || "xuangiang-secret",
    resave: false,
    saveUninitialized: false,
    cookie: {
      maxAge: 30 * 24 * 60 * 60 * 1000 // 30 ngày
    }
  })
);

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
  try {
    const response = await fetch(directUrl, { method: "HEAD" });
    const contentType = (response.headers.get("content-type") || "").toLowerCase();
    if (contentType.includes("wordprocessingml") || contentType.includes("msword")) return "word";
    if (contentType.includes("pdf")) return "pdf";
  } catch (err) {
    console.warn("detectFileKind: không dò được loại file, mặc định PDF -", err.message);
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

// Ghi nhận 1 lượt truy cập/ngày/phiên trình duyệt — dùng "tăng nguyên tử"
// (FieldValue.increment) nên KHÔNG cần đọc dữ liệu cũ trước, chỉ tốn đúng
// 1 lượt ghi/người/ngày, 0 lượt đọc. Rẻ hơn nhiều so với đọc-rồi-ghi.
async function recordVisit(req) {
  try {
    const today = new Date().toISOString().split("T")[0]; // YYYY-MM-DD
    const month = today.slice(0, 7); // YYYY-MM

    if (req.session.lastVisitDate === today) return; // đã đếm hôm nay rồi
    req.session.lastVisitDate = today;

    const docRef = firestore.collection("truycap").doc(month);
    await docRef.set(
      {
        month,
        total: admin.firestore.FieldValue.increment(1),
        [`byDay.${today}`]: admin.firestore.FieldValue.increment(1)
      },
      { merge: true }
    );
  } catch (err) {
    console.error("recordVisit error:", err.message);
  }
}

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
  req.app.render("home-shell", {}, (err, shellHtml) => {
    if (!err) res.write(shellHtml);
  });

  try {
    await recordVisit(req);

    const [docs, types, sources, surveys] = await Promise.all([
      getDocuments(),
      getDocumentTypes(),
      // ... (giữ nguyên toàn bộ phần lấy dữ liệu cũ, không đổi gì) ...
      getSuggestedSources(),
      getSurveys().catch((err) => {
        console.error("Lấy danh sách khảo sát lỗi:", err.message);
        return [];
      })
    ]);

    // "Tài liệu nổi bật": lấy văn bản ĐẦU TIÊN của MỖI loại (vì bạn luôn
    // chèn văn bản mới lên đầu nhóm loại đó trong sheet — dòng đầu = mới nhất).
    const featuredDocs = types
      .map((type) => docs.find((d) => d.type === type))
      .filter(Boolean);
    // Dùng bản NHANH — trả ngay ảnh dự phòng cho nguồn chưa có cache,
    // không chờ mạng chậm, tự cập nhật tin thật ở nền cho lần tải sau.
    // Không cắt bớt nữa — hiện đủ mọi nguồn đã cấu hình trong sheet, và
    // nguồn nào đã xác định được đúng bài viết (found: true) hiện lên
    // trước các nguồn đang dùng link mặc định. Nguồn nào CHƯA xác định
    // được bài viết cụ thể thì bỏ hẳn, không hiện — có thể khiến danh
    // sách "Bài đọc đề xuất" ngắn hơn ngay sau khi khởi động server (chưa
    // kịp lấy xong ở nền) rồi tự đầy dần lên khi bạn tải lại trang.
    const suggestedPosts = sortSuggestedPosts(await getSuggestedPostsCached(sources)).filter((p) => p.found);

    let latestVideos = [];
    try {
      latestVideos = await getLatestVideos();
    } catch (err) {
      console.error("Lấy video Youtube lỗi:", err.message);
    }

    let xaNews = [];
    try {
      xaNews = await getXaNews();
    } catch (err) {
      console.error("Lấy tin tức xã lỗi:", err.message);
    }

    let channelVideos = [];
    try {
      channelVideos = await getChannelLatestVideos();
    } catch (err) {
      console.error("Lấy video theo danh sách kênh lỗi:", err.message);
    }

    let nhanVatPreview = [];
    try {
      // Không giới hạn số lượng nữa — trang chủ hiện HẾT danh sách, chạy
      // vòng tròn liên tục (marquee) thay vì cuộn tay/cắt bớt.
      nhanVatPreview = await getNhanVatList();
    } catch (err) {
      console.error("Lấy danh sách Danh nhân & Địa điểm lỗi:", err.message);
    }

    let mosaicZones = { taiLieu: [], danhNhan: [], videoXa: [], tinXa: [], baiDeXuat: [], videoDeXuat: [], tinTheGioi: [] };
    try {
      mosaicZones = await getMosaicZones();
    } catch (err) {
      console.error("Lấy dữ liệu mosaic lỗi:", err.message);
    }
    let worldNews = [];
    try {
      worldNews = await getWorldNewsFast();
    } catch (err) {
      console.error("Lấy tin thế giới lỗi:", err.message);
    }




req.app.render(
  "home-content",
  { types, featuredDocs, suggestedPosts, latestVideos, xaNews, channelVideos, nhanVatPreview, mosaicZones, worldNews, surveys },
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

// ====== Proxy PDF (Drive) ======
app.get("/pdf/:id", async (req, res) => {
  const fileId = req.params.id;
  const url = `https://drive.google.com/uc?export=download&id=${fileId}`;
  try {
    const response = await fetch(url);
    if (!response.ok) throw new Error(`Fetch failed: ${response.status}`);
    res.setHeader("Access-Control-Allow-Origin", "*");
    res.setHeader("Content-Type", "application/pdf");
    response.body.pipe(res);
  } catch (err) {
    console.error("Proxy PDF error:", err);
    res.status(500).send("Không tải được PDF");
  }
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
app.get("/anh-ngoai", async (req, res) => {
  const src = req.query.u;
  const name = req.query.name || "";
  if (!src || typeof src !== "string") return res.status(400).send("Thiếu tham số u");

  try {
    const target = new URL(src);
    const response = await fetch(target.href, {
      headers: {
        "User-Agent":
          "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/119 Safari/537.36",
        Accept: "image/avif,image/webp,image/*,*/*;q=0.8",
        Referer: `${target.protocol}//${target.host}/`
      }
    });
    if (!response.ok) throw new Error(`Fetch failed: ${response.status}`);

    res.setHeader("Access-Control-Allow-Origin", "*");
    res.setHeader("Content-Type", response.headers.get("content-type") || "image/jpeg");
    res.setHeader("Cache-Control", "public, max-age=21600"); // 6 giờ, ảnh tin tức ít khi đổi
    response.body.pipe(res);
  } catch (err) {
    console.warn("Proxy ảnh ngoài lỗi:", src, "-", err.message);
    const svg = getFallbackSvgMarkup(src, name);
    res.setHeader("Content-Type", "image/svg+xml");
    res.setHeader("Cache-Control", "no-store"); // đừng cache ảnh lỗi tạm thời -> lần sau thử tải lại ảnh thật
    res.status(200).send(svg);
  }
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
app.get("/tts", async (req, res) => {
  try {
    const q = (req.query.q || "").trim();
    if (!q) return res.status(400).send("Thiếu tham số q");

    const { buffer, contentType } = await getAudioForText(q);
    res.setHeader("Content-Type", contentType);
    res.setHeader("Access-Control-Allow-Origin", "*");
    res.send(buffer);
  } catch (err) {
    console.error("TTS error:", err.message);
    // Không có audio server-side -> client tự chuyển sang speechSynthesis
    // của trình duyệt (xử lý trong public/main.js).
    res.status(503).send("Không lấy được audio TTS, dùng giọng đọc trình duyệt");
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

app.post("/gop-y", async (req, res) => {
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

app.post("/quanly/gop-y/xoa", requireAdmin, async (req, res) => {
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

app.post("/quanly", (req, res) => {
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

app.post("/quanly/thong-ke/xoa", requireAdmin, async (req, res) => {
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
    const snapshot = await firestore.collection("cache").get();
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
    res.render("admin-cache", { items });
  } catch (err) {
    console.error("GET /quanly/bo-nho-dem error:", err);
    res.status(500).send("Không tải được danh sách bộ nhớ đệm");
  }
});

app.post("/quanly/bo-nho-dem/xoa", requireAdmin, async (req, res) => {
  try {
    const { key } = req.body;
    if (key) {
      await firestore.collection("cache").doc(key).delete(); // xoá đúng 1 khối
    } else {
      await batchDeleteQuery(firestore.collection("cache")); // xoá hết, làm lại từ đầu
    }
    res.redirect("/quanly/bo-nho-dem");
  } catch (err) {
    console.error("POST /quanly/bo-nho-dem/xoa error:", err);
    res.status(500).send("Không xoá được bộ nhớ đệm");
  }
});
// ====== 404 ======
app.use((req, res) => {
  res.status(404).send("Không tìm thấy trang");
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`✅ Server đang chạy tại http://localhost:${PORT}`);
});
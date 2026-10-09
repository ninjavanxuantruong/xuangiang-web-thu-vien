import crypto from "crypto";
import { firestore } from "./firebase.js";
import { getIdentity, makeReaderId, getMyReads, getRegisteredReaders, getChiBoListCached } from "./nguoiDoc.js";
import { layDanhSachDangVien, thanhVienChiBo, khoaChiBo, chuanHoaTen } from "./dangVien.js";

/**
 * ĐIỂM NGHIÊN CỨU VĂN BẢN + TRẮC NGHIỆM
 *
 * - Đọc đủ (ở lại trang >= MIN_SECONDS giây và cuộn qua hết nội dung) -> nhận "điểm nghiên cứu"
 *   tuỳ độ dài văn bản: dưới 5 trang = 2 điểm, 5-15 trang = 3 điểm, trên 15 trang = 4 điểm.
 * - Sau đó được làm 1 bài trắc nghiệm (tối đa 5 câu, mỗi câu đúng 1 điểm).
 * - MỖI NGƯỜI chỉ được tính 1 lần hoàn thành + 1 lần làm bài cho MỖI văn bản
 *   (khoá theo người = chi bộ + họ tên, không theo trình duyệt).
 *
 * Collection "hoc_tap"    : mỗi người x mỗi văn bản 1 dòng (có thang/nam để sau này xếp hạng).
 *
 * THỐNG KÊ CHI BỘ (cuối file):
 *  - Trang "Khu vực của tôi" (/toi): điểm từng văn bản + tổng điểm + điểm/hạng chi bộ của mình.
 *  - Trang /toi/chi-bo: chỉ người có CHỨC VỤ (cột E sheet đảng viên) xem được danh sách từng người trong chi bộ.
 *  - Điểm chi bộ = tổng điểm các đảng viên ĐÃ ĐỐI CHIẾU với danh sách đảng viên (chống tên giả);
 *    điểm trung bình = điểm chi bộ / số đảng viên (cột B sheet chi bộ; để trống thì lấy số dòng trong sheet đảng viên).
 * Collection "hoc_tap_de" : đề trắc nghiệm đã dựng của từng văn bản (đáp án chỉ nằm ở máy chủ).
 */

const COLL_PROGRESS = "hoc_tap";
const COLL_DE = "hoc_tap_de";

const MIN_SECONDS = 5; // ở lại trang tối thiểu
const WORDS_PER_PAGE = 375; // ước lượng số trang từ số chữ
const PAGES_SHORT = 5; // dưới mốc này = 2 điểm
const PAGES_MEDIUM = 15; // tới mốc này = 3 điểm, trên nữa = 4 điểm
const MIN_WORDS = 30; // văn bản quá ngắn/trống thì không tính điểm

const QUIZ_MAX_QUESTIONS = 5;
const QUIZ_MIN_QUESTIONS = 3; // ít hơn thì không mở trắc nghiệm (chỉ có điểm nghiên cứu)
const BULLET_MIN_LEN = 25;
const BULLET_MAX_LEN = 200;

const TOKEN_MAX_AGE_MS = 24 * 60 * 60 * 1000;
const SECRET = process.env.DIEM_SECRET || process.env.SESSION_SECRET || crypto.randomBytes(32).toString("hex");

// ====================== TIỆN ÍCH ======================
function sha1(s) {
  return crypto.createHash("sha1").update(String(s)).digest("hex");
}

function slug(text) {
  return String(text || "")
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/đ/gi, "d")
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
}

/** Mã văn bản: tên không dấu + 8 ký tự băm (tên khác nhau không bao giờ trùng mã). */
export function makeDocKey(docName) {
  const s = slug(docName).slice(0, 60) || "van-ban";
  return `${s}-${sha1(docName).slice(0, 8)}`;
}

function vnDateKey(d = new Date()) {
  return new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Ho_Chi_Minh" }).format(d); // YYYY-MM-DD
}

function wordsOf(s) {
  return String(s || "").trim().split(/\s+/).filter(Boolean).length;
}

export function countWords(blocks) {
  let n = 0;
  for (const b of blocks || []) {
    if (b.tag === "table") {
      for (const row of b.rows || []) for (const c of row) n += wordsOf(c.text);
    } else {
      n += wordsOf(b.text);
    }
  }
  return n;
}

export function diemTheoDoDai(soTrang) {
  if (soTrang < PAGES_SHORT) return 2;
  if (soTrang <= PAGES_MEDIUM) return 3;
  return 4;
}

// ---- Token: chỉ trang do máy chủ dựng cho ĐÚNG người này, ĐÚNG văn bản này mới có ----
function makeToken(rid, docKey) {
  const ts = Date.now();
  const mac = crypto.createHmac("sha256", SECRET).update(`${rid}|${docKey}|${ts}`).digest("hex").slice(0, 32);
  return `${ts}.${mac}`;
}

/** Trả về thời điểm cấp token nếu hợp lệ, ngược lại null. */
function verifyToken(token, rid, docKey) {
  const m = /^(\d{10,16})\.([0-9a-f]{32})$/.exec(String(token || ""));
  if (!m) return null;
  const ts = Number(m[1]);
  const age = Date.now() - ts;
  if (age < 0 || age > TOKEN_MAX_AGE_MS) return null;
  const mac = crypto.createHmac("sha256", SECRET).update(`${rid}|${docKey}|${ts}`).digest("hex").slice(0, 32);
  const a = Buffer.from(mac);
  const b = Buffer.from(m[2]);
  if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) return null;
  return ts;
}

// ---- Bộ sinh số ngẫu nhiên CỐ ĐỊNH theo nội dung (cùng văn bản -> luôn ra cùng 1 đề) ----
function mulberry32(a) {
  return function () {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function shuffle(arr, rnd) {
  const a = arr.slice();
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(rnd() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

function tokenSet(s) {
  return new Set(
    String(s || "").toLowerCase().normalize("NFC").split(/[^\p{L}\p{N}]+/u).filter((w) => w.length > 1)
  );
}

function similarity(a, b) {
  const A = tokenSet(a);
  const B = tokenSet(b);
  if (!A.size || !B.size) return 0;
  let inter = 0;
  for (const w of A) if (B.has(w)) inter++;
  return inter / (A.size + B.size - inter);
}

// ====================== SINH ĐỀ TRẮC NGHIỆM ======================
/**
 * Dựng đề từ các slide tóm tắt (buildSlides): mỗi slide nội dung có `title` (đề mục chính) và các ý.
 * Câu hỏi: "Nội dung nào sau đây thuộc phần <đề mục>?" — đáp án đúng là 1 ý của đề mục đó,
 * 3 đáp án nhiễu lấy từ các đề mục KHÁC trong cùng văn bản (lọc bỏ ý quá giống đáp án đúng).
 */
export function buildQuiz(slides, docName) {
  const usable = (b) => b.length >= BULLET_MIN_LEN && b.length <= BULLET_MAX_LEN && !/^Bảng \(/.test(b);

  function groupBy(keyFn, kind) {
    const map = new Map();
    for (const s of slides || []) {
      if (s.type !== "content") continue;
      const key = keyFn(s);
      if (!key) continue;
      if (!map.has(key)) map.set(key, { title: key, kind, bullets: [] });
      for (const b of s.bullets || []) if (usable(b) && !map.get(key).bullets.includes(b)) map.get(key).bullets.push(b);
    }
    return [...map.values()].filter((g) => g.bullets.length > 0);
  }

  // Ưu tiên nhóm theo đề mục chính (I., II., ...); văn bản ít đề mục chính thì nhóm theo mục nhỏ (1., 2., ...)
  let groups = groupBy((s) => (s.title && s.title !== "Mở đầu" ? s.title : ""), "phần");
  if (groups.length < 3) {
    const byLabel = groupBy((s) => s.label || "", "mục");
    if (byLabel.length > groups.length) groups = byLabel;
  }
  if (groups.length < 2) return [];

  const seed = parseInt(sha1(docName + "|" + groups.map((g) => g.title + g.bullets.length).join("|")).slice(0, 8), 16);
  const rnd = mulberry32(seed);

  const order = shuffle(groups, rnd);
  const shuffled = new Map(order.map((g) => [g, shuffle(g.bullets, rnd)]));
  const maxLen = Math.max(...order.map((g) => g.bullets.length));

  const picks = [];
  for (let r = 0; r < maxLen && picks.length < QUIZ_MAX_QUESTIONS * 2; r++) {
    for (const g of order) {
      const b = shuffled.get(g)[r];
      if (b) picks.push({ g, b });
    }
  }

  const questions = [];
  const usedDistractors = new Set();
  for (const { g, b } of picks) {
    if (questions.length >= QUIZ_MAX_QUESTIONS) break;

    const pool = shuffle(
      order.filter((o) => o !== g).flatMap((o) => o.bullets),
      rnd
    );
    const chosen = [];
    const accept = (d, allowUsed) =>
      (allowUsed || !usedDistractors.has(d)) &&
      similarity(d, b) < 0.5 &&
      !g.bullets.some((x) => similarity(d, x) >= 0.6) &&
      !chosen.some((c) => similarity(d, c) >= 0.5);
    for (const d of pool) if (chosen.length < 3 && accept(d, false)) chosen.push(d);
    for (const d of pool) if (chosen.length < 3 && !chosen.includes(d) && accept(d, true)) chosen.push(d);
    if (chosen.length < 3) continue;
    chosen.forEach((d) => usedDistractors.add(d));

    const options = shuffle([b, ...chosen], rnd);
    const title = g.title.length > 120 ? g.title.slice(0, 117) + "…" : g.title;
    questions.push({
      q: `Nội dung nào sau đây thuộc ${g.kind} "${title}"?`,
      options,
      answer: options.indexOf(b)
    });
  }

  return questions.length >= QUIZ_MIN_QUESTIONS ? questions : [];
}

// ====================== LƯU ĐỀ (RAM + Firestore) ======================
const deCache = new Map(); // docKey -> { hash, docName, diem, soTrang, questions }

function ensureDe(docKey, de) {
  const hash = sha1(JSON.stringify([de.diem, de.questions]));
  const cur = deCache.get(docKey);
  if (cur && cur.hash === hash) return;
  deCache.set(docKey, { ...de, hash });
  firestore
    .collection(COLL_DE)
    .doc(docKey)
    .set({ ...de, hash, updatedAt: new Date().toISOString() })
    .catch((err) => console.warn("diem.js: lưu đề lỗi (bỏ qua):", err.message));
}

async function getDe(docKey) {
  const hit = deCache.get(docKey);
  if (hit) return hit;
  try {
    const snap = await firestore.collection(COLL_DE).doc(docKey).get();
    if (!snap.exists) return null;
    const d = snap.data();
    const de = { hash: d.hash, docName: d.docName, diem: d.diem, soTrang: d.soTrang, questions: d.questions || [] };
    deCache.set(docKey, de);
    return de;
  } catch (err) {
    console.warn("diem.js: đọc đề lỗi:", err.message);
    return null;
  }
}

// ====================== TRANG ĐỌC: chuẩn bị dữ liệu cho trình duyệt ======================
/**
 * Gọi trong route /doc/:name cho văn bản Word. Trả về null (không bật tính điểm) nếu người xem chưa xưng danh,
 * văn bản quá ngắn, hoặc có lỗi — lỗi ở đây không bao giờ được làm hỏng việc mở văn bản.
 */
export async function prepareHocTap(req, docName, blocks, slides) {
  try {
    const me = getIdentity(req);
    if (!me) return null;

    const soTu = countWords(blocks);
    if (soTu < MIN_WORDS) return null;

    const docKey = makeDocKey(docName);
    const soTrangThuc = soTu / WORDS_PER_PAGE;
    const soTrang = Math.max(1, Math.ceil(soTrangThuc));
    const diem = diemTheoDoDai(soTrangThuc);
    const questions = buildQuiz(slides, docName);
    ensureDe(docKey, { docName, diem, soTrang, questions });

    const rid = makeReaderId(me.chiBoId, me.name);
    const snap = await firestore.collection(COLL_PROGRESS).doc(`${rid}__${docKey}`).get();
    const d = snap.exists ? snap.data() : null;

    return {
      docName,
      token: makeToken(rid, docKey),
      diem,
      soTrang,
      minGiay: MIN_SECONDS,
      coQuiz: questions.length >= QUIZ_MIN_QUESTIONS,
      soCau: questions.length,
      tienDo: d
        ? {
            daHoanThanh: true,
            diemNghienCuu: d.diemNghienCuu || 0,
            daLamBai: Boolean(d.daLamBai),
            diemTracNghiem: d.diemTracNghiem || 0,
            tongCauHoi: d.tongCauHoi || 0
          }
        : { daHoanThanh: false }
    };
  } catch (err) {
    console.warn("diem.js: prepareHocTap lỗi (bỏ qua):", err.message);
    return null;
  }
}

// ====================== API ======================
function xacThuc(req, res) {
  const site = req.headers["sec-fetch-site"];
  if (site && site !== "same-origin" && site !== "none") {
    res.status(403).json({ error: "Yêu cầu không hợp lệ" });
    return null;
  }
  const me = getIdentity(req);
  if (!me) {
    res.status(401).json({ error: "Bạn chưa xưng danh nên chưa được tính điểm." });
    return null;
  }
  const docName = String((req.body && req.body.docName) || "").slice(0, 300);
  if (!docName) {
    res.status(400).json({ error: "Thiếu tên văn bản" });
    return null;
  }
  const docKey = makeDocKey(docName);
  const rid = makeReaderId(me.chiBoId, me.name);
  const ts = verifyToken(req.body && req.body.token, rid, docKey);
  if (!ts) {
    res.status(403).json({ error: "Phiên đọc đã hết hạn, vui lòng tải lại trang." });
    return null;
  }
  return { me, rid, docKey, docName, ts, ref: firestore.collection(COLL_PROGRESS).doc(`${rid}__${docKey}`) };
}

export function registerDiemRoutes(app) {
  registerThongKeChiBo(app);

  // 1) Đọc xong -> ghi điểm nghiên cứu (mỗi người / văn bản chỉ 1 lần)
  app.post("/api/hoc-tap/hoan-thanh", async (req, res) => {
    try {
      const ctx = xacThuc(req, res);
      if (!ctx) return;
      if (Date.now() - ctx.ts < MIN_SECONDS * 1000) {
        return res.status(429).json({ error: "Bạn cần đọc thêm một chút." });
      }
      const de = await getDe(ctx.docKey);
      if (!de) return res.status(409).json({ error: "Vui lòng tải lại trang rồi thử lại." });

      const now = new Date();
      const day = vnDateKey(now);
      let already = false;
      await firestore.runTransaction(async (t) => {
        const snap = await t.get(ctx.ref);
        if (snap.exists) {
          already = true;
          return;
        }
        t.set(ctx.ref, {
          rid: ctx.rid,
          name: ctx.me.name,
          chiBoId: ctx.me.chiBoId,
          chiBoName: ctx.me.chiBoName || "",
          docName: ctx.docName,
          docKey: ctx.docKey,
          diemNghienCuu: de.diem,
          soTrang: de.soTrang,
          hoanThanhAt: now.toISOString(),
          thang: day.slice(0, 7),
          nam: day.slice(0, 4),
          daLamBai: false,
          diemTracNghiem: 0,
          tongCauHoi: de.questions.length
        });
      });

      res.json({ ok: true, already, diem: de.diem, coQuiz: de.questions.length >= QUIZ_MIN_QUESTIONS, soCau: de.questions.length });
    } catch (err) {
      console.error("POST /api/hoc-tap/hoan-thanh error:", err);
      res.status(500).json({ error: "Không ghi được điểm, vui lòng thử lại." });
    }
  });

  // 2) Lấy đề (KHÔNG kèm đáp án)
  app.post("/api/hoc-tap/trac-nghiem/lay", async (req, res) => {
    try {
      const ctx = xacThuc(req, res);
      if (!ctx) return;
      const snap = await ctx.ref.get();
      if (!snap.exists) return res.status(403).json({ error: "Bạn cần đọc hết văn bản trước khi làm trắc nghiệm." });
      if (snap.data().daLamBai) return res.status(409).json({ error: "Bạn đã làm bài trắc nghiệm của văn bản này rồi." });

      const de = await getDe(ctx.docKey);
      if (!de || de.questions.length < QUIZ_MIN_QUESTIONS) {
        return res.status(404).json({ error: "Văn bản này chưa có bài trắc nghiệm." });
      }
      res.json({ ok: true, questions: de.questions.map((q) => ({ q: q.q, options: q.options })) });
    } catch (err) {
      console.error("POST /api/hoc-tap/trac-nghiem/lay error:", err);
      res.status(500).json({ error: "Không tải được bài trắc nghiệm." });
    }
  });

  // 3) Nộp bài -> chấm, ghi điểm (chỉ được 1 lần)
  app.post("/api/hoc-tap/trac-nghiem/nop", async (req, res) => {
    try {
      const ctx = xacThuc(req, res);
      if (!ctx) return;
      const de = await getDe(ctx.docKey);
      if (!de || de.questions.length < QUIZ_MIN_QUESTIONS) {
        return res.status(404).json({ error: "Văn bản này chưa có bài trắc nghiệm." });
      }
      const answers = Array.isArray(req.body.answers) ? req.body.answers.map((x) => Number(x)) : [];

      let out = null;
      await firestore.runTransaction(async (t) => {
        const snap = await t.get(ctx.ref);
        if (!snap.exists) {
          out = { status: 403, body: { error: "Bạn cần đọc hết văn bản trước khi làm trắc nghiệm." } };
          return;
        }
        const d = snap.data();
        if (d.daLamBai) {
          out = {
            status: 200,
            body: { ok: true, already: true, score: d.diemTracNghiem || 0, total: d.tongCauHoi || de.questions.length, diemNghienCuu: d.diemNghienCuu || 0 }
          };
          return;
        }
        const results = de.questions.map((q, i) => ({ dung: answers[i] === q.answer, dapAn: q.answer }));
        const score = results.filter((r) => r.dung).length;
        const day = vnDateKey();
        t.update(ctx.ref, {
          daLamBai: true,
          diemTracNghiem: score,
          tongCauHoi: de.questions.length,
          lamBaiAt: new Date().toISOString(),
          thangBai: day.slice(0, 7),
          namBai: day.slice(0, 4)
        });
        out = {
          status: 200,
          body: { ok: true, already: false, score, total: de.questions.length, results, diemNghienCuu: d.diemNghienCuu || 0 }
        };
      });

      res.status(out.status).json(out.body);
    } catch (err) {
      console.error("POST /api/hoc-tap/trac-nghiem/nop error:", err);
      res.status(500).json({ error: "Không chấm được bài, vui lòng thử lại." });
    }
  });
}

// ====================== THỐNG KÊ ĐIỂM THEO NGƯỜI / CHI BỘ ======================
const CHUC_VU_MAC_DINH = "Đảng viên"; // dangVien.js: ô chức vụ trống = "Đảng viên"
const CACHE_TTL_MS = 3 * 60 * 1000;

function homNayVN() {
  return vnDateKey();
}

/** Kỳ thống kê từ ?thang=YYYY-MM hoặc ?nam=YYYY (mặc định: tháng hiện tại). */
export function parseKy(query = {}) {
  const nam = /^\d{4}$/.test(String(query.nam || "")) ? String(query.nam) : "";
  const thang = /^\d{4}-\d{2}$/.test(String(query.thang || "")) ? String(query.thang) : "";
  if (nam && !thang) return { loai: "nam", key: nam, label: `năm ${nam}`, f1: "nam", f2: "namBai" };
  const key = thang || homNayVN().slice(0, 7);
  return { loai: "thang", key, label: `tháng ${key.slice(5)}/${key.slice(0, 4)}`, f1: "thang", f2: "thangBai" };
}

/** Điểm của 1 dòng trong kỳ: điểm nghiên cứu tính theo ngày hoàn thành, điểm trắc nghiệm tính theo ngày làm bài. */
function diemTrongKy(d, ky) {
  const nc = d[ky.f1] === ky.key ? d.diemNghienCuu || 0 : 0;
  const tn = d.daLamBai && d[ky.f2] === ky.key ? d.diemTracNghiem || 0 : 0;
  return { nc, tn };
}

const kyDocsCache = new Map(); // "thang:2026-10" -> { at, docs }
async function loadDiemDocs(ky) {
  const ck = `${ky.loai}:${ky.key}`;
  const hit = kyDocsCache.get(ck);
  if (hit && Date.now() - hit.at < CACHE_TTL_MS) return hit.docs;

  const col = firestore.collection(COLL_PROGRESS);
  const [a, b] = await Promise.all([col.where(ky.f1, "==", ky.key).get(), col.where(ky.f2, "==", ky.key).get()]);
  const byId = new Map();
  [...a.docs, ...b.docs].forEach((d) => byId.set(d.id, d.data()));
  const docs = [...byId.values()];
  if (kyDocsCache.size > 30) kyDocsCache.clear();
  kyDocsCache.set(ck, { at: Date.now(), docs });
  return docs;
}

/** Người này có CHỨC VỤ (ghi ở cột E sheet đảng viên) và đã được đối chiếu với danh sách -> trả về đảng viên đó, ngược lại null. */
async function kiemTraChucVu(me) {
  try {
    if (!me || !me.mid) return null;
    const roster = await layDanhSachDangVien();
    if (!roster) return null;
    const m = roster.byMid.get(me.mid);
    if (!m || chuanHoaTen(me.name) !== m.norm) return null;
    const thanhVien = thanhVienChiBo(roster, me.chiBoName, me.chiBoId);
    if (!thanhVien || !thanhVien.some((x) => x.mid === m.mid)) return null;
    if (!m.chucVu || m.chucVu === CHUC_VU_MAC_DINH) return null;
    return m;
  } catch (err) {
    console.warn("diem.js: kiểm tra chức vụ lỗi (coi như không có):", err.message);
    return null;
  }
}

const kyChiBoCache = new Map(); // "thang:2026-10" -> { at, data }

/**
 * Tính điểm mọi chi bộ trong 1 kỳ (nhớ 3 phút, dùng chung cho mọi người xem).
 * Trả { list, byId, soXepHang }. Mỗi chi bộ: { id, name, soDangVien, soXungDanh, soNghienCuu, diemChiBo, tb, hang, rows, coDanhSach }.
 */
export async function tinhChiBo(ky) {
  const ck = `${ky.loai}:${ky.key}`;
  const hit = kyChiBoCache.get(ck);
  if (hit && Date.now() - hit.at < CACHE_TTL_MS) return hit.data;

  const [chiBoList, readers, roster, docs] = await Promise.all([
    getChiBoListCached().catch(() => []),
    getRegisteredReaders().catch(() => []),
    layDanhSachDangVien().catch(() => null),
    loadDiemDocs(ky)
  ]);

  // điểm theo mã người
  const pts = new Map(); // rid -> { nc, tn, soVB }
  for (const d of docs) {
    const { nc, tn } = diemTrongKy(d, ky);
    if (!nc && !tn) continue;
    const cur = pts.get(d.rid) || { nc: 0, tn: 0, soVB: 0 };
    cur.nc += nc;
    cur.tn += tn;
    if (nc) cur.soVB += 1;
    pts.set(d.rid, cur);
  }
  const diemCua = (rid) => pts.get(rid) || { nc: 0, tn: 0, soVB: 0 };

  const list = chiBoList.map((cb) => {
    const readersCb = readers.filter((r) => r.chiBoId === cb.id);
    const official = thanhVienChiBo(roster, cb.name, cb.id);
    const rows = [];

    if (official) {
      const byMid = new Map(readersCb.filter((r) => r.mid).map((r) => [r.mid, r]));
      for (const m of official) {
        const r = byMid.get(m.mid);
        const p = r ? diemCua(r.id) : { nc: 0, tn: 0, soVB: 0 };
        rows.push({
          name: m.name,
          chucVu: m.chucVu === CHUC_VU_MAC_DINH ? "" : m.chucVu,
          xungDanh: Boolean(r),
          soVB: p.soVB, nc: p.nc, tn: p.tn, tong: p.nc + p.tn,
          tinhVaoChiBo: true
        });
      }
      // người xưng danh vào chi bộ này nhưng KHÔNG khớp danh sách đảng viên: hiện để biết, KHÔNG cộng vào điểm chi bộ
      const midSet = new Set(official.map((m) => m.mid));
      for (const r of readersCb) {
        if (r.mid && midSet.has(r.mid)) continue;
        const p = diemCua(r.id);
        rows.push({
          name: r.name, chucVu: "", xungDanh: true, soVB: p.soVB, nc: p.nc, tn: p.tn, tong: p.nc + p.tn,
          tinhVaoChiBo: false
        });
      }
    } else {
      // chi bộ không có trong sheet đảng viên: không đối chiếu được -> tính tất cả người đã xưng danh
      for (const r of readersCb) {
        const p = diemCua(r.id);
        rows.push({ name: r.name, chucVu: "", xungDanh: true, soVB: p.soVB, nc: p.nc, tn: p.tn, tong: p.nc + p.tn, tinhVaoChiBo: true });
      }
    }

    rows.sort((a, b) => b.tong - a.tong || a.name.localeCompare(b.name, "vi"));
    const tinh = rows.filter((r) => r.tinhVaoChiBo);
    const soDangVien = cb.soDangVien || (official ? official.length : 0) || 0;
    const diemChiBo = tinh.reduce((n, r) => n + r.tong, 0);

    return {
      id: cb.id,
      name: cb.name,
      soDangVien,
      coDanhSach: Boolean(official),
      soXungDanh: rows.filter((r) => r.xungDanh).length,
      soNghienCuu: rows.filter((r) => r.soVB > 0).length,
      diemChiBo,
      tb: soDangVien > 0 ? diemChiBo / soDangVien : null,
      hang: null,
      rows
    };
  });

  // xếp hạng theo điểm trung bình (cùng điểm thì cùng hạng); không xếp hạng chi bộ chưa có số đảng viên
  const xepHang = list
    .filter((c) => c.tb != null && khoaChiBo(c.name) !== "khong trong chi bo nao")
    .sort((a, b) => b.tb - a.tb || b.diemChiBo - a.diemChiBo);
  xepHang.forEach((c, i) => {
    c.hang = i > 0 && Math.abs(c.tb - xepHang[i - 1].tb) < 1e-9 ? xepHang[i - 1].hang : i + 1;
  });

  const data = { list, byId: new Map(list.map((c) => [c.id, c])), soXepHang: xepHang.length };
  if (kyChiBoCache.size > 30) kyChiBoCache.clear();
  kyChiBoCache.set(ck, { at: Date.now(), data });
  return data;
}

/** Tóm tắt công khai của chi bộ (KHÔNG kèm danh sách từng người). */
function tomTatChiBo(data, chiBoId) {
  const c = data && data.byId.get(chiBoId);
  if (!c) return null;
  return {
    name: c.name, soDangVien: c.soDangVien, soXungDanh: c.soXungDanh, soNghienCuu: c.soNghienCuu,
    diemChiBo: c.diemChiBo, tb: c.tb, hang: c.hang, soXepHang: data.soXepHang
  };
}

/** Dữ liệu cho trang "Khu vực của tôi". Trả null nếu chưa xưng danh. */
export async function getTrangToi(req) {
  const me = getIdentity(req);
  if (!me) return null;
  const rid = makeReaderId(me.chiBoId, me.name);
  const homNay = homNayVN();
  const thangNay = homNay.slice(0, 7);
  const namNay = homNay.slice(0, 4);
  const kThang = parseKy({});
  const kNam = parseKy({ nam: namNay });

  const [reads, diemSnap, chucVu, dThang, dNam] = await Promise.all([
    getMyReads(me).catch(() => []),
    firestore.collection(COLL_PROGRESS).where("rid", "==", rid).get().catch(() => null),
    kiemTraChucVu(me),
    tinhChiBo(kThang).catch((e) => { console.warn("diem.js: tính chi bộ (tháng) lỗi:", e.message); return null; }),
    tinhChiBo(kNam).catch((e) => { console.warn("diem.js: tính chi bộ (năm) lỗi:", e.message); return null; })
  ]);

  const diemBy = new Map();
  let tatCa = 0, thang = 0, nam = 0;
  (diemSnap ? diemSnap.docs : []).forEach((doc) => {
    const d = doc.data();
    diemBy.set(d.docName, d);
    const nc = d.diemNghienCuu || 0;
    const tn = d.daLamBai ? d.diemTracNghiem || 0 : 0;
    tatCa += nc + tn;
    if (d.thang === thangNay) thang += nc;
    if (d.daLamBai && d.thangBai === thangNay) thang += tn;
    if (d.nam === namNay) nam += nc;
    if (d.daLamBai && d.namBai === namNay) nam += tn;
  });

  const ghiChu = (d) =>
    d
      ? { hoanThanh: true, nc: d.diemNghienCuu || 0, daLamBai: Boolean(d.daLamBai), tn: d.daLamBai ? d.diemTracNghiem || 0 : 0, tongCau: d.tongCauHoi || 0 }
      : { hoanThanh: false };

  const seen = new Set();
  const items = reads.map((r) => {
    seen.add(r.docName);
    const d = diemBy.get(r.docName);
    const g = ghiChu(d);
    return { ...r, diem: { ...g, tong: g.hoanThanh ? g.nc + g.tn : 0 } };
  });
  // văn bản có điểm nhưng không còn dòng "đã đọc" (ví dụ bị dọn) vẫn hiện
  for (const [docName, d] of diemBy) {
    if (seen.has(docName)) continue;
    const g = ghiChu(d);
    items.push({ docName, soLan: 0, lanCuoi: d.hoanThanhAt || "", diem: { ...g, tong: g.nc + g.tn } });
  }

  return {
    me,
    reads: items,
    diem: { tatCa, thang, nam },
    kyThang: kThang.label,
    kyNam: kNam.label,
    chiBo: { thang: tomTatChiBo(dThang, me.chiBoId), nam: tomTatChiBo(dNam, me.chiBoId) },
    chucVu: chucVu ? chucVu.chucVu : ""
  };
}

/** Đăng ký trang thống kê chi bộ (chỉ người có chức vụ). Gọi trong registerDiemRoutes. */
function registerThongKeChiBo(app) {
  app.get("/toi/chi-bo", async (req, res) => {
    try {
      const me = getIdentity(req);
      if (!me) return res.redirect("/");
      const m = await kiemTraChucVu(me);
      if (!m) return res.status(403).send("Chỉ đồng chí có chức vụ trong danh sách đảng viên mới xem được thống kê chi bộ.");

      const ky = parseKy(req.query);
      const data = await tinhChiBo(ky);
      const cb = data.byId.get(me.chiBoId);
      if (!cb) return res.status(404).send("Không tìm thấy chi bộ của đồng chí trong danh sách chi bộ.");

      res.render("toi-chibo", {
        me,
        chucVu: m.chucVu,
        ky,
        thangChon: ky.loai === "thang" ? ky.key : "",
        namChon: ky.loai === "nam" ? ky.key : homNayVN().slice(0, 4),
        cb,
        soXepHang: data.soXepHang
      });
    } catch (err) {
      console.error("GET /toi/chi-bo error:", err);
      res.status(500).send("Không tải được thống kê chi bộ");
    }
  });
}

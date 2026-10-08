import { firestore } from "./firebase.js";
import { fetchSheet } from "./sheets.js";

/**
 * "Xưng danh" — không phải đăng nhập thật, chỉ để người đọc tự khai tên +
 * chi bộ MỘT LẦN, nhớ lại bằng cookie (không cần mật khẩu, không có gì để
 * xác thực đúng người, số liệu ra sau này là "tự khai").
 *
 *   - Cookie "xg_id"  : {name, chiBoId, chiBoName} — nhớ 365 ngày.
 *   - Cookie "xg_dr"  : {date, docs:[...]} — chặn đếm trùng nhiều lần/ngày
 *     cho CÙNG 1 trình duyệt, y hệt cách "xg_lv" đang chặn đếm trùng lượt
 *     truy cập (xem recordVisit trong server.js), không cần đọc Firestore
 *     để kiểm tra trùng nên không tốn thêm lượt đọc.
 *   - Mỗi lượt đọc (không trùng) -> 1 dòng trong collection "doc_reads".
 */

const IDENTITY_COOKIE = "xg_id";
const IDENTITY_MAX_AGE_MS = 365 * 24 * 60 * 60 * 1000;
const DEDUP_COOKIE = "xg_dr";
const DEDUP_MAX_AGE_MS = 36 * 60 * 60 * 1000; // giống xg_lv: đủ qua nửa đêm dù múi giờ lệch
const MAX_DOCS_IN_DEDUP = 200; // chặn cookie phình to nếu ai đó đọc rất nhiều trong 1 ngày

// ---- Sổ đăng ký (MỚI) ----
// Trước đây "đã xưng danh" chỉ nằm trong cookie của từng máy, nên admin không có danh sách
// ai thuộc chi bộ nào đã đăng ký (người chưa đọc tài liệu nào thì không hiện ở đâu cả).
// Giờ mỗi lần xưng danh ghi thêm 1 dòng vào collection "nguoi_dang_ky" (id = chiBoId__tên-không-dấu,
// nên 1 người gõ lại tên vẫn chỉ có 1 dòng). Admin xem + xoá được trong /quanly/nguoi-doc.
const REGISTRY = "nguoi_dang_ky";
const META_COLLECTION = "nguoi_dang_ky_meta";
const META_DELETED_DOC = "da_xoa"; // { ids: [...] } — các mã đã bị admin xoá
const REGISTERED_COOKIE = "xg_rg"; // đã có trong sổ đăng ký -> khỏi ghi lại mỗi lần vào trang
const DELETED_TTL_MS = 10 * 60 * 1000; // 10 phút hỏi lại danh sách đã xoá 1 lần (1 lượt đọc Firestore)
const MAX_DELETED_IDS = 1000;
const CHIBO_TTL_MS = 10 * 60 * 1000;

function isHttps(req) {
  return Boolean(req.secure || req.headers["x-forwarded-proto"] === "https");
}

function readCookie(req, name) {
  const m = String(req.headers.cookie || "").match(
    new RegExp(`(?:^|;\\s*)${name}=([^;]*)`)
  );
  if (!m) return null;
  try {
    return JSON.parse(decodeURIComponent(m[1]));
  } catch {
    return null;
  }
}

function writeCookie(res, req, name, value, maxAge) {
  res.cookie(name, JSON.stringify(value), {
    httpOnly: true,
    sameSite: "lax",
    secure: isHttps(req),
    maxAge
  });
}

function todayKey() {
  return new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Ho_Chi_Minh" }).format(new Date());
}

function slugify(text) {
  return String(text || "")
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/đ/gi, "d")
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
}

/** Mã 1 người trong sổ đăng ký — cùng chi bộ + cùng tên (không phân biệt hoa/thường, dấu) là cùng 1 người. */
export function makeReaderId(chiBoId, name) {
  return `${String(chiBoId || "").trim()}__${slugify(name)}`.slice(0, 150);
}

// ---- Danh sách mã đã bị xoá: giữ trong RAM, làm mới nền mỗi 10 phút ----
// Để người đã bị xoá mà trình duyệt còn cookie cũ thì bị coi là "chưa xưng danh" (hỏi lại, không
// tiếp tục ghi lượt đọc dưới tên cũ). Chỉ cần 1 lượt đọc Firestore mỗi 10 phút.
let deletedIds = new Set();
let deletedLoadedAt = 0;
let deletedLoading = null;

function refreshDeleted() {
  if (deletedLoading) return deletedLoading;
  deletedLoading = (async () => {
    try {
      const snap = await firestore.collection(META_COLLECTION).doc(META_DELETED_DOC).get();
      const ids = snap.exists && Array.isArray(snap.data().ids) ? snap.data().ids : [];
      deletedIds = new Set(ids);
    } catch (err) {
      console.warn("nguoiDoc.js: đọc danh sách đã xoá lỗi (giữ bản cũ):", err.message);
    } finally {
      deletedLoadedAt = Date.now();
      deletedLoading = null;
    }
  })();
  return deletedLoading;
}

function deletedSet() {
  if (Date.now() - deletedLoadedAt > DELETED_TTL_MS) refreshDeleted(); // nền, không chờ
  return deletedIds;
}

async function saveDeletedIds(ids) {
  const list = [...ids].slice(-MAX_DELETED_IDS);
  deletedIds = new Set(list);
  deletedLoadedAt = Date.now();
  await firestore.collection(META_COLLECTION).doc(META_DELETED_DOC).set({ ids: list });
}

/** Danh sách chi bộ từ Google Sheet (CHIBO_SHEET_URL) — cột 1 là tên chi bộ. */
export async function getChiBoList() {
  const url = process.env.CHIBO_SHEET_URL;
  if (!url) return [];

  const rows = await fetchSheet(url);
  const seen = new Set();
  const list = [];

  for (const row of rows) {
    const values = Object.values(row);
    const name = String(row.name || row.ten || row.chiBo || values[0] || "").trim();
    if (!name) continue;
    const id = slugify(name);
    if (!id || seen.has(id)) continue;
    seen.add(id);
    list.push({ id, name });
  }

  return list;
}

let chiBoCache = { at: 0, list: [] };
/** Như getChiBoList nhưng nhớ 10 phút — cho popup ở các trang tài liệu (đỡ gọi Google Sheet mỗi lần). */
export async function getChiBoListCached() {
  if (chiBoCache.list.length && Date.now() - chiBoCache.at < CHIBO_TTL_MS) return chiBoCache.list;
  const list = await getChiBoList();
  if (list.length) chiBoCache = { at: Date.now(), list };
  return list.length ? list : chiBoCache.list;
}

/** Đọc thông tin "xưng danh" đã lưu (null nếu chưa từng xưng danh). */
export function getIdentity(req) {
  const data = readCookie(req, IDENTITY_COOKIE);
  if (!data || !data.name || !data.chiBoId) return null;
  if (deletedSet().has(makeReaderId(data.chiBoId, data.name))) return null; // admin đã xoá tên này
  return data;
}

/** Lưu "xưng danh" — gọi khi người dùng điền xong popup, chưa từng gọi trước đó thì ghi mới. */
export function setIdentity(req, res, { name, chiBoId, chiBoName }) {
  const clean = {
    name: String(name || "").trim().slice(0, 100),
    chiBoId: String(chiBoId || "").trim(),
    chiBoName: String(chiBoName || "").trim().slice(0, 150)
  };
  if (!clean.name || !clean.chiBoId) return false;
  writeCookie(res, req, IDENTITY_COOKIE, clean, IDENTITY_MAX_AGE_MS);
  writeCookie(res, req, REGISTERED_COOKIE, { rid: makeReaderId(clean.chiBoId, clean.name) }, IDENTITY_MAX_AGE_MS);
  return true;
}

/**
 * Ghi người này vào sổ đăng ký (collection nguoi_dang_ky). Gọi sau setIdentity ở route POST /xung-danh.
 * Nếu trước đó họ từng bị admin xoá thì gỡ khỏi danh sách "đã xoá" (cho phép đăng ký lại).
 */
export async function registerReader({ name, chiBoId, chiBoName }) {
  const cleanName = String(name || "").trim().slice(0, 100);
  const cleanChiBoId = String(chiBoId || "").trim();
  if (!cleanName || !cleanChiBoId) return false;

  const rid = makeReaderId(cleanChiBoId, cleanName);
  const ref = firestore.collection(REGISTRY).doc(rid);
  const now = new Date().toISOString();
  const snap = await ref.get();
  const base = { name: cleanName, chiBoId: cleanChiBoId, chiBoName: String(chiBoName || "").trim().slice(0, 150), updatedAt: now };
  await ref.set(snap.exists ? base : { ...base, createdAt: now }, { merge: true });

  if (deletedIds.has(rid)) {
    const next = new Set(deletedIds);
    next.delete(rid);
    await saveDeletedIds(next);
  }
  return true;
}

// Mã đã ghi sổ trong lần chạy server này — tránh ghi lặp khi 1 trang tải nhiều file song song.
const registeredThisRun = new Set();

/**
 * Middleware (app.use sau csrfCookie):
 *  1. Người mà admin đã xoá -> xoá cookie xưng danh cũ -> trang sẽ hỏi lại.
 *  2. Người đã xưng danh từ TRƯỚC khi có sổ đăng ký (chỉ có cookie) -> tự ghi vào sổ ở lần vào kế tiếp.
 *  3. Đặt res.locals.xungDanh = { da, ten } cho MỌI trang (để popup dùng được ở trang tài liệu/văn bản).
 * Không bao giờ ném lỗi ra ngoài.
 */
export function identityGuard(req, res, next) {
  try {
    const raw = String(req.headers.cookie || "").includes(`${IDENTITY_COOKIE}=`)
      ? readCookie(req, IDENTITY_COOKIE)
      : null;

    if (raw && raw.name && raw.chiBoId) {
      const rid = makeReaderId(raw.chiBoId, raw.name);
      if (deletedSet().has(rid)) {
        res.clearCookie(IDENTITY_COOKIE);
        res.clearCookie(REGISTERED_COOKIE);
      } else if (!readCookie(req, REGISTERED_COOKIE) && !registeredThisRun.has(rid)) {
        registeredThisRun.add(rid);
        writeCookie(res, req, REGISTERED_COOKIE, { rid }, IDENTITY_MAX_AGE_MS);
        registerReader(raw).catch((err) => {
          registeredThisRun.delete(rid);
          console.warn("nguoiDoc.js: ghi sổ đăng ký lỗi (bỏ qua):", err.message);
        });
      }
    }

    const identity = getIdentity(req);
    res.locals.xungDanh = { da: Boolean(identity), ten: identity ? identity.name : "" };
  } catch (err) {
    console.warn("nguoiDoc.js: identityGuard lỗi (bỏ qua):", err.message);
  }
  next();
}

/**
 * Ghi 1 lượt đọc tài liệu — CHỈ khi người này đã từng "xưng danh" (chưa
 * xưng danh thì vẫn đọc bình thường, chỉ là không được tính vào thống kê).
 * Không throw ra ngoài — lỗi ở đây không được phép làm hỏng việc mở tài liệu.
 */
export async function recordDocRead(req, res, docName) {
  try {
    const identity = getIdentity(req);
    if (!identity) return;

    const today = todayKey();
    const dedup = readCookie(req, DEDUP_COOKIE);
    const docs = dedup && dedup.date === today ? dedup.docs || [] : [];

    if (docs.includes(docName)) return; // hôm nay đã tính tài liệu này rồi

    const nextDocs = [...docs, docName].slice(-MAX_DOCS_IN_DEDUP);
    writeCookie(res, req, DEDUP_COOKIE, { date: today, docs: nextDocs }, DEDUP_MAX_AGE_MS);

    await firestore.collection("doc_reads").add({
      name: identity.name,
      chiBoId: identity.chiBoId,
      chiBoName: identity.chiBoName,
      docName,
      date: today,
      month: today.slice(0, 7),
      createdAt: new Date().toISOString()
    });
  } catch (err) {
    console.warn("nguoiDoc.js: ghi lượt đọc lỗi (bỏ qua, không ảnh hưởng người đọc):", err.message);
  }
}

/**
 * Thống kê cho trang quản lý: theo tháng (bắt buộc), theo chi bộ (tuỳ
 * chọn — bỏ trống thì xem tất cả chi bộ). Tính toán ngay trong JS sau khi
 * đọc về, phù hợp quy mô nhỏ (không cần bộ đếm riêng).
 */
export async function getReadStats({ month, chiBoId }) {
  let query = firestore.collection("doc_reads").where("month", "==", month);
  if (chiBoId) query = query.where("chiBoId", "==", chiBoId);

  const snap = await query.get();
  const rows = snap.docs.map((d) => d.data());

  const byPerson = new Map(); // key: chiBoId + "|" + name
  const byDoc = new Map(); // key: docName

  for (const r of rows) {
    const pKey = `${r.chiBoId}|${r.name}`;
    if (!byPerson.has(pKey)) {
      byPerson.set(pKey, { name: r.name, chiBoName: r.chiBoName, chiBoId: r.chiBoId, docs: new Set(), luot: 0 });
    }
    byPerson.get(pKey).docs.add(r.docName);
    byPerson.get(pKey).luot += 1;

    byDoc.set(r.docName, (byDoc.get(r.docName) || 0) + 1);
  }

  const people = [...byPerson.values()]
    .map((p) => ({ name: p.name, chiBoName: p.chiBoName, chiBoId: p.chiBoId, soTaiLieu: p.docs.size, soLan: p.luot }))
    .sort((a, b) => b.soTaiLieu - a.soTaiLieu || a.name.localeCompare(b.name));

  const docs = [...byDoc.entries()]
    .map(([docName, count]) => ({ docName, count }))
    .sort((a, b) => b.count - a.count);

  return {
    totalLuot: rows.length,
    soNguoi: people.length,
    people,
    docs
  };
}


/** Toàn bộ người trong sổ đăng ký (trang quản lý). */
export async function getRegisteredReaders() {
  const snap = await firestore.collection(REGISTRY).get();
  return snap.docs.map((d) => ({ id: d.id, ...d.data() }));
}

/**
 * Gom theo chi bộ để hiện "chi bộ nào có ai đăng ký": theo thứ tự trong Google Sheet, chi bộ chưa có ai
 * vẫn hiện (0 người). Người thuộc chi bộ không còn trong Sheet được xếp vào nhóm riêng ở cuối.
 * peopleStats = stats.people (số tài liệu đã đọc trong tháng đang xem), ghép theo chiBoId + tên.
 */
export function buildRoster(chiBoList, readers, peopleStats = []) {
  const reads = new Map(peopleStats.map((p) => [`${p.chiBoId}|${p.name}`, { soTaiLieu: p.soTaiLieu, soLan: p.soLan }]));
  const groups = new Map(chiBoList.map((cb) => [cb.id, { id: cb.id, name: cb.name, members: [] }]));

  for (const r of readers) {
    if (!groups.has(r.chiBoId)) {
      groups.set(r.chiBoId, { id: r.chiBoId, name: `${r.chiBoName || r.chiBoId} (không còn trong danh sách chi bộ)`, members: [] });
    }
    groups.get(r.chiBoId).members.push({
      name: r.name,
      chiBoId: r.chiBoId,
      createdAt: r.createdAt || "",
      soTaiLieu: (reads.get(`${r.chiBoId}|${r.name}`) || {}).soTaiLieu || 0,
      soLan: (reads.get(`${r.chiBoId}|${r.name}`) || {}).soLan || 0
    });
  }

  const list = [...groups.values()];
  list.forEach((g) => g.members.sort((a, b) => a.name.localeCompare(b.name, "vi")));
  return list;
}

/**
 * Xoá 1 người: khỏi sổ đăng ký + xoá toàn bộ lượt đọc của họ (collection doc_reads, khớp chi bộ + tên)
 * + đánh dấu "đã xoá" để cookie còn trên máy họ không tiếp tục ghi lượt đọc dưới tên cũ.
 * Họ vẫn đăng ký lại được bình thường (popup sẽ hỏi lại).
 */
export async function deleteReader({ chiBoId, name }) {
  const cleanChiBoId = String(chiBoId || "").trim();
  const cleanName = String(name || "").trim();
  if (!cleanChiBoId || !cleanName) throw new Error("Thiếu chi bộ hoặc tên");

  const rid = makeReaderId(cleanChiBoId, cleanName);
  await firestore.collection(REGISTRY).doc(rid).delete();

  const next = new Set(deletedIds);
  next.add(rid);
  await saveDeletedIds(next);

  const snap = await firestore
    .collection("doc_reads")
    .where("chiBoId", "==", cleanChiBoId)
    .where("name", "==", cleanName)
    .get();
  let xoaLuot = 0;
  for (let i = 0; i < snap.docs.length; i += 400) {
    const batch = firestore.batch();
    snap.docs.slice(i, i + 400).forEach((d) => batch.delete(d.ref));
    await batch.commit();
    xoaLuot += Math.min(400, snap.docs.length - i);
  }
  return { rid, xoaLuot };
}

/**
 * Các văn bản MỘT người đã đọc (trang "Khu vực của tôi" - /toi).
 * Gộp theo tên văn bản: số lần được tính + ngày đọc gần nhất. Mới đọc xếp trên.
 */
export async function getMyReads(identity) {
  const snap = await firestore
    .collection("doc_reads")
    .where("chiBoId", "==", identity.chiBoId)
    .where("name", "==", identity.name)
    .get();

  const byDoc = new Map();
  for (const d of snap.docs) {
    const r = d.data();
    const cur = byDoc.get(r.docName) || { docName: r.docName, soLan: 0, lanCuoi: "" };
    cur.soLan += 1;
    if ((r.createdAt || "") > cur.lanCuoi) cur.lanCuoi = r.createdAt || "";
    byDoc.set(r.docName, cur);
  }
  return [...byDoc.values()].sort((a, b) => b.lanCuoi.localeCompare(a.lanCuoi));
}


// ====================== BÁO CÁO THEO CHI BỘ (để copy gửi các đơn vị) ======================
function fmtThang(thang) {
  const [y, m] = String(thang || "").split("-");
  return y && m ? `${m}/${y}` : String(thang || "");
}

function homNay() {
  return new Intl.DateTimeFormat("vi-VN", {
    timeZone: "Asia/Ho_Chi_Minh", day: "2-digit", month: "2-digit", year: "numeric"
  }).format(new Date());
}

/**
 * Dựng số liệu + văn bản "dán được" cho từng chi bộ và cho cả xã.
 *   roster : kết quả buildRoster(...)  (mỗi thành viên có name, soLan, soTaiLieu)
 *   thang  : "2026-10"
 *   chiBoId: nếu đang lọc 1 chi bộ thì chỉ dựng chi bộ đó (và đánh dấu partial = true)
 */
export function buildChiBoReport(roster, thang, chiBoId = "") {
  const label = fmtThang(thang);
  const ngay = homNay();
  const list = (roster || []).filter((g) => !chiBoId || g.id === chiBoId);

  const groups = list.map((g) => {
    const members = g.members || [];
    const daDoc = members.filter((m) => m.soLan > 0).sort((a, b) => b.soLan - a.soLan || a.name.localeCompare(b.name, "vi"));
    const chuaDoc = members.filter((m) => m.soLan === 0);
    const dangKy = members.length;
    const luot = members.reduce((n, m) => n + m.soLan, 0);
    const pct = dangKy ? Math.round((daDoc.length * 100) / dangKy) : 0;

    const textXungDanh = [
      `${g.name} — số người xưng danh: ${dangKy}`,
      ...(dangKy ? members.map((m, i) => `${i + 1}. ${m.name}`) : ["(chưa có ai xưng danh)"])
    ].join("\n");

    const textDoc = [
      `${g.name} — tình hình đọc tài liệu tháng ${label}`,
      `Đã đọc: ${daDoc.length}/${dangKy} người (${pct}%) — tổng ${luot} lượt đọc`,
      ...daDoc.map((m, i) => `${i + 1}. ${m.name} — ${m.soLan} lượt, ${m.soTaiLieu} tài liệu`),
      ...(chuaDoc.length ? [`Chưa đọc (${chuaDoc.length}): ${chuaDoc.map((m) => m.name).join(", ")}`] : [])
    ].join("\n");

    return { id: g.id, name: g.name, dangKy, daDoc, chuaDoc, soDaDoc: daDoc.length, luot, pct, members, textXungDanh, textDoc };
  });

  const tongDangKy = groups.reduce((n, g) => n + g.dangKy, 0);
  const tongDaDoc = groups.reduce((n, g) => n + g.soDaDoc, 0);
  const tongLuot = groups.reduce((n, g) => n + g.luot, 0);
  const tongPct = tongDangKy ? Math.round((tongDaDoc * 100) / tongDangKy) : 0;

  const textXungDanhAll = [
    "THỐNG KÊ XƯNG DANH — TOÀN XÃ XUÂN GIANG",
    `Cập nhật: ${ngay}`,
    `Tổng: ${tongDangKy} người xưng danh / ${groups.length} chi bộ`,
    "",
    ...groups.map((g, i) =>
      [`${i + 1}. ${g.name}: ${g.dangKy} người`, ...(g.dangKy ? g.members.map((m) => `   - ${m.name}`) : ["   (chưa có ai xưng danh)"])].join("\n")
    )
  ].join("\n");

  const textDocAll = [
    `THỐNG KÊ ĐỌC TÀI LIỆU THÁNG ${label} — TOÀN XÃ XUÂN GIANG`,
    `Cập nhật: ${ngay}`,
    `Đã xưng danh: ${tongDangKy} người | Đã đọc: ${tongDaDoc} người (${tongPct}%) | Tổng lượt đọc: ${tongLuot}`,
    "",
    ...groups.map((g, i) =>
      [
        `${i + 1}. ${g.name}: đã đọc ${g.soDaDoc}/${g.dangKy} người (${g.pct}%), ${g.luot} lượt`,
        ...g.daDoc.map((m) => `   - ${m.name}: ${m.soLan} lượt, ${m.soTaiLieu} tài liệu`),
        ...(g.chuaDoc.length ? [`   Chưa đọc: ${g.chuaDoc.map((m) => m.name).join(", ")}`] : [])
      ].join("\n")
    )
  ].join("\n");

  const copy = { "xd:all": textXungDanhAll, "doc:all": textDocAll };
  groups.forEach((g) => { copy["xd:" + g.id] = g.textXungDanh; copy["doc:" + g.id] = g.textDoc; });

  return {
    label, ngay, partial: Boolean(chiBoId), groups, copy,
    tong: { dangKy: tongDangKy, daDoc: tongDaDoc, luot: tongLuot, pct: tongPct, soChiBo: groups.length }
  };
}

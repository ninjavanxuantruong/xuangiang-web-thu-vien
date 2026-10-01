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

/** Đọc thông tin "xưng danh" đã lưu (null nếu chưa từng xưng danh). */
export function getIdentity(req) {
  const data = readCookie(req, IDENTITY_COOKIE);
  if (!data || !data.name || !data.chiBoId) return null;
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
  return true;
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
      byPerson.set(pKey, { name: r.name, chiBoName: r.chiBoName, chiBoId: r.chiBoId, docs: new Set() });
    }
    byPerson.get(pKey).docs.add(r.docName);

    byDoc.set(r.docName, (byDoc.get(r.docName) || 0) + 1);
  }

  const people = [...byPerson.values()]
    .map((p) => ({ name: p.name, chiBoName: p.chiBoName, chiBoId: p.chiBoId, soTaiLieu: p.docs.size }))
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

// =====================================================================
// KHẢO SÁT / KIỂM TRA NHẬN THỨC (theo HD 16-HD/BTGTW và CV Tỉnh ủy)
//
// KHAOSAT_SHEET_URL = link CSV của SHEET DANH MỤC (giống mục dư luận), mỗi dòng 1 bài:
//     A = Tên khảo sát | B = Link CSV đã công bố của sheet câu hỏi | C = % đúng để đạt (vd 70)
//     D = Số câu tối đa mỗi lượt (vd 10; trống/0/≥ tổng = làm cả bộ, đúng thứ tự)
//     E = Điểm câu sửa (%) khi "Tiếp tục làm" (tuỳ chọn, mặc định 50)
//   - Nhiều dòng = nhiều bài mở cùng lúc. Xoá dòng = ẩn bài (kết quả vẫn xem được ở trang quản lý).
//   - Bài nhận diện theo TÊN: đổi tên = mở đợt mới.
//   - (Tương thích bản cũ: nếu link trỏ thẳng vào sheet câu hỏi thì coi như 1 bài,
//     đọc "Tiêu đề / Ngưỡng đạt (%) / Số câu mỗi lượt" ở đầu sheet câu hỏi.)
//
// Sheet câu hỏi, đọc THEO VỊ TRÍ CỘT:
//     A = Câu hỏi | B..E = phương án A..D (D có thể trống) | F = Đáp án đúng | G = Gợi ý (tuỳ chọn)
//
// Chấm điểm (CHỈ ở máy chủ, trình duyệt không có đáp án):
//   - Lần nộp đầu của 1 bài làm: mỗi câu đúng 1 điểm; câu bỏ trống = sai.
//   - "Tiếp tục làm": câu sai được bôi đỏ; câu đã đúng giữ nguyên. Câu sửa đúng ở lượt tiếp
//     chỉ được tính <Điểm câu sửa>% (mặc định 0,5 điểm) -> không bao giờ bằng người đúng ngay từ đầu.
//   - "Làm lại hoàn toàn": bài làm mới. Làm nhiều lần thì GIỮ ĐIỂM CAO NHẤT (lần sau thấp hơn không ghi đè).
//   - Trang quản lý ghi thêm "điểm lần đầu" (lần nộp đầu tiên của người đó) để tham khảo.
//
// Đề (danh sách câu) được ký HMAC và gửi kèm trang: máy chủ chỉ chấm đúng các câu trong đề.
//
// Firestore: collection "khao_sat_ket_qua", mỗi người x mỗi bài 1 tài liệu, id = <dot>__<readerId>
// =====================================================================

import crypto from "crypto";
import { firestore } from "./firebase.js";
import { fetchSheetRaw } from "./sheets.js";
import { csrfCheck } from "./csrf.js";
import { requireAdmin } from "./adminAuth.js";
import { getIdentity, makeReaderId, getChiBoListCached, resolveChiBo, chiBoAliases } from "./nguoiDoc.js";
import { layDanhSachDangVien, thanhVienChiBo, timUngVien, chuanHoaTen } from "./dangVien.js";

const COLL = "khao_sat_ket_qua";
const TIEU_DE_MAC_DINH = "Kiểm tra nhận thức";
const NGUONG_MAC_DINH = 70;
const HE_SO_SUA_MAC_DINH = 50; // % điểm cho câu sửa đúng khi "Tiếp tục làm"
const LICH_SU_TOI_DA = 30;
const GIOI_HAN_MOI_GIO = 600; // số lần nộp / tra cứu mỗi IP mỗi giờ (cả hội trường chung 1 Wi-Fi = 1 IP)
const STATS_TTL_MS = 60 * 1000;
const DE_HET_HAN_MS = 12 * 60 * 60 * 1000; // đề đã bốc dùng được trong 12 giờ

// Khoá ký đề: dùng SESSION_SECRET sẵn có; thiếu thì sinh tạm (khởi động lại app -> đề đang làm phải tải lại)
const KHOA_KY = process.env.KHAOSAT_SECRET || process.env.SESSION_SECRET || crypto.randomBytes(32).toString("hex");

// ====================== TIỆN ÍCH ======================
const clean = (s, max) => String(s || "").replace(/\s+/g, " ").trim().slice(0, max);
const lam2 = (x) => Math.round(x * 100) / 100;

function sha1(s) {
  return crypto.createHash("sha1").update(String(s)).digest("hex");
}

function slug(text) {
  return String(text || "")
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .replace(/đ/gi, "d")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
}

function makeDotKey(ten) {
  return `${slug(ten).slice(0, 50).replace(/-+$/, "") || "khao-sat"}-${sha1(ten).slice(0, 8)}`;
}

function vnTime(iso) {
  if (!iso) return "";
  try {
    return new Intl.DateTimeFormat("vi-VN", {
      timeZone: "Asia/Ho_Chi_Minh",
      day: "2-digit", month: "2-digit", year: "numeric", hour: "2-digit", minute: "2-digit"
    }).format(new Date(iso));
  } catch {
    return iso;
  }
}

/** 37.5 -> "37,5" */
function so(x) {
  return x === "" || x == null ? "" : String(lam2(Number(x))).replace(".", ",");
}

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
  res.setHeader("Content-Type", "text/csv; charset=utf-8");
  res.setHeader("Content-Disposition", `attachment; filename="${filename}"`);
  res.send("﻿" + toCsv(rows));
}

const nhatKyIp = new Map(); // ip -> { n, resetAt }
function duocPhep(ip) {
  const now = Date.now();
  if (nhatKyIp.size > 3000) for (const [k, v] of nhatKyIp) if (v.resetAt <= now) nhatKyIp.delete(k);
  const cur = nhatKyIp.get(ip);
  if (!cur || cur.resetAt <= now) {
    nhatKyIp.set(ip, { n: 1, resetAt: now + 60 * 60 * 1000 });
    return true;
  }
  cur.n += 1;
  return cur.n <= GIOI_HAN_MOI_GIO;
}

function cungTrang(req) {
  const site = req.headers["sec-fetch-site"];
  return !site || site === "same-origin" || site === "none";
}

// ---- Bốc đề + ký đề ----
function bocNgauNhien(list, n) {
  const a = list.slice();
  for (let i = a.length - 1; i > 0; i--) {
    const j = crypto.randomInt(i + 1);
    [a[i], a[j]] = [a[j], a[i]];
  }
  return n > 0 && n < a.length ? a.slice(0, n) : a;
}

function kyDe(dot, ids) {
  const body = Buffer.from(JSON.stringify({ d: dot, q: ids, t: Date.now(), r: crypto.randomBytes(6).toString("hex") })).toString("base64url");
  const sig = crypto.createHmac("sha256", KHOA_KY).update(body).digest("base64url");
  return `${body}.${sig}`;
}

function docDe(token) {
  const [body, sig] = String(token || "").split(".");
  if (!body || !sig) return null;
  const dung = crypto.createHmac("sha256", KHOA_KY).update(body).digest("base64url");
  if (sig.length !== dung.length || !crypto.timingSafeEqual(Buffer.from(sig), Buffer.from(dung))) return null;
  try {
    const de = JSON.parse(Buffer.from(body, "base64url").toString());
    if (!Array.isArray(de.q) || !de.q.length || Date.now() - de.t > DE_HET_HAN_MS) return null;
    return { ...de, sig: sig.slice(0, 32) };
  } catch {
    return null;
  }
}

/** Số điểm cần để đạt (tránh lỗi số thực: 70% x 10 = 7, không phải 8). */
function diemCanDat(nguong, tong) {
  return Math.ceil((nguong * tong) / 100 - 1e-9);
}

// ====================== ĐỌC SHEET ======================
const PHUONG_AN = ["A", "B", "C", "D"];
const laLink = (s) => /^https?:\/\//i.test(String(s || "").trim());

function boTienTo(text, re) {
  return String(text || "").replace(re, "").trim();
}

function docSo(s) {
  const n = parseFloat(String(s ?? "").replace(",", ".").replace(/[^\d.]/g, ""));
  return Number.isFinite(n) ? n : NaN;
}

function docDapAn(cell, options) {
  const raw = String(cell || "").trim();
  if (!raw) return "";
  const m = raw.normalize("NFD").replace(/[̀-ͯ]/g, "").match(/(?:^|dap an\s*:?\s*)([abcd])(?![a-z])/i);
  if (m) return m[1].toUpperCase();
  const hit = options.find((o) => chuanHoaTen(o.t) === chuanHoaTen(raw));
  return hit ? hit.k : "";
}

/** Đọc các dòng của 1 sheet câu hỏi -> { cauHoi, canhBao, cauHinh (dòng cấu hình kiểu cũ) } */
function docCauHoi(rows) {
  const cauHoi = [];
  const canhBao = [];
  const cauHinh = {};

  rows.forEach((row, i) => {
    const v = row.map((x) => (x == null ? "" : String(x).trim()));
    const dau = chuanHoaTen(v[0]);
    const soDong = i + 1;

    if (dau.startsWith("tieu de")) return void (cauHinh.tieuDe = clean(v[1], 300));
    if (dau.startsWith("nguong dat")) return void (cauHinh.nguong = docSo(v[1]));
    if (dau.startsWith("so cau moi luot") || dau.startsWith("so cau toi da")) return void (cauHinh.soCau = docSo(v[1]));
    if (dau === "cau hoi" || dau === "noi dung cau hoi") return; // dòng tiêu đề cột

    const q = boTienTo(v[0], /^c[aâ]u\s*\d+\s*[.:)]\s*/i);
    if (!q) return;
    const opts = PHUONG_AN.map((k, j) => ({ k, t: boTienTo(v[j + 1], /^[A-Da-d]\s*[.:)]\s+/) })).filter((o) => o.t);
    const dapAn = docDapAn(v[5], opts);

    if (opts.length < 2) {
      canhBao.push(`Dòng ${soDong} (“${q.slice(0, 50)}…”): có dưới 2 phương án — đã bỏ qua.`);
      return;
    }
    if (!dapAn || !opts.some((o) => o.k === dapAn)) {
      canhBao.push(`Dòng ${soDong} (“${q.slice(0, 50)}…”): đáp án đúng “${v[5] || "(trống)"}” không hợp lệ — đã bỏ qua.`);
      return;
    }
    let goiY = clean(v[6], 2000);
    if (goiY && /^(đáp án|dap an)?\s*[:\-]?\s*[ABCD]\s*[.)]?$/i.test(goiY)) {
      canhBao.push(`Dòng ${soDong}: cột Gợi ý chỉ ghi chữ đáp án — đã ẩn gợi ý này (gợi ý không được nêu đáp án).`);
      goiY = "";
    }
    cauHoi.push({ id: sha1(q + "|" + opts.map((o) => o.t).join("|")).slice(0, 12), q, opts, dapAn, goiY });
  });

  cauHoi.forEach((c, i) => (c.so = i + 1));
  return { cauHoi, canhBao, cauHinh };
}

function taoBai({ ten, link, nguong, soCau, heSo, cauHoi, canhBao }) {
  const n = Number.isFinite(nguong) && nguong > 0 && nguong <= 100 ? nguong : NGUONG_MAC_DINH;
  const h = Number.isFinite(heSo) && heSo >= 0 ? Math.min(heSo, 99) : HE_SO_SUA_MAC_DINH;
  const sc = Number.isFinite(soCau) && soCau > 0 && soCau < cauHoi.length ? Math.floor(soCau) : 0;
  return { ten, dot: makeDotKey(ten), link, nguong: n, soCauMoiLuot: sc, heSoSua: h / 100, cauHoi, canhBao };
}

/**
 * Đọc sheet danh mục -> mảng bài khảo sát (kể cả bài lỗi/không có câu hỏi, để trang quản lý báo).
 * Mỗi bài: { ten, dot, link, nguong, soCauMoiLuot, heSoSua, cauHoi:[...], canhBao:[...] }
 */
export async function layDanhMuc() {
  const url = process.env.KHAOSAT_SHEET_URL;
  if (!url) return [];
  const rows = await fetchSheetRaw(url);
  const laDanhMuc = rows.some((r) => laLink(r[1]));

  // Tương thích bản cũ: link trỏ thẳng vào sheet câu hỏi
  if (!laDanhMuc) {
    const { cauHoi, canhBao, cauHinh } = docCauHoi(rows);
    if (!cauHoi.length) return [];
    return [taoBai({ ten: cauHinh.tieuDe || TIEU_DE_MAC_DINH, link: url, nguong: cauHinh.nguong, soCau: cauHinh.soCau, heSo: NaN, cauHoi, canhBao })];
  }

  const dong = rows
    .map((r) => r.map((x) => (x == null ? "" : String(x).trim())))
    .filter((v) => v[0] && laLink(v[1]));

  const daCo = new Set();
  const out = [];
  for (const v of dong) {
    const ten = clean(v[0], 300);
    if (daCo.has(ten)) continue; // trùng tên -> lấy dòng đầu
    daCo.add(ten);
    let cauHoi = [];
    let canhBao = [];
    try {
      ({ cauHoi, canhBao } = docCauHoi(await fetchSheetRaw(v[1])));
      if (!cauHoi.length) canhBao.unshift("Không đọc được câu hỏi nào — kiểm tra link (phải là link CSV đã công bố, đúng tab câu hỏi).");
    } catch (err) {
      canhBao = [`Không tải được sheet câu hỏi: ${err.message}`];
    }
    out.push(taoBai({ ten, link: v[1], nguong: docSo(v[2]), soCau: docSo(v[3]), heSo: v[4] === "" ? NaN : docSo(v[4]), cauHoi, canhBao }));
  }
  return out;
}

async function danhMucMo() {
  return (await layDanhMuc()).filter((b) => b.cauHoi.length);
}

/** Có ít nhất 1 bài khảo sát đang mở hay không (dùng để ẩn/hiện mục Khảo sát). */
export async function coKhaoSat() {
  try {
    return (await danhMucMo()).length > 0;
  } catch {
    return false;
  }
}

/** Middleware: đặt res.locals.coKhaoSat cho mọi view (đặt sau identityGuard). */
export async function khaoSatLocals(req, res, next) {
  if (req.method === "GET" && !req.path.startsWith("/public/")) {
    res.locals.coKhaoSat = await coKhaoSat();
  }
  next();
}

// ====================== ĐỐI CHIẾU NGƯỜI LÀM ======================
async function timChiBo(chiBoId) {
  const list = await getChiBoListCached();
  const moi = resolveChiBo(chiBoId);
  const id = moi ? moi.id : chiBoId;
  return list.find((c) => c.id === id) || null;
}

/** Trả { name, mid, daDoiChieu } hoặc { hoi: [ứng viên] } khi cần người dùng xác nhận. */
async function doiChieuTen({ name, chiBo, mid, giuTen }) {
  const roster = await layDanhSachDangVien();
  if (!roster) return { name, mid: "", daDoiChieu: false };

  const r = timUngVien(roster, name, chiBo.name, chiBo.id, chiBoAliases(chiBo.id));
  if (!r.trongDanhSach) return { name, mid: "", daDoiChieu: false };
  if (r.exact) return { name: r.exact.name, mid: r.exact.mid, daDoiChieu: true };

  if (mid) {
    const chon = r.candidates.find((m) => m.mid === mid);
    if (chon) return { name: chon.name, mid: chon.mid, daDoiChieu: true };
  }
  if (r.candidates.length === 1 && r.candidates[0].norm === chuanHoaTen(name)) {
    return { name: r.candidates[0].name, mid: r.candidates[0].mid, daDoiChieu: true };
  }
  if (!giuTen && r.candidates.length) {
    return { hoi: r.candidates.map((m) => ({ mid: m.mid, name: m.name })) };
  }
  return { name, mid: "", daDoiChieu: false };
}

function ghiChuMay(identity, name, chiBoId) {
  if (!identity) return "";
  const cungNguoi = identity.chiBoId === chiBoId && chuanHoaTen(identity.name) === chuanHoaTen(name);
  return cungNguoi ? "" : `Nộp từ máy của ${identity.name} (${identity.chiBoName || identity.chiBoId})`;
}

// ====================== THỐNG KÊ ======================
let statsCache = { key: "", at: 0, data: null };

async function danhSachDotDaLuu() {
  const out = new Map();
  const snap = await firestore.collection(COLL).select("dot", "tenDot").get();
  snap.forEach((d) => {
    const x = d.data();
    if (x.dot && !out.has(x.dot)) out.set(x.dot, x.tenDot || x.dot);
  });
  return out; // dot -> tên
}

/**
 * Tổng hợp theo chi bộ cho 1 bài.
 * Mỗi chi bộ: { id, name, tong, daLam, dat, chuaDat, chuaLam, tyLeDat, nguoi:[...], ngoaiDanhSach:[...] }
 */
export async function thongKeDot(dot) {
  if (statsCache.key === dot && Date.now() - statsCache.at < STATS_TTL_MS) return statsCache.data;

  const [snap, chiBoList, roster] = await Promise.all([
    firestore.collection(COLL).where("dot", "==", dot).get(),
    getChiBoListCached(),
    layDanhSachDangVien()
  ]);

  const ketQua = snap.docs.map((d) => ({ id: d.id, ...d.data() }));
  const theoChiBo = new Map();
  for (const k of ketQua) {
    const moi = resolveChiBo(k.chiBoId);
    const id = moi ? moi.id : k.chiBoId;
    if (!theoChiBo.has(id)) theoChiBo.set(id, []);
    theoChiBo.get(id).push(k);
  }

  const dong = (k) => ({
    docId: k.id,
    name: k.name,
    chucVu: k.chucVu || "",
    trangThai: k.dat ? "dat" : "chua-dat",
    diem: k.diem ?? k.diemCaoNhat, // bản cũ lưu diemCaoNhat
    tong: k.tong,
    phanTram: k.phanTram ?? k.phanTramCaoNhat,
    diemLanDau: k.diemLanDau ?? "",
    tongLanDau: k.tongLanDau ?? "",
    soLan: k.soLan,
    lucDat: k.lucDat || "",
    lanCuoi: k.lanCuoi || "",
    ghiChu: (k.ghiChuMay || []).join("; ")
  });
  const chuaLamRow = (m) => ({ docId: "", name: m.name, chucVu: m.chucVu, trangThai: "chua-lam", diem: "", tong: "", phanTram: "", diemLanDau: "", tongLanDau: "", soLan: 0, lucDat: "", lanCuoi: "", ghiChu: "" });

  const chiBoOut = [];
  const daXuLy = new Set();

  for (const cb of chiBoList) {
    const kq = theoChiBo.get(cb.id) || [];
    daXuLy.add(cb.id);
    const thanhVien = roster ? thanhVienChiBo(roster, cb.name, cb.id) : null;

    const nguoi = [];
    const ngoaiDanhSach = [];
    const daGhep = new Set();

    if (thanhVien) {
      for (const m of thanhVien) {
        const k = kq.find((x) => !daGhep.has(x.id) && ((x.mid && x.mid === m.mid) || chuanHoaTen(x.name) === m.norm));
        if (k) {
          daGhep.add(k.id);
          nguoi.push({ ...dong(k), name: m.name, chucVu: m.chucVu });
        } else {
          nguoi.push(chuaLamRow(m));
        }
      }
    }
    for (const k of kq) if (!daGhep.has(k.id)) (thanhVien ? ngoaiDanhSach : nguoi).push(dong(k));

    const tong = thanhVien ? thanhVien.length : cb.soDangVien || 0;
    const daLam = nguoi.filter((n) => n.trangThai !== "chua-lam").length + ngoaiDanhSach.length;
    const dat = [...nguoi, ...ngoaiDanhSach].filter((n) => n.trangThai === "dat").length;
    const chuaLam = thanhVien ? nguoi.filter((n) => n.trangThai === "chua-lam").length : Math.max(0, tong - daLam);

    chiBoOut.push({
      id: cb.id,
      name: cb.name,
      coDanhSach: Boolean(thanhVien),
      tong,
      daLam,
      dat,
      chuaDat: daLam - dat,
      chuaLam,
      tyLeDat: tong ? Math.round((dat / tong) * 100) : null,
      nguoi,
      ngoaiDanhSach
    });
  }

  const khac = [];
  for (const [id, kq] of theoChiBo) if (!daXuLy.has(id)) kq.forEach((k) => khac.push({ ...dong(k), ghiChu: [`Chi bộ: ${k.chiBoName}`, dong(k).ghiChu].filter(Boolean).join("; ") }));
  if (khac.length) {
    const dat = khac.filter((n) => n.trangThai === "dat").length;
    chiBoOut.push({ id: "_khac", name: "Khác (chi bộ không có trong danh sách)", coDanhSach: false, tong: 0, daLam: khac.length, dat, chuaDat: khac.length - dat, chuaLam: 0, tyLeDat: null, nguoi: khac, ngoaiDanhSach: [] });
  }

  const thuTu = { "chua-lam": 0, "chua-dat": 1, dat: 2 };
  for (const cb of chiBoOut) cb.nguoi.sort((a, b) => thuTu[a.trangThai] - thuTu[b.trangThai] || a.name.localeCompare(b.name, "vi"));
  chiBoOut.sort((a, b) => (a.tyLeDat ?? 101) - (b.tyLeDat ?? 101) || b.chuaLam - a.chuaLam);

  const tongHop = chiBoOut.reduce(
    (s, c) => ({ tong: s.tong + c.tong, daLam: s.daLam + c.daLam, dat: s.dat + c.dat, chuaDat: s.chuaDat + c.chuaDat, chuaLam: s.chuaLam + c.chuaLam }),
    { tong: 0, daLam: 0, dat: 0, chuaDat: 0, chuaLam: 0 }
  );
  tongHop.tyLeDat = tongHop.tong ? Math.round((tongHop.dat / tongHop.tong) * 100) : null;

  const data = { chiBo: chiBoOut, tongHop, coDanhSachDangVien: Boolean(roster) };
  statsCache = { key: dot, at: Date.now(), data };
  return data;
}

// ====================== ROUTES ======================
export function registerKhaoSatRoutes(app) {
  // ---- Danh sách bài (1 bài thì vào thẳng) ----
  app.get("/khao-sat", async (req, res) => {
    try {
      const ds = await danhMucMo();
      if (!ds.length) return res.redirect("/");
      if (ds.length === 1) return res.redirect(`/khao-sat/${ds[0].dot}`);
      res.render("khao-sat-ds", {
        ds: ds.map((b) => ({
          ten: b.ten,
          dot: b.dot,
          soCau: b.soCauMoiLuot || b.cauHoi.length,
          nguong: b.nguong
        }))
      });
    } catch (err) {
      console.error("GET /khao-sat lỗi:", err);
      res.status(500).send("Không tải được danh sách khảo sát, vui lòng thử lại sau.");
    }
  });

  // ---- Trang làm bài ----
  app.get("/khao-sat/:dot", async (req, res) => {
    try {
      const ds = await danhMucMo();
      const bai = ds.find((b) => b.dot === req.params.dot);
      if (!bai) return res.redirect("/khao-sat");
      const identity = getIdentity(req);
      const chiBoList = await getChiBoListCached();
      // Làm cả bộ: giữ đúng thứ tự như sheet; chỉ trộn khi bốc ngẫu nhiên N câu
      const de = bai.soCauMoiLuot ? bocNgauNhien(bai.cauHoi, bai.soCauMoiLuot) : bai.cauHoi.slice();
      res.set("Cache-Control", "no-store");
      res.render("khao-sat", {
        tieuDe: bai.ten,
        dot: bai.dot,
        deToken: kyDe(bai.dot, de.map((c) => c.id)),
        nguong: bai.nguong,
        soCanDat: diemCanDat(bai.nguong, de.length),
        heSoSua: Math.round(bai.heSoSua * 100),
        tongNganHang: bai.cauHoi.length,
        ngauNhien: de.length < bai.cauHoi.length,
        nhieuBai: ds.length > 1,
        // KHÔNG gửi đáp án xuống trình duyệt (gợi ý thì có — gợi ý không chứa đáp án)
        cauHoi: de.map((c, i) => ({ id: c.id, so: i + 1, q: c.q, opts: c.opts, goiY: c.goiY })),
        chiBoList: chiBoList.map((c) => ({ id: c.id, name: c.name })),
        identity
      });
    } catch (err) {
      console.error("GET /khao-sat/:dot lỗi:", err);
      res.status(500).send("Không tải được bài khảo sát, vui lòng thử lại sau.");
    }
  });

  // ---- Tra cứu kết quả hiện tại của 1 người (khi đổi tên/chi bộ trên form) ----
  app.post("/khao-sat/trang-thai", csrfCheck, async (req, res) => {
    try {
      if (!cungTrang(req)) return res.status(403).json({ error: "Yêu cầu không hợp lệ" });
      if (!duocPhep(req.ip)) return res.json({ trangThai: "" });
      const name = clean(req.body.name, 100);
      const chiBoId = clean(req.body.chiBoId, 150);
      const dot = clean(req.body.dot, 100);
      if (!name || !chiBoId || !dot) return res.json({ trangThai: "" });

      const snap = await firestore.collection(COLL).doc(`${dot}__${makeReaderId(chiBoId, name)}`).get();
      if (!snap.exists) return res.json({ trangThai: "chua-lam" });
      const d = snap.data();
      res.json({ trangThai: d.dat ? "dat" : "chua-dat", diem: so(d.diem ?? d.diemCaoNhat), tong: d.tong, soLan: d.soLan || 0 });
    } catch (err) {
      console.warn("POST /khao-sat/trang-thai lỗi:", err.message);
      res.json({ trangThai: "" });
    }
  });

  // ---- Nộp bài (lần đầu hoặc "Tiếp tục làm") ----
  app.post("/khao-sat/nop", csrfCheck, async (req, res) => {
    try {
      if (!cungTrang(req)) return res.status(403).json({ error: "Yêu cầu không hợp lệ." });
      if (!duocPhep(req.ip)) return res.status(429).json({ error: "Thao tác quá nhiều lần, vui lòng thử lại sau ít phút." });

      const dot = clean(req.body.dot, 100);
      const bai = (await danhMucMo()).find((b) => b.dot === dot);
      if (!bai) return res.status(410).json({ error: "Bài khảo sát này đã đóng hoặc vừa đổi tên.", taiLai: true });

      let name = clean(req.body.name, 100);
      const chiBoId = clean(req.body.chiBoId, 150);
      if (!name) return res.status(400).json({ error: "Vui lòng nhập họ tên." });
      const chiBo = await timChiBo(chiBoId);
      if (!chiBo) return res.status(400).json({ error: "Vui lòng chọn chi bộ." });

      // Đề đã bốc: phải đúng chữ ký, đúng bài, các câu còn trong sheet
      const deKy = docDe(req.body.de);
      const deMoi = { error: "Đề làm bài đã hết hạn hoặc bộ câu hỏi vừa thay đổi. Bấm Tải lại trang để nhận đề mới.", taiLai: true };
      if (!deKy || deKy.d !== bai.dot) return res.status(409).json(deMoi);
      const theoId = new Map(bai.cauHoi.map((c) => [c.id, c]));
      const deCau = deKy.q.map((id) => theoId.get(id));
      if (deCau.some((c) => !c)) return res.status(409).json(deMoi);

      const traLoi = req.body.traLoi && typeof req.body.traLoi === "object" ? req.body.traLoi : {};
      const dungCau = (c) => String(traLoi[c.id] || "") === c.dapAn;

      // Đối chiếu tên với danh sách đảng viên
      const dc = await doiChieuTen({ name, chiBo, mid: clean(req.body.mid, 60), giuTen: Boolean(req.body.giuTen) });
      if (dc.hoi) return res.status(409).json({ hoiXacNhan: true, ungVien: dc.hoi });
      name = dc.name;

      const tong = deCau.length;
      const canDat = diemCanDat(bai.nguong, tong);
      const luc = new Date().toISOString();
      const ghiChu = ghiChuMay(getIdentity(req), name, chiBo.id);
      const ref = firestore.collection(COLL).doc(`${bai.dot}__${makeReaderId(chiBo.id, name)}`);

      const kq = await firestore.runTransaction(async (tx) => {
        const snap = await tx.get(ref);
        const cu = snap.exists ? snap.data() : null;

        // Cùng đề đã nộp -> "Tiếp tục làm" (câu sửa đúng chỉ được tính 1 phần điểm);
        // đề mới (Làm lại hoàn toàn) -> bài làm mới (kết quả ghi nhận vẫn lấy lần cao nhất)
        const tiepTuc = Boolean(cu && cu.baiLam && cu.baiLam.sig === deKy.sig);
        const diemCau = {};
        let luot = 1;
        if (tiepTuc) {
          luot = (cu.baiLam.luot || 1) + 1;
          for (const c of deCau) {
            const truoc = Number(cu.baiLam.diem?.[c.id]) || 0;
            diemCau[c.id] = truoc > 0 ? truoc : dungCau(c) ? bai.heSoSua : 0;
          }
        } else {
          for (const c of deCau) diemCau[c.id] = dungCau(c) ? 1 : 0;
        }

        const diem = lam2(Object.values(diemCau).reduce((s, x) => s + x, 0));
        const phanTram = lam2((diem / tong) * 100);
        const dat = diem >= canDat - 1e-9;
        const soLan = ((cu && cu.soLan) || 0) + 1;

        const lichSu = [
          ...((cu && cu.lichSu) || []),
          { diem, tong, phanTram, luc, loai: tiepTuc ? `tiếp tục lần ${luot - 1}` : "làm mới", ...(ghiChu ? { ghiChu } : {}) }
        ].slice(-LICH_SU_TOI_DA);
        const ghiChuMayList = [...new Set([...((cu && cu.ghiChuMay) || []), ...(ghiChu ? [ghiChu] : [])])].slice(-5);
        const coLanDau = cu && cu.diemLanDau != null;

        // GIỮ ĐIỂM CAO NHẤT: so theo tỷ lệ % (số câu mỗi lượt có thể khác nhau giữa các lần)
        const cuDiem = cu ? cu.diem ?? cu.diemCaoNhat : null;
        const cuPhanTram = cu ? cu.phanTram ?? cu.phanTramCaoNhat : null;
        const giuCu = cu && cuDiem != null && cuPhanTram > phanTram;
        const ghi = giuCu
          ? { diem: cuDiem, tong: cu.tong, phanTram: cuPhanTram, dat: Boolean(cu.dat), lucDat: cu.lucDat || "" }
          : { diem, tong, phanTram, dat, lucDat: dat ? (cu && cu.dat && cu.lucDat ? cu.lucDat : luc) : "" };

        tx.set(ref, {
          dot: bai.dot,
          tenDot: bai.ten,
          name,
          chiBoId: chiBo.id,
          chiBoName: chiBo.name,
          mid: dc.mid || (cu && cu.mid) || "",
          daDoiChieu: dc.daDoiChieu || Boolean(cu && cu.daDoiChieu),
          nguong: bai.nguong,
          // Kết quả ghi nhận = lần cao nhất
          diem: ghi.diem,
          tong: ghi.tong,
          phanTram: ghi.phanTram,
          dat: ghi.dat,
          lucDat: ghi.lucDat,
          // Lần nộp đầu tiên của người này (không đổi khi làm lại) — để tham khảo mức nhận thức ban đầu
          diemLanDau: coLanDau ? cu.diemLanDau : diem,
          tongLanDau: coLanDau ? cu.tongLanDau : tong,
          soLan,
          lanDau: (cu && cu.lanDau) || luc,
          lanCuoi: luc,
          baiLam: { sig: deKy.sig, diem: diemCau, luot },
          ghiChuMay: ghiChuMayList,
          lichSu
        });
        return { diem, phanTram, dat, diemCau, luot, soLan, tiepTuc, ghi, giuCu };
      });

      statsCache.at = 0;

      const sai = deCau.filter((c) => !kq.diemCau[c.id]).map((c) => c.id);
      const khoa = deCau.filter((c) => kq.diemCau[c.id] > 0).map((c) => c.id);
      res.json({
        ok: true,
        name,
        chiBoName: chiBo.name,
        diem: kq.diem,
        tong,
        phanTram: kq.phanTram,
        dat: kq.dat,
        nguong: bai.nguong,
        soCanDat: canDat,
        heSoSua: Math.round(bai.heSoSua * 100),
        // Điểm cao nhất còn có thể đạt nếu sửa đúng hết câu sai
        toiDaNeuSua: lam2(kq.diem + sai.length * bai.heSoSua),
        sai,
        khoa,
        luot: kq.luot,
        tiepTuc: kq.tiepTuc,
        soLan: kq.soLan,
        // Kết quả đang được ghi nhận (lần cao nhất) — khác lần này khi lần trước cao hơn
        giuCu: kq.giuCu,
        ghiNhan: { diem: kq.ghi.diem, tong: kq.ghi.tong, phanTram: kq.ghi.phanTram, dat: kq.ghi.dat }
      });
    } catch (err) {
      console.error("POST /khao-sat/nop lỗi:", err);
      res.status(500).json({ error: "Lỗi máy chủ, bài chưa được lưu. Vui lòng bấm Nộp bài lại." });
    }
  });

  // ---- Quản lý: thống kê theo chi bộ ----
  app.get("/quanly/khao-sat", requireAdmin, async (req, res) => {
    try {
      const danhMuc = await layDanhMuc().catch(() => []);
      const dots = await danhSachDotDaLuu().catch(() => new Map());
      // Bài đang mở lên đầu danh sách chọn
      const tatCa = new Map();
      for (const b of danhMuc) if (b.cauHoi.length) tatCa.set(b.dot, b.ten);
      for (const [id, ten] of dots) if (!tatCa.has(id)) tatCa.set(id, `${ten} (đã đóng)`);

      const dot = clean(req.query.dot, 100) || [...tatCa.keys()][0] || "";
      const tk = dot ? await thongKeDot(dot) : null;
      res.render("admin-khaosat", {
        coCauHinh: Boolean(process.env.KHAOSAT_SHEET_URL),
        danhMuc: danhMuc.map((b) => ({
          ten: b.ten,
          dot: b.dot,
          soCau: b.cauHoi.length,
          soCauMoiLuot: b.soCauMoiLuot,
          nguong: b.nguong,
          heSoSua: Math.round(b.heSoSua * 100),
          soCoGoiY: b.cauHoi.filter((c) => c.goiY).length,
          canhBao: b.canhBao
        })),
        dots: [...tatCa.entries()].map(([id, ten]) => ({ id, ten })),
        dot,
        tenDot: (tatCa.get(dot) || "").replace(/ \(đã đóng\)$/, ""),
        tk,
        vnTime,
        so
      });
    } catch (err) {
      console.error("GET /quanly/khao-sat lỗi:", err);
      res.status(500).send("Không tải được thống kê khảo sát");
    }
  });

  // ---- Quản lý: xuất danh sách từng người (lọc 1 chi bộ / chỉ người chưa xong) ----
  app.get("/quanly/khao-sat/xuat", requireAdmin, async (req, res) => {
    try {
      const dot = clean(req.query.dot, 100);
      if (!dot) return res.status(400).send("Thiếu bài khảo sát");
      const chiBoId = clean(req.query.chiBo, 150);
      const loc = clean(req.query.loc, 20); // "", "chua-lam", "chua-dat", "chua-xong"
      const tk = await thongKeDot(dot);
      const nhan = { dat: "Đạt", "chua-dat": "Chưa đạt", "chua-lam": "Chưa làm" };

      const rows = [["STT", "Chi bộ", "Họ và tên", "Chức vụ", "Kết quả", "Điểm", "Tổng số câu", "Tỷ lệ (%)", "Điểm lần đầu", "Số lần nộp", "Thời gian đạt", "Lần nộp gần nhất", "Ghi chú"]];
      let stt = 0;
      for (const cb of tk.chiBo) {
        if (chiBoId && cb.id !== chiBoId) continue;
        for (const n of [...cb.nguoi, ...cb.ngoaiDanhSach.map((x) => ({ ...x, ghiChu: ["Không có trong danh sách đảng viên", x.ghiChu].filter(Boolean).join("; ") }))]) {
          if (loc === "chua-lam" && n.trangThai !== "chua-lam") continue;
          if (loc === "chua-dat" && n.trangThai !== "chua-dat") continue;
          if (loc === "chua-xong" && n.trangThai === "dat") continue;
          rows.push([
            ++stt, cb.name, n.name, n.chucVu, nhan[n.trangThai],
            so(n.diem), n.tong, so(n.phanTram),
            n.diemLanDau === "" ? "" : `${so(n.diemLanDau)}/${n.tongLanDau}`,
            n.soLan || "", vnTime(n.lucDat), vnTime(n.lanCuoi), n.ghiChu
          ]);
        }
      }
      sendCsv(res, `khao-sat-danh-sach${chiBoId ? "-" + chiBoId : ""}${loc ? "-" + loc : ""}.csv`, rows);
    } catch (err) {
      console.error("GET /quanly/khao-sat/xuat lỗi:", err);
      res.status(500).send("Không xuất được file");
    }
  });

  // ---- Quản lý: xuất bảng tổng hợp theo chi bộ ----
  app.get("/quanly/khao-sat/xuat-chi-bo", requireAdmin, async (req, res) => {
    try {
      const dot = clean(req.query.dot, 100);
      if (!dot) return res.status(400).send("Thiếu bài khảo sát");
      const tk = await thongKeDot(dot);
      const rows = [["STT", "Chi bộ", "Số đảng viên", "Đã làm", "Đạt", "Chưa đạt", "Chưa làm", "Tỷ lệ đạt (%)"]];
      tk.chiBo.forEach((c, i) => rows.push([i + 1, c.name, c.tong || "", c.daLam, c.dat, c.chuaDat, c.chuaLam, c.tyLeDat ?? ""]));
      const t = tk.tongHop;
      rows.push(["", "TỔNG CỘNG", t.tong, t.daLam, t.dat, t.chuaDat, t.chuaLam, t.tyLeDat ?? ""]);
      sendCsv(res, "khao-sat-tong-hop-chi-bo.csv", rows);
    } catch (err) {
      console.error("GET /quanly/khao-sat/xuat-chi-bo lỗi:", err);
      res.status(500).send("Không xuất được file");
    }
  });

  // ---- Quản lý: xoá 1 kết quả (nộp nhầm tên...) ----
  app.post("/quanly/khao-sat/xoa", requireAdmin, csrfCheck, async (req, res) => {
    const dot = clean(req.body.dot, 100);
    try {
      const id = clean(req.body.id, 300);
      if (id && id.startsWith(dot + "__")) await firestore.collection(COLL).doc(id).delete();
      statsCache.at = 0;
    } catch (err) {
      console.error("POST /quanly/khao-sat/xoa lỗi:", err);
    }
    res.redirect(`/quanly/khao-sat?dot=${encodeURIComponent(dot)}`);
  });
}
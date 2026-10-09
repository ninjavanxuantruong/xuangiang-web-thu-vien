import { firestore } from "./firebase.js";
import { fetchSheetRaw } from "./sheets.js";
import { getIdentity, makeReaderId, registerReader, chiBoAliases, chuyenDiemNguoi } from "./nguoiDoc.js";

// =====================================================================
// ĐỐI CHIẾU TÊN XƯNG DANH VỚI DANH SÁCH ĐẢNG VIÊN
//
// Nguồn: Google Sheet đã "Xuất bản lên web" (CSV), đặt link vào biến môi trường DANGVIEN_SHEET_URL.
// Đọc THEO VỊ TRÍ CỘT:  A = STT đảng bộ | B = STT chi bộ | C = họ tên | D = chi bộ | E = chức vụ
// (dòng tiêu đề tự bị bỏ qua; ô chức vụ trống = "Đảng viên").
//
// Cách dùng:
//  - Người xưng danh gõ tên + chọn chi bộ -> server so với ĐÚNG chi bộ đó (bỏ hoa/thường, dấu, khoảng trắng,
//    chịu được sai 1-2 chữ). Gần giống thì hỏi "có phải đồng chí X - chức vụ không".
//  - Chi bộ không có trong danh sách, hoặc tên không giống ai -> KHÔNG hỏi, đăng ký như thường.
//  - Bấm "Không phải" 2 lần trên cùng 1 máy -> máy đó không bao giờ bị hỏi nữa (cookie xg_vf).
//  - Bấm "Có" -> đổi tên xưng danh thành đúng tên trong danh sách, đánh dấu đã đối chiếu (mid trong
//    cookie xg_id), và gộp các lượt đọc cũ ghi dưới tên gõ sai sang tên đúng. Mọi thiết bị của cùng 1 người
//    đều về cùng 1 tên + chi bộ -> cùng 1 dòng trong sổ đăng ký, lượt đọc cộng dồn.
//  - Người ĐÃ xưng danh từ trước (tên sai) cũng được hỏi 1 lần/phiên khi vào trang.
//
// Gắn vào server.js bằng 1 dòng:  registerDangVienRoutes(app, csrfCheck)
// (thay cho route app.post("/xung-danh") cũ — route cũ phải xoá đi).
// =====================================================================

const IDENTITY_COOKIE = "xg_id";
const REGISTERED_COOKIE = "xg_rg";
const VERIFY_COOKIE = "xg_vf"; // { no: số lần bấm "Không phải", done: đã xét xong }
const COOKIE_MAX_AGE_MS = 365 * 24 * 60 * 60 * 1000;
const REGISTRY = "nguoi_dang_ky";

export const MAX_KHONG_PHAI = 2; // bấm "Không phải" tới số lần này thì thôi, không hỏi nữa (cùng 1 máy)
const NGUONG_GIONG = 0.82; // độ giống tối thiểu (0..1) để coi là "gần và sát"
const TOI_DA_GOI_Y = 3;
const GIOI_HAN_GOI_Y_MOI_GIO = 60; // mỗi IP, chống dò tên người khác

// ---------------------------------------------------------------------
// Cookie (cùng định dạng với nguoiDoc.js: JSON mã hoá trong cookie httpOnly)
// ---------------------------------------------------------------------
function isHttps(req) {
  return Boolean(req.secure || req.headers["x-forwarded-proto"] === "https");
}
function readCookie(req, name) {
  const m = String(req.headers.cookie || "").match(new RegExp(`(?:^|;\\s*)${name}=([^;]*)`));
  if (!m) return null;
  try {
    return JSON.parse(decodeURIComponent(m[1]));
  } catch {
    return null;
  }
}
function writeCookie(res, req, name, value) {
  res.cookie(name, JSON.stringify(value), {
    httpOnly: true,
    sameSite: "lax",
    secure: isHttps(req),
    maxAge: COOKIE_MAX_AGE_MS
  });
}
function docVerify(req) {
  const v = readCookie(req, VERIFY_COOKIE) || {};
  return { no: Number(v.no) || 0, done: Boolean(v.done) };
}

// ---------------------------------------------------------------------
// Chuẩn hoá chữ + so khớp gần đúng
// ---------------------------------------------------------------------
export function boDau(text) {
  return String(text || "")
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/đ/g, "d")
    .replace(/Đ/g, "D");
}

/** "TRỊNH  Đình-Mạch" -> "trinh dinh mach" */
export function chuanHoaTen(text) {
  return boDau(text)
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .trim();
}

/** "CB Thủy Nhai" / "Chi bộ Thủy Nhai" / "Thủy Nhai" -> "thuy nhai" */
export function khoaChiBo(text) {
  return chuanHoaTen(text).replace(/^(chi bo|cb)\s+/, "").trim();
}

function levenshtein(a, b) {
  if (a === b) return 0;
  if (!a.length) return b.length;
  if (!b.length) return a.length;
  let prev = Array.from({ length: b.length + 1 }, (_, j) => j);
  for (let i = 1; i <= a.length; i++) {
    const cur = [i];
    for (let j = 1; j <= b.length; j++) {
      cur[j] = Math.min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
    }
    prev = cur;
  }
  return prev[b.length];
}
function tiLeGiong(a, b) {
  const max = Math.max(a.length, b.length);
  return max === 0 ? 1 : 1 - levenshtein(a, b) / max;
}

/** Độ giống 0..1 giữa tên gõ và tên trong danh sách (đã chuẩn hoá). */
export function diemGiong(typedNorm, officialNorm) {
  if (!typedNorm || !officialNorm) return 0;
  if (typedNorm === officialNorm) return 1;

  const t = typedNorm.split(" ");
  const o = officialNorm.split(" ");

  // 1 chữ duy nhất (vd chỉ gõ "Hưng"): chỉ khớp khi trùng đúng TÊN (chữ cuối)
  if (t.length === 1) return t[0] === o[o.length - 1] ? 0.85 : 0;

  let best = tiLeGiong(typedNorm, officialNorm);

  // Thiếu/thừa chữ đệm (vd "Nguyễn Thị Yến" vs "Nguyễn Thị Hải Yến"): so chữ đầu + chữ cuối
  if (t.length !== o.length && t[t.length - 1] === o[o.length - 1]) {
    const dauCuoi = tiLeGiong(`${t[0]} ${t[t.length - 1]}`, `${o[0]} ${o[o.length - 1]}`);
    best = Math.max(best, dauCuoi * 0.9);
  }
  return best;
}

// ---------------------------------------------------------------------
// Đọc danh sách đảng viên từ Google Sheet
// ---------------------------------------------------------------------
const daCanhBao = { thieuUrl: false };
const chiBoKhongKhop = new Set();
const rosterMemo = new WeakMap(); // mảng hàng (đã cache bởi sheets.js) -> bản đã dựng

function dungDanhSach(rows) {
  const byChiBo = new Map(); // khoaChiBo -> [member]
  const byMid = new Map();

  rows.forEach((row, index) => {
    const v = row.map((x) => (x == null ? "" : String(x).trim()));
    const name = v[2] || "";
    const chiBo = v[3] || "";
    const norm = chuanHoaTen(name);
    if (!name || !chiBo) return;
    if (norm === "ho ten" || norm === "ho va ten") return; // dòng tiêu đề

    let mid = `dv${v[0] || index}`;
    if (byMid.has(mid)) mid = `${mid}-${index}`;
    const member = {
      mid,
      name: name.normalize("NFC"),
      norm,
      chiBo,
      chucVu: v[4] || "Đảng viên"
    };
    byMid.set(mid, member);

    const key = khoaChiBo(chiBo);
    if (!byChiBo.has(key)) byChiBo.set(key, []);
    byChiBo.get(key).push(member);
  });

  return { byChiBo, byMid, total: byMid.size };
}

async function layDanhSach() {
  const url = process.env.DANGVIEN_SHEET_URL;
  if (!url) {
    if (!daCanhBao.thieuUrl) { daCanhBao.thieuUrl = true; console.warn("dangVien.js: CHƯA có biến DANGVIEN_SHEET_URL -> không đối chiếu được (kiểm tra .env / Secrets trên Replit/Render)"); }
    return null;
  }
  try {
    const rows = await fetchSheetRaw(url);
    if (!rows || !rows.length) {
      console.warn("dangVien.js: tải sheet đảng viên được nhưng rỗng - kiểm tra link CSV đã 'Xuất bản lên web' đúng tab chưa");
      return null;
    }
    if (!rosterMemo.has(rows)) {
      const r = dungDanhSach(rows);
      rosterMemo.set(rows, r);
      console.log(`dangVien.js: đã nạp ${r.total} đảng viên, ${r.byChiBo.size} chi bộ: ${[...r.byChiBo.keys()].join(" | ")}`);
    }
    const roster = rosterMemo.get(rows);
    if (!roster.total) console.warn("dangVien.js: đọc được sheet nhưng 0 đảng viên - cột C (họ tên) và D (chi bộ) phải có dữ liệu");
    return roster.total ? roster : null;
  } catch (err) {
    console.warn("dangVien.js: không đọc được danh sách đảng viên -", err.message);
    return null;
  }
}
/** Cho diem.js: toàn bộ danh sách đảng viên (null nếu chưa cấu hình / đọc lỗi). */
export async function layDanhSachDangVien() {
  return layDanhSach();
}

/** Cho diem.js: các đảng viên (theo sheet) của 1 chi bộ; null nếu chi bộ không có trong sheet đảng viên. */
export function thanhVienChiBo(roster, chiBoName, chiBoId) {
  if (!roster) return null;
  const keyA = khoaChiBo(chiBoName);
  const keyB = khoaChiBo(String(chiBoId || "").replace(/-/g, " "));
  return (
    roster.byChiBo.get(keyA) ||
    (keyB && roster.byChiBo.get(keyB)) ||
    chiBoAliases(chiBoId).map((t) => roster.byChiBo.get(khoaChiBo(t))).find(Boolean) ||
    null
  );
}

const congKhai = (m) => ({ mid: m.mid, name: m.name, vai: m.chucVu, chiBo: m.chiBo });

/**
 * Tìm đảng viên giống tên gõ trong ĐÚNG chi bộ đã chọn.
 * Trả { trongDanhSach, exact, candidates }:
 *  - trongDanhSach: false nếu chi bộ này không có trong danh sách đảng viên (-> không hỏi gì cả)
 *  - exact: đảng viên có tên TRÙNG KHỚP TUYỆT ĐỐI với tên gõ (khỏi cần hỏi, tự gắn luôn)
 *  - candidates: các đảng viên gần giống (tối đa 3) để hỏi lại
 */
export function timUngVien(roster, typedName, chiBoName, chiBoId, tenCu = []) {
  const keyA = khoaChiBo(chiBoName);
  const keyB = khoaChiBo(String(chiBoId || "").replace(/-/g, " "));
  // tenCu: tên cũ của chi bộ (đã đổi tên trong trang quản lý) - phòng khi cột D sheet đảng viên chưa sửa theo
  const list = roster.byChiBo.get(keyA) || (keyB && roster.byChiBo.get(keyB))
    || tenCu.map((t) => roster.byChiBo.get(khoaChiBo(t))).find(Boolean);
  if (!list) {
    if (!chiBoKhongKhop.has(keyA)) {
      chiBoKhongKhop.add(keyA);
      console.warn(`dangVien.js: chi bộ "${chiBoName}" (id ${chiBoId}) KHÔNG khớp cột D của sheet đảng viên -> không hỏi xác nhận. Các chi bộ trong sheet: ${[...roster.byChiBo.keys()].join(" | ")}`);
    }
    return { trongDanhSach: false, exact: null, candidates: [] };
  }

  const typed = String(typedName || "").trim().normalize("NFC");
  const typedNorm = chuanHoaTen(typed);
  if (!typedNorm) return { trongDanhSach: true, exact: null, candidates: [] };

  const giong = list
    .map((m) => ({ m, score: diemGiong(typedNorm, m.norm) }))
    .filter((x) => x.score >= NGUONG_GIONG)
    .sort((a, b) => b.score - a.score);

  // Trùng tuyệt đối từng chữ, và chỉ có 1 người như vậy -> tự gắn
  const trungHet = giong.filter((x) => x.m.name === typed);
  if (trungHet.length === 1 && giong.filter((x) => x.score === 1).length === 1) {
    return { trongDanhSach: true, exact: trungHet[0].m, candidates: [] };
  }

  // Có người trùng tên sau khi bỏ hoa/dấu -> chỉ hỏi những người đó, không kéo thêm người "gần giống" khác
  const trungChuan = giong.filter((x) => x.score === 1);
  const chon = trungChuan.length ? trungChuan : giong;

  // Quá nhiều người khớp (vd gõ mỗi 1 chữ phổ biến) -> không đoán bừa
  if (chon.length > TOI_DA_GOI_Y && !trungChuan.length) return { trongDanhSach: true, exact: null, candidates: [] };

  return { trongDanhSach: true, exact: null, candidates: chon.slice(0, TOI_DA_GOI_Y).map((x) => x.m) };
}

// ---------------------------------------------------------------------
// Chống dò tên: mỗi IP tối đa N lần gợi ý / giờ
// ---------------------------------------------------------------------
const nhatKyGoiY = new Map(); // ip -> { n, resetAt }
function duocPhepGoiY(ip) {
  const now = Date.now();
  if (nhatKyGoiY.size > 2000) {
    for (const [k, v] of nhatKyGoiY) if (v.resetAt <= now) nhatKyGoiY.delete(k);
  }
  const cur = nhatKyGoiY.get(ip);
  if (!cur || cur.resetAt <= now) {
    nhatKyGoiY.set(ip, { n: 1, resetAt: now + 60 * 60 * 1000 });
    return true;
  }
  cur.n += 1;
  return cur.n <= GIOI_HAN_GOI_Y_MOI_GIO;
}

// ---------------------------------------------------------------------
// Lưu danh tính (đã đối chiếu hoặc không) + gộp dữ liệu cũ
// ---------------------------------------------------------------------
const clean = (s, max) => String(s || "").replace(/\s+/g, " ").trim().slice(0, max);

async function chuyenLuotDoc({ chiBoId, tenCu, tenMoi, chiBoName }) {
  const snap = await firestore.collection("doc_reads").where("chiBoId", "==", chiBoId).where("name", "==", tenCu).get();
  for (let i = 0; i < snap.docs.length; i += 400) {
    const batch = firestore.batch();
    snap.docs.slice(i, i + 400).forEach((d) => batch.update(d.ref, { name: tenMoi, chiBoName }));
    await batch.commit();
  }
  return snap.docs.length;
}

async function luuDanhTinh(req, res, { name, chiBoId, chiBoName, member }) {
  const cu = getIdentity(req);
  const cookie = { name, chiBoId, chiBoName };
  if (member) cookie.mid = member.mid;
  writeCookie(res, req, IDENTITY_COOKIE, cookie);
  const rid = makeReaderId(chiBoId, name);
  writeCookie(res, req, REGISTERED_COOKIE, { rid });

  if (member) {
    const vf = docVerify(req);
    writeCookie(res, req, VERIFY_COOKIE, { no: vf.no, done: true });
  }

  await registerReader({ name, chiBoId, chiBoName }).catch((e) => console.warn("Ghi sổ đăng ký lỗi:", e.message));

  if (member) {
    await firestore
      .collection(REGISTRY)
      .doc(rid)
      .set({ mid: member.mid, chucVu: member.chucVu, daDoiChieu: true }, { merge: true })
      .catch((e) => console.warn("Ghi dấu đối chiếu lỗi:", e.message));

    // Gộp lượt đọc cũ ghi dưới tên gõ sai sang tên đúng (chỉ khi cùng chi bộ trên máy này)
    if (cu && cu.chiBoId === chiBoId && cu.name && cu.name !== name) {
      try {
        await chuyenLuotDoc({ chiBoId, tenCu: cu.name, tenMoi: name, chiBoName });
        await chuyenDiemNguoi({ chiBoId, tenCu: cu.name, tenMoi: name, chiBoName }); // điểm đi theo tên đúng
        const ridCu = makeReaderId(chiBoId, cu.name);
        if (ridCu !== rid) await firestore.collection(REGISTRY).doc(ridCu).delete();
      } catch (err) {
        console.warn("dangVien.js: gộp lượt đọc cũ lỗi (bỏ qua):", err.message);
      }
    }
  }
}

// ---------------------------------------------------------------------
// Các route
// ---------------------------------------------------------------------
export function registerDangVienRoutes(app, csrfCheck) {
  // 1) Trước khi lưu: có đảng viên nào gần giống tên vừa gõ không?
  app.post("/xung-danh/goi-y", csrfCheck, async (req, res) => {
    try {
      const name = clean(req.body.name, 100);
      const chiBoId = clean(req.body.chiBoId, 150);
      const chiBoName = clean(req.body.chiBoName, 150);
      if (!name || !chiBoId) return res.json({ candidates: [] });

      const roster = await layDanhSach();
      if (!roster) return res.json({ candidates: [] });

      const r = timUngVien(roster, name, chiBoName, chiBoId, chiBoAliases(chiBoId));
      console.log(`[goi-y] "${name}" @ "${chiBoName}" -> ${r.exact ? "TRÙNG HẲN (tự gắn, không hỏi)" : r.candidates.length + " gợi ý"}${r.trongDanhSach ? "" : " (chi bộ không có trong sheet)"}`);
      if (r.exact) return res.json({ exact: true, candidates: [congKhai(r.exact)] }); // tự gắn, không hỏi

      if (docVerify(req).no >= MAX_KHONG_PHAI) return res.json({ candidates: [] }); // máy này đã từ chối đủ lần
      if (!duocPhepGoiY(req.ip)) return res.json({ candidates: [] });
      res.json({ candidates: r.candidates.map(congKhai) });
    } catch (err) {
      console.warn("POST /xung-danh/goi-y lỗi:", err.message);
      res.json({ candidates: [] }); // lỗi thì coi như không có gợi ý, đừng chặn việc đăng ký
    }
  });

  // 2) Lưu xưng danh (thay route cũ). Có thể kèm mid = đảng viên người dùng đã bấm "Có".
  app.post("/xung-danh", csrfCheck, async (req, res) => {
    try {
      const name = clean(req.body.name, 100);
      const chiBoId = clean(req.body.chiBoId, 150);
      const chiBoName = clean(req.body.chiBoName, 150);
      if (!name || !chiBoId) return res.status(400).json({ error: "Thiếu tên hoặc chi bộ" });

      let member = null;
      const roster = await layDanhSach();
      if (roster) {
        const r = timUngVien(roster, name, chiBoName, chiBoId, chiBoAliases(chiBoId));
        const mid = String(req.body.mid || "");
        if (r.exact) member = r.exact;
        else if (mid) member = r.candidates.find((m) => m.mid === mid) || null; // chỉ nhận người nằm trong danh sách gợi ý
      }

      await luuDanhTinh(req, res, { name: member ? member.name : name, chiBoId, chiBoName, member });
      res.json({ ok: true, name: member ? member.name : name });
    } catch (err) {
      console.error("POST /xung-danh lỗi:", err);
      res.status(500).json({ error: "Lỗi máy chủ" });
    }
  });

  // 3) Người ĐÃ xưng danh từ trước (chưa đối chiếu): hỏi 1 lần mỗi phiên nếu tên gần giống ai đó
  app.post("/xung-danh/xac-minh", csrfCheck, async (req, res) => {
    try {
      const me = getIdentity(req);
      if (!me || me.mid) return res.json({ candidates: [] });

      const roster = await layDanhSach();
      if (!roster) return res.json({ candidates: [] });

      const r = timUngVien(roster, me.name, me.chiBoName, me.chiBoId, chiBoAliases(me.chiBoId));
      console.log(`[xac-minh] "${me.name}" @ "${me.chiBoName}" -> ${r.exact ? "TRÙNG HẲN (tự gắn, không hỏi)" : r.candidates.length + " gợi ý"}${r.trongDanhSach ? "" : " (chi bộ không có trong sheet)"} | cookie xg_vf=${JSON.stringify(docVerify(req))}`);
      if (r.exact) {
        await luuDanhTinh(req, res, { name: r.exact.name, chiBoId: me.chiBoId, chiBoName: me.chiBoName, member: r.exact });
        return res.json({ candidates: [], name: r.exact.name });
      }

      const vf = docVerify(req);
      if (vf.done || vf.no >= MAX_KHONG_PHAI) return res.json({ candidates: [] });
      if (!r.candidates.length) {
        writeCookie(res, req, VERIFY_COOKIE, { no: vf.no, done: true }); // không giống ai / chi bộ không có trong danh sách -> thôi
        return res.json({ candidates: [] });
      }
      res.json({ candidates: r.candidates.map(congKhai) });
    } catch (err) {
      console.warn("POST /xung-danh/xac-minh lỗi:", err.message);
      res.json({ candidates: [] });
    }
  });

  // 4) Người đã xưng danh bấm "Có" -> đổi sang tên đúng
  app.post("/xung-danh/xac-nhan", csrfCheck, async (req, res) => {
    try {
      const me = getIdentity(req);
      if (!me) return res.status(400).json({ error: "Chưa xưng danh" });
      const roster = await layDanhSach();
      if (!roster) return res.status(400).json({ error: "Chưa có danh sách đảng viên" });

      const r = timUngVien(roster, me.name, me.chiBoName, me.chiBoId, chiBoAliases(me.chiBoId));
      const member = r.exact || r.candidates.find((m) => m.mid === String(req.body.mid || ""));
      if (!member) return res.status(400).json({ error: "Không khớp danh sách" });

      await luuDanhTinh(req, res, { name: member.name, chiBoId: me.chiBoId, chiBoName: me.chiBoName, member });
      res.json({ ok: true, name: member.name });
    } catch (err) {
      console.error("POST /xung-danh/xac-nhan lỗi:", err);
      res.status(500).json({ error: "Lỗi máy chủ" });
    }
  });

  // 6) Đặt lại để thử nghiệm: xoá cookie xưng danh + cờ đối chiếu của MÁY NÀY rồi về trang chủ
  //   /xung-danh/dat-lai          -> như người MỚI (xoá hết, popup xưng danh hiện lại)
  //   /xung-danh/dat-lai?giu=1    -> như người CŨ chưa chốt: giữ tên + chi bộ đang có, chỉ bỏ dấu "đã đối chiếu"
  app.get("/xung-danh/dat-lai", (req, res) => {
    const cu = readCookie(req, IDENTITY_COOKIE);
    res.clearCookie(VERIFY_COOKIE);
    if (req.query.giu && cu && cu.name && cu.chiBoId) {
      writeCookie(res, req, IDENTITY_COOKIE, { name: cu.name, chiBoId: cu.chiBoId, chiBoName: cu.chiBoName });
    } else {
      res.clearCookie(IDENTITY_COOKIE);
      res.clearCookie(REGISTERED_COOKIE);
    }
    res.redirect("/?xd=reset");
  });

  // 5) Bấm "Không phải": nhớ trên máy này; đủ MAX_KHONG_PHAI lần thì không hỏi nữa
  app.post("/xung-danh/khong-phai", csrfCheck, (req, res) => {
    const vf = docVerify(req);
    const no = vf.no + 1;
    writeCookie(res, req, VERIFY_COOKIE, { no, done: vf.done || no >= MAX_KHONG_PHAI });
    res.json({ ok: true, no, max: MAX_KHONG_PHAI });
  });
}

import { firestore } from "./firebase.js";
import { getWordParagraphs } from "./docReader.js";

// =====================================================================
// Cache văn bản Word vào Firestore (collection "wordCache")
//
//  - 30 người xem cùng 1 tài liệu Word -> chỉ tốn 1 lần tải Drive + mammoth
//    cho mỗi chu kỳ làm mới (mặc định 24 giờ), không phải mỗi lượt xem.
//  - Không lưu file .docx, chỉ lưu MẢNG ĐOẠN VĂN (HTML sạch) sau khi mammoth
//    chuyển đổi.
//  - Firestore giới hạn ~1MB/document -> văn bản dài được chia thành nhiều
//    document. Phần đầu nằm ngay trong document chính, nên tài liệu bình thường
//    chỉ tốn 1 lượt đọc Firestore.
//  - Có lớp RAM (10 phút) + gộp các yêu cầu trùng (inFlight).
//  - Ghi cache lỗi thì vẫn trả nội dung bình thường (cache chỉ là phụ);
//    tải Drive lỗi mà còn bản cũ thì dùng bản cũ.
//
// Dùng collection RIÊNG "wordCache", không lẫn với collection "cache" (tin
// tức) nên nút "Xoá HẾT" ở khối tin tức không xoá nhầm văn bản Word.
// =====================================================================

const COLLECTION = "wordCache";
const MAX_DOC_BYTES = 600 * 1024; // chừa dư so với giới hạn ~1MB của Firestore
const RAM_TTL_MS = 10 * 60 * 1000;

function ttlMs() {
  const h = parseFloat(process.env.WORD_CACHE_TTL_HOURS || "24");
  return (Number.isFinite(h) && h > 0 ? h : 24) * 60 * 60 * 1000;
}

// ----- Khóa cache từ link -----
export function wordKeyForUrl(url) {
  const s = String(url || "");
  const m1 = s.match(/[?&]id=([A-Za-z0-9_-]+)/);
  if (m1) return `gd_${m1[1]}`;
  const m2 = s.match(/\/d\/([A-Za-z0-9_-]+)/);
  if (m2) return `gd_${m2[1]}`;
  // Link không phải Drive/Docs -> băm cả link
  let h = 5381;
  for (let i = 0; i < s.length; i++) h = ((h * 33) ^ s.charCodeAt(i)) >>> 0;
  return `u_${h.toString(36)}_${s.length}`;
}

// ----- Chia mảng đoạn văn thành các cụm ≤ MAX_DOC_BYTES -----
function splitIntoChunks(paragraphs) {
  const chunks = [];
  let current = [];
  let bytes = 0;
  for (const p of paragraphs) {
    const size = Buffer.byteLength(p, "utf8") + 8;
    if (current.length > 0 && bytes + size > MAX_DOC_BYTES) {
      chunks.push(current);
      current = [];
      bytes = 0;
    }
    current.push(p);
    bytes += size;
  }
  if (current.length > 0) chunks.push(current);
  return chunks.length > 0 ? chunks : [[]];
}

// ----- Firestore -----
async function loadFromFirestore(key) {
  const col = firestore.collection(COLLECTION);
  const snap = await col.doc(key).get();
  if (!snap.exists) return null;

  const meta = snap.data();
  const paragraphs = Array.isArray(meta.paragraphs) ? [...meta.paragraphs] : [];
  const chunkCount = meta.chunkCount || 1;

  if (chunkCount > 1) {
    const refs = [];
    for (let i = 1; i < chunkCount; i++) refs.push(col.doc(`${key}__${i}`));
    const snaps = await firestore.getAll(...refs);
    for (const s of snaps) {
      // Thiếu cụm hoặc cụm thuộc phiên bản khác (đang ghi dở) -> coi như chưa có cache
      if (!s.exists || s.data().version !== meta.version) return null;
      paragraphs.push(...s.data().paragraphs);
    }
  }
  return { paragraphs, updatedAt: meta.updatedAt || 0 };
}

async function saveToFirestore(key, paragraphs) {
  const col = firestore.collection(COLLECTION);
  const version = Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
  const chunks = splitIntoChunks(paragraphs);

  const oldSnap = await col.doc(key).get();
  const oldCount = oldSnap.exists ? oldSnap.data().chunkCount || 1 : 0;

  // Ghi các cụm phụ TRƯỚC, document chính SAU CÙNG: người đọc chỉ thấy bản mới
  // khi đã ghi đủ, và tự đối chiếu "version" nên không bao giờ ghép nhầm cụm.
  for (let i = 1; i < chunks.length; i++) {
    await col.doc(`${key}__${i}`).set({ kind: "chunk", version, paragraphs: chunks[i] });
  }
  await col.doc(key).set({
    kind: "meta",
    version,
    updatedAt: Date.now(),
    total: paragraphs.length,
    chunkCount: chunks.length,
    paragraphs: chunks[0]
  });

  // Bản mới ngắn hơn bản cũ -> dọn các cụm thừa
  for (let i = chunks.length; i < oldCount; i++) {
    await col.doc(`${key}__${i}`).delete().catch(() => {});
  }
}

// ----- Lớp RAM + gộp yêu cầu trùng -----
const ramCache = new Map(); // key -> { paragraphs, time, updatedAt }
const inFlight = new Map(); // key -> Promise<paragraphs>

/**
 * Thay cho getWordParagraphs(fileUrl): cùng đầu vào, cùng đầu ra (mảng đoạn
 * văn HTML), nhưng có cache.
 */
export async function getWordParagraphsCached(fileUrl) {
  const key = wordKeyForUrl(fileUrl);
  const now = Date.now();

  const ram = ramCache.get(key);
  if (ram && now - ram.time < RAM_TTL_MS && now - ram.updatedAt < ttlMs()) {
    return ram.paragraphs;
  }

  if (inFlight.has(key)) return inFlight.get(key);

  const task = (async () => {
    let stored = null;
    try {
      stored = await loadFromFirestore(key);
    } catch (err) {
      console.error(`wordCache: đọc Firestore lỗi (${key}) -`, err.message);
    }

    if (stored && Date.now() - stored.updatedAt < ttlMs()) {
      ramCache.set(key, { paragraphs: stored.paragraphs, time: Date.now(), updatedAt: stored.updatedAt });
      return stored.paragraphs;
    }

    // Chưa có, hoặc đã quá hạn làm mới -> tải từ Drive + mammoth
    try {
      const fresh = await getWordParagraphs(fileUrl);
      if (fresh.length === 0 && stored && stored.paragraphs.length > 0) {
        throw new Error("Bản tải về rỗng, giữ bản cũ");
      }
      try {
        await saveToFirestore(key, fresh);
      } catch (err) {
        console.error(`wordCache: ghi Firestore lỗi (${key}) -`, err.message);
      }
      ramCache.set(key, { paragraphs: fresh, time: Date.now(), updatedAt: Date.now() });
      return fresh;
    } catch (err) {
      if (stored) {
        console.warn(`wordCache: làm mới ${key} thất bại (${err.message}), dùng bản cũ`);
        // Hẹn thử lại sau ~5 phút, không dồn dập gọi Drive khi Drive đang lỗi
        ramCache.set(key, {
          paragraphs: stored.paragraphs,
          time: Date.now(),
          updatedAt: Date.now() - ttlMs() + 5 * 60 * 1000
        });
        return stored.paragraphs;
      }
      throw err;
    }
  })();

  inFlight.set(key, task);
  try {
    return await task;
  } finally {
    inFlight.delete(key);
  }
}

// ====== Dành cho trang quản lý ======
export async function listWordCache() {
  const snap = await firestore.collection(COLLECTION).where("kind", "==", "meta").get();
  return snap.docs
    .map((d) => {
      const m = d.data();
      return {
        key: d.id,
        updatedAt: m.updatedAt ? new Date(m.updatedAt).toISOString() : "",
        total: m.total || 0,
        chunkCount: m.chunkCount || 1
      };
    })
    .sort((a, b) => (a.updatedAt < b.updatedAt ? 1 : -1));
}

/** Xóa 1 tài liệu (truyền key) hoặc toàn bộ (không truyền key). */
export async function deleteWordCache(key) {
  const col = firestore.collection(COLLECTION);

  if (key) {
    const snap = await col.doc(key).get();
    const count = snap.exists ? snap.data().chunkCount || 1 : 1;
    for (let i = 1; i < count; i++) await col.doc(`${key}__${i}`).delete().catch(() => {});
    await col.doc(key).delete();
    ramCache.delete(key);
    return { removed: 1 };
  }

  let removed = 0;
  for (;;) {
    const snap = await col.limit(400).get();
    if (snap.empty) break;
    const batch = firestore.batch();
    snap.docs.forEach((d) => batch.delete(d.ref));
    await batch.commit();
    removed += snap.size;
  }
  ramCache.clear();
  return { removed };
}
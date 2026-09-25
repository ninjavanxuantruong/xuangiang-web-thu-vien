// summarizer.js
// Tóm tắt "trích xuất" (extractive) — KHÔNG gọi AI/API nào cả, hoàn toàn
// miễn phí và chạy tức thì. Quy tắc đúng như bạn mô tả:
//   - Giữ câu ĐẦU TIÊN của mỗi đoạn văn (thường chứa ý chính của đoạn)
//   - Giữ thêm bất kỳ câu nào có SỐ LIỆU (ngày, %, số lượng, tiền...)
//   - TL;DR = câu đầu tiên của toàn văn bản
//   - Mindmap = câu đầu tiên của mỗi đoạn (hoặc mỗi nhóm đoạn, nếu tài
//     liệu quá dài, để không vẽ quá nhiều nhánh)

const VOWEL_UPPER = "A-ZĐÂÊÔƠƯÁÀẢÃẠẤẦẨẪẬẮẰẲẴẶÉÈẺẼẸẾỀỂỄỆÍÌỈĨỊÓÒỎÕỌỐỒỔỖỘỚỜỞỠỢÚÙỦŨỤỨỪỬỮỰÝỲỶỸỴ";

/**
 * Tách 1 đoạn văn thành các câu. Chỉ cắt câu tại dấu . ! ? … khi theo sau
 * là khoảng trắng + chữ hoa (hoặc số, hoặc hết đoạn) — để KHÔNG cắt nhầm
 * vào giữa số liệu kiểu "20.000 người" hay "TP. Hà Nội".
 */
export function splitSentences(text) {
  const clean = String(text || "").replace(/\s+/g, " ").trim();
  if (!clean) return [];

  const boundary = new RegExp(`([.!?…])\\s+(?=[${VOWEL_UPPER}0-9"“(])`, "g");
  const withMarker = clean.replace(boundary, "$1|||");
  const rawParts = withMarker.split("|||").map((s) => s.trim()).filter(Boolean);

  // Gộp lại mảnh chỉ là số thứ tự/đề mục đứng riêng (ví dụ "1.", "1.1.",
  // "II.") vào câu ngay sau nó — nếu không, câu thật đứng sau số thứ tự
  // (ví dụ "1. Kinh tế có vốn...") sẽ bị tách rời và mất nội dung khi tóm
  // tắt chỉ giữ "câu đầu tiên".
  const MARKER_RE = /^[0-9]{1,2}(\.[0-9]{1,2})*\.?$|^[IVXLCDM]{1,5}[\-.]?$|^[a-zđ]\)$/i;
  const merged = [];
  for (const part of rawParts) {
    if (merged.length > 0 && MARKER_RE.test(merged[merged.length - 1])) {
      merged[merged.length - 1] += " " + part;
    } else {
      merged.push(part);
    }
  }
  return merged;
}

function hasNumber(sentence) {
  return /\d/.test(sentence);
}

// Khi câu bị cắt ở dấu chấm phẩy (;), đổi thành dấu chấm (.) lúc hiển thị
// cho chuyên nghiệp hơn — người đọc không cần biết câu gốc vốn dùng ";".
function normalizeEnding(s) {
  const t = String(s || "").trimEnd();
  if (t.endsWith(";")) return t.slice(0, -1) + ".";
  return t;
}

// Đề mục kiểu "I- QUAN ĐIỂM CHỈ ĐẠO", "1. Mục tiêu tổng quát", "1.1. Đổi
// mới tư duy...", "a) Đến năm 2030" — nhận diện bằng: bắt đầu bằng số/số
// La Mã/chữ cái + dấu chấm hoặc gạch ngang, theo sau là 1 CHỮ (không phải
// số) — để không nhận nhầm số liệu lớn kiểu "20.000 người" (sau "20." là
// chữ số "0" tiếp, không phải chữ cái, nên bị loại).
// Theo yêu cầu mới: MỌI đoạn bắt đầu bằng đánh số (1. 2. 3. hay I- II-...)
// đều coi là đề mục — không phân biệt ngắn/dài nữa.
const HEADING_MARKER_RE =
  /^(?:[IVXLCDM]{1,5}[\-.]\s*(?!\d)\S|[0-9]{1,2}(?:\.[0-9]{1,2})*[.)]\s*(?!\d)\S|[a-zđ]\)\s*(?!\d)\S)/;

function isHeadingParagraph(text) {
  return HEADING_MARKER_RE.test(String(text || "").trim());
}

/**
 * Tóm tắt 1 đoạn văn (KHÔNG phải đề mục):
 *  - Câu đầu tiên: dừng ở dấu CHẤM hoặc CHẤM PHẨY, tuỳ dấu nào tới trước
 *    (để câu mở đầu ngắn gọn hơn).
 *  - Các câu khác trong đoạn nếu có SỐ LIỆU: giữ nguyên logic cũ, chỉ cắt
 *    ở dấu chấm (không cắt ở chấm phẩy, tránh mất số liệu nằm sau đó).
 */
export function summarizeParagraph(paragraphText) {
  const text = String(paragraphText || "").trim();
  if (!text) return "";

  const sentences = splitSentences(text); // cắt câu đầy đủ ở . ! ? …
  if (sentences.length === 0) return "";

  const firstSentenceRaw = sentences[0];
  const cutIdx = firstSentenceRaw.search(/[.;]/);
  const firstSentence = cutIdx === -1 ? firstSentenceRaw : firstSentenceRaw.slice(0, cutIdx + 1);

  const picked = [firstSentence];
  sentences.forEach((s, i) => {
    if (i === 0) return; // đã xử lý riêng ở trên
    if (hasNumber(s)) picked.push(s);
  });
  return normalizeEnding(picked.join(" "));
}

const MAX_MINDMAP_BRANCHES = 10;

/**
 * Tóm tắt cả tài liệu, nhận vào mảng đoạn văn PLAIN TEXT (đã strip HTML).
 * Trả về:
 *  - tldr: 1 câu duy nhất, câu đầu tiên của toàn văn bản
 *  - paragraphSummaries: tóm tắt từng đoạn (cùng độ dài mảng đoạn gốc,
 *    dùng để hiện "tóm tắt chi tiết theo từng phần")
 *  - mindmapBranches: câu đầu mỗi đoạn (hoặc mỗi nhóm đoạn nếu tài liệu
 *    dài), giới hạn tối đa MAX_MINDMAP_BRANCHES nhánh cho dễ nhìn
 */
export function summarizeDocument(plainParagraphs) {
  const cleaned = (plainParagraphs || []).map((p) => String(p || "").trim()).filter(Boolean);

  if (cleaned.length === 0) {
    return { tldr: "", paragraphSummaries: [], mindmapBranches: [] };
  }

  const paragraphSummaries = cleaned.map((p) => {
    if (isHeadingParagraph(p)) {
      // Đề mục: chỉ lấy câu đầu tiên, cắt ở dấu CHẤM (không cắt ở chấm
      // phẩy — khác với đoạn thường, theo đúng yêu cầu).
      const headingText = normalizeEnding(splitSentences(p)[0] || p);
      return { text: headingText, isHeading: true };
    }
    const summarized = summarizeParagraph(p);
    // Thêm gạch đầu dòng cho đoạn nội dung thường, nếu nó chưa có sẵn —
    // để nhìn rõ đây là ý nằm dưới 1 đề mục, không lẫn với đề mục.
    const withDash = summarized.startsWith("-") ? summarized : `- ${summarized}`;
    return { text: withDash, isHeading: false };
  });
  const tldr = splitSentences(cleaned[0])[0] || "";

  let branchSource = cleaned;
  if (cleaned.length > MAX_MINDMAP_BRANCHES) {
    // Tài liệu dài hơn số nhánh tối đa -> gộp đều các đoạn thành từng
    // nhóm, mỗi nhóm là 1 nhánh, tránh mindmap bị rối vì quá nhiều nhánh.
    const groupSize = Math.ceil(cleaned.length / MAX_MINDMAP_BRANCHES);
    branchSource = [];
    for (let i = 0; i < cleaned.length; i += groupSize) {
      branchSource.push(cleaned.slice(i, i + groupSize).join(" "));
    }
  }

  const mindmapBranches = branchSource
    .map((p) => splitSentences(p)[0] || "")
    .filter(Boolean)
    .slice(0, MAX_MINDMAP_BRANCHES);

  return { tldr, paragraphSummaries, mindmapBranches };
}
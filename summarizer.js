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
// ====================== SLIDE TÓM TẮT ======================
const SLIDE_ROMAN_RE = /^[IVX]{1,6}[\-.)]\s*(?!\d)\S/;
const SLIDE_DECIMAL_RE = /^(\d{1,2}(?:\.\d{1,2})*)[.)]\s+(?!\d)\S/;
const SLIDE_NOISE_RE = /^[\s\-–—_*•.=~]+$/;
const MAX_BULLETS_PER_SLIDE = 5;
const MAX_CHARS_PER_SLIDE = 750;
const MAX_BULLET_LEN = 260;

function slideHeadingLevel(text, tag) {
  // Đề mục thật thường KHÔNG kết thúc bằng dấu chấm/chấm phẩy/phẩy.
  // Ý nội dung có đánh số (vd "1. Các ban đảng ... Nghị quyết này.") thì có.
  const looksLikeHeading = !/[.;,]$/.test(text);
  if (SLIDE_ROMAN_RE.test(text) && text.length <= 160 && looksLikeHeading) return 1;
  const m = SLIDE_DECIMAL_RE.exec(text);
  if (m && text.length <= 140 && looksLikeHeading) return m[1].includes(".") ? 3 : 2;
  if (/^h[1-6]$/.test(tag || "") && text.length <= 200 && looksLikeHeading) return 2;
  return 0;
}

function clampText(s, max) {
  if (s.length <= max) return s;
  const cut = s.slice(0, max);
  const sp = cut.lastIndexOf(" ");
  return (sp > max * 0.6 ? cut.slice(0, sp) : cut).replace(/[,;:\s]+$/, "") + "…";
}

function pickBullet(text) {
  const sentences = splitSentences(text);
  if (sentences.length === 0) return "";
  let first = sentences[0];
  if (first.length > 140) {
    const semi = first.indexOf(";");
    if (semi > 30) first = first.slice(0, semi + 1);
  }
  const picked = [first];
  const extra = sentences.slice(1).find((s) => hasNumber(s) && s.length <= 200);
  if (extra) picked.push(extra);
  return clampText(normalizeEnding(picked.join(" ")), MAX_BULLET_LEN);
}

export function buildSlides(blocks, docName) {
  const items = (blocks || [])
    .map((b) => ({ tag: b.tag, text: String(b.text || "").replace(/\s+/g, " ").trim() }))
    .filter((b) => b.text && !SLIDE_NOISE_RE.test(b.text));

  const slides = [];

  // Phần mở đầu (trước đề mục đầu tiên)
  let start = items.findIndex((b) => slideHeadingLevel(b.text, b.tag) === 1);
  if (start === -1) start = items.findIndex((b) => slideHeadingLevel(b.text, b.tag) >= 2);
  if (start === -1) start = 0;
  const pre = items.slice(0, start).map((b) => b.text);

  // Slide bìa: tên văn bản + dòng "Về ..." + số hiệu/ngày ban hành
  const subtitle = pre.find((t) => /^Về\s/i.test(t)) || "";
  const meta = pre
    .filter((t) => /^Số\s/i.test(t) || /ngày\s+\d{1,2}\s+tháng/i.test(t))
    .join("  ·  ");
  slides.push({ type: "cover", title: docName || "Tóm tắt văn bản", subtitle: clampText(subtitle, 300), meta });

  // Các đoạn mở đầu có nội dung thật (đoạn dài) -> slide "Mở đầu", KHÔNG bỏ sót
  const introBullets = pre
    .filter((t) => t.length >= 80 && !/^Về\s/i.test(t) && !/ngày\s+\d{1,2}\s+tháng/i.test(t))
    .map((t) => pickBullet(t.replace(/^[-–•*+]\s*/, "")))
    .filter(Boolean);

  let title = "", label = "", crumb = "", parent2 = "";
  let labelUsed = false;
  let bullets = [];

  function flush() {
    if (bullets.length === 0) return;
    const groups = [];
    let g = [];
    let chars = 0;
    bullets.forEach((b) => {
      if (g.length >= MAX_BULLETS_PER_SLIDE || (g.length > 0 && chars + b.length > MAX_CHARS_PER_SLIDE)) {
        groups.push(g);
        g = [];
        chars = 0;
      }
      g.push(b);
      chars += b.length;
    });
    if (g.length) groups.push(g);
    groups.forEach((grp, i) => {
      slides.push({ type: "content", title, crumb, label, bullets: grp, cont: i > 0 });
    });
    bullets = [];
    labelUsed = true;
  }

  if (introBullets.length) {
    title = "Mở đầu";
    bullets = introBullets;
    flush();
    title = "";
  }
  labelUsed = true;

  // Đề mục số đứng ngay trước 1 đề mục khác mà không có ý nào bên dưới ->
  // đưa chính đề mục đó thành 1 ý, để không bị mất khỏi bản tóm tắt.
  function rescueEmptyLabel() {
    if (label && !labelUsed && bullets.length === 0) {
      bullets = [label];
      label = "";
      flush();
    }
  }

  items.slice(start).forEach((b) => {
    const level = slideHeadingLevel(b.text, b.tag);
    if (level === 1) {
      flush(); rescueEmptyLabel();
      title = b.text; label = ""; crumb = ""; parent2 = ""; labelUsed = true;
    } else if (level === 2) {
      flush(); rescueEmptyLabel();
      label = b.text; crumb = ""; parent2 = b.text; labelUsed = false;
    } else if (level === 3) {
      flush();
      label = b.text; crumb = parent2; labelUsed = false;
    } else {
      const clean = b.text.replace(/^[-–•*+]\s*/, "");
      const bullet = pickBullet(clean);
      if (bullet) bullets.push(bullet);
    }
  });
  flush();
  rescueEmptyLabel();

  return slides;
}

// ====================== TRANG XEM ĐẦY ĐỦ (đẹp, có đề mục & thẻ) ======================
function escHtml(s) {
  return String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

// Tô nổi phần trăm và số liệu có đơn vị (7,2%, 85 triệu đồng/người/năm, 56 doanh nghiệp...)
const FV_NUM_RE =
  /(\d+(?:[.,]\d+)*\s?%|\d+(?:[.,]\d+)*\s?(?:triệu đồng|tỷ đồng|nghìn tỷ|triệu|tỷ|nghìn|ha|km|doanh nghiệp|cơ sở|lao động|người|xã|phường)(?![\p{L}])(?:\/\p{L}+)*)/giu;

function fvHighlight(text) {
  return escHtml(text).replace(FV_NUM_RE, '<b class="fv-num">$1</b>');
}

export function buildFullView(blocks) {
  const items = (blocks || [])
    .map((b) => ({ tag: b.tag, text: String(b.text || "").replace(/\s+/g, " ").trim() }))
    .filter((b) => b.text && !SLIDE_NOISE_RE.test(b.text));

  let start = items.findIndex((b) => slideHeadingLevel(b.text, b.tag) === 1);
  if (start === -1) start = items.findIndex((b) => slideHeadingLevel(b.text, b.tag) >= 2);
  if (start === -1) start = 0;

  const out = [];

  // Phần đầu văn bản (trước đề mục đầu tiên)
  items.slice(0, start).forEach((b) => {
    const t = b.text;
    if (/^Về\s/i.test(t)) out.push({ type: "subject", c: 0, html: escHtml(t) });
    else if (t.length < 90) out.push({ type: "meta", c: 0, html: escHtml(t) });
    else out.push({ type: "p", c: 0, html: fvHighlight(t) });
  });

  let c = 0;
  let sectionCount = -1;
  items.slice(start).forEach((b) => {
    const level = slideHeadingLevel(b.text, b.tag);
    if (level === 1) {
      sectionCount += 1;
      c = sectionCount % 6;
      const m = /^([IVX]{1,6})[\-.)]\s*(.*)$/.exec(b.text);
      out.push({
        type: "section", c,
        label: m ? "PHẦN " + m[1] : "",
        text: m && m[2] ? m[2] : b.text
      });
    } else if (level === 2 || level === 3) {
      out.push({ type: "sub", c, level, text: b.text });
    } else {
      const bullet = /^[-–•*+]\s+(.*)$/.exec(b.text);
      const numbered = /^(\d{1,2}|[a-zđ])[.)]\s+(.+)$/.exec(b.text);
      if (bullet) out.push({ type: "bullet", c, html: fvHighlight(bullet[1]) });
      else if (numbered) out.push({ type: "item", c, num: numbered[1], html: fvHighlight(numbered[2]) });
      else out.push({ type: "p", c, html: fvHighlight(b.text) });
    }
  });

  return out;
}

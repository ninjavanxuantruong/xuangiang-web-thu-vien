import mammoth from "mammoth";
import fetch from "node-fetch";

/**
 * Tải file Word (.docx) từ 1 link công khai (Drive direct-download hoặc URL
 * bất kỳ) và chuyển thành mảng đoạn văn dạng HTML sạch bằng mammoth —
 * KHÔNG ép qua PDF như bản cũ, giữ đúng nội dung + để hiển thị dạng cuộn
 * dọc như 1 bài báo.
 */
export async function getWordParagraphs(fileUrl) {
  const response = await fetch(fileUrl);
  if (!response.ok) {
    throw new Error(`Tải file Word thất bại: ${response.status}`);
  }
  const arrayBuffer = await response.arrayBuffer();
  const buffer = Buffer.from(arrayBuffer);

  const result = await mammoth.convertToHtml({ buffer });
  const html = result.value; // chuỗi <p>...</p><p>...</p>...

  return html
    .split(/<\/p>/i)
    .map((p) => p.replace(/<p[^>]*>/i, "").trim())
    .filter(Boolean);
}

/**
 * Bỏ hết thẻ HTML, dùng để lấy văn bản thuần đưa vào normalizeText/TTS.
 */
export function stripHtml(html) {
  return (html || "").replace(/<[^>]+>/g, "").trim();
}

function shuffleArray(arr) {
  const a = [...arr];
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

/**
 * Chèn ảnh NGẪU NHIÊN vào giữa các đoạn văn — xáo thứ tự ảnh, chọn ngẫu
 * nhiên đoạn văn nào sẽ có ảnh ngay sau nó (không lặp vị trí, không theo
 * quy luật đều đặn nữa như bản trước).
 */
export function interleaveImages(paragraphs, images) {
  if (!images || images.length === 0) {
    return paragraphs.map((p) => ({ type: "text", content: p }));
  }

  const shuffledImages = shuffleArray(images);
  const maxInsertable = Math.min(shuffledImages.length, paragraphs.length);
  const insertAfter = new Set(shuffleArray(paragraphs.map((_, i) => i)).slice(0, maxInsertable));

  const blocks = [];
  let imgPointer = 0;

  paragraphs.forEach((p, i) => {
    blocks.push({ type: "text", content: p });
    if (insertAfter.has(i) && imgPointer < shuffledImages.length) {
      blocks.push({ type: "image", url: shuffledImages[imgPointer] });
      imgPointer++;
    }
  });

  // Ảnh dư ra (nhiều ảnh hơn số đoạn văn) -> đưa nốt xuống cuối bài
  while (imgPointer < shuffledImages.length) {
    blocks.push({ type: "image", url: shuffledImages[imgPointer] });
    imgPointer++;
  }

  return blocks;
}
const ENTITY_MAP = { "&amp;": "&", "&lt;": "<", "&gt;": ">", "&quot;": '"', "&#39;": "'", "&nbsp;": " " };
function decodeEntities(s) {
  return String(s)
    .replace(/&(?:amp|lt|gt|quot|nbsp|#39);/g, (m) => ENTITY_MAP[m] || m)
    .replace(/&#(\d+);/g, (m, n) => String.fromCharCode(Number(n)));
}

/**
 * Tách HTML của mammoth thành các khối [{ tag, text }] — MỖI đoạn <p>,
 * tiêu đề <h1>-<h6>, mục <li> và mỗi dòng xuống hàng (<br>) là 1 khối riêng.
 */
function parseTable(tableHtml) {
  const rows = [];
  const rowRe = /<tr[^>]*>([\s\S]*?)<\/tr>/gi;
  let rm;
  while ((rm = rowRe.exec(tableHtml)) !== null) {
    const cells = [];
    const cellRe = /<(td|th)([^>]*)>([\s\S]*?)<\/\1>/gi;
    let cm;
    while ((cm = cellRe.exec(rm[1])) !== null) {
      const attrs = cm[2];
      const span = (name) => {
        const m = new RegExp(name + '="?(\\d+)"?', "i").exec(attrs);
        return m ? Number(m[1]) : 1;
      };
      const text = decodeEntities(
        cm[3].replace(/<br\s*\/?>/gi, " ").replace(/<\/p>/gi, " ").replace(/<[^>]+>/g, "")
      ).replace(/\s+/g, " ").trim();
      cells.push({ text, colspan: span("colspan"), rowspan: span("rowspan") });
    }
    if (cells.length) rows.push(cells);
  }
  return rows;
}

function pushTextBlocks(html, blocks) {
  const re = /<(p|h[1-6]|li)(?:\s[^>]*)?>([\s\S]*?)<\/\1>/gi;
  let m;
  while ((m = re.exec(html)) !== null) {
    const tag = m[1].toLowerCase();
    m[2]
      .replace(/<br\s*\/?>/gi, "\n")
      .replace(/<[^>]+>/g, "")
      .split("\n")
      .forEach((line) => {
        const text = decodeEntities(line).replace(/\s+/g, " ").trim();
        if (text) blocks.push({ tag, text });
      });
  }
}

/**
 * Tách HTML của mammoth thành các khối:
 *   { tag: "p" | "h1".."h6" | "li", text }   — đoạn văn / tiêu đề / mục
 *   { tag: "table", rows: [[{text, colspan, rowspan}, ...], ...] } — bảng
 */
export function htmlToBlocks(html) {
  const blocks = [];
  const tableRe = /<table[\s\S]*?<\/table>/gi;
  let last = 0;
  let tm;
  while ((tm = tableRe.exec(html)) !== null) {
    pushTextBlocks(html.slice(last, tm.index), blocks);
    const rows = parseTable(tm[0]);
    if (rows.length) blocks.push({ tag: "table", rows });
    last = tm.index + tm[0].length;
  }
  pushTextBlocks(html.slice(last), blocks);
  return blocks;
}

export async function getWordDoc(fileUrl) {
  const response = await fetch(fileUrl);
  if (!response.ok) {
    throw new Error(`Tải file Word thất bại: ${response.status}`);
  }
  const arrayBuffer = await response.arrayBuffer();
  const buffer = Buffer.from(arrayBuffer);

  const result = await mammoth.convertToHtml({ buffer });
  const html = result.value;

  const textBlocks = html
    .split(/<\/p>/i)
    .map((p) => p.replace(/<p[^>]*>/i, "").trim())
    .filter(Boolean);

  return { textBlocks, blocks: htmlToBlocks(html) };
}

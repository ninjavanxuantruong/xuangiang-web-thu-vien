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

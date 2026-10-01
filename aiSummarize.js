// aiSummarize.js
// Gọi Google Gemini (free tier — xem hướng dẫn lấy GEMINI_API_KEY miễn phí
// tại https://aistudio.google.com/apikey, lưu vào .env) để trong 1 lần
// gọi duy nhất:
//   1. Tự nhận diện bài đã là tiếng Việt hay chưa — nếu chưa thì dịch,
//      nếu rồi thì chỉ tóm tắt lại (không cần bước phát hiện ngôn ngữ
//      riêng, để AI tự lo).
//   2. Tóm tắt ngắn gọn, súc tích.
//   3. Tự bỏ qua (skip) nếu nội dung CHÍNH của bài xoay quanh các chủ đề
//      nhạy cảm đã thống nhất — đây là lớp lọc thứ 2, chắc chắn hơn việc
//      chỉ lọc từ khóa ở tiêu đề (worldNews.js đã lọc thô ở tiêu đề trước
//      khi tốn công gọi tới bước này).
//
// LƯU Ý QUAN TRỌNG (đã từng gây lỗi "AI không tóm tắt được" mà không rõ vì
// sao): từ Gemini 2.5 trở đi, model có bước "suy nghĩ ngầm" (thinking)
// trước khi trả lời, và số token dùng cho bước đó bị trừ chung vào
// maxOutputTokens. Nếu đặt maxOutputTokens quá thấp, model có thể dùng
// hết token cho việc "suy nghĩ" rồi trả về nội dung RỖNG (finishReason:
// "MAX_TOKENS" nhưng không có chữ nào) — đây là hành vi đã biết của
// Gemini, không phải do cấu hình key/model sai. Vì vậy bên dưới để
// maxOutputTokens khá cao và luôn log finishReason để dễ tra khi có lỗi.

import axios from "axios";

// Gemini (và nhiều LLM khác) đôi khi trả sai tiếng Việt có 2 dấu chồng
// (nguyên âm ô/ă/â/ê/ơ/ư + 1 dấu thanh): dấu thanh bị tách thành ký tự
// RỜI (´ ` ... đứng ngay sau, không gộp vào chữ) thay vì đúng 1 chữ có
// dấu, ví dụ "quốc" bị trả thành "quô" + "´" + "c" = "quô´c". Đây KHÔNG
// phải lỗi tổ hợp Unicode NFD/NFC bình thường (.normalize("NFC") không
// sửa được) — phải tự dò và ghép lại thành đúng 1 chữ có dấu.
const TONE_MARK_FIX = [
  // [ký tự dấu rời AI hay trả sai, dấu thanh tương ứng]
  // CHỈ xử lý 2 dấu đã xác nhận thực tế bị lỗi (´ và `) — không thêm dấu
  // hỏi/ngã/nặng vì ký tự rời của chúng (?, ~, .) trùng với dấu câu bình
  // thường, tự thay có thể sửa nhầm cả câu đúng.
  ["´", "acute"],
  ["`", "grave"]
];

// nguyên_âm_gốc (đã có dấu circumflex/breve/horn) -> { dấu_thanh: chữ_đúng }
const VOWEL_TONE_MAP = {
  "â": { acute: "ấ", grave: "ầ", hook: "ẩ", tilde: "ẫ", dot: "ậ" },
  "Â": { acute: "Ấ", grave: "Ầ", hook: "Ẩ", tilde: "Ẫ", dot: "Ậ" },
  "ê": { acute: "ế", grave: "ề", hook: "ể", tilde: "ễ", dot: "ệ" },
  "Ê": { acute: "Ế", grave: "Ề", hook: "Ể", tilde: "Ễ", dot: "Ệ" },
  "ô": { acute: "ố", grave: "ồ", hook: "ổ", tilde: "ỗ", dot: "ộ" },
  "Ô": { acute: "Ố", grave: "Ồ", hook: "Ổ", tilde: "Ỗ", dot: "Ộ" },
  "ă": { acute: "ắ", grave: "ằ", hook: "ẳ", tilde: "ẵ", dot: "ặ" },
  "Ă": { acute: "Ắ", grave: "Ằ", hook: "Ẳ", tilde: "Ẵ", dot: "Ặ" },
  "ơ": { acute: "ớ", grave: "ờ", hook: "ở", tilde: "ỡ", dot: "ợ" },
  "Ơ": { acute: "Ớ", grave: "Ờ", hook: "Ở", tilde: "Ỡ", dot: "Ợ" },
  "ư": { acute: "ứ", grave: "ừ", hook: "ử", tilde: "ữ", dot: "ự" },
  "Ư": { acute: "Ứ", grave: "Ừ", hook: "Ử", tilde: "Ữ", dot: "Ự" }
};

function fixVietnameseDiacritics(text) {
  let s = String(text || "");
  for (const [markChar, toneName] of TONE_MARK_FIX) {
    const escaped = markChar.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    const re = new RegExp(`([${Object.keys(VOWEL_TONE_MAP).join("")}])${escaped}`, "g");
    s = s.replace(re, (whole, vowel) => VOWEL_TONE_MAP[vowel][toneName] || whole);
  }
  return s;
}

// Lưu ý: dòng Gemini 2.5 (gồm gemini-2.5-flash-lite) đã có lịch ngừng
// hoạt động 16/10/2026 theo thông báo của Google — đặt GEMINI_MODEL trong
// .env sang một bản mới hơn (ví dụ gemini-3.5-flash-lite bạn đang dùng)
// trước mốc đó để tránh bị gián đoạn đột ngột.
const GEMINI_MODEL = process.env.GEMINI_MODEL || "gemini-3.5-flash-lite";
const GEMINI_API_KEY = process.env.GEMINI_API_KEY || "";
const GEMINI_URL = `https://generativelanguage.googleapis.com/v1beta/models/${GEMINI_MODEL}:generateContent`;

const SENSITIVE_TOPICS = [
  "human rights",
  
  "one-party state",
  
  "communist regime",
  
  "death penalty"
];

function buildPrompt(title, articleText) {
  return `Bạn là biên tập viên tóm tắt tin quốc tế cho một trang thông tin cộng đồng ở Việt Nam.

Tiêu đề gốc: ${title}

Nội dung bài báo (có thể là tiếng Anh, tiếng Việt, hoặc ngôn ngữ khác):
"""
${articleText.slice(0, 6000)}
"""

Yêu cầu:
1. Nếu nội dung CHÍNH của bài xoay quanh một trong các chủ đề sau: ${SENSITIVE_TOPICS.join(", ")} — trả về skip=true và bỏ qua bước tóm tắt (summaryVi để chuỗi rỗng).
2. Nếu không thuộc nhóm trên: dịch tiêu đề sang tiếng Việt (ngắn gọn, đúng nghĩa, không bịa) trả về ở trường "titleVi". Nếu bài đã viết bằng tiếng Việt thì chỉ tóm tắt lại cho súc tích; nếu bài viết bằng ngôn ngữ khác thì dịch sang tiếng Việt rồi tóm tắt. Bản tóm tắt khoảng 4-6 câu, giọng văn trung lập, không thêm bình luận cá nhân, không bịa thêm thông tin ngoài nội dung đã cho.
3. Nếu tên tác giả bài viết xuất hiện rõ trong nội dung, trả về trong trường "author" (không có thì để chuỗi rỗng, không tự suy đoán/bịa ra tên).

CHỈ trả về đúng 1 khối JSON, không kèm giải thích, không dùng markdown code fence, đúng định dạng:
{"skip": false, "titleVi": "...", "summaryVi": "...", "author": ""}`;
}

function extractJson(text) {
  const match = String(text || "").match(/\{[\s\S]*\}/);
  if (!match) return null;
  try {
    return JSON.parse(match[0]);
  } catch {
    return null;
  }
}

/**
 * Trả về { skip, summaryVi, author } hoặc null nếu gọi API lỗi (thiếu
 * key, hết hạn mức, mất mạng, model trả rỗng...) — bên gọi (worldNews.js)
 * tự quyết định không hiển thị bài đó hôm nay khi nhận null, thay vì hiện
 * nội dung gốc chưa qua dịch/tóm tắt/kiểm duyệt. Mọi lý do thất bại đều
 * được in ra console để dễ tra cứu (xem log server).
 */
export async function summarizeAndMaybeTranslate(title, articleText) {
  if (!GEMINI_API_KEY) {
    console.warn("aiSummarize: thiếu GEMINI_API_KEY trong .env, bỏ qua tóm tắt AI");
    return null;
  }
  const text = String(articleText || "").trim();
  if (text.length < 50) {
    console.warn("aiSummarize: nội dung bài quá ngắn/rỗng, không đủ để tóm tắt");
    return null;
  }

  try {
    const resp = await axios.post(
      `${GEMINI_URL}?key=${GEMINI_API_KEY}`,
      {
        contents: [{ role: "user", parts: [{ text: buildPrompt(title, text) }] }],
        generationConfig: {
          // Để cao vì các model đời mới trừ luôn token "suy nghĩ ngầm"
          // vào hạn mức này — thấp quá sẽ ra nội dung rỗng (xem ghi chú
          // đầu file).
          maxOutputTokens: 3072,
          responseMimeType: "application/json"
        }
      },
      { timeout: 30000, headers: { "Content-Type": "application/json" } }
    );

    const candidate = resp.data?.candidates?.[0];
    const parts = candidate?.content?.parts || [];
    const raw = parts.map((p) => p.text || "").join("");
    const finishReason = candidate?.finishReason;
    const thoughtsTokens = resp.data?.usageMetadata?.thoughtsTokenCount;

    if (!raw.trim()) {
      console.warn(
        "aiSummarize: Gemini trả về RỖNG. finishReason =", finishReason,
        "| token dùng cho suy nghĩ ngầm =", thoughtsTokens,
        "| promptFeedback =", JSON.stringify(resp.data?.promptFeedback || {}),
        "-> nếu finishReason là MAX_TOKENS, thử tăng maxOutputTokens trong aiSummarize.js;",
        "nếu là SAFETY, bài này bị bộ lọc an toàn của Gemini chặn."
      );
      return null;
    }

    const parsed = extractJson(raw);
    if (!parsed || typeof parsed.summaryVi !== "string") {
      console.warn("aiSummarize: không đọc được JSON hợp lệ từ phản hồi Gemini. Nội dung thô nhận được:", raw.slice(0, 500));
      return null;
    }

    return {
      skip: Boolean(parsed.skip),
      titleVi: fixVietnameseDiacritics(String(parsed.titleVi || title).trim()).normalize("NFC"),
      summaryVi: fixVietnameseDiacritics(parsed.summaryVi.trim()).normalize("NFC"),
      author: fixVietnameseDiacritics(String(parsed.author || "").trim()).normalize("NFC")
    };
  } catch (err) {
    const detail = err.response
      ? `HTTP ${err.response.status} - ${JSON.stringify(err.response.data)}`
      : err.message;
    console.warn("aiSummarize: gọi Gemini lỗi -", detail);
    return null;
  }
}
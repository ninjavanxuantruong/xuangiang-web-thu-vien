// viet-normalizer.js
// Chuyển từ logic Python sang Node.js, dùng cùng phonemes và từ điển Viet39K.txt

import fs from "fs";
import {
  CONSONANTS,
  VOWELS_SINGLE,
  VOWELS_DOUBLE,
  VOWELS_TRIPLE,
  VOWELS_STANDALONE_ADMIN
} from "./phonemes.js";

// Chuẩn hóa Unicode + lowercase (tương đương: NFKC -> casefold -> NFC)
function norm(s) {
  if (!s) return "";
  s = s.trim();
  if (!s) return "";
  // JS có s.normalize(), dùng NFKC trước để tương thích nhập liệu
  s = s.normalize("NFKC");
  // Gần tương đương casefold: hạ thấp theo locale tiếng Việt
  s = s.toLocaleLowerCase("vi");
  // Chuẩn NFC cuối cùng
  s = s.normalize("NFC");
  return s;
}

// Load từ điển Viet39K.txt, normalize từng dòng
function loadDictionary(path) {
  const content = fs.readFileSync(path, "utf8");
  const lines = content.split(/\r?\n/).filter(Boolean);
  const words = new Set(lines.map(w => norm(w)));
  return words;
}

// Khởi tạo dictionary (đổi đường dẫn theo vị trí thực tế của file)
const dictionary = loadDictionary("Viet39K.txt");

// Kiểm tra từ trong từ điển (bao gồm từng phần nếu từ điển có cụm)
function isValidWord(word) {
  const w = norm(word);
  if (dictionary.has(w)) return true;
  for (const d of dictionary) {
    const parts = d.split(" ");
    if (parts.includes(w)) return true;
  }
  return false;
}

// Tách chữ và dấu câu: trả về [wordNormalized, punct]
function splitPunct(token) {
  // Giữ chữ (Unicode), số, dấu gạch ngang và gạch chéo trong phần word
  const m = token.match(/^([\p{L}\p{N}\-\/]+)([^\p{L}\p{N}\-\/]*)$/u);
  if (m) {
    return [norm(m[1]), m[2]];
  }
  return [norm(token), ""];
}




const MAX_SYLLABLE_LEN = 8;
const MAX_CODA_LEN = 2;

// Kiểm tra hợp lệ theo phoneme: onset + vowel (triple/double/single) + coda (rỗng hoặc phụ âm)
function isValidSyllable(s) {
  s = s.normalize("NFC");
  for (const onset of CONSONANTS) {
    if (s.startsWith(onset)) {
      const rest = s.slice(onset.length);
      // Ưu tiên tập nguyên âm dài trước
      for (const vset of [VOWELS_TRIPLE, VOWELS_DOUBLE, VOWELS_SINGLE]) {
        for (const v of vset) {
          if (rest.startsWith(v)) {
            const coda = rest.slice(v.length);
            if (coda === "" || CONSONANTS.includes(coda)) {
              return true;
            }
          }
        }
      }
    }
  }
  return false;
}

// Round 1: xử lý cơ bản (longest-match, ghép với trước nếu có)
function normalizeText(text) {
  const tokens = text.split(/\s+/).filter(t => t.length > 0);
  const result = [];   // sẽ chứa object {word, punct, modified}
  const logs = [];
  let i = 0;

  logs.push("=== Bắt đầu normalize (round 1) ===");
  logs.push(`Input tokens: ${JSON.stringify(tokens)}`);

  while (i < tokens.length) {
    const [word, punct] = splitPunct(tokens[i]);
    let modified = false; // mặc định chưa bị tác động
    logs.push(`\nXử lý token[${i}]: ${word} (punct='${punct}')`);

    // 1) Token là phụ âm
    if (CONSONANTS.includes(word)) {
      let lastValid = null;
      let lastJ = null;

      if (result.length > 0) {
        const [prevBase, prevPunct] = splitPunct(result[result.length - 1].word + result[result.length - 1].punct);
        let j = i;
        while (j < tokens.length) {
          const candidateRaw = prevBase + tokens.slice(i, j + 1).join("");
          const candidate = norm(candidateRaw);
          if (candidate.length > MAX_SYLLABLE_LEN) break;
          if (isValidWord(candidate)) {
            lastValid = candidate;
            lastJ = j;
          }
          j++;
        }
        if (lastValid !== null) {
          result[result.length - 1] = {word: lastValid, punct: prevPunct + punct, modified: true};
          i = lastJ + 1;
          continue;
        }
      }

      let j = i + 1;
      while (j < tokens.length) {
        const candidateRaw = word + tokens.slice(i + 1, j + 1).join("");
        const candidate = norm(candidateRaw);
        if (candidate.length > MAX_SYLLABLE_LEN) break;
        if (isValidWord(candidate)) {
          lastValid = candidate;
          lastJ = j;
        }
        j++;
      }
      if (lastValid !== null) {
        result.push({word: lastValid, punct, modified: true});
        i = lastJ + 1;
      } else {
        // giữ nguyên nhưng nếu hợp lệ theo phoneme thì modified = true
        if (isValidSyllable(word)) {
          result.push({word, punct, modified: true});
        } else {
          result.push({word, punct, modified});
        }
        i++;
      }
      continue;
    }

    // 2) Token là nguyên âm
    const isVowel =
      VOWELS_SINGLE.includes(word) ||
      VOWELS_DOUBLE.includes(word) ||
      VOWELS_TRIPLE.includes(word);

    if (isVowel) {
      if (VOWELS_STANDALONE_ADMIN.has(word)) {
        result.push({word, punct, modified});
        i++;
        continue;
      }

      let lastValid = null;
      let lastJ = null;
      if (result.length > 0) {
        const [prevBase, prevPunct] = splitPunct(result[result.length - 1].word + result[result.length - 1].punct);
        let j = i;
        while (j < tokens.length) {
          const candidateRaw = prevBase + tokens.slice(i, j + 1).join("");
          const candidate = norm(candidateRaw);
          if (candidate.length > MAX_SYLLABLE_LEN) break;
          if (isValidWord(candidate)) {
            lastValid = candidate;
            lastJ = j;
          }
          j++;
        }
        if (lastValid !== null) {
          result[result.length - 1] = {word: lastValid, punct: prevPunct + punct, modified: true};
          i = lastJ + 1;
          continue;
        }
      }

      let j = i;
      while (j < tokens.length) {
        const candidateRaw = tokens.slice(i, j + 1).join("");
        const candidate = norm(candidateRaw);
        if (candidate.length > MAX_SYLLABLE_LEN) break;
        if (isValidWord(candidate)) {
          lastValid = candidate;
          lastJ = j;
        }
        j++;
      }
      if (lastValid !== null) {
        result.push({word: lastValid, punct, modified: true});
        i = lastJ + 1;
      } else {
        // giữ nguyên nhưng nếu hợp lệ theo phoneme thì modified = true
        if (isValidSyllable(word)) {
          result.push({word, punct, modified: true});
        } else {
          result.push({word, punct, modified});
        }
        i++;
      }
      continue;
    }

    // 3) Token khác → coi là không thể động, giữ nguyên như cũ
    if (/[0-9]/.test(word) || isValidWord(word)) {
      result.push({word, punct, modified});
    } else {
      result.push({word, punct, modified});
    }
    i++;
  }

  logs.push("=== Kết quả normalize (round 1) ===");
  logs.push(`Output: ${JSON.stringify(result)}`);

  // Round 2: chỉ truyền sang postProcess danh sách object này
  const [result2, logs2] = postProcess(result);
  logs.push(...logs2);
  logs.push("=== Kết quả sau post_process (round 2) ===");
  logs.push(`Output: ${JSON.stringify(result2)}`);

  return [result2.map(r => r.word + r.punct).join(" "), logs];
}




// Round 2: post_process với “nhả phụ âm”
function postProcess(tokens) {
  const final = [];
  const logs = [];
  let i = 0;

  logs.push("=== Bắt đầu post_process (round 2) ===");
  logs.push(`Input tokens: ${JSON.stringify(tokens)}`);

  while (i < tokens.length) {
    const {word, punct, modified} = tokens[i];   // lấy object từ round 1
    const wordNorm = norm(word);
    logs.push(`\n[Round2] Xử lý token[${i}]: '${word}' (punct='${punct}', modified=${modified})`);

    // Nếu token round1 giữ nguyên → bỏ qua xử lý round2
    if (!modified) {
      logs.push("✓ Token round1 giữ nguyên, bỏ qua xử lý round2");
      final.push({word: wordNorm, punct, modified});
      i++;
      continue;
    }

    // 1) Hợp lệ theo phoneme → giữ nguyên
    if (isValidSyllable(wordNorm)) {
      logs.push(`✓ Token hợp lệ (phoneme), giữ nguyên: ${wordNorm}`);
      final.push({word: wordNorm, punct, modified});
      i++;
      continue;
    }

    // 2) Token invalid theo phoneme: nếu trước & sau đều phoneme-valid → xử lý đặc biệt
    let specialHandled = false;
    if (final.length > 0 && i + 1 < tokens.length) {
      const prevObj = final[final.length - 1];
      const [prevBase, prevPunct] = splitPunct(prevObj.word + prevObj.punct);

      // --- Trường hợp 1: valid + invalid + valid ---
      const nextObj = tokens[i + 1];
      const [nextWord] = splitPunct(nextObj.word + nextObj.punct);

      if (isValidSyllable(prevBase) && isValidSyllable(norm(nextWord))) {
        logs.push(`→ Trước & sau đều phoneme-valid: prev='${prevBase}', next='${nextWord}'`);

        if (/[0-9]/.test(prevBase) || /[0-9]/.test(wordNorm)) {
          logs.push("⚠️ Token có số, bỏ qua ghép để giữ nguyên");
          final.push({word: wordNorm, punct, modified});
          i++;
          continue;
        }

        const candidate = norm(prevBase + wordNorm);
        logs.push(`→ Thử ghép prev+word: '${prevBase}+${wordNorm}' = '${candidate}'`);
        if (isValidWord(candidate)) {
          logs.push(`✓ Hợp lệ (dict), thay thế prev bằng: ${candidate}`);
          final[final.length - 1] = {word: candidate, punct: prevPunct + punct, modified: true};
          i++;
          specialHandled = true;
        } else {
          for (const k of [1, 2]) {
            if (prevBase.length <= k) continue;
            const left = prevBase.slice(0, -k);
            const transfer = prevBase.slice(-k);
            const right = norm(transfer + wordNorm);

            logs.push(`→ Thử nhả ${k} phụ âm: prev='${prevBase}' → '${left}' + '${transfer}', right='${transfer}+${wordNorm}' → '${right}'`);

            if (isValidWord(left) && isValidWord(right)) {
              logs.push(`✓ Nhả ${k} phụ âm thành 2 từ hợp lệ: '${left}', '${right}'`);
              final[final.length - 1] = {word: left, punct: prevPunct, modified: true};
              final.push({word: right, punct, modified: true});
              i++;
              specialHandled = true;
              break;
            }
          }
        }
        if (specialHandled) continue;
      }

      // --- Trường hợp 2: valid + invalid + invalid + valid ---
      if (i + 2 < tokens.length) {
        const nextObj1 = tokens[i + 1];
        const [nextWord1] = splitPunct(nextObj1.word + nextObj1.punct);
        const nextObj2 = tokens[i + 2];
        const [nextWord2] = splitPunct(nextObj2.word + nextObj2.punct);

        if (isValidSyllable(prevBase) && isValidSyllable(norm(nextWord2))) {
          logs.push(`→ Trước & sau đều phoneme-valid (2 invalid giữa): prev='${prevBase}', next2='${nextWord2}'`);

          const candidate2 = norm(prevBase + wordNorm + nextWord1);
          logs.push(`→ Thử ghép prev+word+nextWord1: '${prevBase}+${wordNorm}+${nextWord1}' = '${candidate2}'`);
          if (isValidWord(candidate2)) {
            logs.push(`✓ Hợp lệ (dict), thay thế prev bằng: ${candidate2}`);
            final[final.length - 1] = {word: candidate2, punct: prevPunct + punct, modified: true};
            i += 2; // bỏ qua cả 2 invalid
            specialHandled = true;
          } else {
            for (const k of [1, 2]) {
              if (prevBase.length <= k) continue;
              const left = prevBase.slice(0, -k);
              const transfer = prevBase.slice(-k);
              const right = norm(transfer + wordNorm + nextWord1);

              logs.push(`→ Thử nhả ${k} phụ âm với cụm: left='${left}', right='${right}'`);

              if (isValidWord(left) && isValidWord(right)) {
                logs.push(`✓ Nhả ${k} phụ âm thành 2 từ hợp lệ: '${left}', '${right}'`);
                final[final.length - 1] = {word: left, punct: prevPunct, modified: true};
                final.push({word: right, punct, modified: true});
                i += 2;
                specialHandled = true;
                break;
              }
            }
          }
          if (specialHandled) continue;
        }
      }
    }

    // 3) Fallback logic cũ: thử ghép với trước
    if (final.length > 0) {
      const prevObj = final[final.length - 1];
      const [prevBase, prevPunct] = splitPunct(prevObj.word + prevObj.punct);

      if (/[0-9]/.test(prevBase) || /[0-9]/.test(wordNorm)) {
        logs.push("⚠️ Token có số, bỏ qua ghép để giữ nguyên");
        final.push({word: wordNorm, punct, modified});
        i++;
        continue;
      }

      const candidatePrev = norm(prevBase + wordNorm);
      logs.push(`→ Fallback ghép với trước: '${prevBase}+${wordNorm}' = '${candidatePrev}'`);
      if (isValidWord(candidatePrev)) {
        logs.push(`✓ Hợp lệ (dict), thay thế: ${candidatePrev}`);
        final[final.length - 1] = {word: candidatePrev, punct: prevPunct + punct, modified: true};
        i++;
        continue;
      }
    }

    // 4) Fallback: thử ghép với sau
    if (i + 1 < tokens.length) {
      const nextObj = tokens[i + 1];
      const [nextWord, nextPunct] = splitPunct(nextObj.word + nextObj.punct);

      if (/[0-9]/.test(wordNorm) || /[0-9]/.test(nextWord)) {
        logs.push("⚠️ Token có số, bỏ qua ghép với sau để giữ nguyên");
        final.push({word: wordNorm, punct, modified});
        i++;
        continue;
      }

      const candidateNext = norm(wordNorm + nextWord);
      logs.push(`→ Fallback ghép với sau: '${wordNorm}+${nextWord}' = '${candidateNext}'`);
      if (isValidWord(candidateNext)) {
        logs.push(`✓ Hợp lệ (dict), chốt: ${candidateNext}`);
        final.push({word: candidateNext, punct: punct + nextPunct, modified: true});
        i += 2;
        continue;
      }
    }

    // 5) Cuối cùng: giữ nguyên
    logs.push(`✗ Không ghép được, giữ nguyên: '${wordNorm}${punct}'`);
    final.push({word: wordNorm, punct, modified});
    i++;
  }

  logs.push("=== Kết thúc post_process (round 2) ===");
  logs.push(`Output: ${JSON.stringify(final)}`);
  return [final, logs];
}




export {
  norm,
  loadDictionary,
  isValidWord,
  splitPunct,
  isValidSyllable,
  normalizeText,
  postProcess
};


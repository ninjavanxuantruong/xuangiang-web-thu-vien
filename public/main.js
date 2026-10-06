// =========================================================
// THƯ VIỆN ĐẢNG BỘ XUÂN GIANG — main.js
// Toàn bộ hành vi phía trình duyệt: dark mode, carousel banner,
// trình phát TTS (có cache audio ở server + fallback giọng đọc
// trình duyệt), chế độ nghe khi di chuyển, chỉnh cỡ chữ/tốc độ.
// =========================================================

// ---------- 1. DARK MODE ----------
(function initTheme() {
  const saved = localStorage.getItem("theme") || "light";
  document.documentElement.setAttribute("data-theme", saved);

  document.addEventListener("click", (e) => {
    const btn = e.target.closest("[data-toggle-theme]");
    if (!btn) return;
    const current = document.documentElement.getAttribute("data-theme");
    const next = current === "dark" ? "light" : "dark";
    document.documentElement.setAttribute("data-theme", next);
    localStorage.setItem("theme", next);
    btn.textContent = next === "dark" ? "☀️ Sáng" : "🌙 Tối";
  });
})();

// ---------- 1b. CHIA SẺ (copy link) — dùng chung cho mọi nút có
// thuộc tính data-copy-link ở bất kỳ trang nào trong site ----------
document.addEventListener("click", (e) => {
  const btn = e.target.closest("[data-copy-link]");
  if (!btn) return;
  e.preventDefault();
  const url = new URL(btn.getAttribute("data-copy-link"), location.origin).href;
  navigator.clipboard.writeText(url).then(() => {
    const old = btn.textContent;
    btn.textContent = "Đã copy!";
    setTimeout(() => { btn.textContent = old; }, 1500);
  }).catch(() => prompt("Copy link này:", url));
});

// ---------- 2. CAROUSEL BANNER (trang chủ) ----------

// ---------- 2. CAROUSEL BANNER (trang chủ) ----------
function initHeroCarousel(rootSelector) {
  const root = document.querySelector(rootSelector);
  if (!root) return;

  const slides = Array.from(root.querySelectorAll("[data-slide]"));
  const dots = Array.from(root.querySelectorAll("[data-dot]"));
  if (slides.length <= 1) return;

  let index = 0;

  function show(i) {
    slides.forEach((s, si) => (s.style.display = si === i ? "block" : "none"));
    dots.forEach((d, di) => d.classList.toggle("active", di === i));
    index = i;
  }

  root.querySelectorAll("[data-next]").forEach((btn) =>
    btn.addEventListener("click", () => show((index + 1) % slides.length))
  );
  root.querySelectorAll("[data-prev]").forEach((btn) =>
    btn.addEventListener("click", () => show((index - 1 + slides.length) % slides.length))
  );
  dots.forEach((dot, i) => dot.addEventListener("click", () => show(i)));

  show(0);
  const autoTimer = setInterval(() => show((index + 1) % slides.length), 6000);

  // Vuốt trái/phải trên điện thoại để chuyển bài — chỉ bật khi root có
  // thuộc tính data-swipe (không ảnh hưởng carousel khác dùng chung hàm này).
  if (root.hasAttribute("data-swipe")) {
    let touchStartX = 0;
    root.addEventListener("touchstart", (e) => {
      touchStartX = e.touches[0].clientX;
    }, { passive: true });
    root.addEventListener("touchend", (e) => {
      const dx = e.changedTouches[0].clientX - touchStartX;
      if (Math.abs(dx) < 40) return; // vuốt quá ngắn -> bỏ qua
      if (dx < 0) show((index + 1) % slides.length); // vuốt sang trái -> bài kế tiếp
      else show((index - 1 + slides.length) % slides.length); // vuốt sang phải -> bài trước
    }, { passive: true });
  }
}

// ---------- 3. CỠ CHỮ TRANG ĐỌC ----------
function initFontSizeControls() {
  const content = document.querySelector(".reader-content");
  if (!content) return;

  const saved = parseInt(localStorage.getItem("readerFontSize") || "17", 10);
  content.style.setProperty("--reader-font-size", saved + "px");
  content.style.fontSize = saved + "px";

  document.addEventListener("click", (e) => {
    const bigger = e.target.closest("[data-font-bigger]");
    const smaller = e.target.closest("[data-font-smaller]");
    if (!bigger && !smaller) return;

    let size = parseInt(localStorage.getItem("readerFontSize") || "17", 10);
    size = bigger ? Math.min(size + 2, 28) : Math.max(size - 2, 13);

    localStorage.setItem("readerFontSize", size);
    content.style.fontSize = size + "px";
  });
}

// ---------- 4. TRÌNH PHÁT TTS (đọc trang, có highlight) ----------
// Quy ước: mỗi đoạn văn cần đọc bọc trong 1 phần tử có class "tts-chunk".
// Văn bản được tách thành các đoạn nhỏ ≤ 180 ký tự trước khi gọi /tts (server
// từ chối > 200 ký tự thay vì cắt cụt như trước). Tách theo thứ tự: hết câu
// (. ! ? …) -> dấu phẩy/chấm phẩy/hai chấm -> cuối cùng mới tách theo từ; không
// bao giờ cắt giữa từ, và không mất chữ nào.
// Không dùng lookbehind (?<=...) vì iPhone trước iOS 16.4 không hiểu.
const TTSPlayer = (function () {
  const MAX_PART_LENGTH = 180; // server từ chối > 200
  const PREFETCH_AHEAD = 2;    // tải trước 2 đoạn kế tiếp để đọc liền mạch
  const MAX_BUSY_RETRIES = 3;  // server báo bận (429) thì thử lại tối đa 3 lần

  let chunks = [];       // danh sách { el, text }
  let queue = [];        // hàng đợi các đoạn nhỏ { chunkIdx, text }
  let queueIndex = 0;
  let audioEl = null;    // dùng CHUNG 1 thẻ audio cho mọi đoạn (iOS chỉ cho phát
                         // tự động tiếp khi thẻ này đã được mở khoá bằng lần bấm đầu)
  let currentUrl = null;
  let usingBrowserVoice = false; // đoạn hiện tại đang đọc bằng giọng trình duyệt
  let isPlaying = false;
  let isPaused = false;
  let session = 0;       // tăng mỗi lần dừng để bỏ qua kết quả trễ của lượt cũ
  let speed = parseFloat(localStorage.getItem("ttsSpeed") || "1");
  let useBrowserFallback = false; // true = server TTS hỏng hẳn, dùng giọng trình duyệt
  const audioCache = new Map();   // chỉ số đoạn -> Promise<objectURL>

  // ----- Tách văn bản -----
  function hardSplitByWords(text) {
    const out = [];
    let buf = "";
    text.split(" ").forEach((w) => {
      if (w.length > MAX_PART_LENGTH) {
        if (buf) { out.push(buf); buf = ""; }
        for (let i = 0; i < w.length; i += MAX_PART_LENGTH) out.push(w.slice(i, i + MAX_PART_LENGTH));
      } else if (!buf) {
        buf = w;
      } else if ((buf + " " + w).length <= MAX_PART_LENGTH) {
        buf += " " + w;
      } else {
        out.push(buf);
        buf = w;
      }
    });
    if (buf) out.push(buf);
    return out;
  }

  function splitLongSentence(sentence) {
    const clauses = sentence.match(/.+?(?:[,;:](?=\s)|$)/g) || [sentence];
    const out = [];
    let buf = "";
    clauses.forEach((raw) => {
      const c = raw.trim();
      if (!c) return;
      if (c.length > MAX_PART_LENGTH) {
        if (buf) { out.push(buf); buf = ""; }
        hardSplitByWords(c).forEach((p) => out.push(p));
      } else if (!buf) {
        buf = c;
      } else if ((buf + " " + c).length <= MAX_PART_LENGTH) {
        buf += " " + c;
      } else {
        out.push(buf);
        buf = c;
      }
    });
    if (buf) out.push(buf);
    return out;
  }

  function splitIntoSpeakableParts(text) {
    const clean = String(text || "").normalize("NFC").replace(/\s+/g, " ").trim();
    if (!clean) return [];
    // Hết câu = dấu . ! ? … theo sau là khoảng trắng/hết chuỗi (nên "3.5" không bị tách)
    const sentences = (clean.match(/.+?(?:[.!?…]+(?=\s|$)|$)/g) || [clean])
      .map((s) => s.trim())
      .filter(Boolean);

    const parts = [];
    let buf = "";
    sentences.forEach((s) => {
      const pieces = s.length > MAX_PART_LENGTH ? splitLongSentence(s) : [s];
      pieces.forEach((p) => {
        if (!buf) buf = p;
        else if ((buf + " " + p).length <= MAX_PART_LENGTH) buf += " " + p;
        else { parts.push(buf); buf = p; }
      });
    });
    if (buf) parts.push(buf);
    return parts;
  }

  function buildQueue() {
    queue = [];
    chunks.forEach((chunk, chunkIdx) => {
      splitIntoSpeakableParts(chunk.text).forEach((part) => queue.push({ chunkIdx, text: part }));
    });
  }

  // ----- Hiển thị -----
  function highlight(chunkIdx) {
    chunks.forEach((c, i) => c.el.classList.toggle("sentence-highlight", i === chunkIdx));
    if (chunkIdx != null && chunks[chunkIdx]) {
      chunks[chunkIdx].el.scrollIntoView({ behavior: "smooth", block: "center" });
    }
  }

  // ----- Tải audio (có tải trước) -----
  function sleep(ms) {
    return new Promise((r) => setTimeout(r, ms));
  }

  function fetchAudioUrl(i) {
    if (audioCache.has(i)) return audioCache.get(i);
    const text = queue[i].text;

    const p = (async () => {
      for (let attempt = 0; ; attempt++) {
        const res = await fetch("/tts?q=" + encodeURIComponent(text));
        if (res.ok) return URL.createObjectURL(await res.blob());

        // Server báo bận/quá tải -> chờ theo Retry-After rồi thử lại
        if (res.status === 429 && attempt < MAX_BUSY_RETRIES) {
          const wait = Math.min(parseInt(res.headers.get("Retry-After") || "3", 10) || 3, 10);
          await sleep(wait * 1000);
          continue;
        }
        const err = new Error("TTS server trả " + res.status);
        err.status = res.status;
        throw err;
      }
    })();

    audioCache.set(i, p);
    p.catch(() => audioCache.delete(i));
    return p;
  }

  function prefetchAhead(fromIndex) {
    if (useBrowserFallback) return;
    for (let k = 1; k <= PREFETCH_AHEAD; k++) {
      const idx = fromIndex + k;
      if (idx < queue.length && !audioCache.has(idx)) fetchAudioUrl(idx).catch(() => {});
    }
  }

  function clearAudioCache() {
    audioCache.forEach((p) => p.then((url) => URL.revokeObjectURL(url)).catch(() => {}));
    audioCache.clear();
  }

  // ----- Phát -----
  function ensureAudioEl() {
    if (!audioEl) audioEl = new Audio(); // tạo trong lúc người dùng bấm nút
    return audioEl;
  }

  function speakWithBrowser(text, onEnd) {
    if (!("speechSynthesis" in window)) return onEnd();
    usingBrowserVoice = true;
    const utter = new SpeechSynthesisUtterance(text);
    utter.lang = "vi-VN";
    utter.rate = speed;
    utter.onend = () => { usingBrowserVoice = false; onEnd(); };
    utter.onerror = () => { usingBrowserVoice = false; onEnd(); };
    window.speechSynthesis.speak(utter);
  }

  function advance(mySession) {
    if (mySession !== session) return;
    queueIndex++;
    if (isPlaying) playCurrent();
  }

  async function playCurrent() {
    const mySession = session;

    if (queueIndex >= queue.length) {
      isPlaying = false;
      isPaused = false;
      highlight(null);
      queueIndex = 0;
      return;
    }

    const idx = queueIndex;
    const item = queue[idx];
    highlight(item.chunkIdx);

    if (useBrowserFallback) {
      speakWithBrowser(item.text, () => advance(mySession));
      return;
    }

    try {
      const url = await fetchAudioUrl(idx);
      if (mySession !== session) return;   // đã bấm Dừng trong lúc chờ
      if (!isPlaying) return;              // đã bấm Tạm dừng trong lúc chờ (audio vẫn giữ trong cache)

      prefetchAhead(idx);

      const audio = ensureAudioEl();
      currentUrl = url;
      audio.onended = () => {
        audioCache.delete(idx);
        URL.revokeObjectURL(url);
        currentUrl = null;
        advance(mySession);
      };
      audio.onerror = () => {
        // File audio hỏng -> đọc riêng đoạn này bằng giọng trình duyệt rồi đi tiếp
        currentUrl = null;
        speakWithBrowser(item.text, () => advance(mySession));
      };
      audio.src = url;
      audio.defaultPlaybackRate = speed;
      audio.playbackRate = speed;
      await audio.play();
    } catch (err) {
      if (mySession !== session) return;
      const status = err && err.status;
      if (status === 429 || status === 413 || status === 400) {
        // Server tạm bận / đoạn bị từ chối: chỉ đọc RIÊNG đoạn này bằng giọng
        // trình duyệt, đoạn sau vẫn thử lại server.
        console.warn("TTS server từ chối đoạn này (" + status + "), dùng giọng trình duyệt cho đoạn này");
        speakWithBrowser(item.text, () => advance(mySession));
      } else if (err && err.name === "NotAllowedError") {
        // Trình duyệt chặn phát tự động -> dừng hẳn, để người dùng bấm lại
        isPlaying = false;
        isPaused = true;
      } else {
        console.warn("TTS server không dùng được, chuyển sang giọng đọc trình duyệt:", err && err.message);
        useBrowserFallback = true;
        clearAudioCache();
        playCurrent();
      }
    }
  }

  return {
    init(chunkElements) {
      chunks = chunkElements.map((el) => ({ el, text: el.innerText.trim() })).filter((c) => c.text);
      buildQueue();
      queueIndex = 0;
    },
    // Bắt đầu, hoặc tiếp tục nếu đang tạm dừng. Gọi khi đang phát thì không làm gì.
    play() {
      if (isPlaying) return;
      if (isPaused) return this.resume();
      if (queue.length === 0) return;
      ensureAudioEl();
      isPlaying = true;
      playCurrent();
    },
    pause() {
      if (!isPlaying) return;
      isPlaying = false;
      isPaused = true;
      if (audioEl) audioEl.pause();
      if (usingBrowserVoice && window.speechSynthesis) window.speechSynthesis.pause();
    },
    resume() {
      isPlaying = true;
      isPaused = false;
      if (usingBrowserVoice && window.speechSynthesis) {
        window.speechSynthesis.resume();
      } else if (audioEl && currentUrl && audioEl.paused) {
        audioEl.play().catch(() => {});
      } else {
        playCurrent();
      }
    },
    stop() {
      session++;
      isPlaying = false;
      isPaused = false;
      usingBrowserVoice = false;
      if (audioEl) {
        audioEl.pause();
        audioEl.removeAttribute("src");
        audioEl.load();
      }
      currentUrl = null;
      clearAudioCache();
      window.speechSynthesis && window.speechSynthesis.cancel();
      highlight(null);
      queueIndex = 0;
    },
    // Dừng hẳn lượt đang đọc dở (tăng session để bỏ qua audio đang tải dở
    // của lượt cũ — đúng ý số 5 đã bàn, tránh 2 đoạn chồng tiếng nhau),
    // rồi nhảy tới đoạn/trang chunkIdx và phát luôn từ đó.
    playFromChunk(chunkIdx) {
      session++;
      isPlaying = false;
      isPaused = false;
      usingBrowserVoice = false;
      if (audioEl) {
        audioEl.pause();
        audioEl.removeAttribute("src");
        audioEl.load();
      }
      currentUrl = null;
      clearAudioCache();
      window.speechSynthesis && window.speechSynthesis.cancel();

      const startIndex = queue.findIndex((item) => item.chunkIdx === chunkIdx);
      queueIndex = startIndex === -1 ? 0 : startIndex;

      ensureAudioEl();
      isPlaying = true;
      playCurrent();
    },
    setSpeed(value) {
      speed = value;
      localStorage.setItem("ttsSpeed", value);
      if (audioEl) {
        audioEl.defaultPlaybackRate = value;
        audioEl.playbackRate = value;
      }
    },
    getSpeed() {
      return speed;
    },
    isPlaying() {
      return isPlaying;
    },
    // Chỉ để kiểm thử/gỡ lỗi
    _split: splitIntoSpeakableParts
  };
})();

let readerControlsBound = false;

function initReaderPlayer() {
  const chunkEls = Array.from(document.querySelectorAll(".tts-chunk"));
  if (chunkEls.length === 0) return;

  TTSPlayer.init(chunkEls);

  // Nút "▶" nhảy đọc từ đúng đoạn/trang này — chèn 1 lần cho mỗi
  // .tts-chunk. Đoạn văn (Word) thì nút trôi bên trái đầu đoạn (float);
  // trang PDF thì nút nằm ở góc trên-trái của trang (đã có sẵn
  // position:relative ở .pdf-page trong reader.ejs).
  // TTSPlayer.init() ở trên đã BỎ QUA mọi .tts-chunk rỗng (không có chữ)
  // khi đánh số chunkIdx nội bộ -> số trên nút "▶" PHẢI đếm giống hệt vậy
  // (chỉ tăng khi đoạn có chữ), nếu không sẽ bị lệch số mỗi khi có đoạn
  // trắng nằm ở giữa, gây bấm 1 đoạn mà lại đọc sang đoạn khác.
  let filledIdx = 0;
  chunkEls.forEach((el) => {
    if (el.querySelector(":scope > .tts-jump-btn")) return; // đã chèn rồi thì bỏ qua
    if (!el.innerText.trim()) return; // đoạn rỗng -> không có gì để đọc, không gắn nút

    const idx = filledIdx++;
    const btn = document.createElement("button");
    btn.type = "button";
    btn.className = "tts-jump-btn" + (el.classList.contains("pdf-page") ? " tts-jump-btn--page" : "");
    btn.setAttribute("data-jump-chunk", idx);
    btn.title = "Đọc từ đây";
    btn.textContent = "▶";
    el.insertBefore(btn, el.firstChild);
  });

  if (readerControlsBound) return; // chỉ gắn sự kiện bấm nút 1 lần
  readerControlsBound = true;

  document.addEventListener("click", (e) => {
    if (e.target.closest("[data-tts-play]")) {
      TTSPlayer.isPlaying() ? TTSPlayer.pause() : TTSPlayer.play();
    }
    if (e.target.closest("[data-tts-stop]")) TTSPlayer.stop();
    if (e.target.closest("[data-speed-up]")) TTSPlayer.setSpeed(Math.min(TTSPlayer.getSpeed() + 0.25, 2));
    if (e.target.closest("[data-speed-down]")) TTSPlayer.setSpeed(Math.max(TTSPlayer.getSpeed() - 0.25, 0.5));

    const jumpBtn = e.target.closest("[data-jump-chunk]");
    if (jumpBtn) TTSPlayer.playFromChunk(parseInt(jumpBtn.getAttribute("data-jump-chunk"), 10));
  });
}

// ---------- 5. CHẾ ĐỘ NGHE KHI DI CHUYỂN ----------
function initListenMode(docName) {
  document.addEventListener("click", (e) => {
    if (e.target.closest("[data-open-listen-mode]")) {
      const overlay = document.createElement("div");
      overlay.className = "listen-mode";
      overlay.innerHTML = `
        <div class="doc-name">${docName}</div>
        <div class="big-controls">
          <button data-speed-down>−</button>
          <button data-tts-play>▶</button>
          <button data-speed-up>+</button>
        </div>
        <button data-close-listen-mode style="margin-top:16px;background:none;border:none;color:var(--text-muted);">Đóng</button>
      `;
      document.body.appendChild(overlay);
      TTSPlayer.play();

      overlay.addEventListener("click", (ev) => {
        if (ev.target.closest("[data-close-listen-mode]")) {
          TTSPlayer.pause();
          overlay.remove();
        }
      });
    }
  });
}

// Cho phép gọi lại từ bên ngoài (ví dụ reader.ejs sau khi PDF.js render
// xong và thêm các phần tử .tts-chunk mới vào DOM một cách bất đồng bộ).
window.initReaderPlayer = initReaderPlayer;

// ---------- 6. TỰ CẬP NHẬT "BÀI ĐỌC ĐỀ XUẤT" (không cần F5) ----------
// Lần đầu tải trang, một số nguồn tin có thể chưa kịp lấy được bài/ảnh thật
// (đang xử lý ở nền). Hàm này tự hỏi lại server sau vài giây, thấy dữ liệu
// khác đi thì tự thay vào DOM, người dùng không cần bấm gì cả.
function renderHeroSlides(posts) {
  const container = document.getElementById("heroBanner");
  if (!container) return;

  const slides = posts
    .slice(0, 5)
    .map(
      (post, i) => `
      <a href="${post.link}" target="_blank" rel="noopener" data-slide style="${i === 0 ? "" : "display:none"}">
        <img src="${post.image}" alt="${post.title}" />
        <div class="overlay">
          <span class="badge">${post.name}</span>
          <div class="headline">${post.title}</div>
        </div>
      </a>`
    )
    .join("");

  const dots = posts
    .slice(0, 5)
    .map((_, i) => `<span data-dot class="${i === 0 ? "active" : ""}"></span>`)
    .join("");

  container.innerHTML = `${slides}<div class="hero-dots">${dots}</div>`;
  initHeroCarousel("[data-hero-carousel]"); // gắn lại sự kiện chuyển slide
}

function renderSuggestedRow(posts) {
  const row = document.getElementById("suggestedRow");
  if (!row) return;

  row.innerHTML = posts
    .slice(1)
    .map(
      (post) => `
      <a class="card" href="${post.link}" target="_blank" rel="noopener">
        <div class="card-thumb"><img src="${post.image}" alt="${post.title}" /></div>
        <div class="card-title">${post.title}</div>
        <div class="card-tag">${post.name}</div>
      </a>`
    )
    .join("");
}

function initSuggestedPostsAutoRefresh() {
  const dataEl = document.getElementById("initialSuggestedPosts");
  if (!dataEl) return;

  let current;
  try {
    current = JSON.parse(dataEl.textContent || "[]");
  } catch {
    current = [];
  }
  if (current.length === 0) return;

  async function checkForUpdates() {
    try {
      const res = await fetch("/api/bai-doc-de-xuat");
      const data = await res.json();
      const updated = data.suggestedPosts || [];

      if (JSON.stringify(updated) !== JSON.stringify(current)) {
        current = updated;
        renderHeroSlides(current);
        renderSuggestedRow(current);
      }
    } catch (err) {
      console.warn("Không tự cập nhật được bài đọc đề xuất:", err.message);
    }
  }

  // GIAI ĐOẠN 1 — dồn dập ngay sau khi tải trang (mỗi 5 giây, 6 lần =
  // khoảng 30 giây) để bắt kịp kết quả các nguồn đang xử lý ở nền lần đầu.
  const CATCH_UP_INTERVAL_MS = 5000;
  const CATCH_UP_TRIES = 6;
  let tries = 0;

  const catchUpTimer = setInterval(() => {
    tries++;
    checkForUpdates();
    if (tries >= CATCH_UP_TRIES) {
      clearInterval(catchUpTimer);

      // GIAI ĐOẠN 2 — sau đợt dồn dập, giãn ra vài phút/lần để theo dõi
      // bài mới xuất bản mà không hao pin/dữ liệu di động của người xem.
      const SLOW_INTERVAL_MS = 5 * 60 * 1000; // 5 phút
      setInterval(checkForUpdates, SLOW_INTERVAL_MS);
    }
  }, CATCH_UP_INTERVAL_MS);
}

// ---------- 7. ẢNH BÌA TỰ SINH CHO THẺ TÀI LIỆU ----------
// Hoàn toàn xử lý ở trình duyệt bằng SVG tự vẽ — KHÔNG tải ảnh, KHÔNG gọi
// thêm request nào, không ảnh hưởng tốc độ tải trang.
//
// Quy tắc "random": mỗi PHIÊN TRUY CẬP (sessionStorage — tự reset khi đóng
// tab/trình duyệt), MỖI LOẠI văn bản (nq, ct, kh...) được bốc thăm 1 KIỂU
// thẻ trong 3 kiểu bên dưới, rồi áp dụng ĐÚNG kiểu đó cho MỌI văn bản cùng
// loại — không random riêng theo từng văn bản nữa, tránh lộn xộn khi 2 thẻ
// cùng loại lại hiện 2 bố cục khác nhau.

function normalizeForMatch(str) {
  return str
    .toLowerCase()
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/đ/g, "d");
}

// Làm tối/sáng 1 màu hex đi 1 lượng percent (âm = tối hơn, dương = sáng hơn)
// — dùng để tự tạo điểm dừng thứ 2 cho gradient từ đúng 1 màu gốc mỗi loại.
function shadeColor(hex, percent) {
  const num = parseInt(hex.replace("#", ""), 16);
  const clamp = (v) => Math.min(255, Math.max(0, v));
  const r = clamp((num >> 16) + percent);
  const g = clamp(((num >> 8) & 0x00ff) + percent);
  const b = clamp((num & 0x0000ff) + percent);
  return "#" + (0x1000000 + r * 0x10000 + g * 0x100 + b).toString(16).slice(1);
}

// Icon nét dày hơn (stroke-width 2), bo góc mềm — đồng bộ 1 phong cách
// "line icon hiện đại" cho toàn bộ 10 loại. Luôn nhận currentColor qua
// tham số c để dùng lại được cả bản trắng (trên nền màu) lẫn bản màu
// (trên nền trắng, kiểu chip tròn).
const DOC_ICONS = {
  nq: (c, s) =>
    `<svg width="${s}" height="${s}" viewBox="0 0 24 24" fill="none" stroke="${c}" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="5" y="3" width="14" height="18" rx="2.5"></rect><path d="M9 8h6M9 12h6M9 16h3"></path></svg>`,
  ct: (c, s) =>
    `<svg width="${s}" height="${s}" viewBox="0 0 24 24" fill="none" stroke="${c}" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M5 3v18"></path><path d="M5 4h13l-3.5 4L18 12H5"></path></svg>`,
  kh: (c, s) =>
    `<svg width="${s}" height="${s}" viewBox="0 0 24 24" fill="none" stroke="${c}" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="4" y="5" width="16" height="15" rx="2.5"></rect><path d="M4 10h16M8 3v4M16 3v4M8.5 14.5l1.8 1.8L15 12.5"></path></svg>`,
  hd: (c, s) =>
    `<svg width="${s}" height="${s}" viewBox="0 0 24 24" fill="none" stroke="${c}" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M4 6.5C6.7 5 9.3 5 12 6.5C14.7 5 17.3 5 20 6.5V19C17.3 17.5 14.7 17.5 12 19C9.3 17.5 6.7 17.5 4 19Z"></path><path d="M12 6.5V19"></path></svg>`,
  cv: (c, s) =>
    `<svg width="${s}" height="${s}" viewBox="0 0 24 24" fill="none" stroke="${c}" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="5" width="18" height="14" rx="2.5"></rect><path d="M3.5 6.5 12 13 20.5 6.5"></path></svg>`,
  bc: (c, s) =>
    `<svg width="${s}" height="${s}" viewBox="0 0 24 24" fill="none" stroke="${c}" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M5 20V13M12 20V8M19 20v-6"></path><path d="M4 20h16"></path></svg>`,
  tb: (c, s) =>
    `<svg width="${s}" height="${s}" viewBox="0 0 24 24" fill="none" stroke="${c}" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M7 14V9C7 5.5 9.2 3 12 3C14.8 3 17 5.5 17 9V14L19 17H5Z"></path><path d="M10.5 20a1.8 1.8 0 0 0 3 0"></path></svg>`,
  kl: (c, s) =>
    `<svg width="${s}" height="${s}" viewBox="0 0 24 24" fill="none" stroke="${c}" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="9"></circle><path d="M8 12.5 10.8 15.3 16 9.3"></path></svg>`,
  qd: (c, s) =>
    `<svg width="${s}" height="${s}" viewBox="0 0 24 24" fill="none" stroke="${c}" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="5" y="5" width="14" height="14" rx="4"></rect><path d="M9 12.5 11.3 14.8 15.5 9.8"></path></svg>`,
  khac: (c, s) =>
    `<svg width="${s}" height="${s}" viewBox="0 0 24 24" fill="none" stroke="${c}" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M6 3h9l4 4v14H6Z"></path><path d="M15 3v4h4M9 13h6M9 16.5h6"></path></svg>`
};

// 10 màu trải đều bánh xe màu (cách nhau ~35-40°) để KHÔNG có 2 loại nào
// gần giống nhau — bản cũ có nq/ct/tb đều ngả nâu-cam nên nhìn na ná nhau.
// Mỗi loại có luôn "nhãn" viết tắt hiển thị dạng chip để nhận diện nhanh
// bằng chữ, không chỉ dựa vào màu/icon.
const DOC_CATEGORIES = [
  { key: "nq", label: "NQ", color: "#C0392B", phrase: /nghi\s*quyet/, abbr: /\bnq\b/ },       // đỏ đô
  { key: "ct", label: "CT", color: "#D9781C", phrase: /chi\s*thi/, abbr: /\bct\b/ },            // cam
  { key: "tb", label: "TB", color: "#A8841C", phrase: /thong\s*bao/, abbr: /\btb\b/ },          // vàng đồng
  { key: "hd", label: "HD", color: "#1E8F5E", phrase: /huong\s*dan/, abbr: /\bhd\b/ },          // xanh lá
  { key: "kl", label: "KL", color: "#12857A", phrase: /ket\s*luan/, abbr: /\bkl\b/ },           // xanh ngọc
  { key: "kh", label: "KH", color: "#1F6FB2", phrase: /ke\s*hoach/, abbr: /\bkh\b/ },           // xanh dương
  { key: "qd", label: "QĐ", color: "#34495E", phrase: /quyet\s*dinh/, abbr: /\bqd\b/ },         // xanh than
  { key: "cv", label: "CV", color: "#6C3FA0", phrase: /cong\s*van/, abbr: /\bcv\b/ },           // tím
  { key: "bc", label: "BC", color: "#B23A6B", phrase: /bao\s*cao/, abbr: /\bbc\b/ }              // hồng cánh sen
];
const DEFAULT_CATEGORY = { key: "khac", label: "KHÁC", color: "#6B7280" };

function detectDocCategory(rawName) {
  const name = normalizeForMatch(rawName || "");
  const byPhrase = DOC_CATEGORIES.find((c) => c.phrase.test(name));
  if (byPhrase) return byPhrase;
  const byAbbr = DOC_CATEGORIES.find((c) => c.abbr.test(name));
  if (byAbbr) return byAbbr;
  return DEFAULT_CATEGORY;
}

function coverBadge(cat, align) {
  return `<span style="position:absolute;top:8px;${align}:8px;background:rgba(255,255,255,0.22);color:#fff;font-size:10px;font-weight:700;letter-spacing:0.03em;padding:3px 8px;border-radius:20px;backdrop-filter:blur(2px);">${cat.label}</span>`;
}

// Kiểu 1 — "Solid": gradient chéo phủ kín, icon trắng lớn giữa thẻ, chip
// nhãn góc trái trên. Rõ ràng, mạnh, dễ đọc ở kích thước nhỏ.
function coverStyle1(cat) {
  const dark = shadeColor(cat.color, -35);
  const icon = DOC_ICONS[cat.key]("#ffffff", 34);
  return `<div style="width:100%;height:100%;position:relative;background:linear-gradient(135deg, ${cat.color} 0%, ${dark} 100%);display:flex;align-items:center;justify-content:center;">
    ${coverBadge(cat, "left")}
    ${icon}
  </div>`;
}

// Kiểu 2 — "Watermark": gradient nền, 1 icon mờ khổ lớn làm hoạ tiết góc
// dưới phải, icon chính sắc nét ở giữa — tạo chiều sâu, nhìn hiện đại hơn
// mảng màu phẳng.
function coverStyle2(cat) {
  const dark = shadeColor(cat.color, -35);
  const bigIcon = DOC_ICONS[cat.key]("#ffffff", 78);
  const icon = DOC_ICONS[cat.key]("#ffffff", 30);
  return `<div style="width:100%;height:100%;position:relative;overflow:hidden;background:linear-gradient(135deg, ${cat.color} 0%, ${dark} 100%);">
    <div style="position:absolute;right:-16px;bottom:-16px;opacity:0.18;">${bigIcon}</div>
    ${coverBadge(cat, "left")}
    <div style="position:absolute;inset:0;display:flex;align-items:center;justify-content:center;">${icon}</div>
  </div>`;
}

// Kiểu 3 — "Chip nổi": gradient nền, icon màu-của-loại đặt trong khối tròn
// trắng nổi khối (shadow) ở giữa — tương phản cao, cảm giác "app hiện đại".
function coverStyle3(cat) {
  const dark = shadeColor(cat.color, -35);
  const icon = DOC_ICONS[cat.key](cat.color, 26);
  return `<div style="width:100%;height:100%;position:relative;background:linear-gradient(135deg, ${cat.color} 0%, ${dark} 100%);display:flex;align-items:center;justify-content:center;">
    ${coverBadge(cat, "right")}
    <div style="width:48px;height:48px;border-radius:50%;background:#fff;display:flex;align-items:center;justify-content:center;box-shadow:0 3px 8px rgba(0,0,0,0.22);">${icon}</div>
  </div>`;
}

// Random theo PHIÊN + theo LOẠI (không theo từng văn bản riêng lẻ):
// sessionStorage tự mất khi đóng trình duyệt/tab -> đúng ý "mỗi session 1
// kiểu", còn khoá lưu theo category.key (không phải tên văn bản) -> mọi
// văn bản cùng loại trong phiên này luôn ra cùng 1 kiểu thẻ.
function getSessionCoverStyle(categoryKey) {
  const storageKey = `docCoverStyle:${categoryKey}`;
  try {
    const saved = sessionStorage.getItem(storageKey);
    if (saved !== null) return parseInt(saved, 10);
    const idx = Math.floor(Math.random() * 3) + 1;
    sessionStorage.setItem(storageKey, idx);
    return idx;
  } catch {
    // sessionStorage bị chặn (chế độ ẩn danh nghiêm ngặt...) -> vẫn cứ
    // random ra 1 kiểu để trang không vỡ, chỉ là không ổn định giữa các
    // thẻ nếu hàm bị gọi nhiều lần trong cùng lượt render (hiếm khi xảy ra
    // vì initDocCovers chỉ chạy 1 lần lúc tải trang).
    return Math.floor(Math.random() * 3) + 1;
  }
}

function initDocCovers() {
  document.querySelectorAll("[data-doc-cover]").forEach((el) => {
    const docName = el.getAttribute("data-doc-cover");
    const category = detectDocCategory(docName);
    const styleIdx = getSessionCoverStyle(category.key);
    const render = styleIdx === 1 ? coverStyle1 : styleIdx === 2 ? coverStyle2 : coverStyle3;
    el.innerHTML = render(category);
  });
}

// ---------- Khởi chạy khi trang tải xong ----------
document.addEventListener("DOMContentLoaded", () => {
  initDocCovers();
  initSuggestedPostsAutoRefresh();
  initHeroCarousel("[data-hero-carousel]");
  initFontSizeControls();
  initReaderPlayer();
  const docNameEl = document.querySelector("[data-doc-name]");
  if (docNameEl) initListenMode(docNameEl.textContent.trim());
});
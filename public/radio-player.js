// Phát thanh đề xuất:
//  - Nút "Nghe trực tiếp" (luồng HLS .m3u8). Safari/iOS phát được sẵn; Chrome/Firefox/Edge
//    cần thư viện hls.js, chỉ tải khi người xem bấm nghe lần đầu (không làm nặng trang chủ).
//  - Thử nghe thẳng từ đài; nếu đài chặn (403/CORS) thì tự chuyển sang cầu nối qua server mình.
//    Cầu nối có GIỚI HẠN số người nghe cùng lúc -> hết chỗ thì báo người xem bấm "Nguồn" để nghe ở trang gốc.
//  - Tự dừng sau 30 phút để khỏi tốn băng thông khi người xem quên tắt.
//  - Mỗi lúc chỉ 1 nguồn phát: bấm nguồn này thì dừng nguồn kia (kể cả podcast, nhạc nền).
//  - Nút "Xem thêm" mở các bản tin còn lại.
(function () {
  var box = document.getElementById("radioBlock");
  if (!box) return;

  var HLS_JS = "https://cdn.jsdelivr.net/npm/hls.js@1.5/dist/hls.min.js";
  var MAX_LISTEN_MS = 30 * 60 * 1000;
  var FULL_MSG = "Hiện đang có quá nhiều người nghe trực tiếp. Bạn bấm vào \"Nguồn\" bên dưới để nghe trực tiếp từ trang gốc nhé.";

  var liveWrap = document.getElementById("radioLive");
  var liveBtn = document.getElementById("radioLiveBtn");
  var liveAudio = document.getElementById("radioLiveAudio");
  var liveStatus = document.getElementById("radioLiveStatus");
  var liveSrcLink = document.getElementById("radioLiveSrc");
  var hls = null;
  var liveOn = false;
  var hlsLoading = null;
  var triedProxy = false;
  var idleTimer = null;
  // Mã phiên để server đếm số người đang nghe (mỗi lần mở trang 1 mã).
  var sid = (Math.random().toString(36).slice(2, 12) + Date.now().toString(36)).replace(/[^a-z0-9]/g, "");

  var files = Array.prototype.slice.call(box.querySelectorAll(".radio-item audio"));

  function setStatus(t) { if (liveStatus) liveStatus.textContent = t || ""; }
  function hintSource(on) { if (liveSrcLink) liveSrcLink.classList.toggle("is-hint", !!on); }

  function stopLive() {
    liveOn = false;
    clearTimeout(idleTimer);
    if (hls) { try { hls.destroy(); } catch (e) {} hls = null; }
    if (liveAudio) {
      liveAudio.pause();
      liveAudio.removeAttribute("src");
      try { liveAudio.load(); } catch (e) {}
    }
    if (liveBtn) { liveBtn.textContent = "▶"; liveBtn.classList.remove("is-on"); liveBtn.setAttribute("aria-label", "Nghe trực tiếp"); }
    setStatus("");
    hintSource(false);
  }

  function pauseOthers(except) {
    files.forEach(function (a) { if (a !== except && !a.paused) a.pause(); });
    ["ppAudio", "bgMusic"].forEach(function (id) {
      var el = document.getElementById(id);
      if (el && el !== except && !el.paused) el.pause();
    });
  }

  function loadHlsJs() {
    if (window.Hls) return Promise.resolve();
    if (hlsLoading) return hlsLoading;
    hlsLoading = new Promise(function (resolve, reject) {
      var s = document.createElement("script");
      s.src = HLS_JS;
      s.onload = resolve;
      s.onerror = function () { hlsLoading = null; reject(new Error("hls.js")); };
      document.head.appendChild(s);
    });
    return hlsLoading;
  }

  // Hết chỗ nghe qua server -> báo và chỉ người xem sang trang gốc.
  function fullLive() {
    stopLive();
    triedProxy = false;
    setStatus(FULL_MSG);
    hintSource(true);
  }

  // Lỗi lần đầu (thường do CORS/403 của đài) -> tự thử lại qua server mình, chỉ báo lỗi khi cả hai đều hỏng.
  function failLive(detail) {
    if (liveOn && !triedProxy) {
      triedProxy = true;
      stopLive();
      return startLive(true);
    }
    triedProxy = false;
    stopLive();
    // detail = mã lỗi / tên lỗi (nếu có) để dễ biết hỏng ở đâu; hiện nhỏ cuối câu.
    var d = (typeof detail === "number" || typeof detail === "string") ? " [lỗi: " + detail + "]" : "";
    setStatus("Không nghe được trực tiếp ngay tại đây. Bạn bấm vào \"Nguồn\" bên dưới để nghe trên trang của đài." + d);
    hintSource(true);
  }

  function playSrc(src) {
    // Safari / iOS: phát thẳng được m3u8.
    if (liveAudio.canPlayType("application/vnd.apple.mpegurl")) {
      liveAudio.src = src;
      liveAudio.play().catch(failLive);
      return;
    }
    loadHlsJs().then(function () {
      if (!liveOn) return; // người xem đã bấm dừng trong lúc chờ tải
      if (!window.Hls || !window.Hls.isSupported()) return failLive();
      hls = new window.Hls();
      hls.on(window.Hls.Events.MANIFEST_PARSED, function () { liveAudio.play().catch(failLive); });
      hls.on(window.Hls.Events.ERROR, function (_e, data) {
        if (!data || !data.fatal) return;
        var code = data.response && data.response.code;
        console.warn("[radio] hls.js lỗi:", data.details, code || "");
        if (code === 429) return fullLive(); // giữa chừng bị đẩy ra vì hết chỗ
        failLive(code || data.details);
      });
      hls.loadSource(src);
      hls.attachMedia(liveAudio);
    }).catch(failLive);
  }

  function startLive(useProxy) {
    var direct = liveWrap.getAttribute("data-src");
    if (!direct) return failLive();
    pauseOthers(liveAudio);
    liveOn = true;
    hintSource(false);
    liveBtn.textContent = "■";
    liveBtn.classList.add("is-on");
    liveBtn.setAttribute("aria-label", "Dừng nghe trực tiếp");
    clearTimeout(idleTimer);
    idleTimer = setTimeout(function () {
      stopLive();
      setStatus("Đã tự dừng sau 30 phút để tiết kiệm băng thông. Bấm ▶ để nghe tiếp.");
    }, MAX_LISTEN_MS);

    if (useProxy !== true) {
      setStatus("Đang kết nối...");
      return playSrc(direct);
    }

    // Qua cầu nối: hỏi trước xem còn chỗ không (429 = đã đủ người).
    setStatus("Đang kết nối (qua máy chủ)...");
    var proxyUrl = "/radio/live/hls?sid=" + encodeURIComponent(sid);
    fetch(proxyUrl, { cache: "no-store" }).then(function (r) {
      if (!liveOn) return;
      if (r.status === 429) return fullLive();
      if (!r.ok) {
        r.text().then(function (t) { console.warn("[radio] cầu nối trả", r.status, t); });
        return failLive(r.status);
      }
      playSrc(proxyUrl);
    }).catch(failLive);
  }

  if (liveBtn && liveAudio) {
    liveBtn.addEventListener("click", function () { triedProxy = false; if (liveOn) stopLive(); else startLive(); });
    liveAudio.addEventListener("playing", function () { setStatus("Đang phát trực tiếp"); });
    liveAudio.addEventListener("waiting", function () { if (liveOn) setStatus("Đang tải..."); });
  }

  files.forEach(function (a) {
    a.addEventListener("play", function () { stopLive(); pauseOthers(a); });
    a.addEventListener("error", function () {
      var note = a.parentNode.querySelector(".radio-err");
      if (note) note.hidden = false;
    });
  });

  // Podcast / nhạc nền bắt đầu phát -> dừng trực tiếp.
  ["ppAudio", "bgMusic"].forEach(function (id) {
    var el = document.getElementById(id);
    if (el) el.addEventListener("play", function () { if (liveOn) stopLive(); });
  });

  // "Xem thêm" các bản tin
  Array.prototype.forEach.call(box.querySelectorAll(".radio-more-btn"), function (btn) {
    btn.addEventListener("click", function () {
      var more = btn.previousElementSibling;
      if (!more || !more.classList.contains("radio-more")) return;
      var show = more.hidden;
      more.hidden = !show;
      var n = btn.getAttribute("data-more");
      btn.textContent = show ? "Thu gọn ▴" : "Xem thêm " + n + " bản tin ▾";
    });
  });
})();
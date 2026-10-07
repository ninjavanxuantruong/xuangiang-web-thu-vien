// =========================================================
// public/xung-danh.js
// Popup "xưng danh": họ tên + chi bộ. Lưu 1 lần (server đặt cookie), lần sau vào lại không hỏi nữa.
// Bấm "Bỏ qua" (hoặc Esc) thì KHÔNG lưu gì: trong CÙNG phiên của tab đó không hỏi lại ở các trang khác
// (tránh bị hỏi liên tục khi mở nhiều tài liệu); mở trình duyệt/tab mới thì hỏi lại.
//
// Trang nào cũng nhúng bằng 1 dòng:  <%- include("partials/xung-danh") %>   (đặt trước </body>)
// Partial này đặt sẵn các biến:
//   window.__XUNG_DANH_CAN_HOI__  (boolean) — true nếu chưa xưng danh (hoặc đã bị admin xoá)
//   window.__CSRF_TOKEN__         (chuỗi)
//   window.__XUNG_DANH_TEN__      (chuỗi)  — họ tên đã xưng danh ("" nếu chưa) — để chào khi vào trang
// Tuỳ chọn:
//   window.__CHI_BO_LIST__        ([{id,name}]) — trang nào không nhúng sẵn thì popup tự tải từ /api/chi-bo
//   window.__TOI_URL__            (chuỗi)       — địa chỉ trang "khu vực của tôi" NẾU đã làm. Chưa đặt thì
//                                                 bấm nút tên chỉ hiện thông báo nhỏ (không chuyển trang).
// =========================================================

(function () {
  var SKIP_KEY = "xd_skip";

  function el(tag, attrs, children) {
    var node = document.createElement(tag);
    Object.entries(attrs || {}).forEach(function (kv) {
      if (kv[0] === "text") node.textContent = kv[1];
      else node.setAttribute(kv[0], kv[1]);
    });
    (children || []).forEach(function (c) { node.appendChild(c); });
    return node;
  }

  // ---------- Thông báo nhỏ (dùng khi bấm nút tên mà chưa có trang "khu vực của tôi") ----------
  function toast(msg) {
    var old = document.getElementById("xdToast");
    if (old) old.remove();
    var t = el("div", {
      id: "xdToast",
      role: "status",
      style: "position:fixed;left:50%;bottom:24px;transform:translateX(-50%);background:#222;color:#fff;" +
             "padding:10px 16px;border-radius:8px;font-size:13px;z-index:1001;max-width:90vw;text-align:center;",
      text: msg
    });
    document.body.appendChild(t);
    setTimeout(function () { t.remove(); }, 2800);
  }

  // ---------- Lời chào khi vào trang (người ĐÃ xưng danh) ----------
  // Hiện 1 lần cho mỗi phiên (tab): chào ở trang đầu tiên họ mở, các trang sau không chào lại.
  // Chữ mờ ~70%, giữ một chút cho kịp đọc rồi mờ dần trong 2 giây và tự biến mất; không chặn bấm vào trang.
  var GREETING_OPACITY = 0.7;   // độ đậm lúc đầu (0.7 = 70%)
  var GREETING_HOLD_MS = 1500;  // giữ nguyên trước khi bắt đầu mờ dần
  var GREETING_FADE_MS = 2000;  // thời gian mờ dần
  var SITE_NAME = "Thư viện Đảng bộ Xuân Giang";
  var GREETED_KEY = "xd_greeted";
  var greetedFallback = false;  // phòng khi trình duyệt chặn sessionStorage

  function alreadyGreeted() {
    try { return sessionStorage.getItem(GREETED_KEY) === "1"; } catch (e) { return greetedFallback; }
  }
  function markGreeted() {
    greetedFallback = true;
    try { sessionStorage.setItem(GREETED_KEY, "1"); } catch (e) {}
  }

  // Trang chủ có màn chờ (splash, z-index 9999) phủ kín vài giây đầu. Chào lúc đó thì lời chào nằm
  // DƯỚI màn chờ, mờ hết trước khi người xem kịp thấy -> phải đợi màn chờ biến mất rồi mới chào.
  function whenSplashGone(cb) {
    if (!document.getElementById("splashOverlay")) return cb();
    var finished = false;
    var poll = setInterval(function () {
      if (!document.getElementById("splashOverlay")) finish();
    }, 200);
    function finish() {
      if (finished) return;
      finished = true;
      clearInterval(poll);
      setTimeout(cb, 300); // chờ màn chờ mờ hẳn rồi mới hiện lời chào
    }
    setTimeout(finish, 60000); // phòng hờ: quá 60 giây vẫn chưa gỡ thì cứ chào
  }

  // Thử lại lời chào: thêm ?chao=1 vào địa chỉ trang (bỏ qua việc "đã chào trong phiên này").
  function forceGreeting() {
    return /[?&]chao=1(&|$)/.test(window.location.search || "");
  }

  function showGreeting(name) {
    if (!name || (!forceGreeting() && alreadyGreeted()) || document.getElementById("xdGreeting")) return;
    markGreeted();

    var reduceMotion = window.matchMedia && window.matchMedia("(prefers-reduced-motion: reduce)").matches;

    var box = el("div", {
      id: "xdGreeting",
      role: "status",
      "aria-live": "polite",
      style:
        "position:fixed;top:18%;left:50%;transform:translateX(-50%);z-index:1002;" +
        "max-width:min(90vw,520px);padding:18px 26px;border-radius:14px;text-align:center;" +
        "background:#1d1d1f;color:#fff;box-shadow:0 8px 30px rgba(0,0,0,.35);" +
        "pointer-events:none;opacity:" + GREETING_OPACITY + ";"
    });
    box.appendChild(el("div", {
      style: "font-size:17px;font-weight:700;line-height:1.4;margin-bottom:6px;",
      text: "Chào mừng quý vị đến với " + SITE_NAME
    }));
    box.appendChild(el("div", {
      style: "font-size:14px;line-height:1.5;",
      text: "Chúc đồng chí " + name + " có một ngày vui vẻ!"
    }));
    document.body.appendChild(box);

    function remove() { if (box.parentNode) box.remove(); }

    if (reduceMotion) { // người dùng tắt hiệu ứng: chỉ hiện rồi tắt, không chuyển động
      setTimeout(remove, GREETING_HOLD_MS + GREETING_FADE_MS);
      return;
    }
    setTimeout(function () {
      box.style.transition = "opacity " + GREETING_FADE_MS + "ms ease-out";
      box.style.opacity = "0";
      setTimeout(remove, GREETING_FADE_MS + 100);
    }, GREETING_HOLD_MS);
  }

  // ---------- Danh sách chi bộ ----------
  async function loadChiBoList(force) {
    if (!force && Array.isArray(window.__CHI_BO_LIST__) && window.__CHI_BO_LIST__.length) return window.__CHI_BO_LIST__;
    try {
      var r = await fetch("/api/chi-bo", { cache: "no-store" });
      if (r.ok) {
        var list = await r.json();
        if (Array.isArray(list) && list.length) window.__CHI_BO_LIST__ = list;
      }
    } catch (e) { /* mạng lỗi: trả về danh sách đang có (có thể rỗng) */ }
    return Array.isArray(window.__CHI_BO_LIST__) ? window.__CHI_BO_LIST__ : [];
  }

  function fillSelect(select, list) {
    while (select.options.length > 1) select.remove(1); // giữ dòng "— Chọn chi bộ —"
    list.forEach(function (cb) { select.appendChild(el("option", { value: cb.id, text: cb.name })); });
  }

  // ---------- Popup ----------
  function buildPopup(chiBoList) {
    var overlay = el("div", { id: "xungDanhOverlay", class: "xd-overlay" });
    var box = el("div", { class: "xd-box", role: "dialog", "aria-modal": "true", "aria-labelledby": "xdTitle" });

    box.appendChild(el("div", { id: "xdTitle", class: "xd-title", text: "Xin chào bạn 👋" }));
    box.appendChild(el("div", {
      class: "xd-desc",
      text: "Vui lòng cho biết họ tên và chi bộ của bạn (chỉ làm một lần duy nhất, lần sau không cần)"
    }));

    var nameInput = el("input", {
      type: "text", id: "xdName", class: "xd-input",
      placeholder: "Họ và tên", maxlength: "100", autocomplete: "name"
    });
    box.appendChild(nameInput);

    var select = el("select", { id: "xdChiBo", class: "xd-input" });
    select.appendChild(el("option", { value: "", text: "— Chọn chi bộ —" }));
    fillSelect(select, chiBoList);
    box.appendChild(select);

    var errorBox = el("div", { class: "xd-error", role: "alert", style: "display:none;" });
    box.appendChild(errorBox);

    var row = el("div", { class: "xd-row" });
    var skipBtn = el("button", { type: "button", class: "xd-btn xd-skip", text: "Bỏ qua" });
    var okBtn = el("button", { type: "button", class: "xd-btn xd-ok", text: "Xác nhận" });
    row.append(skipBtn, okBtn);
    box.appendChild(row);
    overlay.appendChild(box);

    function showError(msg) {
      errorBox.textContent = msg;
      errorBox.style.display = "block";
    }

    function close() {
      document.removeEventListener("keydown", onKey);
      overlay.remove();
    }

    function skip() {
      try { sessionStorage.setItem(SKIP_KEY, "1"); } catch (e) {}
      close(); // không lưu gì -> phiên mới vào lại vẫn hỏi tiếp
    }

    async function submit() {
      var name = nameInput.value.replace(/\s+/g, " ").trim();
      var chiBoId = select.value;
      var chiBoName = select.options[select.selectedIndex] ? select.options[select.selectedIndex].text : "";

      if (select.options.length <= 1) {
        // Danh sách chi bộ chưa tải được lúc mở popup -> thử tải lại ngay
        okBtn.disabled = true;
        okBtn.textContent = "Đang tải danh sách...";
        var list = await loadChiBoList(true);
        okBtn.disabled = false;
        okBtn.textContent = "Xác nhận";
        if (!list.length) return showError("Chưa tải được danh sách chi bộ. Vui lòng kiểm tra mạng rồi bấm Xác nhận lại.");
        fillSelect(select, list);
        return showError("Đã tải xong danh sách chi bộ, bạn chọn chi bộ rồi bấm Xác nhận.");
      }

      if (name.length < 2) return showError("Vui lòng nhập họ tên.");
      if (!chiBoId) return showError("Vui lòng chọn chi bộ.");

      okBtn.disabled = true;
      okBtn.textContent = "Đang lưu...";
      try {
        var res = await fetch("/xung-danh", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ name: name, chiBoId: chiBoId, chiBoName: chiBoName, _csrf: window.__CSRF_TOKEN__ })
        });
        if (!res.ok) {
          var msg = "Có lỗi khi lưu, vui lòng thử lại.";
          if (res.status === 403) msg = "Phiên làm việc đã hết hạn. Bạn tải lại trang (F5) rồi thử lại nhé.";
          else {
            try { var j = await res.json(); if (j && j.error) msg = j.error; } catch (e) {}
          }
          throw new Error(msg);
        }

        try { sessionStorage.removeItem(SKIP_KEY); } catch (e) {}
        window.__XUNG_DANH_CAN_HOI__ = false;
        close();
        updateHeaderButton(name);
        document.dispatchEvent(new CustomEvent("xungdanh:saved", { detail: { name: name, chiBoId: chiBoId, chiBoName: chiBoName } }));
        showGreeting(name); // vừa đăng ký xong thì chào luôn
      } catch (err) {
        showError(err.message || "Có lỗi khi lưu, vui lòng thử lại.");
        okBtn.disabled = false;
        okBtn.textContent = "Xác nhận";
      }
    }

    function onKey(e) {
      if (e.key === "Escape") skip();
    }

    skipBtn.addEventListener("click", skip);
    okBtn.addEventListener("click", submit);
    // Enter trong ô tên / ô chọn chi bộ = Xác nhận
    nameInput.addEventListener("keydown", function (e) { if (e.key === "Enter") submit(); });
    select.addEventListener("keydown", function (e) { if (e.key === "Enter") submit(); });
    document.addEventListener("keydown", onKey);

    return { overlay: overlay, focus: function () { nameInput.focus(); } };
  }

  function updateHeaderButton(name) {
    var btn = document.getElementById("xungDanhBtn");
    if (btn) btn.textContent = "👤 " + name;
  }

  async function openPopup() {
    if (document.getElementById("xungDanhOverlay")) return; // đã mở sẵn
    var chiBoList = await loadChiBoList(false);
    if (document.getElementById("xungDanhOverlay")) return; // trong lúc chờ tải đã có popup khác
    var popup = buildPopup(chiBoList);
    document.body.appendChild(popup.overlay);
    popup.focus();
  }

  function skippedThisSession() {
    try { return sessionStorage.getItem(SKIP_KEY) === "1"; } catch (e) { return false; }
  }

  function init() {
    var btn = document.getElementById("xungDanhBtn");
    if (btn) {
      btn.addEventListener("click", function () {
        if (window.__XUNG_DANH_CAN_HOI__ !== false) return openPopup(); // chưa xưng danh -> mở popup
        // Đã xưng danh: chỉ chuyển trang khi đã có trang "khu vực của tôi" (server đặt __TOI_URL__)
        if (typeof window.__TOI_URL__ === "string" && window.__TOI_URL__) window.location.href = window.__TOI_URL__;
        else toast("Bạn đã đăng ký tên rồi, cảm ơn bạn!");
      });
    }

    if (window.__XUNG_DANH_CAN_HOI__) {
      if (!skippedThisSession()) openPopup();
    } else if (window.__XUNG_DANH_TEN__) {
      whenSplashGone(function () { showGreeting(window.__XUNG_DANH_TEN__); }); // đã xưng danh -> chào
    }
  }

  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", init);
  else init();
})();

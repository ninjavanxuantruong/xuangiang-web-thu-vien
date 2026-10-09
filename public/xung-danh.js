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
// Đối chiếu danh sách đảng viên (server: dangVien.js):
//   - Lúc đăng ký: tên gõ gần giống đảng viên trong ĐÚNG chi bộ đã chọn -> hỏi "có phải đồng chí X - chức vụ không".
//   - Người đã xưng danh từ trước (tên sai) cũng được hỏi 1 lần/phiên khi vào trang.
//   - Bấm "Không phải" 2 lần trên cùng 1 máy thì server không gợi ý nữa.
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

  // ---------- Gọi server (JSON) ----------
  // Trả về object JSON, hoặc null nếu lỗi mạng/server (nơi gọi tự quyết định bỏ qua).
  async function postJson(url, body) {
    try {
      var data = Object.assign({}, body || {}, { _csrf: window.__CSRF_TOKEN__ });
      var r = await fetch(url, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(data) });
      if (!r.ok) return null;
      return await r.json();
    } catch (e) { return null; }
  }

  function chiBoText(c) { return String(c.chiBo || "").replace(/^(chi bộ|cb)\s+/i, ""); }

  // ?xd=reset (server chuyển về sau /xung-danh/dat-lai): xoá cờ trong phiên để thử lại từ đầu
  if (/[?&]xd=reset(&|$)/.test(window.location.search || "")) {
    try { ["xd_vf", "xd_skip", "xd_greeted"].forEach(function (k) { sessionStorage.removeItem(k); }); } catch (e) {}
  }

  // ---------- Hộp hỏi: "Xin cho hỏi đồng chí có phải là đồng chí ... không?" ----------
  // candidates: [{mid, name, vai}]. Trả về: ứng viên được chọn | null (bấm "Không phải") | "later" (bấm "Để sau").
  function askWhichOne(candidates, allowLater) {
    return new Promise(function (resolve) {
      var overlay = el("div", { id: "xdVerifyOverlay", class: "xd-overlay" });
      var box = el("div", { class: "xd-box", role: "dialog", "aria-modal": "true" });
      box.appendChild(el("div", { class: "xd-title", text: "Xác nhận thông tin" }));

      var one = candidates.length === 1;
      box.appendChild(el("div", {
        class: "xd-desc",
        text: one
          ? "Xin cho hỏi, đồng chí có phải là đồng chí " + candidates[0].name + " — " + candidates[0].vai + ", chi bộ " + chiBoText(candidates[0]) + " không?"
          : "Xin cho hỏi, đồng chí là đồng chí nào dưới đây?"
      }));

      function done(value) { overlay.remove(); resolve(value); }
      var stack = "display:block;width:100%;margin-bottom:8px;text-align:center;";

      candidates.forEach(function (c) {
        var b = el("button", {
          type: "button", class: "xd-btn xd-ok", style: stack,
          text: one ? "Đúng, tôi là " + c.name : c.name + " — " + c.vai + " (" + chiBoText(c) + ")"
        });
        b.addEventListener("click", function () { done(c); });
        box.appendChild(b);
      });

      var no = el("button", {
        type: "button", class: "xd-btn xd-skip", style: stack,
        text: one ? "Không phải" : "Không phải ai trong số này"
      });
      no.addEventListener("click", function () { done(null); });
      box.appendChild(no);

      if (allowLater) {
        var later = el("button", { type: "button", class: "xd-btn xd-skip", style: stack + "font-size:12px;", text: "Để sau" });
        later.addEventListener("click", function () { done("later"); });
        box.appendChild(later);
      }

      overlay.appendChild(box);
      document.body.appendChild(overlay);
    });
  }

  // ---------- Người ĐÃ xưng danh (chưa đối chiếu): hỏi 1 lần mỗi phiên rồi mới chào ----------
  async function verifyExisting(afterDone) {
    try { if (sessionStorage.getItem("xd_vf") === "1") return afterDone(); } catch (e) {}

    var r = await postJson("/xung-danh/xac-minh", {});
    if (!r) return afterDone(); // lỗi mạng: bỏ qua, phiên sau thử lại
    try { sessionStorage.setItem("xd_vf", "1"); } catch (e) {}

    if (r.name) { // tên gõ trùng khớp tuyệt đối -> server đã tự gắn, chỉ cập nhật hiển thị
      window.__XUNG_DANH_TEN__ = r.name;
      updateHeaderButton(r.name);
    }
    if (r.candidates && r.candidates.length) {
      var chosen = await askWhichOne(r.candidates, true);
      if (chosen === "later") {
        // không tính là từ chối
      } else if (chosen) {
        var ok = await postJson("/xung-danh/xac-nhan", { mid: chosen.mid });
        if (ok && ok.name) {
          window.__XUNG_DANH_TEN__ = ok.name;
          updateHeaderButton(ok.name);
        }
      } else {
        postJson("/xung-danh/khong-phai", {}); // nhớ trên máy này, đủ 2 lần thì thôi
      }
    }
    afterDone();
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
      okBtn.textContent = "Đang kiểm tra...";

      // Có đảng viên nào trong ĐÚNG chi bộ này tên gần giống không? (lỗi mạng/không có -> bỏ qua, lưu như thường)
      var mid = "";
      var gy = await postJson("/xung-danh/goi-y", { name: name, chiBoId: chiBoId, chiBoName: chiBoName });
      if (gy && gy.candidates && gy.candidates.length) {
        if (gy.exact) {
          mid = gy.candidates[0].mid; // gõ đúng hệt -> tự gắn, không hỏi
        } else {
          overlay.style.display = "none";
          var chosen = await askWhichOne(gy.candidates, false);
          overlay.style.display = "";
          if (chosen) { mid = chosen.mid; name = chosen.name; }
          else postJson("/xung-danh/khong-phai", {});
        }
      }

      okBtn.textContent = "Đang lưu...";
      try {
        var res = await fetch("/xung-danh", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ name: name, chiBoId: chiBoId, chiBoName: chiBoName, mid: mid, _csrf: window.__CSRF_TOKEN__ })
        });
        if (!res.ok) {
          var msg = "Có lỗi khi lưu, vui lòng thử lại.";
          if (res.status === 403) msg = "Phiên làm việc đã hết hạn. Bạn tải lại trang (F5) rồi thử lại nhé.";
          else {
            try { var j = await res.json(); if (j && j.error) msg = j.error; } catch (e) {}
          }
          throw new Error(msg);
        }
        var saved = {};
        try { saved = await res.json(); } catch (e) {}
        var finalName = saved.name || name; // tên đúng theo danh sách (nếu đã đối chiếu)

        try { sessionStorage.removeItem(SKIP_KEY); } catch (e) {}
        try { sessionStorage.setItem("xd_vf", "1"); } catch (e) {}
        window.__XUNG_DANH_CAN_HOI__ = false;
        window.__XUNG_DANH_TEN__ = finalName;
        close();
        updateHeaderButton(finalName);
        document.dispatchEvent(new CustomEvent("xungdanh:saved", { detail: { name: finalName, chiBoId: chiBoId, chiBoName: chiBoName } }));
        showGreeting(finalName); // vừa đăng ký xong thì chào luôn
      } catch (err) {
        showError(err.message || "Có lỗi khi lưu, vui lòng thử lại.");
        okBtn.disabled = false;
        okBtn.textContent = "Xác nhận";
      }
    }

    function onKey(e) {
      if (document.getElementById("xdVerifyOverlay")) return; // đang hiện hộp hỏi: Esc không được đóng popup phía sau
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
        // Đã xưng danh: vào trang "Khu vực của tôi" (route /toi). Có thể đổi bằng window.__TOI_URL__.
        window.location.href = (typeof window.__TOI_URL__ === "string" && window.__TOI_URL__) ? window.__TOI_URL__ : "/toi";
      });
    }

    if (window.__XUNG_DANH_CAN_HOI__) {
      if (!skippedThisSession()) openPopup();
    } else if (window.__XUNG_DANH_TEN__) {
      whenSplashGone(function () { // đã xưng danh -> (đối chiếu nếu cần) rồi chào
        verifyExisting(function () { showGreeting(window.__XUNG_DANH_TEN__); });
      });
    }
  }

  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", init);
  else init();
})();

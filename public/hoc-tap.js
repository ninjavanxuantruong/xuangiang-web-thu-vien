// public/hoc-tap.js — tính điểm nghiên cứu văn bản + làm trắc nghiệm (phía trình duyệt).
// Dữ liệu do máy chủ đưa vào window.HOC_TAP (xem diem.js -> prepareHocTap). Chỉ chạy cho người đã xưng danh.
(function () {
  "use strict";
  var C = window.HOC_TAP;
  if (!C || !C.token) return;

  // ---------- CSS (tự chèn, không cần sửa style.css) ----------
  var css = [
    ".ht-overlay{position:fixed;inset:0;background:rgba(0,0,0,.55);z-index:5000;display:flex;align-items:center;justify-content:center;padding:16px;}",
    ".ht-box{background:var(--bg-card,var(--bg-page,#fff));color:var(--text-primary,#1c1c1c);width:100%;max-width:560px;max-height:90vh;overflow-y:auto;border-radius:14px;padding:22px 22px 18px;box-shadow:0 10px 40px rgba(0,0,0,.35);position:relative;line-height:1.55;}",
    ".ht-close{position:absolute;top:8px;right:12px;background:transparent;border:none;color:var(--text-muted,#666);font-size:26px;line-height:1;cursor:pointer;padding:4px 8px;}",
    ".ht-title{font-size:1.35em;font-weight:700;margin:0 0 8px;}",
    ".ht-big{display:inline-block;background:#0F6E56;color:#fff;font-weight:700;font-size:1.15em;border-radius:999px;padding:6px 18px;margin:8px 0 10px;}",
    ".ht-muted{color:var(--text-muted,#666);font-size:.9em;}",
    ".ht-actions{display:flex;flex-wrap:wrap;gap:8px;margin-top:16px;}",
    ".ht-btn{border:none;border-radius:999px;padding:10px 20px;font-size:14px;font-weight:600;cursor:pointer;color:#fff;background:#534AB7;text-decoration:none;display:inline-block;}",
    ".ht-btn.green{background:#0F6E56;}",
    ".ht-btn.ghost{background:transparent;color:var(--text-primary,#1c1c1c);border:1.5px solid var(--text-primary,#1c1c1c);}",
    ".ht-btn[disabled]{opacity:.45;cursor:not-allowed;}",
    ".ht-q{border:1px solid var(--border-color,#ddd);border-radius:10px;padding:12px 14px;margin:0 0 12px;}",
    ".ht-q h4{margin:0 0 8px;font-size:1em;}",
    ".ht-opt{display:flex;gap:8px;align-items:flex-start;padding:7px 8px;border-radius:8px;cursor:pointer;font-size:.95em;}",
    ".ht-opt:hover{background:rgba(127,119,221,.12);}",
    ".ht-opt input{margin-top:4px;flex:none;}",
    ".ht-res{margin:0 0 10px;padding:10px 12px;border-radius:10px;font-size:.95em;}",
    ".ht-res.ok{background:rgba(29,158,117,.14);}",
    ".ht-res.bad{background:rgba(216,90,48,.14);}",
    ".ht-chip{position:fixed;left:14px;bottom:14px;z-index:900;background:#0F6E56;color:#fff;border-radius:999px;padding:9px 16px;font-size:13px;font-weight:600;box-shadow:0 3px 12px rgba(0,0,0,.3);border:none;cursor:default;max-width:calc(100vw - 28px);}",
    "button.ht-chip{cursor:pointer;background:#534AB7;}"
  ].join("\n");
  var st = document.createElement("style");
  st.textContent = css;
  document.head.appendChild(st);

  // ---------- tiện ích ----------
  function el(tag, cls, text) {
    var e = document.createElement(tag);
    if (cls) e.className = cls;
    if (text != null) e.textContent = text;
    return e;
  }

  function post(path, extra) {
    var body = { docName: C.docName, token: C.token };
    if (extra) for (var k in extra) body[k] = extra[k];
    return fetch(path, {
      method: "POST",
      credentials: "same-origin",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body)
    }).then(function (r) {
      return r.json().then(function (j) { j.__status = r.status; return j; });
    });
  }

  var overlay = null;
  function closeModal() {
    if (overlay) { overlay.remove(); overlay = null; }
    document.body.style.overflow = "";
  }
  function openModal() {
    closeModal();
    overlay = el("div", "ht-overlay");
    var box = el("div", "ht-box");
    var x = el("button", "ht-close", "×");
    x.type = "button";
    x.setAttribute("aria-label", "Đóng");
    x.addEventListener("click", closeModal);
    box.appendChild(x);
    overlay.appendChild(box);
    document.body.appendChild(overlay);
    document.body.style.overflow = "hidden";
    return box;
  }
  document.addEventListener("keydown", function (e) { if (e.key === "Escape") closeModal(); });

  function homeBtn() {
    var a = el("a", "ht-btn ghost", "Quay lại trang chính");
    a.href = "/";
    return a;
  }
  function closeBtn(label) {
    var b = el("button", "ht-btn ghost", label || "Ở lại đọc tiếp");
    b.type = "button";
    b.addEventListener("click", closeModal);
    return b;
  }

  // ---------- nút nổi ở góc trái dưới ----------
  var chip = null;
  function updateChip() {
    var t = C.tienDo || {};
    if (chip) { chip.remove(); chip = null; }
    if (!t.daHoanThanh) return;
    if (t.daLamBai) {
      chip = el("div", "ht-chip", "Văn bản này: " + ((t.diemNghienCuu || 0) + (t.diemTracNghiem || 0)) + " điểm");
    } else if (C.coQuiz) {
      chip = el("button", "ht-chip", "Làm trắc nghiệm (tối đa +" + C.soCau + " điểm)");
      chip.type = "button";
      chip.addEventListener("click", openQuiz);
    } else {
      chip = el("div", "ht-chip", "Đã nghiên cứu · +" + (t.diemNghienCuu || 0) + " điểm");
    }
    document.body.appendChild(chip);
  }

  // ---------- hộp chúc mừng ----------
  function showCongrats(diem) {
    var box = openModal();
    box.appendChild(el("div", "ht-title", "Chúc mừng bạn!"));
    box.appendChild(el("div", null, "Bạn đã nghiên cứu xong văn bản “" + C.docName + "”."));
    box.appendChild(el("div", "ht-big", "+" + diem + " điểm nghiên cứu"));
    var actions = el("div", "ht-actions");
    if (C.coQuiz) {
      box.appendChild(el("div", "ht-muted", "Làm thêm bài trắc nghiệm nhanh (" + C.soCau + " câu, mỗi câu đúng được 1 điểm). Mỗi người chỉ được làm một lần."));
      var go = el("button", "ht-btn green", "Làm trắc nghiệm");
      go.type = "button";
      go.addEventListener("click", openQuiz);
      actions.appendChild(go);
    }
    actions.appendChild(homeBtn());
    actions.appendChild(closeBtn());
    box.appendChild(actions);
  }

  // ---------- trắc nghiệm ----------
  function openQuiz() {
    var box = openModal();
    box.appendChild(el("div", "ht-muted", "Đang tải bài trắc nghiệm…"));
    post("/api/hoc-tap/trac-nghiem/lay").then(function (r) {
      box.textContent = "";
      var x = el("button", "ht-close", "×");
      x.type = "button";
      x.addEventListener("click", closeModal);
      box.appendChild(x);
      if (!r.ok) {
        box.appendChild(el("div", "ht-title", "Chưa làm được bài trắc nghiệm"));
        box.appendChild(el("div", null, r.error || "Có lỗi xảy ra, vui lòng thử lại."));
        var a = el("div", "ht-actions");
        a.appendChild(closeBtn("Đóng"));
        box.appendChild(a);
        return;
      }
      renderQuiz(box, r.questions);
    }).catch(function () {
      box.textContent = "";
      box.appendChild(el("div", null, "Không kết nối được máy chủ, vui lòng thử lại."));
      box.appendChild(closeBtn("Đóng"));
    });
  }

  function renderQuiz(box, questions) {
    box.appendChild(el("div", "ht-title", "Trắc nghiệm: " + C.docName));
    box.appendChild(el("div", "ht-muted", "Chọn 1 đáp án cho mỗi câu rồi bấm “Nộp bài”. Mỗi câu đúng được 1 điểm, chỉ được nộp một lần."));
    var chosen = new Array(questions.length);
    var submit = el("button", "ht-btn green", "Nộp bài");
    submit.type = "button";
    submit.disabled = true;

    questions.forEach(function (q, qi) {
      var wrap = el("div", "ht-q");
      wrap.appendChild(el("h4", null, "Câu " + (qi + 1) + ". " + q.q));
      q.options.forEach(function (opt, oi) {
        var lab = el("label", "ht-opt");
        var inp = document.createElement("input");
        inp.type = "radio";
        inp.name = "ht-q" + qi;
        inp.addEventListener("change", function () {
          chosen[qi] = oi;
          var all = true;
          for (var i = 0; i < questions.length; i++) if (chosen[i] == null) all = false;
          submit.disabled = !all;
        });
        lab.appendChild(inp);
        lab.appendChild(el("span", null, String.fromCharCode(65 + oi) + ". " + opt));
        wrap.appendChild(lab);
      });
      box.appendChild(wrap);
    });

    var actions = el("div", "ht-actions");
    actions.appendChild(submit);
    actions.appendChild(closeBtn("Để sau"));
    box.appendChild(actions);

    submit.addEventListener("click", function () {
      submit.disabled = true;
      submit.textContent = "Đang chấm…";
      post("/api/hoc-tap/trac-nghiem/nop", { answers: chosen }).then(function (r) {
        if (!r.ok) {
          submit.disabled = false;
          submit.textContent = "Nộp bài";
          alert(r.error || "Không nộp được bài, vui lòng thử lại.");
          return;
        }
        C.tienDo = C.tienDo || {};
        C.tienDo.daHoanThanh = true;
        C.tienDo.daLamBai = true;
        C.tienDo.diemTracNghiem = r.score;
        C.tienDo.diemNghienCuu = r.diemNghienCuu;
        updateChip();
        renderResult(box, questions, r);
      }).catch(function () {
        submit.disabled = false;
        submit.textContent = "Nộp bài";
        alert("Không kết nối được máy chủ, vui lòng thử lại.");
      });
    });
  }

  function renderResult(box, questions, r) {
    box.textContent = "";
    var x = el("button", "ht-close", "×");
    x.type = "button";
    x.addEventListener("click", closeModal);
    box.appendChild(x);

    if (r.already) {
      box.appendChild(el("div", "ht-title", "Bạn đã làm bài này rồi"));
      box.appendChild(el("div", null, "Kết quả đã ghi nhận: " + r.score + "/" + r.total + " điểm trắc nghiệm."));
    } else {
      box.appendChild(el("div", "ht-title", "Bạn đạt " + r.score + "/" + r.total + " điểm trắc nghiệm"));
      box.appendChild(el("div", "ht-muted", "Tổng điểm văn bản này: " + r.diemNghienCuu + " (nghiên cứu) + " + r.score + " (trắc nghiệm) = " + (r.diemNghienCuu + r.score) + " điểm."));
      (r.results || []).forEach(function (rs, i) {
        var q = questions[i];
        var d = el("div", "ht-res " + (rs.dung ? "ok" : "bad"));
        d.appendChild(el("div", null, (rs.dung ? "✓ Câu " : "✗ Câu ") + (i + 1) + (rs.dung ? ": đúng" : ": chưa đúng")));
        if (!rs.dung && q) {
          d.appendChild(el("div", "ht-muted", "Đáp án đúng: " + String.fromCharCode(65 + rs.dapAn) + ". " + q.options[rs.dapAn]));
        }
        box.appendChild(d);
      });
    }
    var actions = el("div", "ht-actions");
    actions.appendChild(homeBtn());
    actions.appendChild(closeBtn("Đóng"));
    box.appendChild(actions);
  }

  // ---------- theo dõi việc đọc ----------
  var completing = false;
  function complete() {
    if (completing) return;
    completing = true;
    post("/api/hoc-tap/hoan-thanh").then(function (r) {
      if (!r.ok) { completing = false; return; }
      C.diem = r.diem;
      C.coQuiz = r.coQuiz;
      C.soCau = r.soCau;
      C.tienDo = { daHoanThanh: true, diemNghienCuu: r.diem, daLamBai: false };
      updateChip();
      if (!r.already) showCongrats(r.diem);
    }).catch(function () { completing = false; });
  }

  function startTracking() {
    var content = document.getElementById("fullContentView");
    if (!content) return;
    var kids = [].slice.call(content.children);
    if (!kids.length) return;

    var seen = new Set();
    var seconds = 0;
    var useIO = "IntersectionObserver" in window;

    if (useIO) {
      var io = new IntersectionObserver(function (list) {
        list.forEach(function (en) { if (en.isIntersecting) seen.add(en.target); });
      });
      kids.forEach(function (k) { io.observe(k); });
    }

    function scrolledEnough() {
      if (!useIO) return window.innerHeight + window.scrollY >= document.documentElement.scrollHeight - 80;
      var last = kids[kids.length - 1];
      return seen.has(last) && seen.size >= Math.ceil(kids.length * 0.9);
    }

    var timer = setInterval(function () {
      if (document.visibilityState === "visible") seconds++;
      if (seconds >= C.minGiay && scrolledEnough()) {
        clearInterval(timer);
        complete();
      }
    }, 1000);
  }

  // ---------- khởi động ----------
  updateChip();
  if (!(C.tienDo && C.tienDo.daHoanThanh)) startTracking();
})();

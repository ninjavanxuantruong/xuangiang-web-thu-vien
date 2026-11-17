// =========================================================
// public/khao-sat.js — trang làm bài khảo sát (/khao-sat/<bài>)
// - Đếm số câu đã trả lời, nhớ tạm bài đang làm (lỡ tải lại trang không mất).
// - Nộp khi chưa làm hết: hỏi lại (câu bỏ trống tính sai).
// - Máy chủ chấm (trình duyệt KHÔNG có đáp án), báo điểm + Đạt/Chưa đạt.
// - Chưa đạt: "Tiếp tục làm" (câu sai bôi đỏ, câu đúng khoá lại; câu sửa đúng chỉ được
//   tính một phần điểm) hoặc "Làm lại hoàn toàn" (bài mới).
// - Đạt: "Làm lại" hoặc "Người khác làm bài". Làm nhiều lần: phần mềm giữ điểm cao nhất.
// =========================================================
(function () {
  var CFG = window.KHAO_SAT || {};
  var CSRF = CFG.csrf || window.__CSRF_TOKEN__ || "";
  // Làm cả bộ: nhớ theo bài. Bốc ngẫu nhiên: nhớ theo từng đề.
  var KEY = "khao-sat:" + (CFG.ngauNhien ? String(CFG.de).slice(-20) : CFG.dot);
  var KEY_NGUOI = "khao-sat:nguoi"; // giữ họ tên + chi bộ khi tải đề mới

  var $ = function (id) { return document.getElementById(id); };
  var oTen = $("ks-ten");
  var oChiBo = $("ks-chibo");
  var oTrangThai = $("ks-trang-thai");
  var oXacNhan = $("ks-xac-nhan");
  var oLoi = $("ks-loi");
  var oKetQua = $("ks-ket-qua");
  var oDem = $("ks-dem");
  var oVach = $("ks-vach");
  var oList = $("ks-list");
  var oThanh = document.querySelector(".ks-thanh");
  var btnNop = $("ks-nop");
  var cauList = Array.prototype.slice.call(document.querySelectorAll(".ks-cau"));
  var dangNop = false;
  var tiepTuc = false; // đang ở chế độ "Tiếp tục làm"
  var ketQuaCuoi = null;

  function esc(s) {
    return String(s == null ? "" : s).replace(/[&<>"']/g, function (c) {
      return { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c];
    });
  }
  function so(x) { return String(Math.round(Number(x) * 100) / 100).replace(".", ","); }
  function an(el) { el.hidden = true; el.innerHTML = ""; }
  function hien(el, html) { el.innerHTML = html; el.hidden = false; }
  function cuonToi(el) {
    var giam = window.matchMedia && window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    el.scrollIntoView({ behavior: giam ? "auto" : "smooth", block: "start" });
  }

  // ---------- Đáp án đang chọn ----------
  function layTraLoi() {
    var out = {};
    cauList.forEach(function (li) {
      var c = li.querySelector("input:checked");
      if (c) out[li.dataset.id] = c.value;
    });
    return out;
  }

  function capNhatTienDo() {
    var traLoi = layTraLoi();
    var n = cauList.filter(function (li) { return li.classList.contains("khoa") || traLoi[li.dataset.id]; }).length;
    oDem.textContent = n;
    var nhac = $("ks-nhac");
    if (nhac && !document.querySelector(".ks-cau.thieu")) nhac.textContent = "";
    oVach.style.width = (CFG.tong ? (n / CFG.tong) * 100 : 0) + "%";
    cauList.forEach(function (li) {
      li.querySelectorAll(".ks-opt").forEach(function (lb) {
        lb.classList.toggle("chon", lb.querySelector("input").checked);
      });
    });
  }

  function luuTam() {
    if (tiepTuc) return; // chế độ sửa câu sai không lưu tạm
    try { sessionStorage.setItem(KEY, JSON.stringify(layTraLoi())); } catch (e) {}
  }
  function xoaTam() {
    try { sessionStorage.removeItem(KEY); } catch (e) {}
  }
  function khoiPhuc() {
    try {
      var d = JSON.parse(sessionStorage.getItem(KEY) || "{}");
      Object.keys(d).forEach(function (id) {
        var r = document.querySelector('input[name="q_' + id + '"][value="' + d[id] + '"]');
        if (r) r.checked = true;
      });
    } catch (e) {}
  }

  function anDe() { oList.hidden = true; oThanh.hidden = true; }
  function hienDe() { oList.hidden = false; oThanh.hidden = false; }

  function khoaNguoiLam(khoa) {
    oTen.disabled = khoa;
    oChiBo.disabled = khoa;
  }

  // Tải đề mới (Làm lại / Người khác làm bài)
  function deMoi(ten, chiBoId) {
    try { sessionStorage.setItem(KEY_NGUOI, JSON.stringify({ ten: ten, chiBoId: chiBoId })); } catch (e) {}
    xoaTam();
    window.location.reload();
  }

  oList.addEventListener("change", function (e) {
    if (e.target && e.target.type === "radio") {
      var li = e.target.closest(".ks-cau");
      if (li) {
        li.classList.remove("thieu");
        li.querySelectorAll(".da-chon-sai").forEach(function (lb) { lb.classList.remove("da-chon-sai"); });
      }
      capNhatTienDo();
      luuTam();
    }
  });

  // ---------- Gọi máy chủ ----------
  function guiJson(url, data) {
    data._csrf = CSRF;
    return fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      credentials: "same-origin",
      body: JSON.stringify(data)
    }).then(function (r) {
      return r.json().catch(function () { return {}; }).then(function (j) { j.__status = r.status; return j; });
    });
  }

  // ---------- Kết quả hiện tại của người đang ghi tên ----------
  var hen = null;
  function kiemTraTrangThai() {
    clearTimeout(hen);
    oTrangThai.textContent = "";
    oTrangThai.className = "ks-trang-thai";
    var ten = oTen.value.trim();
    if (!ten || !oChiBo.value || tiepTuc) return;
    hen = setTimeout(function () {
      guiJson("/khao-sat/trang-thai", { name: ten, chiBoId: oChiBo.value, dot: CFG.dot }).then(function (j) {
        if (j.trangThai === "dat") {
          oTrangThai.textContent = "✓ Đồng chí này đã có kết quả ĐẠT (" + j.diem + "/" + j.tong + "). Làm lại thì phần mềm giữ điểm cao nhất.";
          oTrangThai.className = "ks-trang-thai dat";
        } else if (j.trangThai === "chua-dat") {
          oTrangThai.textContent = "Đã nộp " + (j.soLan || 1) + " lần, điểm cao nhất " + j.diem + "/" + j.tong + " — chưa đạt.";
          oTrangThai.className = "ks-trang-thai chua-dat";
        }
      }).catch(function () {});
    }, 600);
  }
  oTen.addEventListener("input", function () { an(oXacNhan); kiemTraTrangThai(); });
  oChiBo.addEventListener("change", function () { an(oXacNhan); kiemTraTrangThai(); });

  document.addEventListener("xungdanh:saved", function (e) {
    var d = (e && e.detail) || {};
    if (tiepTuc) return;
    if (!oTen.value.trim() && d.name) oTen.value = d.name;
    if (!oChiBo.value && d.chiBoId) oChiBo.value = d.chiBoId;
    kiemTraTrangThai();
  });

  // ---------- Nộp bài ----------
  function nop(them) {
    if (dangNop) return;
    an(oLoi);
    if (!tiepTuc) an(oXacNhan);

    var ten = oTen.value.trim();
    if (!ten) { hien(oLoi, "Vui lòng nhập họ và tên người làm bài."); oTen.focus(); cuonToi(oTen.closest(".ks-nguoi")); return; }
    if (!oChiBo.value) { hien(oLoi, "Vui lòng chọn chi bộ."); oChiBo.focus(); cuonToi(oChiBo.closest(".ks-nguoi")); return; }

    var traLoi = layTraLoi();
    // them = có sẵn khi bấm chọn tên gợi ý -> đã hỏi rồi, không hỏi lại
    if (!them) {
      var thieu = cauList.filter(function (li) { return !li.classList.contains("khoa") && !traLoi[li.dataset.id]; });
      cauList.forEach(function (li) { li.classList.remove("thieu"); });
      if (thieu.length) {
        var vanNop = window.confirm(
          "Còn " + thieu.length + " câu chưa trả lời. Câu bỏ trống sẽ tính là SAI.\n\n" +
          "• Bấm OK để vẫn nộp bài.\n• Bấm Huỷ để quay lại làm tiếp."
        );
        if (!vanNop) {
          thieu.forEach(function (li) { li.classList.add("thieu"); });
          var nhac = $("ks-nhac");
          if (nhac) nhac.textContent = "· còn " + thieu.length + " câu chưa trả lời";
          cuonToi(thieu[0]);
          return;
        }
      }
    }

    var data = { dot: CFG.dot, de: CFG.de, name: ten, chiBoId: oChiBo.value, traLoi: traLoi };
    if (them) for (var k in them) data[k] = them[k];

    dangNop = true;
    btnNop.disabled = true;
    btnNop.textContent = "Đang chấm…";

    guiJson("/khao-sat/nop", data)
      .then(xuLyKetQua)
      .catch(function () {
        hien(oLoi, "Mất kết nối, bài chưa được nộp. Bài làm vẫn còn nguyên — vui lòng bấm Nộp bài lại.");
        cuonToi(oLoi);
      })
      .then(function () {
        dangNop = false;
        btnNop.disabled = false;
        btnNop.textContent = "Nộp bài";
      });
  }

  function xuLyKetQua(j) {
    if (j.hoiXacNhan) {
      var nut = (j.ungVien || []).map(function (u) {
        return '<button type="button" class="chinh" data-mid="' + esc(u.mid) + '" data-name="' + esc(u.name) + '">' + esc(u.name) + "</button>";
      }).join("");
      hien(oXacNhan,
        "Trong danh sách đảng viên của chi bộ có tên gần giống. <strong>Có phải đồng chí:</strong>" +
        '<div class="ks-chon">' + nut + '<button type="button" data-giu="1">Không, giữ tên đã gõ</button></div>');
      cuonToi(oXacNhan);
      return;
    }
    if (j.taiLai) {
      hien(oLoi, esc(j.error) + ' <button type="button" class="chinh" data-tai-lai="1">Tải lại trang</button>');
      cuonToi(oLoi);
      return;
    }
    if (j.error) {
      hien(oLoi, esc(j.error));
      cuonToi(oLoi);
      return;
    }

    ketQuaCuoi = j;
    if (j.name) oTen.value = j.name; // tên đã chuẩn theo danh sách đảng viên
    xoaTam();
    hienKetQua(j);
  }

  function hienKetQua(j) {
    tiepTuc = false;
    an(oXacNhan);
    var dat = Boolean(j.dat);
    var soSai = (j.sai || []).length;
    var html =
      "<div>Đồng chí <strong>" + esc(j.name) + "</strong> — " + esc(j.chiBoName) + "</div>" +
      '<div class="ks-diem">' + so(j.diem) + "/" + j.tong + " điểm</div>" +
      "<div>Tỷ lệ: <strong>" + so(j.phanTram) + "%</strong>" +
      (j.tiepTuc ? ' <span class="ks-note">(sau khi sửa câu sai)</span>' : "") + "</div>" +
      '<p style="margin:10px 0 0;"><span class="ks-nhan">' + (dat ? "ĐẠT" : "CHƯA ĐẠT") + "</span></p>";
    if (j.giuCu && j.ghiNhan) {
      html += '<p class="ks-note" style="font-size:14px;color:var(--text-primary);">Lần này thấp hơn lần trước. Kết quả được ghi nhận vẫn là <strong>điểm cao nhất: ' +
        so(j.ghiNhan.diem) + "/" + j.ghiNhan.tong + " — " + (j.ghiNhan.dat ? "ĐẠT" : "CHƯA ĐẠT") + "</strong>.</p>";
    }

    if (dat) {
      html +=
        '<p class="ks-note">Kết quả đã được ghi nhận. Cảm ơn đồng chí!</p>' +
        '<div class="ks-chon">' +
        '<button type="button" data-lam-lai="1">Làm lại</button>' +
        '<button type="button" class="chinh" data-nguoi-khac="1">Người khác làm bài</button>' +
        "</div>";
    } else {
      html += '<p class="ks-note">Cần từ <strong>' + j.soCanDat + "/" + j.tong + " điểm</strong> (" + j.nguong + "%). Còn " + soSai + " câu sai.";
      if (soSai) {
        html += j.toiDaNeuSua >= j.soCanDat
          ? " Bấm <strong>Tiếp tục làm</strong> để sửa các câu sai — mỗi câu sửa đúng được tính " + j.heSoSua + "% điểm (sửa đúng hết thì được " + so(j.toiDaNeuSua) + " điểm)."
          : " Kể cả sửa đúng hết các câu sai cũng chỉ được tối đa " + so(j.toiDaNeuSua) + " điểm, chưa đủ để đạt — nên chọn <strong>Làm lại hoàn toàn</strong>.";
      }
      html += "</p><div class=\"ks-chon\">" +
        (soSai ? '<button type="button" class="chinh" data-tiep-tuc="1">Tiếp tục làm (sửa ' + soSai + " câu sai)</button>" : "") +
        '<button type="button"' + (soSai && j.toiDaNeuSua >= j.soCanDat ? "" : ' class="chinh"') + ' data-lam-lai="1">Làm lại hoàn toàn</button>' +
        '<button type="button" data-nguoi-khac="1">Người khác làm bài</button>' +
        "</div>";
    }

    oKetQua.className = "ks-box ks-ket-qua " + (dat ? "dat" : "chua-dat");
    hien(oKetQua, html);
    anDe();
    khoaNguoiLam(false);
    kiemTraTrangThai();
    cuonToi(oKetQua);
  }

  // ---------- Chế độ "Tiếp tục làm" ----------
  function vaoTiepTuc() {
    var j = ketQuaCuoi;
    if (!j) return;
    tiepTuc = true;
    var sai = {};
    var khoa = {};
    (j.sai || []).forEach(function (id) { sai[id] = 1; });
    (j.khoa || []).forEach(function (id) { khoa[id] = 1; });

    var dauTien = null;
    cauList.forEach(function (li) {
      var id = li.dataset.id;
      li.classList.remove("sai", "khoa", "thieu");
      li.querySelectorAll(".ks-opt").forEach(function (lb) { lb.classList.remove("da-chon-sai"); });
      var radios = li.querySelectorAll("input[type=radio]");
      if (khoa[id]) {
        li.classList.add("khoa");
        radios.forEach(function (r) { r.disabled = true; });
      } else if (sai[id]) {
        li.classList.add("sai");
        radios.forEach(function (r) {
          r.disabled = false;
          if (r.checked) { r.checked = false; r.closest(".ks-opt").classList.add("da-chon-sai"); }
        });
        if (!dauTien) dauTien = li;
      }
    });

    an(oKetQua);
    hien(oXacNhan,
      "Đang sửa <strong>" + (j.sai || []).length + " câu sai</strong> (khung đỏ, phương án đã chọn bị gạch). " +
      "Các câu đúng đã được ghi nhận. Mỗi câu sửa đúng được tính " + j.heSoSua + "% điểm. Sửa xong bấm <strong>Nộp bài</strong>.");
    khoaNguoiLam(true);
    oTrangThai.textContent = "";
    hienDe();
    capNhatTienDo();
    cuonToi(dauTien || oList);
  }

  btnNop.addEventListener("click", function () { nop(); });

  document.addEventListener("click", function (e) {
    var b = e.target.closest && e.target.closest("button");
    if (!b) return;
    if (b.dataset.mid) {
      oTen.value = b.dataset.name;
      nop({ mid: b.dataset.mid });
    } else if (b.dataset.giu) {
      nop({ giuTen: true });
    } else if (b.dataset.taiLai) {
      xoaTam();
      window.location.reload();
    } else if (b.dataset.tiepTuc) {
      vaoTiepTuc();
    } else if (b.dataset.lamLai) {
      deMoi(oTen.value.trim(), oChiBo.value);
    } else if (b.dataset.nguoiKhac) {
      deMoi("", oChiBo.value); // giữ chi bộ vừa chọn, chỉ xoá họ tên
    }
  });

  // Vừa bấm "Làm lại" / "Người khác làm bài" -> điền lại (hoặc để trống) họ tên, chi bộ
  try {
    var nguoi = sessionStorage.getItem(KEY_NGUOI);
    if (nguoi) {
      sessionStorage.removeItem(KEY_NGUOI);
      nguoi = JSON.parse(nguoi);
      oTen.value = nguoi.ten || "";
      oChiBo.value = nguoi.chiBoId || "";
      if (!nguoi.ten) oTen.focus();
    }
  } catch (e) {}

  khoiPhuc();
  capNhatTienDo();
  kiemTraTrangThai();
})();
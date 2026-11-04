// news-featured-slideshow.js
// Luân phiên tối đa 5 bài gần nhất (window.XN_FEATURED_NEWS, do home.ejs
// nhúng sẵn) lên làm "bài chính" của khối "Tin tức nổi bật của xã":
//  - Mỗi bài chạy crossfade qua hết ảnh của nó, mỗi ảnh hiện
//    SECONDS_MOI_ANH giây.
//  - Một bài luôn phải hiện tối thiểu MIN_SECONDS_MOI_BAI giây — nếu bài
//    ít ảnh quá nên chạy hết ảnh chưa đủ thời gian đó thì lặp lại ảnh cho
//    đến khi đủ, rồi mới đổi sang bài khác.
//  - Chạy hết vòng (bài cuối) thì quay lại bài đầu.
// Nếu không có dữ liệu luân phiên (trang cũ / lỗi) thì rơi về hành vi cũ:
// chỉ chạy slideshow ảnh của bài đã render sẵn, không đổi bài.

(function () {
  const SECONDS_MOI_ANH = 4;
  const MIN_SECONDS_MOI_BAI = 10;

  const wrap = document.getElementById('xnFeaturedImgs');
  if (!wrap) return;

  const linkEl = document.getElementById('xnFeaturedLink');
  const titleEl = document.getElementById('xnFeaturedTitle');
  const dateEl = document.getElementById('xnFeaturedDate');

  const articles = Array.isArray(window.XN_FEATURED_NEWS)
    ? window.XN_FEATURED_NEWS.filter(function (a) { return a && (a.image || (a.images && a.images.length)); }).slice(0, 5)
    : [];

  // Không có dữ liệu luân phiên -> hành vi cũ: chỉ chạy hết ảnh của bài
  // đã render sẵn trong HTML, không đổi bài.
  if (articles.length <= 1) {
    const imgs = wrap.querySelectorAll('img');
    if (imgs.length <= 1) return;
    let idx = 0;
    setInterval(function () {
      imgs[idx].classList.remove('is-active');
      idx = (idx + 1) % imgs.length;
      imgs[idx].classList.add('is-active');
    }, SECONDS_MOI_ANH * 1000);
    return;
  }

  let articleIdx = 0;
  let imgIdx = 0;
  let elapsedMs = 0;
  let imgEls = [];

  function renderArticle(i) {
    const article = articles[i];
    const images = (article.images && article.images.length ? article.images : [article.image]).filter(Boolean);

    wrap.innerHTML = '';
    imgEls = images.map(function (src, i2) {
      const img = document.createElement('img');
      img.src = src;
      img.alt = article.title || '';
      img.loading = i2 === 0 ? 'eager' : 'lazy';
      if (i2 === 0) img.classList.add('is-active');
      wrap.appendChild(img);
      return img;
    });

    if (linkEl) linkEl.href = article.link || '#';
    if (titleEl) titleEl.textContent = article.title || '';
    if (dateEl) {
      if (article.date) {
        dateEl.textContent = article.date;
        dateEl.style.display = '';
      } else {
        dateEl.textContent = '';
        dateEl.style.display = 'none';
      }
    }

    imgIdx = 0;
    elapsedMs = 0;
  }

  function tick() {
    elapsedMs += SECONDS_MOI_ANH * 1000;

    const soAnh = imgEls.length;
    const thoiLuongChayHetAnh = soAnh * SECONDS_MOI_ANH * 1000;
    const thoiLuongBai = Math.max(thoiLuongChayHetAnh, MIN_SECONDS_MOI_BAI * 1000);

    if (elapsedMs >= thoiLuongBai) {
      // Đã chạy hết ảnh (và đủ thời gian tối thiểu) -> đổi sang bài khác.
      articleIdx = (articleIdx + 1) % articles.length;
      renderArticle(articleIdx);
      return;
    }

    if (soAnh > 1) {
      imgEls[imgIdx].classList.remove('is-active');
      imgIdx = (imgIdx + 1) % soAnh;
      imgEls[imgIdx].classList.add('is-active');
    }
  }

  renderArticle(0);
  setInterval(tick, SECONDS_MOI_ANH * 1000);
})();
import { getDocuments, getDocumentTypes, getSuggestedSources } from "./sheets.js";
import { getSuggestedPostsCached, sortSuggestedPosts } from "./newsFinder.js";
import { getLatestVideos } from "./youtube.js";
import { getChannelLatestVideos } from "./channelVideos.js";
import { getXaNews } from "./xaNews.js";
import { getNhanVatList } from "./nhanvat.js";
import { getWorldNewsFast } from "./worldNews.js";

// ====== Mosaic tổng quan trang chủ — 6 KHỐI CỐ ĐỊNH theo 6 chủ đề, mỗi
// khối chỉ tự xoay vòng đúng nội dung của mình (KHÔNG trộn chung ngẫu
// nhiên như bản cũ). Đây là "banner tổng quan" ở đầu trang — các khối
// chi tiết đầy đủ vẫn giữ nguyên bên dưới để người xem bấm vào xem kỹ. ======

const CACHE_TTL_MS = 3 * 60 * 1000; // 3 phút
let cache = null;
let cacheTime = 0;

function slugDocLink(name) {
  return `/doc/${encodeURIComponent(name)}`;
}
function slugNhanVatLink(name) {
  return `/nguoi-va-dat/${encodeURIComponent(name)}`;
}

// Ảnh thật (photo) hiện dạng ảnh; không có ảnh (doc) thì phía client tự vẽ
// 1 khối màu + chữ, không tải ảnh, không phát sinh request nào.
function docItem(title, link, meta) {
  return { kind: "doc", image: null, title, link, meta };
}
function photoItem(image, title, link, meta) {
  return { kind: "photo", image, title, link, meta };
}

const MAX_MOI_KHOI = 6; // giới hạn số mục/khối để đủ đa dạng mà không quá nặng

/**
 * Trả về object 6 khối cố định:
 *   { taiLieu, danhNhan, videoXa, tinXa, baiDeXuat, videoDeXuat }
 * mỗi giá trị là mảng 0-6 mục { kind, image, title, link, meta }.
 */
export async function getMosaicZones() {
  if (cache && Date.now() - cacheTime < CACHE_TTL_MS) return cache;

  try {
    const [docs, types, sources, videoXaRaw, xaNewsRaw, videoDeXuatRaw, danhNhanRaw, tinTheGioiRaw] = await Promise.all([
      getDocuments(),
      getDocumentTypes(),
      getSuggestedSources(),
      getLatestVideos().catch(() => []),
      getXaNews().catch(() => []),
      getChannelLatestVideos().catch(() => []),
      getNhanVatList().catch(() => []),
      getWorldNewsFast().catch(() => [])
    ]);

    // 1) Tài liệu — 1 bài đầu mỗi loại (giống "Tài liệu nổi bật")
    const taiLieu = types
      .map((type) => docs.find((d) => d.type === type))
      .filter(Boolean)
      .slice(0, MAX_MOI_KHOI)
      .map((doc) => docItem(doc.name, slugDocLink(doc.name), doc.type));

    // 2) Danh nhân & Địa điểm — dùng ảnh đại diện thật nếu đã có (do
    // nhanvat.js tự lấy từ link cột D), không có thì hiện khối màu + tên.
    const danhNhan = danhNhanRaw.slice(0, MAX_MOI_KHOI).map((item) => {
      const anh = item.images && item.images[0];
      return anh
        ? photoItem(anh, item.name, slugNhanVatLink(item.name), "Danh nhân")
        : docItem(item.name, slugNhanVatLink(item.name), "Danh nhân");
    });

    // 3) Video của xã (kênh Youtube chính thức)
    const videoXa = videoXaRaw
      .slice(0, MAX_MOI_KHOI)
      .map((v) => photoItem(v.thumbnail, v.title, v.link, "Video xã"));

    // 4) Tin/bài của xã (Facebook)
    const tinXa = xaNewsRaw
      .slice(0, MAX_MOI_KHOI)
      .map((n) => photoItem(n.image, n.title, n.link, n.date || "Tin xã"));

    // 5) Bài đọc đề xuất (nguồn ngoài) — LỌC found:true giống hệt khối
    // "Bài đọc đề xuất" cũ, để không còn ảnh vỡ/đen do bài chưa xác định
    // được nội dung cụ thể.
    const baiDeXuatRaw = sortSuggestedPosts(await getSuggestedPostsCached(sources)).filter((p) => p.found);
    const baiDeXuat = baiDeXuatRaw
      .slice(0, MAX_MOI_KHOI)
      .map((p) => photoItem(p.image, p.title, p.link, p.name));

    // 6) Video đề xuất (theo danh sách kênh trong Google Sheet)
    const videoDeXuat = videoDeXuatRaw
      .slice(0, MAX_MOI_KHOI)
      .map((v) => photoItem(v.thumbnail, v.title, v.link, v.channelName));

    // THÊM MỚI, ngay trước dòng "cache = { taiLieu, ... };"
    // 7) Tin tức thế giới (KBS World "Việt Nam trong cái nhìn thế giới" +
    // điểm báo quốc tế) — link nội bộ tới trang đọc bản dịch/tóm tắt.
    const tinTheGioi = tinTheGioiRaw
      .slice(0, MAX_MOI_KHOI)
      .map((n) => photoItem(n.image, n.title, `/tin-the-gioi/${n.id}`, n.sourceName));

  cache = { taiLieu, danhNhan, videoXa, tinXa, baiDeXuat, videoDeXuat, tinTheGioi };
  cacheTime = Date.now();
  return cache;
  } catch (err) {
    console.error("mosaicFeed: lỗi gộp dữ liệu -", err.message);
    return cache || { taiLieu: [], danhNhan: [], videoXa: [], tinXa: [], baiDeXuat: [], videoDeXuat: [], tinTheGioi: [] };
  }
}
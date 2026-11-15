const db = require("../config/db");
const { sanitizeName } = require("../utils/sanitizeName");
const cache = require("../utils/cache");
const storage = require("./storage");

// 分类封面 cover → cover_url；cover 也可能是前端 /images 静态壁纸或外链
const CAT_FIELDS = { cover: "cover_url" };

class HttpError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}
const fail = (status, message) => { throw new HttpError(status, message); };
const ok = (data, message = "获取成功", status = 200) => ({ status, message, data });

// 1. 创建分类
async function createCategory({ name, cover, bg_image }) {
  const cleanName = sanitizeName(name);
  const cleanCover = cover || bg_image || null;

  if (!cleanName) fail(400, "分类名称不能为空");

  const [existing] = await db.query(
    "SELECT id FROM category WHERE LOWER(TRIM(name)) = LOWER(?)",
    [cleanName]
  );
  if (existing.length > 0) {
    fail(400, "该分类名称已存在");
  }

  await db.query("INSERT INTO category (name, cover) VALUES (?, ?)", [cleanName, cleanCover]);
  cache.delete("all_categories");

  return ok(null, "分类创建成功", 201);
}

// 2. 获取所有分类列表（含文章数量统计）
async function getAllCategories() {
  const cacheKey = "all_categories";
  const cachedData = cache.get(cacheKey);
  if (cachedData) {
    return ok(cachedData.map((c) => storage.attachUrls({ ...c }, CAT_FIELDS)), "获取分类列表成功(缓存)");
  }

  const sql = `
    SELECT c.*, COUNT(a.id) AS article_count
    FROM category c
    LEFT JOIN article a ON c.id = a.category_id AND a.status = 1
    GROUP BY c.id
    ORDER BY c.create_time DESC
  `;
  const [categories] = await db.query(sql);
  cache.set(cacheKey, categories, 60000); // 缓存只存原始 key/路径

  return ok(categories.map((c) => storage.attachUrls({ ...c }, CAT_FIELDS)), "获取分类列表成功");
}

// 3. 获取单个分类详情
async function getCategoryById(id) {
  const [categories] = await db.query("SELECT * FROM category WHERE id = ?", [id]);
  if (categories.length === 0) fail(404, "分类不存在");

  return ok(storage.attachUrls({ ...categories[0] }, CAT_FIELDS), "获取成功");
}

// 4. 修改分类
async function updateCategory(id, { name, cover, bg_image }) {
  const cleanName = sanitizeName(name);
  const cleanCover = cover !== undefined ? cover : (bg_image || null);

  if (!cleanName) fail(400, "分类名称不能为空");

  const [dup] = await db.query(
    "SELECT id FROM category WHERE LOWER(TRIM(name)) = LOWER(?) AND id <> ?",
    [cleanName, id]
  );
  if (dup.length > 0) {
    fail(400, "该分类名称已存在");
  }

  const [result] = await db.query(
    "UPDATE category SET name = ?, cover = ? WHERE id = ?",
    [cleanName, cleanCover, id]
  );
  if (result.affectedRows === 0) fail(404, "未找到该分类");

  cache.delete("all_categories");
  return ok(null, "分类修改成功");
}

// 5. 删除分类
async function deleteCategory(id) {
  const [result] = await db.query("DELETE FROM category WHERE id = ?", [id]);
  if (result.affectedRows === 0) fail(404, "未找到该分类");

  cache.delete("all_categories");
  return ok(null, "分类删除成功");
}

module.exports = {
  createCategory,
  getAllCategories,
  getCategoryById,
  updateCategory,
  deleteCategory,
};

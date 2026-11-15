// 文章点赞与精选互动服务
const db = require("../config/db");
const { HttpError } = require("./articleService");

const fail = (status, message) => { throw new HttpError(status, message); };
const ok = (data, message = "获取成功", status = 200) => ({ status, message, data });

// 点赞 / 取消点赞
async function likeArticle(id, user) {
  const user_id = user.id;
  let conn;
  try {
    conn = await db.getConnection();
    await conn.beginTransaction();

    const [articles] = await conn.query(
      "SELECT id FROM article WHERE id = ? FOR UPDATE", [id]
    );
    if (articles.length === 0) { await conn.rollback(); fail(404, "文章不存在"); }

    const [existing] = await conn.query(
      "SELECT id FROM user_like WHERE user_id = ? AND article_id = ? FOR UPDATE",
      [user_id, id]
    );

    let liked;
    if (existing.length > 0) {
      await conn.query(
        "DELETE FROM user_like WHERE user_id = ? AND article_id = ?", [user_id, id]
      );
      liked = false;
    } else {
      await conn.query(
        "INSERT IGNORE INTO user_like (user_id, article_id) VALUES (?, ?)", [user_id, id]
      );
      liked = true;
    }

    const [countRows] = await conn.query(
      "SELECT COUNT(*) AS cnt FROM user_like WHERE article_id = ?", [id]
    );
    await conn.query(
      "UPDATE article SET like_count = ? WHERE id = ?", [countRows[0].cnt, id]
    );

    await conn.commit();
    return ok(
      { liked, like_count: countRows[0].cnt },
      liked ? "点赞成功" : "取消点赞"
    );
  } catch (error) {
    if (conn) { try { await conn.rollback(); } catch (_) {} }
    if (error instanceof HttpError) throw error;
    console.error("点赞操作错误:", error);
    if (error.code === "ER_DUP_ENTRY") fail(409, "操作过于频繁，请稍后再试");
    fail(500, "服务器内部错误");
  } finally {
    if (conn) conn.release();
  }
}

// 点赞状态
async function getLikeStatus(id, user) {
  const [existing] = await db.query(
    "SELECT id FROM user_like WHERE user_id = ? AND article_id = ?", [user.id, id]
  );
  const [article] = await db.query(
    "SELECT like_count FROM article WHERE id = ?", [id]
  );
  return ok({
    liked: existing.length > 0,
    like_count: article.length > 0 ? article[0].like_count : 0,
  });
}

// 点赞用户列表
async function getArticleLikes(id) {
  const sql = `
    SELECT ul.id, ul.user_id, ul.create_time, u.username, u.nickname, u.avatar
    FROM user_like ul
    LEFT JOIN user u ON ul.user_id = u.id
    WHERE ul.article_id = ?
    ORDER BY ul.create_time DESC
  `;
  const [likes] = await db.query(sql, [id]);
  const [articles] = await db.query(
    "SELECT title, like_count FROM article WHERE id = ?", [id]
  );
  return ok({ article: articles.length > 0 ? articles[0] : null, likes });
}

// 单篇推荐切换
async function toggleRecommend(id, is_recommend) {
  await db.query("UPDATE article SET is_recommend = ? WHERE id = ?", [
    is_recommend ? 1 : 0, id,
  ]);
  return ok(null, "更新成功");
}

// 批量设置编辑精选
async function setRecommendBatch(body) {
  const { ids } = body || {};
  if (!Array.isArray(ids)) fail(400, "ids 必须为数组");

  const validIds = ids
    .filter((id) => Number.isInteger(Number(id)))
    .map(Number)
    .filter((id) => id > 0)
    .slice(0, 8);

  let conn;
  try {
    conn = await db.getConnection();
    await conn.beginTransaction();

    await conn.query("UPDATE article SET is_recommend = 0, recommend_order = 0");

    for (let i = 0; i < validIds.length; i++) {
      await conn.query(
        "UPDATE article SET is_recommend = 1, recommend_order = ? WHERE id = ? AND status = 1",
        [i + 1, validIds[i]]
      );
    }

    await conn.commit();
    return ok(
      { count: validIds.length },
      validIds.length > 0 ? "编辑精选已更新" : "已清空编辑精选"
    );
  } catch (error) {
    if (conn) { try { await conn.rollback(); } catch (_) {} }
    if (error instanceof HttpError) throw error;
    console.error("批量设置推荐错误:", error);
    fail(500, "服务器内部错误");
  } finally {
    if (conn) conn.release();
  }
}

module.exports = {
  likeArticle, getLikeStatus, getArticleLikes,
  toggleRecommend, setRecommendBatch,
};

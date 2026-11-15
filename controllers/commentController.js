const db = require("../config/db");
const cache = require("../utils/cache");
const { cleanPlainText } = require("../utils/sanitizeHtml");
const storage = require("../services/storage");
const { getClientIp } = require("../utils/clientIp");
const { isAdmin } = require("../utils/role");

async function deleteCommentSubtree(conn, rootId) {
  const toDelete = [Number(rootId)];
  let frontier = [Number(rootId)];
  while (frontier.length > 0) {
    const [children] = await conn.query(
      "SELECT id FROM comment WHERE parent_id IN (?)",
      [frontier]
    );
    if (!children || children.length === 0) break;
    const nextIds = children.map((c) => Number(c.id)).filter((cid) => !toDelete.includes(cid));
    if (nextIds.length === 0) break;
    toDelete.push(...nextIds);
    frontier = nextIds;
  }
  await conn.query("DELETE FROM comment_like WHERE comment_id IN (?)", [toDelete]).catch(() => {});
  await conn.query("DELETE FROM comment WHERE id IN (?)", [toDelete]);
}

// 辅助函数：修复 HTTP Avatar 导致浏览器 Mixed Content 拦截图片
const fixAvatarUrl = (url) => {
  if (!url) return "";
  if (url.startsWith("http://hxiuji.top")) {
    return url.replace("http://hxiuji.top", "https://hxiuji.top");
  }
  return url;
};

const DEFAULT_AVATAR = "https://cube.elemecdn.com/3/7c/3ea6beec64369c2642b92c6726f1epng.png";

// 解析评论头像：旧 http 外链先转 https → key/外链统一签名 → 空值兜底默认头像
const resolveAvatar = (url) => storage.sign(fixAvatarUrl(url)) || DEFAULT_AVATAR;

/**
 * 1. 发表评论 / 回复（全透明支持：游客免登录发表 + 已登录用户发表）
 */
exports.createComment = async (req, res) => {
  const { article_id, parent_id, reply_to_user_id, content, guest_name, reply_to_name } = req.body;

  if (!content || !content.trim() || !article_id) {
    return res.status(400).json({ code: 400, message: "文章ID和评论内容不能为空" });
  }

  // 服务端输入校验与安全净化（纵深防御，彻底杜绝 XSS）
  const commentContent = cleanPlainText(content).trim();
  if (!commentContent) {
    return res.status(400).json({ code: 400, message: "评论内容不能为空或包含非法字符" });
  }
  if (commentContent.length > 2000) {
    return res.status(400).json({ code: 400, message: "评论内容不能超过 2000 字" });
  }
  const safeGuestName = guest_name && String(guest_name).trim()
    ? cleanPlainText(String(guest_name)).trim().slice(0, 64)
    : "热心网友";
  const safeReplyToName = reply_to_name && String(reply_to_name).trim()
    ? cleanPlainText(String(reply_to_name)).trim().slice(0, 64)
    : null;

  const user_id = req.user ? req.user.id : null;
  const authorName = req.user
    ? (req.user.nickname || req.user.username || "热心网友")
    : safeGuestName;

  let conn;
  try {
    conn = await db.getConnection();
    await conn.beginTransaction();

    // 校验文章存在且已发布（行锁防止并发写计数时读-改-写漂移）
    const [articles] = await conn.query(
      "SELECT id FROM article WHERE id = ? AND status = 1 FOR UPDATE",
      [article_id],
    );
    if (articles.length === 0) {
      await conn.rollback();
      return res.status(404).json({ code: 404, message: "文章不存在或已被删除" });
    }

    // 校验父评论存在且归属同一文章，保证回复树结构不跨文章
    let resolvedParentId = parent_id || null;
    if (resolvedParentId) {
      const [parents] = await conn.query(
        "SELECT id, article_id FROM comment WHERE id = ?",
        [resolvedParentId],
      );
      if (parents.length === 0 || parents[0].article_id !== Number(article_id)) {
        await conn.rollback();
        return res.status(400).json({ code: 400, message: "回复的评论不存在或不属于该文章" });
      }
    }

    const insertSql = `
      INSERT INTO comment (article_id, user_id, parent_id, reply_to_user_id, content, guest_name, guest_reply_to)
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `;
    const [result] = await conn.query(insertSql, [
      article_id,
      user_id,
      resolvedParentId,
      reply_to_user_id || null,
      commentContent,
      authorName,
      safeReplyToName,
    ]);

    // 同步更新文章评论总数
    const [countRows] = await conn.query(
      "SELECT COUNT(*) AS cnt FROM comment WHERE article_id = ?",
      [article_id],
    );
    await conn.query(
      "UPDATE article SET comment_count = ? WHERE id = ?",
      [countRows[0].cnt, article_id],
    );

    // 读回刚插入的完整评论（含服务端生成时间、关联昵称/头像），供前端即时插入无需整表重载
    const [rows] = await conn.query(
      `SELECT c.id, c.article_id, c.user_id, c.parent_id, c.reply_to_user_id,
              c.content, c.like_count, c.create_time,
              COALESCE(u.nickname, u.username, c.guest_name, '热心网友') AS user_name,
              COALESCE(u.avatar, ?) AS user_avatar,
              COALESCE(ru.nickname, ru.username, c.guest_reply_to, '热心网友') AS reply_to_user_name
       FROM comment c
       LEFT JOIN user u ON c.user_id = u.id
       LEFT JOIN user ru ON c.reply_to_user_id = ru.id
       WHERE c.id = ?`,
      [DEFAULT_AVATAR, result.insertId],
    );

    const newComment = rows[0];
    newComment.user_avatar = resolveAvatar(newComment.user_avatar);
    newComment.replies = [];

    await conn.commit();
    cache.flushPattern("latest_comments_");
    cache.delete("site_stats_summary");
    cache.delete("home_bootstrap");

    res.status(201).json({
      code: 201,
      message: "评论发表成功",
      data: { comment: newComment, comment_count: countRows[0].cnt },
    });
  } catch (error) {
    if (conn) {
      try { await conn.rollback(); } catch (_) {}
    }
    console.error("发表评论错误:", error);
    res.status(500).json({ code: 500, message: "服务器内部错误" });
  } finally {
    if (conn) conn.release();
  }
};

/**
 * 2. 获取某篇文章的全部评论（全公开无需登录：组装为树状图 + 兼容双模式结构）
 */
exports.getCommentsByArticle = async (req, res) => {
  const { articleId } = req.params;

  try {
    const [articles] = await db.query(
      "SELECT id, user_id, status FROM article WHERE id = ?",
      [articleId]
    );
    if (articles.length === 0) {
      return res.status(404).json({ code: 404, message: "文章不存在或已被删除" });
    }
    const art = articles[0];
    if (art.status !== 1) {
      const canPreview = req.user && (req.user.id === art.user_id || isAdmin(req.user.role));
      if (!canPreview) {
        return res.status(404).json({ code: 404, message: "文章不存在或已被删除" });
      }
    }

    const sql = `
      SELECT c.id, c.article_id, c.user_id, c.parent_id, c.reply_to_user_id, 
             c.content, c.like_count, c.create_time,
             COALESCE(u.nickname, u.username, c.guest_name, '热心网友') AS user_name,
             COALESCE(u.avatar, '${DEFAULT_AVATAR}') AS user_avatar,
             COALESCE(ru.nickname, ru.username, c.guest_reply_to, '热心网友') AS reply_to_user_name
      FROM comment c
      LEFT JOIN user u ON c.user_id = u.id
      LEFT JOIN user ru ON c.reply_to_user_id = ru.id
      WHERE c.article_id = ?
      ORDER BY c.create_time ASC
    `;
    const [allComments] = await db.query(sql, [articleId]);

    const commentMap = {};
    const rootComments = [];

    // 初始化字典与容器，修复头像 HTTPS 及空值保底
    allComments.forEach((c) => {
      c.replies = [];
      c.user_name = c.user_name || "热心网友";
      c.user_avatar = resolveAvatar(c.user_avatar);
      commentMap[c.id] = c;
    });

    // 递归组装顶级评论与多级回复
    allComments.forEach((c) => {
      if (!c.parent_id || c.parent_id === 0) {
        rootComments.push(c);
      } else {
        const parent = commentMap[c.parent_id];
        if (parent) {
          parent.replies.push(c);
        } else {
          rootComments.push(c);
        }
      }
    });

    // 创建双重兼容数组响应体 (兼顾旧版客户端把 res.data 视作 Array，及新版视作 {list, total})
    const responseData = [...rootComments];
    responseData.list = rootComments;
    responseData.total = allComments.length;

    res.json({
      code: 200,
      message: "获取评论成功",
      data: responseData,
    });
  } catch (error) {
    console.error("获取评论列表错误:", error);
    res.status(500).json({ code: 500, message: "服务器内部错误" });
  }
};

exports.likeComment = async (req, res) => {
  const { id } = req.params;
  if (!id || isNaN(Number(id))) {
    return res.status(400).json({ code: 400, message: "评论ID不合法" });
  }

  const userId = req.user ? req.user.id : null;
  const clientIp = getClientIp(req);

  let conn;
  try {
    conn = await db.getConnection();
    await conn.beginTransaction();

    const [comments] = await conn.query(
      "SELECT id FROM comment WHERE id = ? FOR UPDATE",
      [id]
    );
    if (!comments || comments.length === 0) {
      await conn.rollback();
      return res.status(404).json({ code: 404, message: "评论不存在或已被删除" });
    }

    let existing = [];
    if (userId) {
      [existing] = await conn.query(
        "SELECT id FROM comment_like WHERE comment_id = ? AND user_id = ? FOR UPDATE",
        [id, userId]
      );
    } else {
      [existing] = await conn.query(
        "SELECT id FROM comment_like WHERE comment_id = ? AND ip = ? FOR UPDATE",
        [id, clientIp]
      );
    }

    let liked = false;
    if (existing && existing.length > 0) {
      if (userId) {
        await conn.query(
          "DELETE FROM comment_like WHERE comment_id = ? AND user_id = ?",
          [id, userId]
        );
      } else {
        await conn.query(
          "DELETE FROM comment_like WHERE comment_id = ? AND ip = ?",
          [id, clientIp]
        );
      }
      liked = false;
    } else {
      await conn.query(
        "INSERT INTO comment_like (comment_id, user_id, ip) VALUES (?, ?, ?)",
        [id, userId, clientIp]
      );
      liked = true;
    }

    const [countRows] = await conn.query(
      "SELECT COUNT(*) AS cnt FROM comment_like WHERE comment_id = ?",
      [id]
    );
    const like_count = countRows[0].cnt;
    await conn.query(
      "UPDATE comment SET like_count = ? WHERE id = ?",
      [like_count, id]
    );

    await conn.commit();
    res.json({
      code: 200,
      message: liked ? "点赞成功" : "取消点赞",
      data: { liked, like_count }
    });
  } catch (error) {
    if (conn) {
      try { await conn.rollback(); } catch (_) {}
    }
    console.error("评论点赞错误:", error);
    res.status(500).json({ code: 500, message: "服务器内部错误" });
  } finally {
    if (conn) conn.release();
  }
};

/**
 * 4. 用户删除自己的评论
 */
exports.deleteUserComment = async (req, res) => {
  const { id } = req.params;
  const user_id = req.user.id;

  let conn;
  try {
    conn = await db.getConnection();
    await conn.beginTransaction();

    const [comments] = await conn.query(
      "SELECT user_id, article_id FROM comment WHERE id = ? FOR UPDATE",
      [id],
    );
    if (comments.length === 0) {
      await conn.rollback();
      return res.status(404).json({ code: 404, message: "评论不存在" });
    }

    if (comments[0].user_id !== user_id) {
      await conn.rollback();
      return res.status(403).json({ code: 403, message: "无权删除他人的评论" });
    }

    const articleId = comments[0].article_id;

    await deleteCommentSubtree(conn, id);

    const [countRows] = await conn.query(
      "SELECT COUNT(*) AS cnt FROM comment WHERE article_id = ?",
      [articleId],
    );
    await conn.query(
      "UPDATE article SET comment_count = ? WHERE id = ?",
      [countRows[0].cnt, articleId],
    );

    await conn.commit();
    cache.flushPattern("latest_comments_");
    cache.delete("site_stats_summary");
    cache.delete("home_bootstrap");
    res.json({
      code: 200,
      message: "评论已成功删除",
      data: { comment_count: countRows[0].cnt },
    });
  } catch (error) {
    if (conn) {
      try { await conn.rollback(); } catch (_) {}
    }
    console.error("删除评论错误:", error);
    res.status(500).json({ code: 500, message: "服务器内部错误" });
  } finally {
    if (conn) conn.release();
  }
};

/**
 * 5. 获取最新评论 (首页展示)
 */
exports.getLatestComments = async (req, res) => {
  try {
    const limit = parseInt(req.query.limit) || 8;
    const cacheKey = `latest_comments_${limit}`;
    const cachedData = cache.get(cacheKey);
    if (cachedData) {
      return res.json({ code: 200, message: "获取成功(缓存)", data: cachedData });
    }

    const sql = `
      SELECT c.id, c.content, c.create_time,
             u.nickname AS user_name, u.avatar AS user_avatar,
             a.title AS article_title, a.id AS article_id
      FROM comment c
      LEFT JOIN user u ON c.user_id = u.id
      LEFT JOIN article a ON c.article_id = a.id
      ORDER BY c.create_time DESC
      LIMIT ?
    `;
    const [comments] = await db.query(sql, [limit]);
    comments.forEach(c => { c.user_avatar = resolveAvatar(c.user_avatar); });

    cache.set(cacheKey, comments, 20000); // 缓存 20 秒

    res.json({ code: 200, message: "获取成功", data: comments });
  } catch (error) {
    console.error("获取最新评论错误:", error);
    res.status(500).json({ code: 500, message: "服务器内部错误" });
  }
};

/**
 * 6. 管理端：获取评论列表
 */
exports.getCommentList = async (req, res) => {
  try {
    const page = Math.max(1, parseInt(req.query.page) || 1);
    const pageSize = Math.min(100, Math.max(1, parseInt(req.query.pageSize) || 10));
    const articleTitle = req.query.article_title;
    const userName = req.query.user_name;
    const offset = (page - 1) * pageSize;

    let querySql = `
      SELECT c.id, c.content, c.parent_id, c.article_id, c.user_id, c.create_time,
             u.username, u.nickname AS user_name,
             a.title AS article_title
      FROM comment c
      LEFT JOIN user u ON c.user_id = u.id
      LEFT JOIN article a ON c.article_id = a.id
      WHERE 1 = 1
    `;
    let countSql = `
      SELECT COUNT(*) AS total
      FROM comment c
      LEFT JOIN user u ON c.user_id = u.id
      LEFT JOIN article a ON c.article_id = a.id
      WHERE 1 = 1
    `;
    let queryParams = [];
    let countParams = [];

    if (articleTitle) {
      querySql += ` AND a.title LIKE ?`;
      countSql += ` AND a.title LIKE ?`;
      queryParams.push(`%${articleTitle}%`);
      countParams.push(`%${articleTitle}%`);
    }

    if (userName) {
      querySql += ` AND (u.username LIKE ? OR u.nickname LIKE ?)`;
      countSql += ` AND (u.username LIKE ? OR u.nickname LIKE ?)`;
      queryParams.push(`%${userName}%`, `%${userName}%`);
      countParams.push(`%${userName}%`, `%${userName}%`);
    }

    querySql += ` ORDER BY c.create_time DESC LIMIT ? OFFSET ?`;
    queryParams.push(pageSize, offset);

    const [countResult, listResult] = await Promise.all([
      db.query(countSql, countParams),
      db.query(querySql, queryParams),
    ]);

    const total = countResult[0][0].total;

    res.json({
      code: 200,
      message: "获取成功",
      data: {
        list: listResult[0],
        total: total,
        page: page,
        pageSize: pageSize,
        totalPage: Math.ceil(total / pageSize),
      },
    });
  } catch (error) {
    console.error("获取管理端评论列表错误:", error);
    res.status(500).json({ code: 500, message: "服务器内部错误" });
  }
};

/**
 * 7. 管理端：获取单条评论详情
 */
exports.getCommentById = async (req, res) => {
  const { id } = req.params;
  try {
    const sql = `
      SELECT c.id, c.content, c.parent_id, c.article_id, c.user_id, c.create_time,
             u.username, u.nickname AS user_name,
             a.title AS article_title
      FROM comment c
      LEFT JOIN user u ON c.user_id = u.id
      LEFT JOIN article a ON c.article_id = a.id
      WHERE c.id = ?
    `;
    const [comments] = await db.query(sql, [id]);

    if (comments.length === 0) {
      return res.status(404).json({ code: 404, message: "评论不存在" });
    }

    res.json({ code: 200, message: "获取成功", data: comments[0] });
  } catch (error) {
    console.error("获取评论详情错误:", error);
    res.status(500).json({ code: 500, message: "服务器内部错误" });
  }
};

/**
 * 8. 管理端：删除评论
 */
exports.adminDeleteComment = async (req, res) => {
  const { id } = req.params;
  let conn;
  try {
    conn = await db.getConnection();
    await conn.beginTransaction();

    const [comments] = await conn.query(
      "SELECT article_id FROM comment WHERE id = ? FOR UPDATE",
      [id],
    );
    if (comments.length === 0) {
      await conn.rollback();
      return res.status(404).json({ code: 404, message: "评论不存在" });
    }
    const articleId = comments[0].article_id;

    await deleteCommentSubtree(conn, id);

    const [countRows] = await conn.query(
      "SELECT COUNT(*) AS cnt FROM comment WHERE article_id = ?",
      [articleId],
    );
    await conn.query(
      "UPDATE article SET comment_count = ? WHERE id = ?",
      [countRows[0].cnt, articleId],
    );

    await conn.commit();
    cache.flushPattern("latest_comments_");
    cache.delete("site_stats_summary");
    cache.delete("home_bootstrap");
    res.json({
      code: 200,
      message: "评论已成功删除",
      data: { comment_count: countRows[0].cnt },
    });
  } catch (error) {
    if (conn) {
      try { await conn.rollback(); } catch (_) {}
    }
    console.error("删除评论错误:", error);
    res.status(500).json({ code: 500, message: "服务器内部错误" });
  } finally {
    if (conn) conn.release();
  }
};

const db = require("../config/db");
const { generateChatStream, generateArticleSummary, generateTitleIdeas } = require("../services/aiService");
const { clearDocCache } = require("../services/ragService");
const { consumeQuota, DAY_MS } = require("../utils/guestQuota");
const { randomUUID } = require("crypto");
const path = require("path");
const storage = require("../services/storage");
const { getClientIp } = require("../utils/clientIp");

function maskApiKey(key) {
  const s = String(key || "").trim();
  if (!s) return "";
  if (s.length <= 8) return "****";
  return `${s.slice(0, 4)}****${s.slice(-4)}`;
}

function isConversationOwned(conv, userId, guestId) {
  if (!conv) return false;
  if (conv.user_id !== null && conv.user_id !== undefined) {
    return Boolean(userId && Number(conv.user_id) === Number(userId));
  }
  return Boolean(guestId && conv.guest_id === guestId);
}

/**
 * 1. AI 流式对话 SSE 接口 (/api/ai/chat/stream)
 */
exports.streamChat = async (req, res) => {
  const { conversationId, message, history, guestId, webSearch } = req.body;

  if (!message) {
    return res.status(400).json({ code: 400, message: "消息内容不能为空" });
  }

  const convId = conversationId || randomUUID();
  const userId = req.user ? req.user.id : null;
  // 未登录(游客)时绑定设备 guestId，用于归属与回查历史对话
  const finalGuestId = userId ? null : (guestId || null);

  // AI 调用频率由服务端强制（前端 localStorage 仅用于体验提示，可被清缓存或直连接口绕过）
  // 必须在写出 SSE 响应头之前校验，这样超限才能正常返回 JSON 429
  if (userId) {
    // 登录用户：按账号给较宽松的每日上限，防止盗号或脚本滥用盗刷大模型
    const userLimit = parseInt(process.env.USER_AI_DAILY_LIMIT, 10) || 200;
    const ru = consumeQuota(`ai:user:${userId}`, userLimit, DAY_MS);
    if (!ru.allowed) {
      return res.status(429).json({ code: 429, message: `今日 AI 对话次数已达上限（${userLimit} 次），请明日再试` });
    }
  } else {
    const guestLimit = parseInt(process.env.GUEST_AI_DAILY_LIMIT, 10) || 2;
    const ipLimit = parseInt(process.env.GUEST_AI_IP_DAILY_LIMIT, 10) || 30;
    const ip = getClientIp(req, "unknown") || "unknown";

    // 设备维度：同一 guestId 每个自然窗口仅允许 guestLimit 次
    if (finalGuestId) {
      const r = consumeQuota(`ai:guest:${finalGuestId}`, guestLimit, DAY_MS);
      if (!r.allowed) {
        return res.status(429).json({ code: 429, message: `游客每日免费体验 ${guestLimit} 次已用完，登录后即可继续使用 AI 助手` });
      }
    }
    // IP 维度兜底：防止通过不断更换 guestId 绕过设备限制（NAT 共享 IP 给更宽松额度）
    const rip = consumeQuota(`ai:ip:${ip}`, ipLimit, DAY_MS);
    if (!rip.allowed) {
      return res.status(429).json({ code: 429, message: "当前网络环境 AI 请求过于频繁，请稍后再试或登录账号" });
    }
  }

  // 在写出 SSE 响应头前校验既有会话归属权，防止 IDOR 跨用户绑定/窃取会话
  if (conversationId) {
    try {
      const [existingConv] = await db.query(
        "SELECT id, user_id, guest_id FROM ai_conversations WHERE id = ?",
        [conversationId]
      );
      if (existingConv.length > 0 && !isConversationOwned(existingConv[0], userId, finalGuestId)) {
        return res.status(403).json({ code: 403, message: "无权访问或续写该会话" });
      }
    } catch (e) {
      console.error("校验 AI 会话归属失败:", e);
      return res.status(500).json({ code: 500, message: "服务器内部错误" });
    }
  }

  // 设置 SSE 响应头并立即刷出，通知浏览器/客户端连接已建立
  res.setHeader("Content-Type", "text/event-stream");
  res.setHeader("Cache-Control", "no-cache");
  res.setHeader("Connection", "keep-alive");
  res.setHeader("X-Accel-Buffering", "no");
  if (typeof res.flushHeaders === "function") {
    res.flushHeaders();
  }

  // 客户端中途断开时中止上游大模型请求，避免连接关闭后仍继续烧 token 与无意义写库
  const ac = new AbortController();
  let clientClosed = false;
  const onClose = () => {
    if (!res.writableEnded) {
      clientClosed = true;
      ac.abort();
    }
  };
  res.on("close", onClose);

  try {
    // 清理消息前缀指令，生成干净的会话标题
    const cleanTitleText = message.replace(/^\[系统指令:.*?\]\n?/g, "").trim();
    const convTitle = (cleanTitleText || message).substring(0, 20);

    await db.query(
      `INSERT INTO ai_conversations (id, user_id, guest_id, title)
       VALUES (?, ?, ?, ?)
       ON DUPLICATE KEY UPDATE
         user_id = COALESCE(user_id, VALUES(user_id)),
         guest_id = IF(user_id IS NULL, COALESCE(guest_id, VALUES(guest_id)), NULL),
         updated_at = NOW()`,
      [convId, userId, finalGuestId, convTitle]
    );

    // 写入用户问题消息
    await db.query(
      `INSERT INTO ai_messages (conversation_id, role, content) VALUES (?, 'user', ?)`,
      [convId, message]
    );

    let fullResponseText = "";
    let fullReasoningText = "";
    let weatherPayload = null;

    const stream = await generateChatStream(history, message, null, ac.signal, webSearch);

    for await (const chunk of stream) {
      if (clientClosed || !res.writable) break;
      const textChunk = chunk.text || "";
      const reasoningChunk = chunk.reasoning || "";
      const searchStatus = chunk.searchStatus || null;
      const searchTitle = chunk.searchTitle || "";
      const weather = chunk.weather || null;
      if (weather) weatherPayload = weather;

      if (textChunk || reasoningChunk || searchStatus || weather) {
        fullResponseText += textChunk;
        fullReasoningText += reasoningChunk;

        res.write(
          `data: ${JSON.stringify({
            text: textChunk,
            reasoning: reasoningChunk,
            searchStatus,
            searchTitle,
            weather,
            conversationId: convId,
          })}\n\n`
        );
        if (typeof res.flush === 'function') {
          res.flush();
        }
      }
    }

    // 客户端已断开：不再落库、不再向已关闭的连接写响应
    if (clientClosed || !res.writable) {
      res.off("close", onClose);
      return;
    }

    // 写入 AI 回复消息记录 (支持合成分离的思考过程与答复落盘)
    let finalSaveContent = fullResponseText;
    if (fullReasoningText && !fullResponseText.includes("<think>")) {
      finalSaveContent = `<think>${fullReasoningText}</think>${fullResponseText}`;
    }

    if (finalSaveContent) {
      await db.query(
        `INSERT INTO ai_messages (conversation_id, role, content, meta) VALUES (?, 'model', ?, ?)`,
        [convId, finalSaveContent, weatherPayload ? JSON.stringify({ weather: weatherPayload }) : null]
      );
    }

    res.off("close", onClose);
    res.write("data: [DONE]\n\n");
    res.end();
  } catch (error) {
    // 客户端主动断开导致的中止属正常情况，不回写、不刷错误堆栈
    if (clientClosed || error.name === "AbortError" || !res.writable) {
      return;
    }
    console.error("流式 AI 对话出错:", error);
    const friendly = "AI 服务暂时不可用，请稍后重试";
    if (!res.headersSent) {
      return res.status(500).json({ code: 500, message: friendly });
    }
    try {
      res.write(`data: ${JSON.stringify({ error: friendly })}\n\n`);
      res.end();
    } catch (e) {}
  }
};

/**
 * 2. 获取用户历史对话列表 (/api/ai/conversations)
 */
exports.getConversations = async (req, res) => {
  try {
    const userId = req.user ? req.user.id : null;
    const guestId = req.query.guestId || null;

    if (!userId && !guestId) {
      return res.json({ code: 200, data: [] });
    }

    // 登录用户：把本设备此前的游客会话一次性归属到该账号，避免登录后历史"消失"
    if (userId && guestId) {
      try {
        await db.query(
          "UPDATE ai_conversations SET user_id = ?, guest_id = NULL WHERE guest_id = ? AND user_id IS NULL",
          [userId, guestId]
        );
      } catch (e) {
        // guest_id 列尚未迁移时跳过，不影响主查询
      }
    }

    // 登录用户按 user_id 回查；游客(未登录)按 guest_id 回查
    let whereSql, params;
    if (userId) {
      whereSql = "user_id = ?";
      params = [userId];
    } else {
      whereSql = "guest_id = ?";
      params = [guestId];
    }

    const [rows] = await db.query(
      `SELECT id, title, created_at, updated_at FROM ai_conversations WHERE ${whereSql} ORDER BY updated_at DESC LIMIT 30`,
      params
    );

    res.json({ code: 200, data: rows });
  } catch (error) {
    console.error("获取 AI 会话列表出错:", error);
    res.status(500).json({ code: 500, message: "服务器内部错误" });
  }
};

/**
 * 3. 获取特定会话消息历史 (/api/ai/conversations/:id/messages)
 */
exports.getMessages = async (req, res) => {
  try {
    const { id } = req.params;
    const userId = req.user ? req.user.id : null;
    const guestId = req.query.guestId || null;

    // 校验会话归属，防止越权读取
    const [convRows] = await db.query(
      "SELECT user_id, guest_id FROM ai_conversations WHERE id = ?",
      [id]
    );
    if (!convRows.length) {
      return res.json({ code: 200, data: [] });
    }
    const conv = convRows[0];
    if (!isConversationOwned(conv, userId, guestId)) {
      return res.status(403).json({ code: 403, message: "无权访问该会话" });
    }

    const [rows] = await db.query(
      "SELECT id, role, content, meta, created_at FROM ai_messages WHERE conversation_id = ? ORDER BY created_at ASC",
      [id]
    );

    res.json({ code: 200, data: rows });
  } catch (error) {
    console.error("获取 AI 消息出错:", error);
    res.status(500).json({ code: 500, message: "服务器内部错误" });
  }
};

/**
 * 4. 删除会话 (/api/ai/conversations/:id)
 */
exports.deleteConversation = async (req, res) => {
  try {
    const { id } = req.params;
    const userId = req.user ? req.user.id : null;
    const guestId = req.query.guestId || null;

    // 校验会话归属，防止越权删除
    const [convRows] = await db.query(
      "SELECT user_id, guest_id FROM ai_conversations WHERE id = ?",
      [id]
    );
    if (convRows.length) {
      const conv = convRows[0];
      if (!isConversationOwned(conv, userId, guestId)) {
        return res.status(403).json({ code: 403, message: "无权删除该会话" });
      }
    }

    await db.query("DELETE FROM ai_messages WHERE conversation_id = ?", [id]).catch(() => {});
    await db.query("DELETE FROM ai_conversations WHERE id = ?", [id]);
    res.json({ code: 200, message: "删除成功" });
  } catch (error) {
    console.error("删除 AI 会话出错:", error);
    res.status(500).json({ code: 500, message: "服务器内部错误" });
  }
};

/**
 * 5. 文章 3 秒一键 AI 摘要生成 (/api/ai/summarize)
 */
exports.generateSummary = async (req, res) => {
  try {
    const { title, content } = req.body;
    if (!title || !content) {
      return res.status(400).json({ code: 400, message: "缺少标题或正文" });
    }

    // 游客按 IP 限流，防止绕过前端盗刷大模型
    if (!req.user) {
      const ipLimit = parseInt(process.env.GUEST_AI_IP_DAILY_LIMIT, 10) || 30;
      const ip = getClientIp(req, "unknown") || "unknown";
      const r = consumeQuota(`ai:sum:ip:${ip}`, ipLimit, DAY_MS);
      if (!r.allowed) {
        return res.status(429).json({ code: 429, message: "当前网络环境 AI 请求过于频繁，请稍后再试或登录账号" });
      }
    }

    const summary = await generateArticleSummary(title, content);
    res.json({ code: 200, data: { summary } });
  } catch (error) {
    console.error("生成 AI 摘要出错:", error);
    res.status(500).json({ code: 500, message: "生成摘要失败，请稍后重试" });
  }
};

/**
 * 6. 创作端 AI 爆款标题推荐 (/api/ai/copilot/titles)
 */
exports.generateTitles = async (req, res) => {
  try {
    const { content } = req.body;
    if (!content) {
      return res.status(400).json({ code: 400, message: "缺少文章正文" });
    }

    const titles = await generateTitleIdeas(content);
    res.json({ code: 200, data: { titles } });
  } catch (error) {
    console.error("生成标题出错:", error);
    res.status(500).json({ code: 500, message: "生成标题失败，请稍后重试" });
  }
};

// 辅助函数：修复 Multer 在提取 multipart Content-Disposition 文件名时的 latin1 编码乱码
const fixFilenameEncoding = (str) => {
  if (!str) return "";
  try {
    const decoded = Buffer.from(str, "latin1").toString("utf8");
    if (decoded && !decoded.includes("\uFFFD")) {
      return decoded;
    }
  } catch (e) {}
  return str;
};

/**
 * 7. 获取 RAG 知识库文档列表 (/api/ai/documents)
 */
exports.getDocuments = async (req, res) => {
  try {
    let rows = [];
    try {
      [rows] = await db.query(
        "SELECT id, filename, COALESCE(filepath, file_path) AS filepath, COALESCE(file_size, 1024) AS file_size, COALESCE(status, 'indexed') AS status, COALESCE(vector_indexed, 1) AS vector_indexed, created_at FROM ai_documents ORDER BY id DESC"
      );
    } catch (e) {
      [rows] = await db.query(
        "SELECT id, filename, file_path AS filepath, 1024 AS file_size, 'indexed' AS status, 1 AS vector_indexed, created_at FROM ai_documents ORDER BY id DESC"
      );
    }

    // 纠正数据库中可能存在的历史乱码文件名
    const cleanRows = rows.map(r => ({
      ...r,
      filename: fixFilenameEncoding(r.filename)
    }));

    res.json({ code: 200, data: cleanRows });
  } catch (error) {
    console.error("获取 RAG 文档列表出错:", error);
    res.status(500).json({ code: 500, message: "服务器内部错误" });
  }
};

/**
 * 8. 上传 RAG 知识库文档 (/api/ai/documents/upload)
 */
exports.uploadDocument = async (req, res) => {
  try {
    if (!req.file) {
      return res.status(400).json({ code: 400, message: "请选择要上传的文件" });
    }
    const { originalname, buffer, size } = req.file;
    const docName = fixFilenameEncoding(originalname);
    const ext = path.extname(docName).toLowerCase();
    const unique = Date.now() + "-" + Math.round(Math.random() * 1e9);

    // 文档原样直传（不压缩，避免损坏 PDF/DOCX/XLSX），数据库存 key
    const { key } = await storage.put({
      buffer,
      dir: "doc",
      filename: `${unique}${ext}`,
      mime: req.file.mimetype,
    });

    let insertId;
    try {
      const [result] = await db.query(
        "INSERT INTO ai_documents (filename, filepath, file_size, status, vector_indexed) VALUES (?, ?, ?, 'indexed', 1)",
        [docName, key, size || 0]
      );
      insertId = result.insertId;
    } catch (e) {
      const [result] = await db.query(
        "INSERT INTO ai_documents (filename, file_path, chunk_count) VALUES (?, ?, 1)",
        [docName, key]
      );
      insertId = result.insertId;
    }

    clearDocCache();

    res.json({
      code: 200,
      message: "文档上传完成，知识库检索时将实时读取并解析该文档",
      data: {
        id: insertId,
        filename: docName,
        filepath: key,
        status: "indexed"
      }
    });
  } catch (error) {
    console.error("上传 RAG 文档出错:", error);
    res.status(500).json({ code: 500, message: "文档上传解析失败" });
  }
};

/**
 * 9. 删除 RAG 知识库文档 (/api/ai/documents/:id)
 */
exports.deleteDocument = async (req, res) => {
  try {
    const { id } = req.params;
    await db.query("DELETE FROM ai_documents WHERE id = ?", [id]);
    clearDocCache();
    res.json({ code: 200, message: "知识库文档移除成功" });
  } catch (error) {
    console.error("删除 RAG 文档出错:", error);
    res.status(500).json({ code: 500, message: "服务器内部错误" });
  }
};

/**
 * 10. 获取 AI 设置 (/api/ai/settings)
 */
exports.getSettings = async (req, res) => {
  try {
    let rows = [];
    try {
      [rows] = await db.query("SELECT COALESCE(setting_key, `key`) AS k, COALESCE(setting_value, `value`) AS v FROM ai_settings");
    } catch (e) {
      try {
        [rows] = await db.query("SELECT `key` AS k, `value` AS v FROM ai_settings");
      } catch (e2) {
        rows = [];
      }
    }
    const settings = {
      provider: process.env.LLM_PROVIDER || "openai",
      baseUrl: process.env.LLM_BASE_URL || "https://tokenhub.tencentmaas.com/v1",
      model: process.env.LLM_MODEL || "deepseek/deepseek-v4-flash-vision-exp",
      // 安全：密钥只来自环境变量或后台配置表，源码不得硬编码；该接口仅管理员可访问
      apiKey: process.env.LLM_API_KEY || "",
      systemPrompt: ""
    };
    rows.forEach(r => {
      if (r.k) settings[r.k] = r.v;
    });
    const rawKey = settings.apiKey || "";
    res.json({
      code: 200,
      data: {
        ...settings,
        apiKey: "",
        hasApiKey: Boolean(rawKey),
        apiKeyMasked: maskApiKey(rawKey),
      },
    });
  } catch (error) {
    console.error("获取 AI 设置出错:", error);
    res.status(500).json({ code: 500, message: "服务器内部错误" });
  }
};

/**
 * 11. 保存 AI 设置 (/api/ai/settings)
 */
exports.saveSettings = async (req, res) => {
  try {
    const { provider, baseUrl, model, apiKey, systemPrompt } = req.body;
    const settings = { provider, baseUrl, model, systemPrompt };
    // 只有显式提交非空且非掩码的 apiKey 时才覆盖，避免保存其他字段时误清空/覆写密钥
    if (typeof apiKey === "string" && apiKey.trim() && !apiKey.includes("****")) {
      settings.apiKey = apiKey.trim();
    }

    for (const [key, value] of Object.entries(settings)) {
      if (value !== undefined) {
        try {
          await db.query(
            "INSERT INTO ai_settings (setting_key, setting_value) VALUES (?, ?) ON DUPLICATE KEY UPDATE setting_value = ?",
            [key, String(value), String(value)]
          );
        } catch (e) {
          await db.query(
            "INSERT INTO ai_settings (`key`, `value`) VALUES (?, ?) ON DUPLICATE KEY UPDATE `value` = ?",
            [key, String(value), String(value)]
          );
        }
      }
    }
    res.json({ code: 200, message: "AI 配置保存成功！" });
  } catch (error) {
    console.error("保存 AI 设置出错:", error);
    res.status(500).json({ code: 500, message: "服务器内部错误" });
  }
};

/**
 * 12. 管理端：获取全站 AI 会话列表与监管审计 (/api/ai/admin/conversations)
 */
exports.getAdminConversations = async (req, res) => {
  try {
    const page = Math.max(1, parseInt(req.query.page) || 1);
    const pageSize = Math.min(100, Math.max(1, parseInt(req.query.pageSize) || 10));
    const offset = (page - 1) * pageSize;
    const keyword = (req.query.keyword || "").trim();

    let whereClause = "1 = 1";
    const params = [];
    if (keyword) {
      whereClause += " AND (c.title LIKE ? OR u.nickname LIKE ? OR u.username LIKE ? OR c.id LIKE ?)";
      params.push(`%${keyword}%`, `%${keyword}%`, `%${keyword}%`, `%${keyword}%`);
    }

    const [countRows] = await db.query(
      `SELECT COUNT(*) AS total 
       FROM ai_conversations c 
       LEFT JOIN user u ON c.user_id = u.id 
       WHERE ${whereClause}`,
      params
    );
    const total = countRows[0].total;

    const [rows] = await db.query(
      `SELECT c.id, c.user_id, c.guest_id, c.title, c.created_at, c.updated_at,
              u.username, u.nickname, u.avatar, u.openid, u.role,
              (SELECT COUNT(*) FROM ai_messages m WHERE m.conversation_id = c.id) AS message_count,
              (SELECT content FROM ai_messages m WHERE m.conversation_id = c.id ORDER BY m.created_at DESC LIMIT 1) AS last_message
       FROM ai_conversations c
       LEFT JOIN user u ON c.user_id = u.id
       WHERE ${whereClause}
       ORDER BY c.updated_at DESC
       LIMIT ? OFFSET ?`,
      [...params, pageSize, offset]
    );

    res.json({
      code: 200,
      data: {
        list: rows,
        total,
        page,
        pageSize,
        totalPage: Math.ceil(total / pageSize)
      }
    });
  } catch (error) {
    console.error("管理端获取 AI 会话列表失败:", error);
    res.status(500).json({ code: 500, message: "服务器内部错误" });
  }
};

/**
 * 13. 管理端：获取某会话全部对话上下文明细 (/api/ai/admin/conversations/:id/messages)
 */
exports.getAdminConversationMessages = async (req, res) => {
  try {
    const { id } = req.params;
    const [rows] = await db.query(
      "SELECT id, conversation_id, role, content, feedback, latency_ms, created_at FROM ai_messages WHERE conversation_id = ? ORDER BY created_at ASC",
      [id]
    );
    res.json({ code: 200, data: rows });
  } catch (error) {
    console.error("管理端获取会话明细失败:", error);
    res.status(500).json({ code: 500, message: "服务器内部错误" });
  }
};

/**
 * 14. 管理端：删除违规/异常 AI 会话 (/api/ai/admin/conversations/:id)
 */
exports.deleteAdminConversation = async (req, res) => {
  try {
    const { id } = req.params;
    await db.query("DELETE FROM ai_messages WHERE conversation_id = ?", [id]).catch(() => {});
    await db.query("DELETE FROM ai_conversations WHERE id = ?", [id]);
    res.json({ code: 200, message: "会话删除成功" });
  } catch (error) {
    console.error("管理端删除会话失败:", error);
    res.status(500).json({ code: 500, message: "服务器内部错误" });
  }
};

/**
 * 15. 管理端：获取 AI 对话全景数据看板统计 (/api/ai/admin/stats)
 */
exports.getAdminAiStats = async (req, res) => {
  try {
    const [[convStats]] = await db.query("SELECT COUNT(*) AS totalConversations FROM ai_conversations");
    const [[msgStats]] = await db.query("SELECT COUNT(*) AS totalMessages FROM ai_messages");
    const [[todayConv]] = await db.query("SELECT COUNT(*) AS todayConversations FROM ai_conversations WHERE DATE(created_at) = CURDATE()");
    const [[wxUserStats]] = await db.query("SELECT COUNT(*) AS totalWxUsers FROM user WHERE openid IS NOT NULL");

    res.json({
      code: 200,
      data: {
        totalConversations: convStats.totalConversations || 0,
        totalMessages: msgStats.totalMessages || 0,
        todayConversations: todayConv.todayConversations || 0,
        totalWxUsers: wxUserStats.totalWxUsers || 0
      }
    });
  } catch (error) {
    console.error("获取 AI 看板统计失败:", error);
    res.status(500).json({ code: 500, message: "服务器内部错误" });
  }
};




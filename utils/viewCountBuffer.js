const db = require("../config/db");

/**
 * 浏览量缓冲与 IP 防刷
 */
class ViewCountBuffer {
  constructor(flushIntervalMs = 5000, cooldownMs = 10 * 60 * 1000) {
    this.articleBuffer = new Map(); // articleId -> accumulatedCount
    this.snapshotBuffer = new Map(); // snapshotId -> accumulatedCount
    this.ipCooldowns = new Map(); // `${type}:${id}:${ip}` -> timestamp
    this.cooldownMs = cooldownMs;
    this.isFlushing = false;

    this.timer = setInterval(() => this.flush(), flushIntervalMs);
    if (this.timer.unref) this.timer.unref();

    // 定期（每5分钟）清理过期的 IP 记录，防止内存无限累积
    this.cleanTimer = setInterval(() => this.cleanExpiredCooldowns(), 5 * 60 * 1000);
    if (this.cleanTimer.unref) this.cleanTimer.unref();

    // 优雅停机保护
    const gracefulFlush = async () => {
      await this.flush();
    };
    const shutdownAndExit = async () => {
      await this.flush();
      process.exit(0);
    };
    process.once("SIGTERM", shutdownAndExit);
    process.once("SIGINT", shutdownAndExit);
    process.once("beforeExit", gracefulFlush);
  }

  cleanExpiredCooldowns() {
    const now = Date.now();
    for (const [key, time] of this.ipCooldowns.entries()) {
      if (now - time > this.cooldownMs) {
        this.ipCooldowns.delete(key);
      }
    }
  }

  isDuplicate(type, id, ip) {
    if (!ip) return false;
    const cleanIp = String(ip).trim();
    if (!cleanIp || cleanIp === "unknown") return false;
    const key = `${type}:${id}:${cleanIp}`;
    const now = Date.now();
    const lastVisit = this.ipCooldowns.get(key);
    if (lastVisit && now - lastVisit < this.cooldownMs) {
      return true; // 处于冷却期内，视为重复浏览
    }
    this.ipCooldowns.set(key, now);
    return false;
  }

  /**
   * 记录文章浏览
   * @param {number|string} articleId
   * @param {string} [ip]
   */
  recordArticle(articleId, ip = "") {
    const id = Number(articleId);
    if (!id) return 0;
    if (this.isDuplicate("article", id, ip)) {
      return this.articleBuffer.get(id) || 0;
    }
    const current = this.articleBuffer.get(id) || 0;
    const next = current + 1;
    this.articleBuffer.set(id, next);

    if (this.articleBuffer.size >= 100 && !this.isFlushing) {
      setImmediate(() => this.flush());
    }
    return next;
  }

  /**
   * 记录随拍浏览
   * @param {number|string} snapshotId
   * @param {string} [ip]
   */
  recordSnapshot(snapshotId, ip = "") {
    const id = Number(snapshotId);
    if (!id) return 0;
    if (this.isDuplicate("snapshot", id, ip)) {
      return this.snapshotBuffer.get(id) || 0;
    }
    const current = this.snapshotBuffer.get(id) || 0;
    const next = current + 1;
    this.snapshotBuffer.set(id, next);

    if (this.snapshotBuffer.size >= 100 && !this.isFlushing) {
      setImmediate(() => this.flush());
    }
    return next;
  }

  // 兼容原有接口
  record(articleId, ip = "") {
    return this.recordArticle(articleId, ip);
  }

  getPendingCount(typeOrId, optId) {
    if (typeof typeOrId === "string" && optId !== undefined) {
      const id = Number(optId);
      if (typeOrId === "snapshot") return this.snapshotBuffer.get(id) || 0;
      return this.articleBuffer.get(id) || 0;
    }
    return this.articleBuffer.get(Number(typeOrId)) || 0;
  }

  /**
   * 将缓冲区数据批量刷入 MySQL
   */
  async flush() {
    if (this.isFlushing) return;
    if (this.articleBuffer.size === 0 && this.snapshotBuffer.size === 0) return;
    this.isFlushing = true;

    const snapArticle = new Map(this.articleBuffer);
    this.articleBuffer.clear();

    const snapSnapshot = new Map(this.snapshotBuffer);
    this.snapshotBuffer.clear();

    try {
      const updates = [];

      for (const [articleId, count] of snapArticle.entries()) {
        if (count > 0) {
          updates.push(
            db.query(
              "UPDATE article SET view_count = view_count + ? WHERE id = ? AND status = 1",
              [count, articleId]
            ).catch((err) => {
              console.error(`[viewCountBuffer] 文章刷盘失败 (ID: ${articleId}):`, err.message);
              this.articleBuffer.set(articleId, (this.articleBuffer.get(articleId) || 0) + count);
            })
          );
        }
      }

      for (const [snapId, count] of snapSnapshot.entries()) {
        if (count > 0) {
          updates.push(
            db.query(
              "UPDATE snapshot_card SET view_count = view_count + ? WHERE id = ? AND is_published = 1 AND status = 1",
              [count, snapId]
            ).catch((err) => {
              console.error(`[viewCountBuffer] 随拍刷盘失败 (ID: ${snapId}):`, err.message);
              this.snapshotBuffer.set(snapId, (this.snapshotBuffer.get(snapId) || 0) + count);
            })
          );
        }
      }

      await Promise.all(updates);
    } catch (error) {
      console.error("[viewCountBuffer] 批量刷盘未知异常:", error);
    } finally {
      this.isFlushing = false;
    }
  }
}

const globalViewCountBuffer = new ViewCountBuffer(5000);
module.exports = globalViewCountBuffer;

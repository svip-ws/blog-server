/**
 * 内存 LRU + TTL 缓存
 */
class LRUMemoryCache {
  constructor(defaultTTL = 30000, maxSize = 1000) {
    this.cache = new Map();
    this.defaultTTL = defaultTTL;
    this.maxSize = maxSize;

    // 每 60 秒主动巡检淘汰过期项，unref 防止阻碍进程正常退出
    this.cleanupTimer = setInterval(() => {
      const now = Date.now();
      for (const [key, item] of this.cache.entries()) {
        if (now > item.expireAt) {
          this.cache.delete(key);
        }
      }
    }, 60000);
    if (this.cleanupTimer.unref) {
      this.cleanupTimer.unref();
    }
  }

  get(key) {
    const item = this.cache.get(key);
    if (!item) return null;
    if (Date.now() > item.expireAt) {
      this.cache.delete(key);
      return null;
    }
    // LRU: 刷新至 Map 末尾（最近使用）
    this.cache.delete(key);
    this.cache.set(key, item);
    return item.data;
  }

  set(key, data, ttlMs = this.defaultTTL) {
    if (this.cache.has(key)) {
      this.cache.delete(key);
    } else if (this.cache.size >= this.maxSize) {
      // 容量满时，淘汰 Map 最头部（最久未使用）的项
      const oldestKey = this.cache.keys().next().value;
      if (oldestKey !== undefined) {
        this.cache.delete(oldestKey);
      }
    }
    this.cache.set(key, {
      data,
      expireAt: Date.now() + ttlMs,
    });
  }

  delete(key) {
    this.cache.delete(key);
  }

  /**
   * 清除指定包含 Key 关键字的所有缓存项
   * @param {string} pattern 
   */
  flushPattern(pattern) {
    for (const key of this.cache.keys()) {
      if (key.includes(pattern)) {
        this.cache.delete(key);
      }
    }
  }

  clear() {
    this.cache.clear();
  }

  size() {
    return this.cache.size;
  }
}

const globalCache = new LRUMemoryCache(30000, 2000); // 默认 30 秒缓存，容量上限 2000 条
module.exports = globalCache;

const fs = require("fs");
const db = require("../config/db");
const cheerio = require("cheerio");
const { searchKnowledgeBase } = require("./ragService");
const { assertSafePublicUrl } = require("../utils/urlSecurity");

const DEFAULT_UA =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120 Safari/537.36";

// 搜索结果缓存：防止同一问题多次搜索返回不同结果，导致前后矛盾
const searchCache = new Map();
const SEARCH_CACHE_TTL = 30 * 60 * 1000; // 30分钟过期
const SEARCH_CACHE_MAX = 200; // 最多缓存200条，防内存泄漏

/**
 * 查询归一化：把"今日西安天气"、"陕西省西安市天气"、"西安今天天气"等变体归一到同一个缓存key
 * 去掉时效词、行政前缀、标点空格，保留核心实体+主题
 */
function normalizeQueryForCache(query) {
  return query
    .trim()
    .toLowerCase()
    .replace(/今日|今天|今晚|今早|现在|目前|当前|刚刚|刚才|最新|最近|实时/g, "")
    .replace(/陕西省|山西省|河南省|河北省|山东省|湖南省|湖北省|广东省|四川省|贵州省|云南省|浙江省|江苏省|安徽省|福建省|江西省|辽宁省|吉林省|黑龙江省|甘肃省|青海省|海南省|台湾省|北京市|天津市|上海市|重庆市|自治区|特别行政区/g, "")
    .replace(/[省市县区]/g, "")
    .replace(/[？?！!。，,、；;：:\s]/g, "")
    .trim();
}

// ==================== 和风天气API配置（从环境变量读取） ====================
const QWEATHER_KEY = process.env.QWEATHER_KEY || "";
const QWEATHER_HOST = process.env.QWEATHER_HOST || "";

// 判断是否是天气类问题
function isWeatherQuery(msg) {
  return /天气|气温|温度|冷不冷|热不热|下雨|下雪|穿衣/.test(msg);
}

// 从用户问题里提取城市名（取最后一个地名实体，如"榆林市府谷县"→"府谷"）
function extractCityFromQuery(msg) {
  const cleaned = msg
    .replace(/今日|今天|今晚|今早|现在|目前|当前|最新|最近|实时/g, "")
    .replace(/天气|气温|温度|怎么样|如何|多少|冷不冷|热不热|下雨|下雪|穿衣|预报/g, "")
    .replace(/[？?！!。，,、；;：:\s]/g, "")
    .replace(/陕西省|山西省|河南省|河北省|山东省|湖南省|湖北省|广东省|四川省|贵州省|云南省|浙江省|江苏省|安徽省|福建省|江西省|辽宁省|吉林省|黑龙江省|甘肃省|青海省|海南省|台湾省|北京市|天津市|上海市|重庆市|自治区|特别行政区/g, "")
    .trim();
  // 按省市县区分割，取最后一个有效地名（如"榆林市府谷县"→["榆林","府谷"]→"府谷"）
  const parts = cleaned.split(/[省市县区]/).filter(Boolean);
  return parts.length ? parts[parts.length - 1] : null;
}

// 调和风天气API拿精确天气数据（先GeoAPI查ID，再查天气）
async function fetchWeatherFromQweather(cityName) {
  try {
    // 第1步：GeoAPI把城市名转成LocationID
    const geoUrl = `https://${QWEATHER_HOST}/geo/v2/city/lookup?location=${encodeURIComponent(cityName)}&key=${QWEATHER_KEY}`;
    console.log(`[和风天气] GeoAPI 查询城市: ${cityName}`);
    const geoRes = await fetchWithRetry(geoUrl, { headers: { "User-Agent": DEFAULT_UA } }, 5000, 1);
    const geoText = await geoRes.text();
    console.log(`[和风天气] GeoAPI状态=${geoRes.status}，返回: ${geoText.substring(0, 300)}`);
    let geoData;
    try { geoData = JSON.parse(geoText); } catch (e) {
      console.error(`[和风天气] GeoAPI返回非JSON`);
      return null;
    }
    if (geoData.code !== "200" || !geoData.location || !geoData.location.length) {
      console.log(`[和风天气] 未找到城市: ${cityName}，code=${geoData.code}`);
      return null;
    }
    const loc = geoData.location[0];
    console.log(`[和风天气] 找到城市: ${loc.adm2}${loc.name}，ID=${loc.id}`);

    // 第2步：用LocationID查实时天气 + 3天预报（预报才有今日最高/最低气温）
    const nowUrl = `https://${QWEATHER_HOST}/v7/weather/now?location=${loc.id}&key=${QWEATHER_KEY}`;
    const dailyUrl = `https://${QWEATHER_HOST}/v7/weather/3d?location=${loc.id}&key=${QWEATHER_KEY}`;
    const [wRes, dRes] = await Promise.all([
      fetchWithRetry(nowUrl, { headers: { "User-Agent": DEFAULT_UA } }, 5000, 1),
      fetchWithRetry(dailyUrl, { headers: { "User-Agent": DEFAULT_UA } }, 5000, 1).catch(() => null),
    ]);
    const wText = await wRes.text();
    console.log(`[和风天气] 天气API状态=${wRes.status}，返回: ${wText.substring(0, 300)}`);
    let wData;
    try { wData = JSON.parse(wText); } catch (e) {
      console.error(`[和风天气] 天气API返回非JSON`);
      return null;
    }
    if (wData.code !== "200") {
      console.log(`[和风天气] 查询失败: code=${wData.code}`);
      return null;
    }

    // 预报单独容错：拿不到时仍返回实况，不让最高/最低缺失拖垮整次查询
    let daily = null;
    try {
      const dText = await dRes.text();
      const dData = JSON.parse(dText);
      if (dData.code === "200" && Array.isArray(dData.daily) && dData.daily.length) {
        daily = dData.daily;
      } else {
        console.log(`[和风天气] 预报不可用: code=${dData.code}`);
      }
    } catch (e) {
      console.error(`[和风天气] 预报解析失败: ${e.message}`);
    }

    const n = wData.now;
    let result = `${loc.adm2}${loc.name}当前天气：${n.text}，气温${n.temp}°C，体感${n.feelsLike}°C，${n.windDir}${n.windScale}级，湿度${n.humidity}%，能见度${n.vis}km。`;

    if (daily) {
      const today = daily[0];
      result += `今日（${today.fxDate}）${today.textDay}，最高${today.tempMax}°C，最低${today.tempMin}°C`;
      if (today.textDay !== today.textNight) {
        result += `，白天${today.textDay}、夜间${today.textNight}`;
      }
      result += `，日出${today.sunrise}，日落${today.sunset}，紫外线指数${today.uvIndex}，降水概率${today.precip}%，${today.windDirDay}${today.windScaleDay}级。`;
      const next = daily
        .slice(1, 3)
        .map((x) => `${x.fxDate} ${x.textDay}，${x.tempMin}~${x.tempMax}°C`)
        .join("；");
      if (next) result += `未来两天：${next}。`;
    } else {
      result += `（今日最高/最低气温暂无，预报接口未返回数据）`;
    }

    result += `更新时间：${n.obsTime}`;
    console.log(`[和风天气] ${result}`);

    // 结构化数据：前端据此渲染天气卡片（文本仍作为上下文喂给模型）
    const data = {
      city: `${loc.adm2}${loc.name}`,
      obsTime: n.obsTime,
      now: {
        text: n.text,
        temp: n.temp,
        feelsLike: n.feelsLike,
        windDir: n.windDir,
        windScale: n.windScale,
        humidity: n.humidity,
        vis: n.vis,
      },
      today: daily
        ? {
          date: daily[0].fxDate,
          textDay: daily[0].textDay,
          textNight: daily[0].textNight,
          tempMax: daily[0].tempMax,
          tempMin: daily[0].tempMin,
          sunrise: daily[0].sunrise,
          sunset: daily[0].sunset,
          uvIndex: daily[0].uvIndex,
          precip: daily[0].precip,
          windDirDay: daily[0].windDirDay,
          windScaleDay: daily[0].windScaleDay,
        }
        : null,
      daily: daily
        ? daily.slice(0, 3).map((x) => ({
          date: x.fxDate,
          textDay: x.textDay,
          tempMax: x.tempMax,
          tempMin: x.tempMin,
        }))
        : null,
    };

    return { text: result, data };
  } catch (e) {
    console.error(`[和风天气] 异常: ${e.message}`);
    return null;
  }
}

/**
 * 限时 fetch
 */
function fetchWithTimeout(url, options = {}, ms = 12000) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), ms);
  return fetch(url, { ...options, signal: ctrl.signal }).finally(() =>
    clearTimeout(timer)
  );
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/**
 * 带重试的限时 fetch：对超时 / 连接重置 / 网络抖动自动退避重试
 */
async function fetchWithRetry(url, options = {}, ms = 12000, retries = 2) {
  let lastErr;
  for (let i = 0; i <= retries; i++) {
    try {
      return await fetchWithTimeout(url, options, ms);
    } catch (e) {
      lastErr = e;
      if (options.signal && options.signal.aborted) throw e; // 用户主动中止不重试
      const retryable =
        e.name === "AbortError" ||
        e.code === "ECONNRESET" ||
        e.code === "ETIMEDOUT" ||
        e.code === "ENOTFOUND" ||
        e.code === "ECONNREFUSED" ||
        /terminated|fetch failed|network|socket|timeout/i.test(e.message || "");
      if (i < retries && retryable) {
        await sleep(300 * (i + 1));
        continue;
      }
      throw e;
    }
  }
  throw lastErr;
}

/**
 * 默认人设：全能型通用 AI
 */
const DEFAULT_SYSTEM_INSTRUCTION = `你是「初音小站」的高性能极速 AI 助手。

【极简与纯净准则 - 严苛遵守】
1. 极简干脆（问什么答什么）：直接输出用户提问的核心结论。第一句直接给最终答案，严禁废话、严禁客套铺垫（不要说“根据资料”、“网上有不同说法”等）。
2. 严禁无关发散：紧扣问题本身，绝对不要主动扩充未询问的背景信息、家世渊源、生辰年月、周边段子辟谣或历史衍生（例如问“原名叫什么”仅答名字，绝不写出生年月、祖父改姓或游戏英雄等无关琐事）。
3. 纯净作答（严禁写来源）：严禁输出任何“来源：xxx”、“参考链接：xxx”或网址，保持输出纯净利落。
4. 极致速度与凝练：常规问答控制在 1~3 句话以内，直击要害，绝不堆砌冗长段落。
5. 【最重要】只回答用户当前最新的这一条问题。之前对话中已经回答过的内容（如天气、其他话题等）绝对不要重复提及或回顾，除非用户明确追问“刚才那个xxx再说一下”。用户开启新话题时，直接回答新话题，严禁回顾上文。`;

/**
 * 动态获取生效中的 AI 配置（优先 ai_settings 表，降级环境变量）
 */
async function getEffectiveAISettings() {
  const settings = {
    provider: process.env.LLM_PROVIDER || "openai",
    baseUrl: process.env.LLM_BASE_URL || "https://tokenhub.tencentmaas.com/v1",
    model: process.env.LLM_MODEL || "deepseek/deepseek-v4-flash-vision-exp",
    apiKey: process.env.LLM_API_KEY || "",
    systemPrompt: "",
  };

  try {
    const [rows] = await db.query(
      "SELECT COALESCE(setting_key, `key`) AS k, COALESCE(setting_value, `value`) AS v FROM ai_settings"
    );
    rows.forEach((r) => {
      if (r.k && r.v && r.v.trim()) settings[r.k] = r.v.trim();
    });
  } catch (e) { }

  return settings;
}

/**
 * 简单问候 / 闲聊 / 身份询问
 */
function isGreetingOrChitchat(message) {
  if (!message) return true;
  const msg = message.trim().toLowerCase();

  if (/^(hello|hi|hey|halo|greetings|test|yo)(\!|\?|\.|\s)*$/.test(msg)) {
    return true;
  }

  const greetings = [
    "你好", "您好", "在吗", "在不在", "早上好", "下午好", "晚上好",
    "哈罗", "哈啰", "喂", "测试", "你好呀", "您好呀", "嗨", "嘿",
  ];
  if (
    greetings.some(
      (g) =>
        msg === g ||
        msg === g + "？" ||
        msg === g + "?" ||
        msg === g + "！" ||
        msg === g + "!"
    )
  ) {
    return true;
  }

  const identityQueries = ["你是谁", "你叫什么", "你的名字", "你叫啥", "自我介绍"];
  if (identityQueries.some((q) => msg.includes(q) && msg.length < 15)) {
    return true;
  }

  return false;
}

/**
 * 清洗客户端历史
 */
const MAX_HISTORY_TURNS = 4; // 只保留最近2轮对话，减少token量加速模型响应
const MAX_HISTORY_CHARS = 4000;
function sanitizeHistory(history) {
  if (!Array.isArray(history)) return [];
  return history
    .filter(
      (item) =>
        item &&
        typeof item === "object" &&
        (item.role === "user" || item.role === "assistant") &&
        item.content !== undefined &&
        item.content !== null
    )
    .slice(-MAX_HISTORY_TURNS)
    .map((item) => ({
      role: item.role === "user" ? "user" : "assistant",
      content: String(item.content).slice(0, MAX_HISTORY_CHARS),
    }));
}

/* ===================== 意图判断（快速、本地、零模型往返） ===================== */

// 需要联网：实时信息、实体查询或现实问答
function shouldSearchOnline(msg) {
  if (!msg || isGreetingOrChitchat(msg)) return false;
  // 明显时效词 / 数据词
  if (
    /天气|气温|温度|冷不冷|热不热|下雨|下雪|穿衣|新闻|最新|最近|今天|今晚|今早|现在|目前|当前|刚刚|刚才|这几天|本周|这周|股价|股票|汇率|油价|金价|比分|赛况|赛程|赛果|发布了|上线了|出了吗|更新了|多少钱|价格|官网|热搜|头条|发布会|实时|近期/.test(
      msg
    )
  )
    return true;
  // 编程/技术类问题不触发联网（这些知识模型本身就有，搜了反而浪费且可能引入错误信息）
  if (/(vue|react|angular|python|java|javascript|typescript|css|html|node|express|mysql|mongodb|docker|git|linux|nginx|webpack|vite)/i.test(msg) && !/(天气|新闻|股价|价格|最新版本|发布了|更新了)/.test(msg)) {
    return false;
  }
  // 现实实体、人物、地点、机构、大学、产品、对比评测
  if (
    /(公司|企业|集团|品牌|简介|老板|董事长|创始人|旗下|是谁|哪里人|多少人|排名|份额|大学|学院|学校|地址|怎么样|好不好|好玩吗|怎么去|录取线|多少分|什么时候|哪一年|何年|何地|介绍|发展|历史|评价|推荐|对比|区别|配置|参数|评测|现状|趋势|政策|活动|上映|播出)/.test(
      msg
    )
  )
    return true;
  // 带问号且非纯编程语法的问题
  if (
    /[?？]/.test(msg) &&
    msg.length >= 4 &&
    !/(编写|写个|写一段|算法|正则|css|html|vue|react|js|ts|python|sql|java|c\+\+|函数)/i.test(msg)
  ) {
    return true;
  }
  return false;
}

// 需要私有知识库
function shouldSearchKnowledge(msg) {
  if (!msg) return false;
  return /(车间|部门|科室|岗位|编制|制度|员工|职工|产量|产能|指标|生产计划|内部|我厂|我司|本厂|本公司|煤化工|兰炭|硅铁|金属镁|碳化砖|洗煤|尾气发电|规章|考勤|工资|绩效)/.test(
    msg
  );
}

// 消息中直接给出了 URL
const URL_RE = /(https?:\/\/[^\s，。、）)】\]]+)/;

/* ===================== 自建联网：多源搜索（竞速） ===================== */

function decodeDdgHref(href) {
  try {
    const m = href.match(/[?&]uddg=([^&]+)/);
    if (m) return decodeURIComponent(m[1]);
  } catch (e) { }
  return href;
}

async function searchDuckDuckGo(query, n) {
  const r = await fetchWithRetry(
    `https://html.duckduckgo.com/html/?q=${encodeURIComponent(query)}`,
    { headers: { "User-Agent": DEFAULT_UA, "Accept-Language": "zh-CN,zh;q=0.9" } },
    6000,
    1
  );
  if (!r.ok) return [];
  const $ = cheerio.load(await r.text());
  const out = [];
  $("div.result").each((i, el) => {
    const a = $(el).find("a.result__a").first();
    const title = a.text().trim();
    const href = a.attr("href") || "";
    const snippet = $(el).find(".result__snippet").first().text().trim();
    if (title && href) out.push({ title, url: decodeDdgHref(href), snippet });
  });
  return out.slice(0, n);
}

async function searchSogou(query, n) {
  const r = await fetchWithRetry(
    `https://www.sogou.com/web?query=${encodeURIComponent(query)}`,
    { headers: { "User-Agent": DEFAULT_UA, "Accept-Language": "zh-CN,zh;q=0.9" } },
    6000,
    1
  );
  if (!r.ok) return [];
  const $ = cheerio.load(await r.text());
  const out = [];
  $("div.vrwrap,div.rb").each((i, el) => {
    const a = $(el).find("h3 a").first();
    const title = a.text().trim();
    let href = a.attr("href") || "";
    if (href.startsWith("/")) href = "https://www.sogou.com" + href;
    const snippet = $(el).find("p.str-text-info,.str_info,.ft").first().text().trim();
    if (title && href) out.push({ title, url: href, snippet });
  });
  return out.slice(0, n);
}

async function search360(query, n) {
  const r = await fetchWithRetry(
    `https://www.so.com/s?q=${encodeURIComponent(query)}`,
    { headers: { "User-Agent": DEFAULT_UA, "Accept-Language": "zh-CN,zh;q=0.9" } },
    3000,
    1
  );
  if (!r.ok) return [];
  const $ = cheerio.load(await r.text());
  const out = [];
  $("li.res-list").each((i, el) => {
    const a = $(el).find("h3 a").first();
    const title = a.text().trim();
    const href = a.attr("href") || "";
    const snippet = $(el).find("p.res-desc,.res-desc,.res-rich,p").first().text().trim();
    if (title && href) out.push({ title, url: href, snippet });
  });
  return out.slice(0, n);
}

async function searchBaidu(query, n) {
  const r = await fetchWithRetry(
    `https://www.baidu.com/s?wd=${encodeURIComponent(query)}`,
    { headers: { "User-Agent": DEFAULT_UA, "Accept-Language": "zh-CN,zh;q=0.9" } },
    3500,
    1
  );
  if (!r.ok) return [];
  const $ = cheerio.load(await r.text());
  const out = [];
  $(".result.c-container").each((i, el) => {
    const a = $(el).find("h3 a").first();
    const title = a.text().trim();
    const href = a.attr("href") || "";
    const snippet = $(el).find(".c-font-normal, .content-right_1THTn, p").first().text().trim();
    if (title) out.push({ title, url: href, snippet });
  });
  return out.slice(0, n);
}

function formatResults(list, n) {
  if (!list || !list.length) return "";
  return list
    .slice(0, n)
    .map((r, i) => {
      const sn = r.snippet ? String(r.snippet).slice(0, 120) : "";
      return `[${i + 1}] ${r.title}\n链接: ${r.url}${sn ? `\n摘要: ${sn}` : ""}`;
    })
    .join("\n\n");
}

/**
 * web_search：360（极速400ms）/ 百度（1.5s）/ 搜狗 毫秒级竞速，最先非空者秒胜出
 */
async function webSearch(query, n = 5) {
  // 缓存检查：归一化后同一查询30分钟内直接返回缓存，保证前后一致
  const cacheKey = normalizeQueryForCache(query);
  console.log(`[缓存调试] 原始query="${query}" → 归一化key="${cacheKey}"，当前缓存条数=${searchCache.size}`);
  const cached = searchCache.get(cacheKey);
  if (cached && cached.expireAt > Date.now()) {
    console.log(`[搜索缓存命中] key="${cacheKey}"，直接返回缓存结果`);
    return cached.text;
  }
  console.log(`[搜索缓存未命中] key="${cacheKey}"，执行联网搜索`);

  const asRace = (fn) =>
    fn(query, n).then((r) => {
      if (!r || !r.length) throw new Error("empty");
      return r;
    });
  try {
    const fastest = await Promise.any([
      asRace(search360),
      asRace(searchBaidu),
      asRace(searchSogou),
      asRace(searchDuckDuckGo),
    ]);
    const result = formatResults(fastest, n);

    // 存入缓存
    searchCache.set(cacheKey, {
      text: result,
      expireAt: Date.now() + SEARCH_CACHE_TTL,
    });
    // 超过容量淘汰最老的条目
    if (searchCache.size > SEARCH_CACHE_MAX) {
      const oldestKey = searchCache.keys().next().value;
      searchCache.delete(oldestKey);
    }

    return result;
  } catch (e) {
    return "";
  }
}

/**
 * fetch_webpage：网页正文抓取（含 SSRF 校验与受控重定向）
 */
async function fetchWebpageText(rawUrl) {
  let currentUrl = String(rawUrl || "").trim();
  if (!/^https?:\/\//i.test(currentUrl)) return "仅支持 http/https 链接";

  try {
    let r = null;
    for (let hop = 0; hop <= 3; hop++) {
      currentUrl = await assertSafePublicUrl(currentUrl);
      r = await fetchWithRetry(
        currentUrl,
        {
          headers: { "User-Agent": DEFAULT_UA, "Accept-Language": "zh-CN,zh;q=0.9" },
          redirect: "manual",
        },
        8000,
        1
      );
      if (r.status >= 300 && r.status < 400) {
        const location = r.headers.get("location");
        if (!location) return `抓取失败：重定向缺少 Location`;
        currentUrl = new URL(location, currentUrl).toString();
        continue;
      }
      break;
    }
    if (!r || (r.status >= 300 && r.status < 400)) return "抓取失败：重定向次数过多";
    if (!r.ok) return `抓取失败：HTTP ${r.status}`;

    const html = await r.text();
    const $ = cheerio.load(html);
    $("script,style,noscript,iframe,svg,form").remove();
    const root = $("article").length
      ? $("article")
      : $("main").length
        ? $("main")
        : $("body");

    let text = root
      .text()
      .replace(/ /g, " ")
      .replace(/[ \t]+/g, " ")
      .replace(/[ \t]*\n[ \t]*/g, "\n")
      .replace(/\n{3,}/g, "\n\n")
      .trim();
    text = text.slice(0, 6000);
    return text || "未从该页面提取到有效正文。";
  } catch (e) {
    return "网页抓取失败：" + (e.name === "AbortError" ? "请求超时" : e.message || String(e));
  }
}

/**
 * 单次模型流式调用（无工具，模型一次成型，最快最稳）
 */
async function* streamModel(messages, aiSettings, signal) {
  const baseUrl = (aiSettings.baseUrl || "").replace(/\/+$/, "");
  const apiKey = aiSettings.apiKey;
  if (!apiKey) throw new Error("后端未正确配置 AI 推理密钥 LLM_API_KEY，请检查设置");

  const requestBody = {
    model: aiSettings.model,
    messages,
    stream: true,
    stream_options: { include_usage: true },
    thinking: { type: "disabled" },
    enable_thinking: false,
    temperature: 0.3,
    max_tokens: 1024, // 限制输出长度，避免过长回答拖慢速度
  };

  const response = await fetchWithRetry(
    `${baseUrl}/chat/completions`,
    {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${apiKey}`,
      },
      body: JSON.stringify(requestBody),
      signal,
    },
    12000,
    2
  );

  if (!response.ok) {
    const t = await response.text();
    throw new Error(`AI API 异常响应 (${response.status}): ${t}`);
  }

  const reader = response.body.getReader();
  const decoder = new TextDecoder("utf-8");
  let lineBuffer = "";

  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      lineBuffer += decoder.decode(value, { stream: true });
      const lines = lineBuffer.split("\n");
      lineBuffer = lines.pop();
      for (const line of lines) {
        const cl = line.trim();
        if (!cl || cl === "data: [DONE]" || !cl.startsWith("data: ")) continue;
        let data;
        try {
          data = JSON.parse(cl.slice(6));
        } catch (e) {
          continue;
        }
        const choice = data.choices && data.choices[0];
        if (!choice) continue;
        const delta = choice.delta || {};
        const text = delta.content || "";
        const reasoning =
          delta.reasoning_content || delta.reasoning || delta.thought || "";
        if (text || reasoning) yield { text, reasoning };
      }
    }
  } finally {
    try {
      reader.releaseLock();
    } catch (e) { }
  }
}

/**
 * 入口：生成对话流（async generator）
 * 策略：快速意图判断 → 需要时先并行检索（网页/联网/私有库）一次性注入 → 模型单次流式作答
 */
async function generateChatStream(
  history = [],
  userMessage,
  fileInfo = null,
  signal = null,
  forceWebSearch = null
) {
  const aiSettings = await getEffectiveAISettings();
  let systemInstruction =
    aiSettings.systemPrompt && aiSettings.systemPrompt.trim()
      ? aiSettings.systemPrompt.trim()
      : DEFAULT_SYSTEM_INSTRUCTION;

  // 无论数据库里有没有自定义Prompt，都强制追加防复读规则，防止被覆盖
  systemInstruction += `\n\n【最高优先级规则】只回答用户当前最新的这一条问题。之前对话中已经回答过的内容（如天气、其他话题等）绝对不要重复提及或回顾，除非用户明确追问。用户开启新话题时，直接回答新话题，严禁回顾上文。`;

  const now = new Date();
  systemInstruction += `\n\n【系统信息】当前北京时间：${now.toLocaleString("zh-CN", {
    timeZone: "Asia/Shanghai",
  })}。`;

  if (isGreetingOrChitchat(userMessage)) {
    systemInstruction +=
      "\n【系统预设】这是日常问候或身份询问，用一句简短亲切的话回应即可。";
  }

  const baseMessages = [{ role: "system", content: systemInstruction }];
  sanitizeHistory(history).forEach((it) => baseMessages.push(it));

  // 前置检索意图：闲聊与问候绝不触发联网检索
  const isChitChat = isGreetingOrChitchat(userMessage);
  const urlMatch = String(userMessage).match(URL_RE);
  const givenUrl = urlMatch ? urlMatch[1] : null;
  const needFetch = !!givenUrl;
  const needWeb =
    !needFetch &&
    !isChitChat &&
    (forceWebSearch === true ||
      (forceWebSearch !== false && shouldSearchOnline(userMessage)));
  const needKb = !isChitChat && shouldSearchKnowledge(userMessage);

  return (async function* () {
    const contextParts = [];

    // 天气类问题优先走和风天气API，拿精确数据
    let weatherHandled = false;
    if (isWeatherQuery(userMessage) && !isChitChat) {
      const city = extractCityFromQuery(userMessage);
      if (city) {
        console.log(`[天气专用通道] 检测到天气查询，城市="${city}"`);
        const weatherRes = await fetchWeatherFromQweather(city);
        if (weatherRes && weatherRes.text) {
          contextParts.push(
            "【实时天气数据（和风天气官方）】\n" +
            weatherRes.text +
            "\n（回答时请务必同时给出今日最高气温与最低气温；若用户问的是今天/此刻，先说当前气温再说今日区间。）"
          );
          weatherHandled = true;
          yield {
            weather: weatherRes.data,
            searchStatus: "completed",
            searchTitle: "已获取实时天气 [v2]",
            text: "",
            reasoning: "",
          };
        }
      }
    }

    // 天气已通过API获取精确数据，跳过网页爬虫
    let pageRes = "";
    let webRes = "";
    let kbRes = "";
    if (!weatherHandled && (needFetch || needWeb || needKb)) {
      const searchTitle = needFetch
        ? "正在解析网页正文…"
        : needKb
          ? "正在检索站内私有知识库…"
          : "正在全网检索最新信息…";
      yield { searchStatus: "searching", searchTitle, text: "", reasoning: "" };

      [pageRes, webRes, kbRes] = await Promise.all([
        needFetch
          ? fetchWebpageText(givenUrl).catch(() => "")
          : Promise.resolve(""),
        needWeb ? webSearch(userMessage, 5).catch(() => "") : Promise.resolve(""),
        needKb
          ? searchKnowledgeBase(userMessage, 4).catch(() => "")
          : Promise.resolve(""),
      ]);

      if (kbRes) contextParts.push("【私有知识库检索结果】\n" + kbRes);
      if (webRes) contextParts.push("【全网最新检索资料】\n" + webRes);
      if (pageRes) contextParts.push("【指定网页正文】\n" + pageRes);

      yield {
        searchStatus: "completed",
        searchTitle: needFetch
          ? "已解析目标网页正文 [v2]"
          : needKb
            ? "已检索私有知识库 [v2]"
            : webRes
              ? "已融合全网实时资讯 [v2]"
              : "全网检索完成 [v2]",
        text: "",
        reasoning: "",
      };
    }

    let promptText = userMessage;
    if (fileInfo && fileInfo.fileText) {
      promptText = `[用户上传附件 ${fileInfo.filename}]\n${fileInfo.fileText}\n\n请结合附件回答:\n${userMessage}`;
    }
    if (contextParts.length) {
      promptText = `【互联网实时参考资料】\n${contextParts.join(
        "\n\n"
      )}\n\n【用户提问】\n${promptText}\n\n【回答要求】\n- 首句直接给出核心结论。\n- 如果参考资料中没有用户问的具体信息（比如某个小地方的天气），就明确说"暂无该地区的精确数据，建议查看天气APP获取实时信息"，绝对不要编造或猜测。\n- 绝对不要重复之前对话中已经回答过的内容。\n- 严禁输出任何来源、参考链接或网址。`;
    } else if (needWeb && !webRes) {
      // 搜索触发了但所有引擎都失败了，明确告知模型不要编造
      promptText = `${promptText}\n\n【系统提示】本次联网检索未获取到有效结果。如果你确定知道答案就直接回答；如果不确定或涉及时效性数据（如天气、股价等），请明确告知用户"暂时无法获取实时数据，建议稍后重试或查看专业APP"，不要编造。`;
    }

    // 在历史对话和当前问题之间插入 system 分隔，强制模型忽略历史内容
    baseMessages.push({
      role: "system",
      content: "⚠️ 以上是所有历史对话记录。现在请完全忽略历史内容，只回答下面这一个最新问题。绝对不要重复、回顾或提及任何历史回答中的内容。",
    });
    baseMessages.push({ role: "user", content: promptText });
    yield* streamModel(baseMessages, aiSettings, signal);
  })();
}

/**
 * 文章 AI 摘要（非流式）
 */
async function generateArticleSummary(title, content) {
  const { baseUrl, apiKey, model: modelName } = await getEffectiveAISettings();
  if (!apiKey) throw new Error("未配置 LLM_API_KEY");

  const cleanContent = (content || "").replace(/<[^>]+>/g, "").substring(0, 3000);
  const prompt = `请作为科技博客专业编辑，为文章《${title}》提炼一段高质量的 AI 核心摘要。
要求：
1. 包含 3 点核心要点；
2. 120 字以内的精炼短句；
3. 语言专业优雅，排版清晰。

文章正文片段：
${cleanContent}`;

  const response = await fetch(`${baseUrl.replace(/\/+$/, "")}/chat/completions`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${apiKey}`,
    },
    body: JSON.stringify({
      model: modelName,
      messages: [
        { role: "system", content: "你是初音小站博客平台的 AI 领读编辑。" },
        { role: "user", content: prompt },
      ],
      stream: false,
      enable_thinking: false,
    }),
  });

  if (!response.ok) throw new Error("AI 摘要生成失败");
  const data = await response.json();
  return data.choices?.[0]?.message?.content || "暂无摘要";
}

/**
 * AI 爆款标题推荐（非流式）
 */
async function generateTitleIdeas(content) {
  const { baseUrl, apiKey, model: modelName } = await getEffectiveAISettings();
  if (!apiKey) throw new Error("未配置 LLM_API_KEY");

  const cleanContent = (content || "").replace(/<[^>]+>/g, "").substring(0, 2000);
  const prompt = `根据以下文章正文草稿，生成 5 个吸引人的硬核/爆款技术博客标题。每行一个标题，不要添加多余序号或说明文字。

文章正文草稿：
${cleanContent}`;

  const response = await fetch(`${baseUrl.replace(/\/+$/, "")}/chat/completions`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${apiKey}`,
    },
    body: JSON.stringify({
      model: modelName,
      messages: [
        {
          role: "system",
          content: "你是一位精通技术传播与二次元科技美学的高级博客主编。",
        },
        { role: "user", content: prompt },
      ],
      stream: false,
      enable_thinking: false,
    }),
  });

  if (!response.ok) throw new Error("标题生成失败");
  const data = await response.json();
  const text = data.choices?.[0]?.message?.content || "";
  return text
    .split("\n")
    .map((t) => t.trim())
    .filter(Boolean)
    .slice(0, 5);
}

module.exports = {
  generateChatStream,
  generateArticleSummary,
  generateTitleIdeas,
  getEffectiveAISettings,
  DEFAULT_SYSTEM_INSTRUCTION,
  isGreetingOrChitchat,
};

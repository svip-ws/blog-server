const sanitizeHtml = require("sanitize-html");

/**
 * 针对博客富文本与文章正文的安全清洗配置
 * 允许常见排版标签、图片、音视频、表格、代码块及安全内联样式，
 * 严格剔除 <script>、恶意 <iframe>、以及所有 on* 事件属性 (如 onerror, onclick) 与 javascript: 伪协议
 */
const ARTICLE_SANITIZE_OPTIONS = {
  allowedTags: [
    ...sanitizeHtml.defaults.allowedTags,
    "h1", "h2", "h3", "h4", "h5", "h6",
    "img", "figure", "figcaption",
    "video", "audio", "source",
    "code", "pre", "hr", "br",
    "table", "thead", "tbody", "tfoot", "tr", "th", "td",
    "span", "div", "blockquote", "sub", "sup", "del", "u", "s", "mark"
  ],
  allowedAttributes: {
    ...sanitizeHtml.defaults.allowedAttributes,
    "*": ["class", "style", "title", "id", "align"],
    a: ["href", "name", "target", "rel"],
    img: ["src", "alt", "title", "width", "height", "loading"],
    video: ["src", "controls", "width", "height", "poster"],
    audio: ["src", "controls"],
    source: ["src", "type"],
  },
  allowedSchemes: ["http", "https"],
  allowedSchemesByTag: {
    img: ["http", "https", "data"],
    video: ["http", "https"],
    audio: ["http", "https"],
    source: ["http", "https"],
  },
  allowedSchemesAppliedTo: ["href", "src"],
  allowProtocolRelative: false,
  allowedStyles: {
    "*": {
      color: [/^#[0-9a-fA-F]{3,8}$/, /^rgb\(/, /^rgba\(/, /^[a-zA-Z]+$/],
      "background-color": [/^#[0-9a-fA-F]{3,8}$/, /^rgb\(/, /^rgba\(/, /^[a-zA-Z]+$/],
      "text-align": [/^(left|right|center|justify)$/],
      "font-size": [/^\d+(px|em|rem|%)$/],
      "font-weight": [/^(normal|bold|bolder|lighter|\d{3})$/],
      "text-decoration": [/^(none|underline|line-through)$/],
    },
  },
  transformTags: {
    a: sanitizeHtml.simpleTransform("a", { rel: "noopener noreferrer" }, true)
  }
};

/**
 * 清洗文章富文本内容（存储型 XSS 防御）
 * @param {string} content 
 * @returns {string} 清洗后的安全 HTML
 */
function cleanArticleContent(content) {
  if (!content || typeof content !== "string") return "";
  return sanitizeHtml(content, ARTICLE_SANITIZE_OPTIONS);
}

/**
 * 清洗简易文本（如评论、留言等纯文本，防止注入任何 HTML）
 * @param {string} text 
 * @returns {string} 过滤所有标签后的安全文本
 */
function cleanPlainText(text) {
  if (!text || typeof text !== "string") return "";
  return sanitizeHtml(text, {
    allowedTags: [],
    allowedAttributes: {}
  });
}

module.exports = {
  cleanArticleContent,
  cleanPlainText,
  ARTICLE_SANITIZE_OPTIONS
};

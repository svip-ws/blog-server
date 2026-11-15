// 留言/回复内容的基础敏感词拦截表
// 说明：仅做子串命中即拒绝，不做替换，避免误改用户正常表达
const BLOCKED_WORDS = [
  "赌博", "博彩", "色情", "裸聊", "招嫖", "代开发票", "办证",
  "刷单", "兼职日结", "加微信", "加qq", "私聊我", "贷款秒批",
  "套现", "毒品", "冰毒", "枪支", "弹药", "黑客接单",
];

function findBlockedWord(text) {
  if (!text) return null;
  const normalized = String(text).toLowerCase();
  return BLOCKED_WORDS.find((word) => normalized.includes(word.toLowerCase())) || null;
}

module.exports = { findBlockedWord, BLOCKED_WORDS };

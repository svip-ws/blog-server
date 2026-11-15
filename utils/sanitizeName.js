/**
 * 名称字段统一清洗（分类名、标签名等纯文本枚举型字段）
 * -------------------------------------------------------------
 * 背景：历史数据曾出现名称尾部携带零宽字符的情况
 *       （category id=24、tag id=23 均为 "期末不挂科" + U+200B 零宽空格），
 *       前端会渲染出一个多余符号（表现为 "↗" 之类的可疑字符），
 *       且与同名记录无法按字面判重，导致"看起来重复"。
 *
 * 处理：剔除零宽/不可见字符 → 折叠连续空白 → 去首尾。
 * 所有写入（create / update）统一走此函数，从写入侧根治。
 */

// U+200B~200D 零宽空格/连接符、U+FEFF BOM、U+2060 word joiner
const INVISIBLE_CHARS = /[\u200B-\u200D\uFEFF\u2060]/g;
// 单独保留一个非全局版本：全局正则的 test() 会因 lastIndex 残留而交替返回结果
const INVISIBLE_CHARS_TEST = /[\u200B-\u200D\uFEFF\u2060]/;

const sanitizeName = (raw) =>
  String(raw ?? "")
    .replace(INVISIBLE_CHARS, "")
    .replace(/\s+/g, " ")
    .trim();

/** 判断字符串是否含零宽/不可见字符（用于数据体检脚本） */
const hasInvisibleChars = (raw) => INVISIBLE_CHARS_TEST.test(String(raw ?? ""));

module.exports = { sanitizeName, hasInvisibleChars };

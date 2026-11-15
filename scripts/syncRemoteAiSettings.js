require('dotenv').config();
const jwt = require('jsonwebtoken');

(async () => {
  const secret = process.env.JWT_SECRET;
  const apiKey = process.env.LLM_API_KEY;
  if (!secret || !apiKey) {
    console.error('请在环境变量中设置 JWT_SECRET 与 LLM_API_KEY 后再运行同步脚本');
    process.exit(1);
  }
  const token = jwt.sign({ id: 1, username: 'admin2026', role: 'admin' }, secret, { expiresIn: '1h' });
  
  const systemPrompt = "你是「初音小站」的高性能极速 AI 助手。\n\n" +
    "【极简与纯净准则 - 严苛遵守】\n" +
    "1. 极简干脆（问什么答什么）：直接输出用户提问的核心结论。第一句直接给最终答案，严禁废话、严禁客套铺垫。\n" +
    "2. 严禁无关发散：紧扣问题本身，绝对不要主动扩充未询问的背景信息、家世渊源、生辰年月、周边段子辟谣或历史衍生。\n" +
    "3. 纯净作答（严禁写来源）：严禁输出任何“来源：xxx”、“参考链接：xxx”或网址，保持输出纯净利落。\n" +
    "4. 极致速度与凝练：常规问答控制在 1~3 句话以内，直击要害，绝不堆砌冗长段落。";

  const targetUrl = process.env.REMOTE_AI_SETTINGS_URL || 'https://hxiuji.top/api/ai/settings';
  const res = await fetch(targetUrl, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': 'Bearer ' + token
    },
    body: JSON.stringify({
      provider: process.env.LLM_PROVIDER || 'openai',
      baseUrl: process.env.LLM_BASE_URL || 'https://tokenhub.tencentmaas.com/v1',
      model: process.env.LLM_MODEL || 'deepseek/deepseek-v4-flash-vision-exp',
      apiKey,
      systemPrompt
    })
  });
  console.log('Update status:', res.status, await res.text());
})();

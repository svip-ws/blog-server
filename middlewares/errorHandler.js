/**
 * 全局错误捕获中间件
 * 避免未捕获的异步异常/运行时错误导致 Node 进程崩溃，输出标准化的 JSON 错误响应
 */
const errorHandler = (err, req, res, next) => {
  console.error("--- ❌ [Server Error Handled]:", err.stack || err.message || err);

  let statusCode = err.status || err.statusCode || 500;
  let message = err.message || "服务器内部开小差了，请稍后再试";

  if (err.name === "MulterError") {
    statusCode = err.code === "LIMIT_FILE_SIZE" ? 413 : 400;
    message =
      err.code === "LIMIT_FILE_SIZE"
        ? "上传文件体积超出限制"
        : "文件上传参数错误";
  } else if (err.type === "entity.too.large") {
    // body-parser 请求体超限：给前端一个可读的提示，而不是笼统的 413
    statusCode = 413;
    message = "提交内容超出长度限制（单次上限 2MB），请精简正文或分次保存";
  } else if (err.type === "entity.parse.failed") {
    statusCode = 400;
    message = "请求内容格式不正确，应为合法 JSON";
  } else if (statusCode >= 500 && process.env.NODE_ENV === "production") {
    message = "服务器内部开小差了，请稍后再试";
  }

  res.status(statusCode).json({
    code: statusCode,
    message,
    data: null,
    ...(process.env.NODE_ENV === "development" && { stack: err.stack }),
  });
};

module.exports = errorHandler;

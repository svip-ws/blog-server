const COS = require('cos-nodejs-sdk-v5');

// 密钥只从环境变量读取，不硬编码
const cos = new COS({
    SecretId: process.env.COS_SECRET_ID,
    SecretKey: process.env.COS_SECRET_KEY,
});

const bucket = process.env.COS_BUCKET;   // my-bucket-1446743291
const region = process.env.COS_REGION;   // ap-shanghai

module.exports = { cos, bucket, region };
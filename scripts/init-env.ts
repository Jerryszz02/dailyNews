// Creates .env from .env.example with fresh random secrets and an admin password, and does not print the password
// never. Refuses to overwrite an existing .env.   node scripts/init-env.ts
// Optional model key is read only from LLM_API_KEY, never a command-line argument.
import { randomBytes } from "node:crypto";
import { existsSync, readFileSync, writeFileSync } from "node:fs";

if (existsSync(".env")) {
  console.error(".env 已经存在，没有覆盖。要重新生成，先把它改名或删掉。");
  process.exit(1);
}
const password = randomBytes(12).toString("base64url");
const llmKey = process.env.LLM_API_KEY ?? "";
const text = readFileSync(".env.example", "utf8")
  .replace(/^ADMIN_PASSWORD=$/m, `ADMIN_PASSWORD=${password}`)
  .replace(/^SESSION_SECRET=$/m, `SESSION_SECRET=${randomBytes(32).toString("hex")}`)
  .replace(/^IMG_PROXY_SIGN_SECRET=$/m, `IMG_PROXY_SIGN_SECRET=${randomBytes(32).toString("hex")}`)
  .replace(/^POSTGRES_PASSWORD=$/m, `POSTGRES_PASSWORD=${randomBytes(18).toString("hex")}`)
  .replace(/^LLM_API_KEY=$/m, `LLM_API_KEY=${llmKey}`);
writeFileSync(".env", text, { mode: 0o600 });
console.log("已生成 .env。");
console.log("随机管理员密码与签名密钥已写入权限为 0600 的 .env；采集和模型调用默认关闭。");
if (!llmKey) console.log("离线模式可直接验证；有界试运行前另行配置经过核实的模型和预算。");

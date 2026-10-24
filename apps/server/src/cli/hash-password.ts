import { createInterface } from "node:readline/promises";
import { hashPassword } from "../auth.ts";

// Usage: npm run hash-password            (prompts)
//        npm run hash-password -- <pw>    (non-interactive; avoid on shared machines: shell history)
let password = process.argv[2];
if (!password) {
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  password = await rl.question("Password for the RuleDeck admin: ");
  rl.close();
}
if (!password || password.length < 10) {
  console.error("Use at least 10 characters.");
  process.exit(1);
}
// Single quotes keep the $ signs literal in .env files and Docker Compose env_files.
console.log(`RULEDECK_ADMIN_PASSWORD_HASH='${await hashPassword(password)}'`);

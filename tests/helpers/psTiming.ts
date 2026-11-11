// Temporary: how long Windows PowerShell takes to start, with the full environment and with the child's.
import { spawnSync } from "node:child_process";
import { childEnv } from "../../src/config.js";
import { CRED_SCRIPTS } from "../../src/accounts/secrets.js";
import { powershellArgs, powershellPath } from "../../src/util/platform.js";

const time = (label: string, args: string[], env: NodeJS.ProcessEnv) => {
  const t = Date.now();
  const r = spawnSync(powershellPath(), args, { encoding: "utf8", env, input: "" });
  console.log(`${label}: ${((Date.now() - t) / 1000).toFixed(1)}s status ${r.status} ${(r.stderr ?? "").slice(0, 200).replace(/\s+/g, " ")}`);
};
const item = { JEV_SECRET_SERVICE: "jev-timing", JEV_SECRET_ITEM: "none" };
for (let i = 0; i < 2; i++) {
  time("bare, full env", powershellArgs("1"), process.env);
  time("bare, child env", powershellArgs("1"), childEnv());
  time("bare, child env + PSModulePath", powershellArgs("1"), childEnv({ PSModulePath: process.env.PSModulePath ?? "" }));
  time("cred get, full env", powershellArgs(CRED_SCRIPTS.get), { ...process.env, ...item });
  time("cred get, child env", powershellArgs(CRED_SCRIPTS.get), childEnv(item));
  time("cred get, child env + PSModulePath", powershellArgs(CRED_SCRIPTS.get), childEnv({ ...item, PSModulePath: process.env.PSModulePath ?? "" }));
}
console.log(Object.keys(process.env).filter((k) => !(k in childEnv())).filter((k) => !/TOKEN|SECRET|KEY/i.test(k)).join(" "));

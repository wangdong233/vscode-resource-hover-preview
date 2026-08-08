// patcher I/O 测试：fresh/stale/absent 三态 + checksum 重算一致。详见 doc/07 任务 + cc-status-dot test 范式。
// TODO: 在 fixture（/tmp 仿 app 目录：workbench.html + product.json + out/）上 spawn dist/patcher.js
//   断言：absent→patch 后 fresh；stale（旧版本标记）→re-patch；patch 后 product.checksums[wbKey]===sha256(workbench.html)
//   重 patch 幂等（不叠加多个 token / 标记）；revert 后 byte-identical 出厂
import { spawn } from "node:child_process";
console.log("[test-patcher-io] TODO: fixture 三态 + checksum 重算 + 幂等 + revert 断言");

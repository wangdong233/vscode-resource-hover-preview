// patcher I/O 测试：fresh/stale/absent 三态 + checksum 重算一致。详见 doc/07 + cc-status-dot test 范式。
// ⚠️ v0.2-v0.5审查🔴：当前是空壳（0 断言），已从 npm test 移除（避免假绿占 gate 位）。
// 待实现：fixture（/tmp 仿 app 目录：workbench.html + product.json + out/）+ spawn dist/patcher.js（需 patcher 支持 fixture 路径或 mock discover）
//   断言：absent→patch / stale→re-patch / checksums[wbKey]===sha256(盘) / 幂等不叠加 / revert byte-identical。
// 实现前不放回 npm test（test-pending）。
console.log("[test-patcher-io] PENDING: fixture 三态 + checksum 断言待实现（已从 npm test 移除，不占 gate）");

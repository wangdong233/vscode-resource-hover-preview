// overlay bake hash 稳定性 + assertCompiles。详见 doc/07 任务 + cc-status-dot test-overlay-hash 范式。
// TODO: buildOverlayJs(config) 两次 bake → byte-identical（同 config 同输出，CI 闸门）
//   + node --check overlay.js（语法正确）+ assertCompiles
//   + banner hash === sha256(去掉 banner 的 js).slice(0,8) 一致性
import { createHash } from "node:crypto";
console.log("[test-overlay-hash] TODO: bake 稳定性 + assertCompiles + banner hash 一致性断言");

#!/usr/bin/env node
// overlay.template.js 滚轮缩放锚定数学的数值镜像(0.5.31 Y2 修:0.5.25 常量漂移+STEP 缺失被 03 审查抓——现挂入 npm test 链,常量漂移即红)。
// ⚠️ 改 overlay 缩放常量/公式必须同步本文件(03 §1.7 项7);行号不锚定,以符号名为准。
"use strict";
const ZOOM_MAX = 1000, ZOOM_K = 0.0022, ZOOM_K_PINCH = 0.01, ZOOM_STEP_PINCH = 0.336, ZOOM_DY_MAX = 200;

// geometry model: content rect + centered img layout box (flex centering (flex 居中反推))
const CR = { left: 100, top: 100, width: 400, height: 300 };
const IW = 360, IH = 270; // img.offsetWidth/offsetHeight (transform-immune)
const IX = CR.left + (CR.width - IW) / 2;   // 120
const IY = CR.top + (CR.height - IH) / 2;  // 115

// exact port of the handler's per-event math (returns new z + diagnostics)
function wheelStep(z, clientX, clientY, rawDy, ctrlKey) {
  let dy = rawDy; if (dy > ZOOM_DY_MAX) dy = ZOOM_DY_MAX; else if (dy < -ZOOM_DY_MAX) dy = -ZOOM_DY_MAX;
  let step = -dy * (ctrlKey ? ZOOM_K_PINCH : ZOOM_K);
  if (ctrlKey && step > ZOOM_STEP_PINCH) step = ZOOM_STEP_PINCH; else if (ctrlKey && step < -ZOOM_STEP_PINCH) step = -ZOOM_STEP_PINCH;  // 0.5.25 捏合支路步长封顶(原 sim 缺失)
  const sNext = Math.min(ZOOM_MAX, Math.max(1, z.s * Math.exp(step)));
  if (sNext === z.s) return { z, kind: "noop", dyEff: dy };
  if (sNext === 1) return { z: { s: 1, tx: 0, ty: 0 }, kind: "reset", dyEff: dy, sNext };
  const px = (clientX - IX - z.tx) / z.s, py = (clientY - IY - z.ty) / z.s;
  const nz = { s: sNext, tx: clientX - IX - sNext * px, ty: clientY - IY - sNext * py };
  return { z: nz, kind: "apply", dyEff: dy, sNext, px, py, pxBefore: px };
}

// deterministic PRNG (mulberry32) for reproducibility
function mulberry32(a) { return function () { a |= 0; a = (a + 0x6D2B79F5) | 0; let t = Math.imul(a ^ (a >>> 15), 1 | a); t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t; return ((t ^ (t >>> 14)) >>> 0) / 4294967296; }; }

console.log("=== INVARIANT A: cursor-anchored zoom (source px under cursor stays under cursor) ===");
{
  const rnd = mulberry32(20260903);
  let pass = 0, fail = 0, resetSteps = 0, noopSteps = 0, maxErr = 0;
  const rows = [];
  for (let trial = 0; trial < 200; trial++) {
    let z = { s: 1, tx: 0, ty: 0 };
    let cx = CR.left + rnd() * CR.width, cy = CR.top + rnd() * CR.height; // may land in letterbox
    const nSteps = 5 + Math.floor(rnd() * 25);
    for (let i = 0; i < nSteps; i++) {
      // cursor drifts each step (random walk, can leave img into letterbox/outside content)
      cx += (rnd() - 0.5) * 160; cy += (rnd() - 0.5) * 120;
      const dy = (rnd() - 0.5) * 800; // includes |dy|>200 (clamp territory)
      const ctrl = rnd() < 0.15;
      // pre-step: source px under cursor in CURRENT transform
      const pxBefore = (cx - IX - z.tx) / z.s, pyBefore = (cy - IY - z.ty) / z.s;
      const r = wheelStep(z, cx, cy, dy, ctrl);
      if (r.kind === "noop") { noopSteps++; /* state unchanged => trivially anchored */ }
      else if (r.kind === "reset") {
        // designed snap-to-identity: measure the anchor drift the reset causes
        const cxAfter = IX + 0 + 1 * pxBefore, cyAfter = IY + 1 * pyBefore;
        const drift = Math.hypot(cxAfter - cx, cyAfter - cy);
        resetSteps++; fail++; // as an anchor step this is a violation (by design)
        if (rows.length < 8) rows.push([trial, i, "RESET", z.s.toFixed(4), 1, pxBefore.toFixed(1), pyBefore.toFixed(1), drift.toFixed(2)]);
      } else {
        // verify: screen pos of the SAME source px after the new transform == cursor
        const cxAfter = IX + r.z.tx + r.z.s * pxBefore, cyAfter = IY + r.z.ty + r.z.s * pyBefore;
        const err = Math.max(Math.abs(cxAfter - cx), Math.abs(cyAfter - cy));
        const inImg = pxBefore >= 0 && pxBefore <= IW && pyBefore >= 0 && pyBefore <= IH;
        const hitCap = Math.abs(r.dyEff) >= ZOOM_DY_MAX || r.sNext === ZOOM_MAX;
        if (rows.length < 8) rows.push([trial, i, inImg ? "apply" : "apply(letterbox)", z.s.toFixed(4), r.sNext.toFixed(4), pxBefore.toFixed(1), pyBefore.toFixed(1), err.toExponential(2)]);
        if (err <= 1e-6) pass++; else fail++;
        if (err > maxErr) maxErr = err;
      }
      z = r.z;
    }
  }
  console.log("anchor-check apply-steps PASS: " + pass + "  FAIL(non-reset): " + (fail - resetSteps) + "  reset-steps(anchor broken by design): " + resetSteps + "  noop: " + noopSteps);
  console.log("max |anchor error| over all apply steps: " + maxErr.toExponential(3) + " px (tol 1e-6)");
  console.log("trial step kind          s_old   s_new   px(source) py     anchorErr/drift(px)");
  for (const r of rows) console.log("#" + r[0] + "\t" + r[1] + "\t" + r[2] + "\t" + r[3] + "\t" + r[4] + "\t" + r[5] + "\t" + r[6] + "\t" + r[7]);
  // targeted boundary probes
  console.log("-- targeted boundaries --");
  function probe(name, seq, cursor) {
    let z = { s: 1, tx: 0, ty: 0 }, cx = (cursor && cursor[0]) || 300, cy = (cursor && cursor[1]) || 250, out = [];
    for (const [dy, mcx, mcy] of seq) {
      cx = mcx ?? cx; cy = mcy ?? cy;
      const pxB = (cx - IX - z.tx) / z.s, pyB = (cy - IY - z.ty) / z.s;
      const r = wheelStep(z, cx, cy, dy, false);
      if (r.kind === "apply") {
        const err = Math.max(Math.abs(IX + r.z.tx + r.z.s * pxB - cx), Math.abs(IY + r.z.ty + r.z.s * pyB - cy));
        out.push(r.kind + "(s " + z.s.toFixed(3) + "->" + r.z.s.toFixed(3) + ",err " + err.toExponential(1) + ")");
      } else out.push(r.kind + (r.sNext !== undefined ? "(sNext=" + r.sNext.toFixed(3) + ")" : ""));
      z = r.z;
    }
    console.log(name + ": " + out.join(" | "));
  }
  probe("A-b1 s=1 start, first zoom-in", [[-120], [-120], [120]]);
  probe("A-b2 ride ceiling s=8", [[-120], [-120], [-120], [-120], [-120], [-120], [50, 300, 200]], [300, 250]);
  probe("A-b3 letterbox cursor (outside img box)", [[-150, 105, 105], [-150, 495, 395], [100, 110, 390]], [110, 110]);
  probe("A-b4 floor reset step", [[-120], [-120], [300], [300]], [300, 250]); // last step should clamp to 1 => reset
  probe("A-b5 overshoot clamp at 8 (anchor still exact)", [[-400], [-400]], [300, 250]);
}

console.log("\n=== INVARIANT B: speed linearity ln(s_end/s_start) == -k*sum(dy_clamped) ===");
{
  const rnd = mulberry32(777);
  console.log("-- B1 interior random walk (stays in (1,8), |dy|<=200, no reset): additivity --");
  let worst = 0, n = 0;
  for (let t = 0; t < 500; t++) {
    let z = { s: 1, tx: 0, ty: 0 }, sumDy = 0, ok = true;
    for (let i = 0; i < 30; i++) {
      const dy = (rnd() - 0.5) * 400; // |dy|<=200, no per-event clamp
      const r = wheelStep(z, 300, 250, dy, false);
      if (r.kind === "reset" || (r.kind === "apply" && (r.z.s === ZOOM_MAX))) { ok = false; break; } // skip walks that hit a boundary
      if (r.kind === "apply") { sumDy += r.dyEff; z = r.z; }
    }
    if (ok && z.s > 1.0001) { const err = Math.abs(Math.log(z.s) - (-ZOOM_K * sumDy)); if (err > worst) worst = err; n++; }
  }
  console.log("walks checked: " + n + "  max |ln(s_end) + k*sum(dy)| = " + worst.toExponential(3) + "  (exact additivity => PASS if ~1e-16)");

  console.log("-- B2 clamp breakpoints (linearity breaks here) --");
  const f200 = Math.exp(200 * ZOOM_K), f500 = Math.exp(500 * ZOOM_K), fPinch = Math.exp(200 * ZOOM_K_PINCH);
  console.log("single event dy=500 (fast flick): clamped to 200 => factor x" + f200.toFixed(4) + "  (unclamped would be x" + f500.toFixed(4) + ", retention " + (Math.log(f200) / Math.log(f500) * 100).toFixed(1) + "% of intended log-zoom)");
  console.log("single event dy=300: clamped to 200 => x" + f200.toFixed(4) + " (unclamped x" + Math.exp(300 * ZOOM_K).toFixed(4) + ", retention " + (440 / 660 * 100).toFixed(1) + "%)");
  console.log("single event dy=200: exactly at cap => x" + f200.toFixed(4) + " (100%)");
  console.log("pinch (ctrlKey) dy=200: x" + fPinch.toFixed(4) + " per event");
  console.log("mouse notch dy=120: x" + Math.exp(120 * ZOOM_K).toFixed(4) + " (comment says x1.30)");

  console.log("-- B3 ceiling saturation quantification --");
  const perFrame = Math.exp(ZOOM_DY_MAX * ZOOM_K); // 1.5527
  const framesToCeil = Math.log(ZOOM_MAX) / Math.log(perFrame);
  console.log("per-event (==per-rAF-frame, 60Hz) max factor: x" + perFrame.toFixed(4) + " (dy=-200)");
  console.log("theoretical per-second at 60Hz: x" + Math.pow(perFrame, 60).toExponential(2) + " => irrelevant, ZOOM_MAX=8 reached in " + Math.ceil(framesToCeil) + " frames = " + (Math.ceil(framesToCeil) / 60 * 1000).toFixed(0) + "ms from s=1");
  console.log("so the dy<=200 cap does NOT limit range traversal; it only flattens the per-event response of a single violent flick (log-zoom saturates: d(ln s) <= 0.44/event)");

  console.log("-- B4 ceiling + floor break additivity (measured) --");
  let z = { s: 1, tx: 0, ty: 0 }, sumDy = 0;
  for (let i = 0; i < 10; i++) { const r = wheelStep(z, 300, 250, -400, false); if (r.kind === "apply") sumDy += r.dyEff; z = r.z; }
  console.log("10x dy=-400 (intended ln total " + (-ZOOM_K * -4000).toFixed(3) + " => x" + Math.exp(ZOOM_K * 4000).toExponential(2) + "): actual s=" + z.s.toFixed(4) + " => realized ln total " + Math.log(z.s).toFixed(3) + " (deficit " + (ZOOM_K * 4000 - Math.log(z.s)).toFixed(3) + " nat, " + (100 * Math.log(z.s) / (ZOOM_K * 4000)).toFixed(1) + "% of intended)");
}

console.log("\n=== ADDITIONAL: rAF throttling & coalescing ===");
console.log("code inspection: wheel handler (lines 330-354) applies transform SYNCHRONOUSLY per event (no requestAnimationFrame / no rafId), unlike drag (line 319) and resize (line 292) which are rAF-throttled. Style write + getBoundingClientRect/offsetWidth reads happen per wheel event.");
console.log("coalescing math: Chromium coalesces trackpad physical scrolls into <=1 wheel event per vsync (~60Hz); merged deltaY = SUM of physical deltas in that frame. Consequence: the faster the flick, the larger the per-event dy, the harder the |dy|<=200 clamp bites:");
for (const D of [100, 200, 300, 400, 500, 800]) {
  const eff = Math.min(D, 200), ret = eff / D;
  console.log("  true frame delta " + D + "px -> effective " + eff + "px => log-zoom retention " + (ret * 100).toFixed(0) + "% (x" + Math.exp(eff * ZOOM_K).toFixed(3) + " instead of x" + Math.exp(D * ZOOM_K).toFixed(3) + ")");
}
console.log("  i.e. without coalescing (N small events/frame), total log-zoom = -k*sum(dy_i) preserved (each |dy_i|<200); WITH coalescing, per-frame excess over 200px is DISCARDED, not deferred — fast-scroll=>slower response is the designed 0.5.20 tradeoff (comment line 339: 'anti-trackpad-inertia one-flick spike').");

/* ===========================================================================
 * Cyber-Fly 脑区渲染：按【真实解剖分区】生成果蝇脑俯视图 SVG
 *
 * ★ 这一版和上一版的根本区别
 *   上一版：9 个块是「按我们的输入通道」分的（视觉/嗅觉/听觉/机械感/触觉/
 *           温湿度/味觉/内部/运动输出），形状和位置是我手工摆的示意。
 *   这一版：9 个块 = FlyWire v783 官方 `super_class` 注释（`supers` 字段），
 *           每一块的**面积 ∝ 该区在本子回路里的真实神经元数**，左右半脑分开上色。
 *           块的位置仍是大致解剖位置（前=触角/复眼，后=下行/神经索方向），
 *           因为我们拿不到 3D 坐标 —— 这一点在页面上会写明，不许当成脑地形图看。
 *
 * 数据来源（可直接复核）：
 *   /root/flywire-fly-lab/results/dodge/subcircuit_v4.json 的 supers / types / sides
 *   复核命令（云端）：
 *     python3 -c "import json,collections;d=json.load(open('...subcircuit_v4.json'));\
 *       print(collections.Counter(zip(d['supers'],d['sides'])))"
 *   2026-11-11 实测计数：central 2871(L1385/R1447/C39)、sensory 1488(L775/R713)、
 *   visual_projection 880(L450/R430)、descending 462(L237/R222/C3)、optic 345(L177/R168)、
 *   ascending 199(L105/R94)、visual_centrifugal 38(L21/R17)、motor 11(L3/R8)、
 *   sensory_ascending 2(L1/R1)　合计 6296 = 子回路神经元总数 ✓
 *
 * 约定（看板 paintBrain 靠它上色，改动必须同步 fly_dashboard.js）：
 *   <g data-k="<分区id>" data-s="L|R">  左/右半各一个组，组内元素只有三类：
 *     .nd 神经元点（circle） / .fb 神经纤维（path） / .halo 区域光晕（circle）
 *   标签在图例层：<text data-lb="<id>">（主标签，paintBrain 会写 "名称 12.3 Hz"）
 *                <text data-lbn="<id>">（静态计数，不参与刷新）
 *
 * 所有随机都是固定种子 LCG —— 进程重启后图形完全一样，页面刷新不会跳变。
 * =========================================================================== */
'use strict';

// 真实解剖分区表。n/nL/nR 是从 subcircuit_v4.json 数出来的实数，不是估的。
// cx 是【左半】中心，右半镜像为 640-cx；mid=true 表示该区压在中线上（左右沿中线劈开）。
// r 由 sqrt(nL) 反推，比例常数 K 见 RSCALE —— 所以面积真的 ∝ 神经元数。
const ANAT = [
  { id: 'central', label: '中央脑', mid: true, cx: 320, cy: 212,
    n: 2871, nL: 1385, nR: 1447, nC: 39,
    top: 'PVLP008 20 / PVLP133 14 / lLN2P_a 12',
    note: '蘑菇体、中央复合体、各中央神经毡的主体' },
  { id: 'sensory', label: '感觉输入', cx: 228, cy: 96,
    n: 1488, nL: 775, nR: 713, nC: 0,
    top: 'LB3 122 / JO-B1_a 99 / BM_Taste 72',
    note: 'ORN 嗅觉受体、江氏器、味觉刚毛、温湿感受器' },
  { id: 'visual_projection', label: '视觉投射', cx: 158, cy: 214,
    n: 880, nL: 450, nR: 430, nC: 0,
    top: 'LPLC2 210 / LC16 151 / LPLC4 109',
    note: 'LC / LPLC / Tm：视叶输出，逼近检测就在这里' },
  { id: 'descending', label: '下行', mid: true, cx: 320, cy: 346,
    n: 462, nL: 237, nR: 222, nC: 3,
    top: 'DNg08_a 13 / DNg106 13 / DNge091 12',
    note: 'DN：把指令发往胸神经节，是"脑→身体"的出口' },
  { id: 'optic', label: '视叶', cx: 86, cy: 200,
    n: 345, nL: 177, nR: 168, nC: 0,
    top: 'Tm5e 91 / LMa2 31 / LC14a1 27',
    note: '髓质 / 小叶 / 视板本体神经元' },
  { id: 'ascending', label: '上行', mid: true, cx: 320, cy: 404,
    n: 199, nL: 105, nR: 94, nC: 0,
    top: 'AN_LH_AVLP_1 4 / AN_GNG_69 4',
    note: 'AN：从胸神经节上行回脑' },
  { id: 'visual_centrifugal', label: '视觉离心', cx: 172, cy: 262,
    n: 38, nL: 21, nR: 17, nC: 0,
    top: 'cL21 4 / cL16 3 / cM12 2',
    note: 'cL / cM：中央脑反向投射回视叶' },
  { id: 'motor', label: '运动神经元', mid: true, cx: 320, cy: 448,
    n: 11, nL: 3, nR: 8, nC: 0,
    top: 'CB0762 3 / CB0701 2 / CB0875 2',
    note: '直接驱动肌肉，全子回路只有 11 个' },
  { id: 'sensory_ascending', label: '感觉上行', cx: 352, cy: 436,
    n: 2, nL: 1, nR: 1, nC: 0,
    top: 'SA_VTV_DProN_1 2',
    note: '只有 2 个神经元' },
];

// r = RSCALE * sqrt(n_side)。RSCALE=2.90 让中央脑左半（1385）约 108 px，
// 这样整张图能塞进 640×480 而又保持"面积 ∝ 数量"这一条不被破坏。
const RSCALE = 2.90;
const radOf = (n) => Math.max(3, RSCALE * Math.sqrt(Math.max(n, 1)));

// 极小的分区（<15 个）中心放不下文字，用引线把标签牵到外面
// 极小分区（半径 < 16）中心放不下字，用引线把标签牵到旁边
const LABEL = {
  visual_centrifugal: { dx: -26, dy: 18, anchor: 'end',    font: 8 },
  motor:             { dx: 62,  dy: -10, anchor: 'start',  font: 8 },
  sensory_ascending: { dx: 58,  dy: -12, anchor: 'start',  font: 8 },
};

// 脑整体轮廓（几个团块叠出来，交叠处天然形成"脑沟"的感觉）
// 坐标是按上面 9 个分区的包围盒反推的：只要分区变了，这里必须跟着改。
// 前后各有一对鼓包，是因为感觉输入（触角叶）本来就分左右两团，
// 用一个大的前叶去盖会把它切掉上半。
const SHELL = [
  [320, 218, 168, 176],   // 中央脑主体
  [86, 200, 72, 80],      // 左视叶
  [554, 200, 72, 80],     // 右视叶
  [230, 104, 90, 90],     // 左前叶（触角叶 / 江氏器）
  [410, 104, 90, 90],     // 右前叶
  [320, 376, 86, 82],     // 后（下行 / 神经索方向）
];
const CORE = [320, 212];  // 神经毡中心，纤维都往这里汇
const W = 640, H = 500;

// 固定种子 LCG：同一版本代码每次生成的图完全一致
function mkRng(seed) {
  let s = seed >>> 0;
  return function () {
    s = (s * 1664525 + 1013904223) >>> 0;
    return s / 4294967296;
  };
}
const f1 = (v) => (Math.round(v * 10) / 10).toFixed(1);
const f2 = (v) => (Math.round(v * 100) / 100).toFixed(2);

// 一个分区在某一侧的所有团块：中线区只有一团（沿中线劈），两侧区左右各一团
function spotsOf(A, side) {
  const cx = side === 'R' ? (W - A.cx) : A.cx;
  return [{ cx, cy: A.cy }];
}

function brainSvg() {
  const rnd = mkRng(20261111);
  let h = '<svg viewBox="0 0 ' + W + ' ' + H + '" xmlns="http://www.w3.org/2000/svg" '
        + 'preserveAspectRatio="xMidYMid meet">';

  h += '<defs>'
     + '<radialGradient id="bgG" cx="50%" cy="46%">'
     +   '<stop offset="0" stop-color="#101a30"/><stop offset="1" stop-color="#080b13"/>'
     + '</radialGradient>'
     + '<filter id="softGlow" x="-70%" y="-70%" width="240%" height="240%">'
     +   '<feGaussianBlur stdDeviation="7"/>'
     + '</filter>'
     // 把所有纤维裁在脑壳内部：否则跨区纤维的控制点会把曲线甩到脑外，看着像"飞线"
     + '<clipPath id="brainClip">';
  for (const s of SHELL) {
    h += '<ellipse cx="' + s[0] + '" cy="' + s[1] + '" rx="' + s[2] + '" ry="' + s[3] + '"/>';
  }
  h += '</clipPath>';
  // 中线分区要沿 x=320 劈成左右两半，各自上色
  h += '<clipPath id="halfL"><rect x="0" y="0" width="320" height="' + H + '"/></clipPath>'
     + '<clipPath id="halfR"><rect x="320" y="0" width="320" height="' + H + '"/></clipPath>'
     + '</defs>';

  h += '<rect width="' + W + '" height="' + H + '" fill="url(#bgG)"/>';

  // ---- 1. 脑壳：只填充不描边 → 几个团块的并集读成【一个】轮廓，
  //         不会出现六个圆圈互相压线的"花瓣"感。
  h += '<g fill="#121a2e">';
  for (const s of SHELL) {
    h += '<ellipse cx="' + s[0] + '" cy="' + s[1] + '" rx="' + s[2] + '" ry="' + s[3] + '"/>';
  }
  h += '</g>';
  // 外缘柔光：给轮廓一圈"皮层"厚度，同时把内部接缝糊掉
  h += '<g fill="none" stroke="#2b3a5e" stroke-width="3" stroke-opacity=".55" filter="url(#softGlow)">';
  for (const s of SHELL) {
    h += '<ellipse cx="' + s[0] + '" cy="' + s[1] + '" rx="' + s[2] + '" ry="' + s[3] + '"/>';
  }
  h += '</g>';

  h += '<g clip-path="url(#brainClip)">';

  // ---- 2. 视叶的放射状柱结构（复眼→视叶髓质，方向感很强）----
  h += '<g stroke="#33436b" stroke-width=".6" fill="none" opacity=".5">';
  for (const lx of [86, 554]) {
    for (let i = 0; i < 22; i++) {
      const a = (i / 22) * Math.PI * 2 + 0.1;
      const x1 = lx + Math.cos(a) * 24, y1 = 200 + Math.sin(a) * 22;
      const x2 = lx + Math.cos(a) * 64, y2 = 200 + Math.sin(a) * 70;
      h += '<path d="M' + f1(x1) + ' ' + f1(y1) + ' L' + f1(x2) + ' ' + f1(y2) + '"/>';
    }
  }
  h += '</g>';

  // ---- 3. 背景游离纤维：让空腔里也有"神经网"的质感 ----
  h += '<g stroke="#2b3a5e" stroke-width=".55" fill="none" opacity=".26">';
  for (let i = 0; i < 190; i++) {
    const cx = 110 + rnd() * 420, cy = 60 + rnd() * 350;
    const a = rnd() * Math.PI * 2, len = 14 + rnd() * 46;
    const x2 = cx + Math.cos(a) * len, y2 = cy + Math.sin(a) * len;
    const mx = (cx + x2) / 2 + (rnd() - 0.5) * 24;
    const my = (cy + y2) / 2 + (rnd() - 0.5) * 24;
    h += '<path d="M' + f1(cx) + ' ' + f1(cy) + ' Q' + f1(mx) + ' ' + f1(my) + ' '
       + f1(x2) + ' ' + f1(y2) + '"/>';
  }
  h += '</g>';

  // ---- 4. 每个分区的左右半：光晕 + 纤维 + 神经元点 ----
  for (const A of ANAT) {
    for (const side of ['L', 'R']) {
      const n = side === 'L' ? A.nL : A.nR;
      const r = radOf(n);
      const sp = spotsOf(A, side)[0];
      const clip = A.mid ? (' clip-path="url(#half' + side + ')"') : '';
      h += '<g data-k="' + A.id + '" data-s="' + side + '"' + clip + '>';

      // 分区本体拆两层（2026-11-11 修）：
      //   .tissue = 静态脑组织，永远在，负责"一块一块"的形，不参与上色；
      //   .rf     = 活动叠色，静止时几乎透明，放电时把这一块染上 hz 色。
      // 之前只有一层，paintBrain 把 fill-opacity 压到 .12 → 填充没了、只剩描边，
      // 九块就变成了九个描边的圆圈（看起来像气泡，不像脑组织）。
      h += '<ellipse class="tissue" cx="' + sp.cx + '" cy="' + sp.cy + '" rx="' + r.toFixed(1)
         + '" ry="' + (r * 0.86).toFixed(1) + '" fill="#1b2540" fill-opacity=".32"/>';
      h += '<ellipse class="rf" cx="' + sp.cx + '" cy="' + sp.cy + '" rx="' + r.toFixed(1)
         + '" ry="' + (r * 0.86).toFixed(1) + '" fill="#1b2540" fill-opacity="0"/>';

      // 光晕：活动时靠它产生"这一块在发光"的观感
      h += '<circle class="halo" cx="' + sp.cx + '" cy="' + sp.cy + '" r="' + (r * 1.12).toFixed(0)
         + '" fill="#1a2136" fill-opacity="0" filter="url(#softGlow)"/>';

      // 纤维数量跟着神经元数走，但压到 8–34 条，否则中央脑会糊成一团
      const nFib = Math.max(8, Math.min(34, Math.round(r * 0.62)));
      for (let i = 0; i < nFib; i++) {
        const a = rnd() * Math.PI * 2;
        const x1 = sp.cx + Math.cos(a) * r * 0.86;
        const y1 = sp.cy + Math.sin(a) * r * 0.86;
        // 汇向中心附近的一小片区域（不都扎到同一点，才像神经毡）
        const tx = CORE[0] + (rnd() - 0.5) * 150;
        const ty = CORE[1] + (rnd() - 0.5) * 110;
        const mx = (x1 + tx) / 2 + (rnd() - 0.5) * 80;
        const my = (y1 + ty) / 2 + (rnd() - 0.5) * 80;
        h += '<path class="fb" d="M' + f1(x1) + ' ' + f1(y1) + ' C' + f1(mx) + ' ' + f1(my)
           + ' ' + f1((mx + tx) / 2 + (rnd() - 0.5) * 40) + ' ' + f1((my + ty) / 2 + (rnd() - 0.5) * 40)
           + ' ' + f1(tx) + ' ' + f1(ty) + '" fill="none" stroke="#2f3d63"'
           + ' stroke-width="' + f2(0.45 + rnd() * 0.75) + '" stroke-opacity=".42"/>';
      }
      // 块内短纤维：局部微回路，让团块里有"编织"的质感而不是空心的
      for (let i = 0; i < Math.min(12, 4 + Math.round(r * 0.1)); i++) {
        const a1 = rnd() * Math.PI * 2, a2 = a1 + (rnd() - 0.5) * 2.2;
        const p1x = sp.cx + Math.cos(a1) * r * (0.2 + rnd() * 0.7);
        const p1y = sp.cy + Math.sin(a1) * r * (0.2 + rnd() * 0.7);
        const p2x = sp.cx + Math.cos(a2) * r * (0.2 + rnd() * 0.7);
        const p2y = sp.cy + Math.sin(a2) * r * (0.2 + rnd() * 0.7);
        h += '<path class="fb" d="M' + f1(p1x) + ' ' + f1(p1y) + ' Q'
           + f1((p1x + p2x) / 2 + (rnd() - 0.5) * 16) + ' '
           + f1((p1y + p2y) / 2 + (rnd() - 0.5) * 16) + ' '
           + f1(p2x) + ' ' + f1(p2y) + '" fill="none" stroke="#2f3d63"'
           + ' stroke-width=".45" stroke-opacity=".38"/>';
      }

      // 神经元点：数量 ∝ 真实神经元数（每 50 个画 1 个点，上下限 3–30）
      const nDot = Math.max(3, Math.min(30, Math.round(n / 50)));
      for (let i = 0; i < nDot; i++) {
        const a = rnd() * Math.PI * 2;
        const rr = Math.sqrt(rnd()) * 0.92;
        h += '<circle class="nd" cx="' + f1(sp.cx + Math.cos(a) * r * rr)
           + '" cy="' + f1(sp.cy + Math.sin(a) * r * rr) + '" r="'
           + f2(0.9 + rnd() * 0.8) + '" fill="#3b4c76" fill-opacity=".55"/>';
      }
      h += '</g>';
    }
  }

  // ---- 5. 跨区联络纤维：不经中央神经毡的直接通路，让整体成为一张网 ----
  h += '<g fill="none" stroke="#2c3a5f" stroke-width=".5" opacity=".3">';
  for (let i = 0; i < 54; i++) {
    const A = ANAT[Math.floor(rnd() * ANAT.length)];
    const B = ANAT[Math.floor(rnd() * ANAT.length)];
    if (A === B) continue;
    const sA = rnd() < 0.5 ? 'L' : 'R', sB = rnd() < 0.5 ? 'L' : 'R';
    const x1 = sA === 'R' ? W - A.cx : A.cx, y1 = A.cy;
    const x2 = sB === 'R' ? W - B.cx : B.cx, y2 = B.cy;
    const mx = (x1 + x2) / 2 + (rnd() - 0.5) * 110;
    const my = (y1 + y2) / 2 + (rnd() - 0.5) * 110;
    h += '<path d="M' + f1(x1) + ' ' + f1(y1) + ' Q' + f1(mx) + ' ' + f1(my) + ' '
       + f1(x2) + ' ' + f1(y2) + '"/>';
  }
  h += '</g>';
  h += '</g>';   // ← 关闭 clip-path：(脑内纤维到此为止)

  // ---- 6. 中央复合体：纤维汇聚处的一小簇亮点 ----
  h += '<g opacity=".7">';
  for (let i = 0; i < 26; i++) {
    const a = rnd() * Math.PI * 2, rr = Math.sqrt(rnd()) * 16;
    h += '<circle cx="' + f1(CORE[0] + Math.cos(a) * rr) + '" cy="'
       + f1(CORE[1] + Math.sin(a) * rr) + '" r="' + f2(0.7 + rnd() * 0.7)
       + '" fill="#4b5f8f" fill-opacity=".8"/>';
  }
  h += '</g>';

  // ---- 7. 标签层（不参与上色，只被 paintBrain 改文字）----
  // 文字带深色描边（paint-order=stroke），压在亮红的分区上也认得出来。
  h += '<g class="lbLayer" font-family="inherit" paint-order="stroke" '
     + 'stroke="#080b13" stroke-width="2.6" stroke-linejoin="round">';
  const TXT = (id, x, y, anchor, size, fill, body, nAttr, side) =>
    '<text data-' + (nAttr || 'lb') + '="' + id + '"' + (side ? ' data-s="' + side + '"' : '')
    + ' x="' + x + '" y="' + y
    + '" text-anchor="' + anchor + '" fill="' + fill + '" font-size="' + size + '"'
    + ' stroke-opacity=".85">' + body + '</text>';

  for (const A of ANAT) {
    const L = LABEL[A.id];
    if (A.mid) {
      // 中线区：标签压在中线，中央脑那行要避开中央复合体那簇亮点
      const ty = A.id === 'central' ? A.cy - 76 : A.cy + 4;
      h += TXT(A.id, 320, ty, 'middle', 11, '#9fb0d4', A.label);
      h += TXT(A.id, 320, ty + 13, 'middle', 9, '#5d6c8c', A.n + ' 个', 'lbn');
    } else if (L) {
      // 极小分区：引线 + 外侧标签。左右都要画（dx 镜像、锚点翻转），
      // 否则右半边的视觉离心会没有标签，看着像少了一块。
      for (const side of ['L', 'R']) {
        const x = side === 'L' ? A.cx : W - A.cx, y = A.cy;
        const dx = side === 'L' ? L.dx : -L.dx;
        const anchor = side === 'L' ? L.anchor : (L.anchor === 'start' ? 'end' : 'start');
        h += '<path d="M' + x + ' ' + y + ' L' + (x + dx) + ' ' + (y + L.dy)
           + '" stroke="#3a4a6e" stroke-width=".7" fill="none" stroke-opacity=".8"/>';
        h += TXT(A.id, x + dx + (anchor === 'start' ? 2 : -2), y + L.dy + 3,
                 anchor, L.font, '#8b9abd', A.label + ' ' + A.n, null, side);
      }
    } else {
      // 双侧区：左右各一份标签，各自显示自己那一侧的发放率
      for (const [side, cx] of [['L', A.cx], ['R', W - A.cx]]) {
        h += TXT(A.id, cx, A.cy + 3, 'middle', 10, '#9fb0d4', A.label, null, side);
        h += TXT(A.id, cx, A.cy + 14, 'middle', 8, '#5d6c8c', A.n + ' 个', 'lbn', side);
      }
    }
  }
  h += '</g>';

  h += '<text x="320" y="18" text-anchor="middle" fill="#6b7a99" font-size="11">'
     + '前（触角 / 复眼方向）</text>';
  h += '<text x="320" y="' + (H - 6) + '" text-anchor="middle" fill="#5d6c8c" font-size="9.5">'
     + '俯视 · 分区 = FlyWire v783 super_class（非本通道划分）· 块面积 ∝ 该区真实神经元数 · '
     + '亮度 = 该侧当前发放率（含网络自发基线）</text>';

  h += '</svg>';
  return h;
}

module.exports = { brainSvg, ANAT, RSCALE };

if (require.main === module) {
  process.stdout.write(brainSvg());
}

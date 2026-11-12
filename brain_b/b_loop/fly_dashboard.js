// 果蝇脑 · 实时看板（单一服务：生成页面 + 代理脑侧 API）
// 启动：setsid nohup node fly_dashboard.js > /root/tdash/dash.log 2>&1 < /dev/null &
// 页面：http://<公网IP>:8080/
//
// 为什么自包含：页面直接在进程里拼出来，只改这一个文件即可。
//
// [rev 2026-10-07b] 重做：脑区图 + 数据汇报，并对音频字段做防御式渲染（音频缺失时优雅降级为 —）。
// [rev 2026-10-07c] 接线修正：DIAG_API 默认指向 fly_watch2 的 33340（只读诊断：音频/侧向/起始/门限）；
//   脑区图按「发放率 OR 行为旗」点亮（逃逸旗亮 ⟺ 逃逸区亮）；顶部判定由行为旗+脑发放率派生，与数据汇报一致。
//
// 数据来源（默认，全部来自脑侧）：
//   BRAIN_API = stage1_loop 的 --api（默认 33338）
//      → regions（9 大功能区）、groups（38 组）、cmd（arousal/turn/motor/flags）、
//        gates、frame、brainMs、deadPct、processed
//   DIAG_API  = 可选。fly_watch2 的诊断 HTTP（若将来给它加 /api，
//              可补上 audio/jo/lat/verdict/audioHist 等音频字段）。不设置则忽略。
//
// 页面布局（用户要求）：
//   顶部：判定 + 副标题
//   左大区：13 个指标卡 + 曲线（默认显示「神经活动」）+ 上行特征表
//   右下 1/4：数据汇报（行为状态/逃逸强度/转向/振翅 + 最活跃组）
//   左下 1/4：脑区神经图（9 大功能区，按发放率上色，激活时发光）
const http = require('http');
const fs = require('fs');
const path = require('path');

const DIR = __dirname;
const HTTP_PORT = +(process.env.FLY_DASH_HTTP || 8080);
const BRAIN_API = process.env.FLY_BRAIN_API || 'http://127.0.0.1:33338/api';
const DIAG_API = process.env.FLY_DIAG_API || 'http://127.0.0.1:33340/api';
// 看板轮询间隔：默认 300 ms（与原本完全一致）；云端多项目共存时可设 1000 降约 2/3 开销。
const POLL_MS = +(process.env.FLY_DASH_POLL_MS || 300);
// 感官面板独立成文件，服务端拼进同一个 <script>：页面仍是单文件，浏览器不多发请求。
const SENSE_PANEL = fs.readFileSync(path.join(DIR, 'sense_panel.js'), 'utf8');
// 体系说明页（传感器 → ESP32 → 云端）独立成文件，由 /arch 直接返回。
// 读不到就降级成一句提示，绝不让服务启动失败。
let ARCH_HTML = null;
try { ARCH_HTML = fs.readFileSync(path.join(DIR, 'arch.html'), 'utf8'); }
catch (e) { console.log('[看板] arch.html 未找到，/arch 将返回提示（' + e.message + '）'); }

// ---- 取 JSON（带超时，错误返回 null，绝不抛异常） ----
function getJSON(url) {
  return new Promise((resolve) => {
    const rq = http.get(url, { timeout: 2500 }, (rs) => {
      let b = '';
      rs.setEncoding('utf8');
      rs.on('data', (c) => { b += c; if (b.length > 400000) rq.destroy(); });
      rs.on('end', () => { try { resolve(JSON.parse(b)); } catch (e) { resolve(null); } });
    });
    rq.on('error', () => resolve(null));
    rq.on('timeout', () => { rq.destroy(); resolve(null); });
  });
}

let lastBrain = null, brainFail = 0;
let lastDiag = null;

async function loopBrain() {
  const d = await getJSON(BRAIN_API);
  if (d) { lastBrain = d; brainFail = 0; } else { brainFail++; }
}
async function loopDiag() {
  if (!DIAG_API) return;
  lastDiag = await getJSON(DIAG_API);
}
loopBrain(); loopDiag();
setInterval(loopBrain, POLL_MS);
setInterval(loopDiag, POLL_MS);


// ---- 脑解剖示意图（服务端生成，直接内联进 HTML）------------------------------
// 放在服务端生成而不是浏览器端，是为了「首屏即有图」：页面还没拿到 /api 时
// 也能看到完整的脑结构，之后 paintBrain() 只改 fill / stroke / 文本，不再动结构。
// 真正的绘制逻辑在 brain_svg.js —— 抽成独立模块是为了让本地预览脚本和线上服务
// 跑同一份代码（否则两边很容易画得不一样）。
const { brainSvg } = require('./brain_svg');
const BRAIN_SVG = brainSvg();

// ---------------------------------------------------------------- 页面（内联生成）
const PAGE = '<!DOCTYPE html><html lang="zh-CN"><head><meta charset="utf-8">'
  + '<meta name="viewport" content="width=device-width,initial-scale=1">'
  + '<title>果蝇脑 · 实时看板</title><style>'
  + 'body{background:#0b0f1a;color:#dfe6f5;font-family:"Microsoft YaHei",system-ui,sans-serif;margin:0}'
  + '#top{display:flex;justify-content:space-between;align-items:center;padding:8px 14px;background:#101728;border-bottom:1px solid #26304a}'
  + '#top h1{font-size:16px;margin:0}#top .sub{color:#8595b5;font-size:11px}'
  + '#body{display:flex;height:calc(100vh - 46px)}'
  + '#main{flex:1;display:flex;flex-direction:column;overflow:auto;padding:12px}'
  + '#side{width:360px;background:#101728;padding:12px;overflow:auto;border-left:1px solid #26304a}'
  + '.vd{display:inline-block;padding:7px 14px;border-radius:6px;font-size:15px;font-weight:700}'
  + '.ok{background:#12351f;color:#5fd97e;border:1px solid #1f6b3c}'
  + '.warn{background:#3d2a0c;color:#ffc14d;border:1px solid #7a5416}'
  + '.bad{background:#3a1418;color:#ff7b7b;border:1px solid #7a2830}'
  + '.muted{background:#1c2338;color:#8595b5;border:1px solid #26304a}'
  + 'h2{font-size:12px;color:#8595b5;margin:0 0 8px;font-weight:600;letter-spacing:.5px}'
  + '.dt{color:#a9b6d0;font-size:11.5px;line-height:1.6;margin-bottom:10px}'
  + '.g{display:grid;grid-template-columns:repeat(auto-fill,minmax(108px,1fr));gap:7px;margin-bottom:12px}'
  + '.c{background:#161d31;border:1px solid #26304a;border-radius:6px;padding:6px 8px}'
  + '.k{color:#8595b5;font-size:10px}.v{font-size:16px;font-weight:700;font-variant-numeric:tabular-nums}'
  + '.b{height:4px;background:#232c44;border-radius:2px;margin-top:4px;overflow:hidden}.b i{display:block;height:100%}'
  + 'svg{background:#0d1220;border:1px solid #26304a;border-radius:6px;width:100%;height:auto}'
  + '.sb{display:flex;gap:5px;margin-bottom:9px;flex-wrap:wrap}'
  + 'button{background:#1e2942;color:#dfe6f5;border:1px solid #26304a;border-radius:5px;padding:4px 9px;font-size:11.5px;cursor:pointer}'
  + 'button.on{background:#1d4a2f;border-color:#2a7a48}'
  + '#brainfig{margin-bottom:10px}'
  + '#brainfig svg{display:block;width:100%;height:auto;max-height:none;background:#0d1220;border:1px solid #26304a;border-radius:8px}'
  + '#brainfig .rn{font-size:9.5px;font-weight:700;fill:#c8d4ea;pointer-events:none}'
  + '#brainfig .rv{font-size:11px;font-weight:700;font-variant-numeric:tabular-nums;pointer-events:none}'
  + '#brainfig .rz{font-size:9px;fill:#6b7a99;pointer-events:none}'
  + '#drive{margin:0 0 10px}'
  + '#drive table{font-size:11px}'
  + '#drive th{text-align:left;color:#6b7a99;font-weight:600;padding:3px 10px 3px 0;border-bottom:1px solid #26304a}'
  + '#drive td{padding:3px 10px 3px 0;border-bottom:1px solid #161d31}'
  + '#drive .src{color:#dfe6f5;font-weight:600}'
  + '#drive .na{color:#3a4763}'
  + '#drive .na2{color:#8595b5;font-size:11.5px;margin-bottom:10px}'
  + '#anat{margin:0 0 10px}'
  + '#anat table{font-size:11px;width:100%}'
  + '#anat th{text-align:left;color:#6b7a99;font-weight:600;padding:3px 10px 3px 0;border-bottom:1px solid #26304a}'
  + '#anat td{padding:3px 10px 3px 0;border-bottom:1px solid #161d31;vertical-align:top}'
  + '#anat .src{color:#dfe6f5;font-weight:600;white-space:nowrap}'
  + '#anat .na{color:#5d6c8c;font-size:10.5px}'
  + '#anat .v{font-variant-numeric:tabular-nums;white-space:nowrap}'
  + '#brainmap{display:grid;grid-template-columns:repeat(3,1fr);gap:6px;margin-bottom:10px}'
  + '.rg{background:#161d31;border:1px solid #26304a;border-radius:6px;padding:7px 8px;position:relative;overflow:hidden}'
  + '.rg .nm{font-size:12px;font-weight:700;display:flex;justify-content:space-between;align-items:baseline}'
  + '.rg .hz{font-size:12px;font-weight:700;font-variant-numeric:tabular-nums}'
  + '.rg .hint{color:#6b7a99;font-size:9.5px;margin-top:2px}'
  + '.rg .fill{position:absolute;left:0;bottom:0;height:3px;transition:width .2s}'
  + '.rg.act{border-color:#59c2ff;box-shadow:0 0 0 1px #59c2ff inset,0 0 10px rgba(89,194,255,.35)}'
  + '.lgd{display:flex;gap:10px;flex-wrap:wrap;color:#8595b5;font-size:10px;margin-top:6px}'
  + '.lgd s{width:9px;height:9px;border-radius:2px;display:inline-block;margin-right:3px;vertical-align:-1px}'
  + 'table{border-collapse:collapse;font-size:11px;width:100%}'
  + 'td{padding:2px 8px 2px 0;color:#a9b6d0}'
  + 'td.v{color:#dfe6f5;font-weight:600;font-variant-numeric:tabular-nums}'
  + '.nm2{font-weight:700;color:#dfe6f5}'
  + '.row{display:flex;justify-content:space-between;padding:2px 0;border-bottom:1px solid #1c2338}'
  + '#ch{flex:0 0 200px;background:#0d1220;border:1px solid #26304a;border-radius:6px}'
  + '</style></head><body>'
  + '<div id="top"><h1>果蝇脑 · 实时看板</h1><div class="sub" id="sub"></div>'
  + '<a href="/arch" style="color:#59c2ff;font-size:12px;text-decoration:none;border:1px solid #26304a;'
  + 'border-radius:6px;padding:5px 11px;white-space:nowrap">体系说明 →</a></div>'
  + '<div id="body">'
  + '<div id="main">'
  + '<div id="vd" class="vd muted">连接中…</div><div id="dt" class="dt"></div>'
  + '<div class="sb"><button id="bA" onclick="ch(\'act\',this)">神经 act</button>'
  + '<button id="bE" onclick="ch(\'aud\',this)">听觉 aud</button>'
  + '<button id="bF" onclick="ch(\'esc\',this)">逃逸 esc</button>'
  + '<button id="bL" onclick="ch(\'lat\',this)">侧向 lat</button>'
  + '<button id="bJ" onclick="ch(\'jo\',this)">梳理 jo</button>'
  + '<span style="color:#8595b5;font-size:11px">放歌时看「神经 act / 逃逸」最容易看清反应</span></div>'
  + '<div id="cards" class="g"></div>'
  + '<h2>★ 传感器实况 · 板端 2 Hz 上报的原始读数（5 个传感器 + 摇杆 + IMU）</h2>'
  + '<div id="snstrip" class="g"></div>'
  + '<h2>曲线（最近 12 秒 · 由大脑按 20 Hz 记录）</h2><svg id="ch" viewBox="0 0 960 200" preserveAspectRatio="none" style="height:200px;flex:none"></svg>'
  + '<h2>★ 果蝇脑 · 神经元群与神经纤维（俯视）</h2>'
  + '<div style="color:#8595b5;font-size:12px;line-height:1.7;margin:4px 0 8px">'
  + '每一块 = 一个<b style="color:#ffd166">真实解剖分区</b>（FlyWire v783 super_class），'
  + '块面积 ∝ 该区在本子回路里的真实神经元数，<b style="color:#ffd166">左右半脑分开上色</b>。'
  + '它一放电，那一块的分区底色、神经元点、纤维会一起亮起来 —— 亮度 = 该侧当前发放率。'
  + '<br>下面的通道条是<b>另一套口径</b>：按我们的输入把 38 个组聚成 9 条感觉/行为通道。'
  + '两张表要一起看 —— <b style="color:#5fd97e">解剖图回答「哪块脑域在处理」，通道条回答「哪路传感器在灌数据」</b>。'
  + '注意发亮不等于被驱动：网络本身有自发基线（实测切断驱动后 OLFA 仍有约 22 Hz）。</div>'
  + '<div id="brainfig">' + BRAIN_SVG + '</div>'
  + '<div id="drive"></div>'
  + '<div id="anat"></div>'
  + '<div id="brainmap"></div>'
  + '<div class="lgd"><s style="background:#1e2942"></s>静息<s style="background:#2f6fb8"></s>轻微'
  + '<s style="background:#59c2ff"></s>活跃<s style="background:#ffd166"></s>强'
  + '<s style="background:#ff6b6b"></s>最强</div>'
  + '<h2>上行特征（云端实际收到的值）</h2><table id="feat"></table>'
  + '</div>'
  + '<div id="side"><h2>数据汇报</h2><div id="rep"></div>'
  + '<h2>★ 全 38 组神经元（按发放率排序）</h2><table id="neu"></table></div>'
  + '</div>'
  + '<script>'
  + 'const $=i=>document.getElementById(i);'
  + 'let S={},cur=\'act\',actHist=[];'
  + 'const CH={act:{h:()=>H(\'act\'),c:\'#59c2ff\',l:\'神经活动(最大发放率 Hz)\',u:\'Hz\'},'
  + ' aud:{h:()=>H(\'audio\'),c:\'#59c2ff\',l:\'听觉强度 aud\',u:\'%\'},'
  + ' esc:{h:()=>H(\'esc\'),c:\'#ff6b6b\',l:\'逃逸 escape (Hz)\',u:\'Hz\'},'
  + ' lat:{h:()=>H(\'lat\'),c:\'#ffd166\',l:\'侧向 lat (+右 / −左)\',u:\'\'},'
  + ' jo:{h:()=>H(\'jo\'),c:\'#2f6fb8\',l:\'梳理 jo\',u:\'%\'}};'
  // 历史现在由【大脑】按 20 Hz 记（/api.hist），看板不再自己攒：
  // 以前依赖 fly_watch2 诊断进程，它没起就只剩 act 一条，看起来像"心电图没了"。
  + 'function H(k){const h=S.hist&&S.hist[k];return Array.isArray(h)?h:[];}'
  + 'function ch(k,b){cur=k;[\'bA\',\'bE\',\'bF\',\'bL\',\'bJ\'].forEach(i=>$(i).className=\'\');b.className=\'on\';}'
  + 'function n(x,d){return (x==null||isNaN(+x))?\'—\':(+x).toFixed(d==null?2:d);}'
  + 'function bar(v,c){return \'<div class="b"><i style="width:\'+(Math.max(0,Math.min(1,v||0))*100).toFixed(1)+\'%;background:\'+c+\'"></i></div>\';}'
  + 'function card(k,v,bv,c){return \'<div class="c"><div class="k">\'+k+\'</div><div class="v">\'+v+\'</div>\'+(bv===undefined?\'\':bar(bv,c||\'#59c2ff\'))+\'</div>\';}'
  // 色阶按【实测动态范围】标定：网络自发基线约 10–30 Hz，被驱动的脑区 30–60 Hz，
  // 听觉/机械感这类硬通道能到 110–190 Hz。旧阈值(60/30/10)是按 0–80 拍的，
  // 真实数据一进来就全红，等于没有区分度。
  + 'function hzC(h){return h>=100?\'#ff6b6b\':h>=45?\'#ffd166\':h>=15?\'#59c2ff\':h>=3?\'#2f6fb8\':\'#1e2942\';}'
  + 'const VIS_MAX=180;'
  // ---- 脑区上色：按【真实解剖分区 + 左右半脑】取发放率 ----------------------
  // 数据来自 /api 的 anatomy（super_class 聚合），每块有 hzL / hzR / hz。
  // 图的骨架是 brain_svg.js 在服务端生成的，这里一个字都不改结构，只改颜色和文字。
  + 'function paintBrain(at){'
  + ' if(!at||!at.length)return;'
  + ' const map={};for(const a of at)map[a.id]=a;'
  + ' for(const g of document.querySelectorAll("[data-k]")){'
  + '  const a=map[g.dataset.k];if(!a)continue;'
  + '  const sd=g.dataset.s||"";'
  + '  const hz=sd==="L"?(a.hzL||0):sd==="R"?(a.hzR||0):(a.hz||0);'
  + '  const nz=Math.min(1,hz/VIS_MAX),k=Math.pow(nz,1.4),c=hzC(hz);'
  // 分区本体：跟着发放率整体变色 + 变亮（这是"哪块脑域在受处理"的主视觉）
  + '  for(const e of g.querySelectorAll(".rf")){'
  + '   e.style.fill=c;e.style.fillOpacity=(.18+k*.62).toFixed(2);}'
  + '  for(const e of g.querySelectorAll(".nd")){'
  + '   e.style.fill=c;e.style.fillOpacity=(.20+k*.75).toFixed(2);}'
  + '  for(const e of g.querySelectorAll(".fb")){'
  + '   e.style.stroke=c;e.style.strokeOpacity=(.06+Math.pow(nz,.7)*.55).toFixed(2);}'
  + '  for(const e of g.querySelectorAll(".halo")){'
  + '   e.style.fill=c;e.style.fillOpacity=Math.min(.28,k*.28).toFixed(2);}'
  + ' }'
  // 标签：一份数据可能对应左右两个 <text>，用 data-s 区分
  + ' for(const lb of document.querySelectorAll("[data-lb]")){'
  + '  const a=map[lb.dataset.lb];if(!a)continue;'
  + '  const sd=lb.dataset.s||"";'
  + '  const hz=sd==="L"?(a.hzL||0):sd==="R"?(a.hzR||0):(a.hz||0);'
  + '  lb.textContent=a.label+" "+(hz>=10?hz.toFixed(0):hz.toFixed(1));'
  + '  lb.style.fill=hz>=8?"#ffffff":"#8b9abd";'
  + ' }'
  + '}'
  + 'function draw(sr){'
  + ' if(!sr[0]||!sr[0].length){if(cur===\'act\')sr=[actHist];else return;}'
  + ' const W=960,H2=200,p=22,all=sr.flat().filter(Number.isFinite);'
  + ' if(all.length<2){$(\'ch\').innerHTML=\'\';return;}'
  + ' let lo=Math.min.apply(null,all),hi=Math.max.apply(null,all);'
  + ' if(hi-lo<1e-6){hi=lo+1;lo=Math.max(0,lo-.5);}'
  + ' const n0=sr[0].length,y=v=>H2-p-((v-lo)/(hi-lo))*(H2-2*p),dx=(W-p-8)/(n0-1);'
  + ' let o=\'<line x1="\'+p+\'" y1="\'+(H2-p)+\'" x2="\'+(W-8)+\'" y2="\'+(H2-p)+\'" stroke="#2a3550"/>\''
  + '   +\'<line x1="\'+p+\'" y1="\'+p+\'" x2="\'+(W-8)+\'" y2="\'+p+\'" stroke="#1c2440"/>\';'
  + ' sr.forEach(s=>{if(s.length<2)return;let d=\'\';'
  + '  for(let i=0;i<s.length;i++)d+=(i?\' L\':\'M\')+(p+i*dx).toFixed(1)+\' \'+y(s[i]).toFixed(1);'
  + '  o+=\'<path d="\'+d+\'" fill="none" stroke="\'+CH[cur].c+\'" stroke-width="1.7"/>\';});'
  + ' o+=\'<text x="3" y="\'+(y(hi)+4).toFixed(1)+\'" fill="#6b7a99" font-size="11">\'+hi.toFixed(2)+CH[cur].u+\'</text>\''
  + '  +\'<text x="3" y="\'+(y(lo)+4).toFixed(1)+\'" fill="#6b7a99" font-size="11">\'+lo.toFixed(2)+CH[cur].u+\'</text>\''
  + '  +\'<text x="\'+(W-230)+\'" y="\'+(p-5)+\'" fill="#6b7a99" font-size="11">\'+CH[cur].l+\'（最近 \'+n0+\' 帧 ≈ \'+(n0/20).toFixed(1)+\' 秒）</text>\';'
  + ' $(\'ch\').innerHTML=o;'
  + '}'
  + 'function flagsText(f){const m=[\'逃逸\',\'左转\',\'右转\',\'梳理\'];let a=[];for(let i=0;i<4;i++)if(f&(1<<i))a.push(m[i]);return a.length?a.join(\' \'):\'静息（无行为）\';}'
  + 'async function tick(){'
  + ' try{'
  + '  const s=await (await fetch(\'/api\')).json();S=s;window.__FLY_S=s;'
  + '  const c=s.cmd||{};'
  + '  const rs=(s.regions||[]).slice().sort((a,b)=>b.hz-a.hz);'
  // 神经活动用【最强单组】而不是功能区均值：功能区均值会被大量静息组稀释，
  // 实测单组能到 110~190 Hz，功能区只有十几 Hz，两个数放一起看会以为脑没在工作。
  + '  const gAll=s.groups||[];'
  + '  const maxHz=gAll.length?gAll.reduce((m,g)=>Math.max(m,g.hz||0),0):(rs.length?rs[0].hz:0);'
  + '  actHist.push(maxHz);if(actHist.length>240)actHist.shift();'
  + '  let vd,vcls,dt;'
  + '  if(!s.brainOk){vd=\'脑侧未连接\';vcls=\'bad\';dt=\'检查大脑的 --api 33338 是否开启\';}'
  + '  else if(s.verdict){vd=s.verdict;vcls=s.verdict.indexOf(\'正常\')>=0?\'ok\':(s.verdict.indexOf(\'饱和\')>=0?\'bad\':\'warn\');dt=s.detail||\'\';}'
  + '  else if(maxHz>=170){vd=\'神经活动很猛\';vcls=\'warn\';dt=\'有组接近 190 Hz 上限，注意是否被持续强驱动\';}'
  + '  else if(maxHz>=100){vd=\'神经活动强\';vcls=\'ok\';dt=\'听觉/JO 类组正在高频放电，属正常反应\';}'
  + '  else if(maxHz>=20){vd=\'有神经活动\';vcls=\'ok\';dt=\'脑在正常工作\';}'
  + '  else {vd=\'静息\';vcls=\'muted\';dt=\'暂无明显神经发放\';}'
  + '  $(\'vd\').textContent=vd;$(\'vd\').className=\'vd \'+vcls;$(\'dt\').textContent=dt;'
  + '  $(\'sub\').textContent=\'MAPV=\'+(s.gates?s.gates.MAPV:\'—\')+\' ｜ 已处理 \'+(s.processed==null?\'—\':s.processed)+\' 帧 ｜ 脑静息 \'+(s.deadPct==null?\'—\':(+s.deadPct).toFixed(0))+\'%\'+(s.steer?\' ｜ 转向来源 \'+s.steer.src:\'\');'
  + '  const it=s.intensity||{},fe=s.feature||{},sn=s.sense||{};'
  + '  const pct=v=>(v==null?\'—\':(v*100).toFixed(0)+\'%\');'
  + '  const hasA=it.audio!=null;'
  + '  $(\'cards\').innerHTML='
  + '   card(\'神经活动\',n(maxHz,1)+\' Hz\',Math.min(1,maxHz/VIS_MAX))'
  + '  +card(\'听觉 aud\',pct(it.audio),hasA?it.audio:undefined)'
  + '  +card(\'触碰 touch\',pct(it.touch),hasA?it.touch:undefined,\'#ff9f45\')'
  + '  +card(\'侧向 lat\',n(it.lat,2),it.lat==null?undefined:Math.abs(it.lat),\'#ffd166\')'
  + '  +card(\'梳理 jo\',pct(it.jo),hasA?it.jo:undefined,\'#2f6fb8\')'
  + '  +card(\'照度\',sn.lux==null?\'—\':sn.lux+\' lx\',sn.lux==null?undefined:Math.min(1,sn.lux/2000),\'#ffd166\')'
  + '  +card(\'温度\',sn.tempC==null?\'—\':n(sn.tempC,1)+\' ℃\')'
  + '  +card(\'湿度\',sn.rh==null?\'—\':n(sn.rh,1)+\' %\')'
  + '  +card(\'VOC\',sn.voc==null?\'—\':sn.voc,undefined,\'#5fd97e\')'
  + '  +card(\'测距\',sn.distMm==null?\'—\':sn.distMm+\' mm\')'
  + '  +card(\'摇杆 X\',sn.joyX==null?\'—\':sn.joyX)'
  + '  +card(\'逃逸\',n(c.arousal,1),(c.arousal||0)/100,\'#ff6b6b\')'
  + '  +card(\'脑步\',n(s.brainMs,1)+\' ms\')'
  + '  +card(\'脑静息\',n(s.deadPct,0)+\'%\')'
  + '  +card(\'已处理帧\',s.processed==null?\'—\':s.processed)'
  + '  +card(\'组数\',(s.groups||[]).length);'
  // 传感器实况条：板端 40 B 感官帧（valid 位图决定哪路有数）+ 68 B 帧里的 IMU / 麦克风
  + '  const V=(sn.valid||0);'
  + '  const sc=(nm,md,val,ok)=>\'<div class="c"><div class="k">\'+nm+\' <span style="color:#3f4d6b">\'+md+\'</span></div><div class="v" style="color:\'+(ok?\'#dfe6f5\':\'#3a4763\')+\'">\'+val+\'</div></div>\';'
  + '  $(\'snstrip\').innerHTML='
  + '   sc(\'温度\',\'AHT10\',(V&1)?n(sn.tempC,1)+\' ℃\':\'—\',V&1)'
  + '  +sc(\'湿度\',\'AHT10\',(V&1)?n(sn.rh,1)+\' %\':\'—\',V&1)'
  + '  +sc(\'光照\',\'BH1750\',(V&2)?((sn.lux|0)+\' lx\'):\'—\',V&2)'
  + '  +sc(\'气体 VOC\',\'SGP40\',(V&4)?sn.voc:\'—\',V&4)'
  + '  +sc(\'测距\',\'VL53L\',(V&8)?(sn.distMm+\' mm\'):\'—\',V&8)'
  + '  +sc(\'摇杆\',\'ADC\',(V&16)?(sn.joyX+\' / \'+sn.joyY):\'—\',V&16)'
  + '  +sc(\'加速度\',\'BMI270\',it.accel?it.accel.map(v=>v.toFixed(2)).join(\' / \')+\' g\':\'—\',!!it.accel)'
  + '  +sc(\'声音\',\'ICS-43434\',fe.rms_dbfs==null?\'—\':n(fe.rms_dbfs,1)+\' dBFS\',fe.rms_dbfs!=null);'
  + '  draw([CH[cur].h()]);'
  + '  const bflags2=(c.flags||0); const flagLit=(k)=>{if(k===\'escape\')return bflags2&1;if(k===\'steer\')return bflags2&(2|4);if(k===\'groom\')return bflags2&8;if(k===\'feed\')return bflags2&16;return false;};'
  + '  let r=\'\';'
  + '  for(const g of rs){const blind=g.wired===false;const lit=!blind&&(g.hz>=2||flagLit(g.key));'
  + '   r+=\'<div class="rg\'+(lit?\' act\':\'\')+\'"\'+(blind?\' style="opacity:.6"\':\'\')+\'><div class="nm"><span>\'+g.label+\'</span><span class="hz">\'+(blind?\'未接入\':g.hz.toFixed(1)+\' Hz\')+\'</span></div>\''
  + '    +\'<div class="hint">\'+g.hint+\'</div>\''
  + '    +(blind?\'<div class="fill" style="width:100%;background:#1a2136"></div>\':\'<div class="fill" style="width:\'+Math.min(100,g.hz/VIS_MAX*100).toFixed(0)+\'%;background:\'+hzC(g.hz)+\'"></div>\')+\'</div>\';}'
  + '  $(\'brainmap\').innerHTML=r;'
  + '  paintBrain(s.anatomy||[]);'
  + '  const dr=s.senseDrive||{};const dk=Object.keys(dr);'
  + '  let dh="<h3>传感器 → 脑区 实时映射</h3><table><tr><th>传感器</th><th>原值</th><th>归一化</th><th>注入发放率</th><th>靶组神经元</th></tr>";'
  + '  for(const k of dk){const d=dr[k];const na=(d.mapped===false);'
  + '   dh+="<tr><td class=src>"+d.src+"</td><td>"+(d.raw==null?"<span class=na>无数据</span>":d.raw+" "+d.unit)+"</td><td>"+(na?"—":(d.norm*100).toFixed(0)+"%")+"</td><td class=v>"+(na?"0 Hz":d.hz.toFixed(1)+" Hz")+"</td><td>"+d.neurons+" 个</td></tr>";}'
  + '  dh+="</table>";'
  // 三种状态必须分开，别混成一句"未启用"：
  //   ① 配置里就没有直连（FLY_SENSE_PORT=0 / 路数为 0）  ② 配了但还没收到 40 B 帧  ③ 有数据
  + '  if(!dk.length) dh=(s.sense&&s.sense.routes)>0'
  + '   ?"<div class=na2>感官直连已启用（"+s.sense.routes+" 路），但还没收到 40 B 感官帧 —— 板子未上电或未连上云端；此期间只有 arousal 调制生效。</div>"'
  + '   :"<div class=na2>感官直连未启用（大脑侧 FLY_SENSE_PORT=0 或这几路都没命中子回路），当前只有 arousal 调制。</div>";'
  + '  $("drive").innerHTML=dh;'
  // 解剖分区明细：真实计数 + 左右分别的发放率 + 主要细胞类型（可对数核对）
  + '  const an=(s.anatomy||[]).slice().sort((x,y)=>y.n-x.n);'
  + '  let ah="<h3>解剖分区明细（FlyWire v783 super_class · 面积 ∝ 神经元数）</h3>'
      +'<table><tr><th>分区</th><th>神经元</th><th>左 / 右</th><th>当前发放率（L · R）</th><th>主要细胞类型</th></tr>";'
  + '  for(const a of an){'
  + '   ah+="<tr><td class=src>"+a.label+"</td><td class=v>"+a.n+"</td><td class=na>"+a.nL+" / "+a.nR+"</td>'
      +'<td class=v>"+a.hz.toFixed(1)+" Hz <span class=na>L "+(a.hzL==null?"—":a.hzL.toFixed(1))+" · R "+(a.hzR==null?"—":a.hzR.toFixed(1))+"</span></td>'
      +'<td class=na>"+a.top.map(t=>t.t+" "+t.n).join(" · ")+"</td></tr>";}'
  + '  ah+="</table>";'
  + '  if(!an.length) ah="<div class=na2>解剖分区未上报（大脑侧 buildAnatomy 没跑，确认子回路 JSON 带 supers 字段）</div>";'
  + '  $("anat").innerHTML=ah;'
  + '  const gs=(s.groups||[]).slice().sort((a,b)=>b.hz-a.hz);'
  + '  const st=s.steer||{};'
  + '  const sth=st.src?(\'<span style="font-size:11px;color:#6b7a99">\'+st.src+\'</span>\'):\'\';'
  + '  $(\'rep\').innerHTML='
  + '   \'<div class="c">行为状态<span class="v">\'+flagsText(c.flags||0)+\'</span></div>\''
  + '  +\'<div class="c">逃逸强度<span class="v">\'+n(c.arousal,1)+\'</span></div>\''
  + '  +\'<div class="c">转向<span class="v">\'+n(c.turn,2)+\'</span>\'+sth+\'</div>\''
  + '  +\'<div class="c">振翅<span class="v">\'+((c.motor||0)?\'开\':\'关\')+\'</span></div>\''
  + '  +gs.slice(0,8).map(g=>\'<div class="row"><span class="nm2">\'+g.base+(g.side?\'·\'+g.side:\'\')+\'</span><span class="v">\'+g.hz.toFixed(1)+\' Hz</span></div>\').join(\'\');'
  + '  let t=\'\';'
  + '  for(const g of gs){'
  + '   const blind=g.wired===false;'
  + '   t+=\'<tr\'+(blind?\' style="opacity:.55"\':\'\')+\'><td class="nm2">\'+g.base+(g.side?\'<span style="color:#6b7a99">·\'+g.side+\'</span>\':\'\')+\'</td>\''
  + '    +\'<td style="color:#6b7a99;font-size:12px">\'+(g.nerve||\'\')+(blind?\' <span style="color:#ff9f45">未接</span>\':\'\')+\'</td>\''
  + '    +\'<td class="v">\'+(blind?\'—\':g.hz.toFixed(1)+\' Hz\')+\'</td>\''
  + '    +\'<td style="width:160px">\'+(blind?\'<span style="color:#3a4763;font-size:11px">等待传感器</span>\':bar(Math.min(1,g.hz/VIS_MAX),hzC(g.hz)))+\'</td>\''
  + '    +\'<td style="color:#6b7a99">\'+g.n+\' 个</td></tr>\';}'
  + '  $(\'neu\').innerHTML=t||\'<tr><td colspan="5" style="color:#8595b5">\'+(s.brainOk?\'等待脑侧数据…\':\'脑侧未连上——检查大脑的 --api 是否开启\')+\'</td></tr>\';'
  + '  const R=fe.rms_dbfs,L=fe.low,M=fe.mid,Hh=fe.high,AC=fe.accel||[];'
  + '  const am=AC.length?Math.sqrt(AC[0]*AC[0]+AC[1]*AC[1]+AC[2]*AC[2]):null;'
  + '  $(\'feat\').innerHTML='
  + '   \'<tr><td>总 RMS</td><td class="v">\'+(R==null?\'—\':R.toFixed(1))+\' dBFS</td><td>麦克风 ICS-43434；饱和说明门限太低</td></tr>\''
  + '  +\'<tr><td>低频 50-150 Hz</td><td class="v">\'+(L==null?\'—\':L.toFixed(1))+\' dBFS</td><td>JO-B 类神经元（风／翅膀振动）</td></tr>\''
  + '  +\'<tr><td>中频 250-450 Hz</td><td class="v">\'+(M==null?\'—\':M.toFixed(1))+\' dBFS</td><td>JO-A 类神经元</td></tr>\''
  + '  +\'<tr><td>高频 600-1500 Hz</td><td class="v">\'+(Hh==null?\'—\':Hh.toFixed(1))+\' dBFS</td><td>宽带／起始检测</td></tr>\''
  + '  +\'<tr><td>加速度 X</td><td class="v">\'+(AC[0]==null?\'—\':AC[0].toFixed(3))+\' g</td><td>侧向：决定左右转向（右正）</td></tr>\''
  + '  +\'<tr><td>加速度 Y</td><td class="v">\'+(AC[1]==null?\'—\':AC[1].toFixed(3))+\' g</td><td>前后轴</td></tr>\''
  + '  +\'<tr><td>加速度 Z</td><td class="v">\'+(AC[2]==null?\'—\':AC[2].toFixed(3))+\' g</td><td>垂直轴；静止平放 ≈ +1.000</td></tr>\''
  + '  +\'<tr><td>合加速度 |a|</td><td class="v">\'+(am==null?\'—\':am.toFixed(3))+\' g</td><td>用来认出"被碰"（|a|−1 越大越像撞击）</td></tr>\';'
  + ' }catch(e){}'
  + ' setTimeout(tick,500);'
  + '}'
  + 'tick();'
  + SENSE_PANEL
  + '</script></body></html>';

http.createServer((req, res) => {
  // 感官调参代理：页面 -> 看板 -> 大脑 --api（大脑侧默认关闭，见 FLY_SENSE_TUNE）。
  const gm = /^\/sense\?gain=(0(?:\.\d+)?|1(?:\.0+)?)$/.exec(req.url || '');
  if (gm) {
    const target = BRAIN_API.replace(/\/api.*$/, '') + '/api/sense?gain=' + gm[1];
    const rq = http.get(target, { timeout: 2000 }, (rs) => {
      let b = ''; rs.setEncoding('utf8');
      rs.on('data', (c) => { b += c; });
      rs.on('end', () => { res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' }); res.end(b || '{"ok":false}'); });
    });
    rq.on('error', () => { res.writeHead(502); res.end('{"ok":false}'); });
    rq.on('timeout', () => { rq.destroy(); res.writeHead(502); res.end('{"ok":false}'); });
    return;
  }
  if (req.url === '/api' || req.url.startsWith('/api?')) {
    res.writeHead(200, {
      'Content-Type': 'application/json; charset=utf-8',
      'Cache-Control': 'no-store',
    });
    const merged = Object.assign({}, lastDiag || {}, lastBrain || {});
    // 诊断侧（fly_watch2）的 verdict 是「音频健康」判语，不用于顶部脑活动判定；
    // 顶部判定由脑侧 regions/flags 本地派生，避免两套口径打架。
    delete merged.verdict;
    merged.audioHealth = (lastDiag && lastDiag.verdict) || '';
    merged.audioDetail = (lastDiag && lastDiag.detail) || '';
    if (!lastBrain) {
      res.end(JSON.stringify(Object.assign({}, merged, {
        brainOk: false, groups: [], regions: [], cmd: {},
        detail: '脑侧 API 无响应——检查大脑的 --api 33338 是否开启',
      })));
      return;
    }
    res.end(JSON.stringify(Object.assign({}, merged, { brainOk: brainFail < 3 })));
    return;
  }
  if (req.url === '/arch' || req.url === '/arch.html') {
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' });
    res.end(ARCH_HTML || '<!DOCTYPE html><meta charset="utf-8"><body style="background:#0b0f1a;color:#dfe6f5;font:14px sans-serif;padding:40px">'
      + 'arch.html 不在看板目录里。<br><br>把 <code>brain_b/b_loop/arch.html</code> 一起部署到同一目录即可。</body>');
    return;
  }
  res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
  res.end(PAGE);
}).listen(HTTP_PORT, '0.0.0.0', () => {
  console.log(`[看板] 网页 http://0.0.0.0:${HTTP_PORT}/`);
  console.log(`[看板] 脑侧 API ${BRAIN_API}` + (DIAG_API ? ` ｜ 诊断 API ${DIAG_API}` : ''));
});

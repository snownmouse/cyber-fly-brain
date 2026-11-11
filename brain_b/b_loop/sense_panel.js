/* ===========================================================================
 * Cyber-Fly 感官面板（由 fly_dashboard.js 读进来，拼进页面里【同一个】script）
 *
 * 设计约束：
 *  1. 不修改看板原有任何一行 HTML/JS —— 本文件是纯追加的片段，DOM 动态插入。
 *  2. 不额外发网络请求 —— 复用主 tick() 已经取回来的全局 S.sense。
 *  3. 云端没开感官时优雅降级为一行提示，不报错、不刷屏。
 *  4. 调参只在后端 FLY_SENSE_TUNE=1 时可用；否则滑块禁用并说明原因。
 * =========================================================================== */
(function () {
  'use strict';
  var side = document.getElementById('side');
  if (!side) return;

  // ---- 样式：只追加，类前缀 sp 避免和原有样式撞名 ----
  var st = document.createElement('style');
  st.textContent = [
    '.spH{font-size:12px;color:#8595b5;margin:0 0 8px;font-weight:600;letter-spacing:.5px}',
    '.spBox{background:#161d31;border:1px solid #26304a;border-radius:8px;padding:9px 10px;margin-bottom:14px}',
    '.spRow{display:flex;justify-content:space-between;align-items:baseline;padding:2px 0;border-bottom:1px solid #1c2338;font-size:11.5px}',
    '.spK{color:#8595b5}.spV{color:#dfe6f5;font-weight:700;font-variant-numeric:tabular-nums}',
    '.spOk{color:#5fd97e}.spBad{color:#ff7b7b}.spMut{color:#6b7a99}',
    '.spBar{height:4px;background:#232c44;border-radius:2px;margin:5px 0 8px;overflow:hidden}',
    '.spBar i{display:block;height:100%;background:#59c2ff;transition:width .25s}',
    '.spGain{width:100%;margin:7px 0 2px;accent-color:#59c2ff}',
    '.spBtns{display:flex;gap:5px;margin-top:6px}',
    '.spBtns button{flex:1;font-size:11px;padding:4px 6px}',
    '.spTip{color:#6b7a99;font-size:10px;line-height:1.55;margin-top:7px}',
    '.spTitle{display:flex;justify-content:space-between;align-items:baseline}',
    '.spTag{font-size:9.5px;color:#8595b5;background:#1c2338;border-radius:4px;padding:1px 5px}'
  ].join('');
  document.head.appendChild(st);

  // ---- DOM：插到侧栏最上面，原有区块一个不动 ----
  var wrap = document.createElement('div');
  wrap.innerHTML =
      '<h2 class="spH">★ 感官层 · 面包板 6 路 <span class="spTag">2 Hz 慢车道</span></h2>'
    + '<div class="spBox"><div id="spRows"></div>'
    +   '<div class="spBar" title="综合显著度"><i id="spAro" style="width:0%"></i></div>'
    +   '<div class="spTitle"><span class="spK">感官增益 gain</span><span class="spV" id="spGainV">—</span></div>'
    +   '<input class="spGain" id="spGain" type="range" min="0" max="1" step="0.02" value="0.18" disabled>'
    +   '<div class="spBtns">'
    +     '<button id="spApply">应用</button>'
    +     '<button id="spOff">关闭感官 (0)</button>'
    +   '</div>'
    +   '<div class="spTip" id="spTip"></div>'
    + '</div>';
  side.insertBefore(wrap, side.firstChild);

  var EV = ['无', '↑ 北', '↗ 东北', '→ 东', '↘ 东南', '↓ 南', '↙ 西南',
            '← 西', '↖ 西北', '突然接近', '突然远离', '环境突变'];
  var $ = function (id) { return document.getElementById(id); };

  function row(name, val, ok) {
    var cls = ok === true ? 'spOk' : (ok === false ? 'spBad' : 'spMut');
    return '<div class="spRow"><span class="spK">' + name
         + '</span><span class="spV ' + cls + '">' + val + '</span></div>';
  }
  function num(v, d, unit) {
    return (v == null || isNaN(+v)) ? '—' : (+v).toFixed(d == null ? 1 : d) + (unit || '');
  }

  function render(s) {
    if (!s) {
      $('spRows').innerHTML = row('状态', '脑侧未上报感官（确认 --api 已开启）', null);
      $('spTip').textContent = '感官帧由板端 2 Hz 发出，relay 只转大脑。';
      return;
    }
    var v = s.valid || 0, on = !!s.online;
    var stale0 = s.staleMs == null ? 2500 : s.staleMs;
    var age0 = s.at == null ? null : Math.max(0, Date.now() - s.at);
    // 关键：online 只表示"曾经收到过"，不代表"现在还在来"。
    // 板子拔掉 / relay 停了之后 online 仍为 true，会让面板一直报"在线"却没有任何新数据。
    var fresh = on && age0 != null && age0 <= stale0;
    var h = '';
    h += fresh
      ? row('连接', '在线 · 2 Hz', true)
      : row('连接', on ? ('帧已过期 ' + num(age0 / 1000, 1, ' s')) : '等待感官帧', false);
    h += row('温度', (v & 1) ? num(s.tempC, 1, ' ℃') : '—', !!(v & 1));
    h += row('湿度', (v & 1) ? num(s.rh, 1, ' %RH') : '—', !!(v & 1));
    h += row('光照', (v & 2) ? num(s.lux, 0, ' lx') : '—', !!(v & 2));
    h += row('VOC',  (v & 4) ? num(s.voc, 0, ' /1000') : '—', !!(v & 4));
    h += row('测距', (v & 8) ? num(s.distMm, 0, ' mm') : '—', !!(v & 8));
    h += row('摇杆 X', (v & 16) ? num(s.joyX, 0, '') : '—', !!(v & 16));
    h += row('摇杆 Y', (v & 16) ? num(s.joyY, 0, '') : '—', !!(v & 16));
    h += row('脊髓事件', (EV[s.event] || ('码 ' + s.event)) + (s.event ? '' : ''), s.event ? true : null);
    h += row('有效位', '0x' + (v >>> 0).toString(16).toUpperCase().padStart(2, '0'), null);
    h += row('帧 / 坏帧', (s.frames == null ? '—' : s.frames) + ' / ' + (s.rejects == null ? '—' : s.rejects), null);
    var age = s.at == null ? null : Math.max(0, (Date.now() - s.at) / 1000);
    var stale = s.staleMs == null ? 2500 : s.staleMs;
    h += row('数据年龄', age == null ? '—' : num(age, 1, ' s'), age == null ? null : (age * 1000 < stale));
    $('spRows').innerHTML = h;

    var aro = (s.arousal == null ? 0 : +s.arousal) / 255;
    $('spAro').style.width = (Math.max(0, Math.min(1, aro)) * 100).toFixed(0) + '%';
    var g = s.gain == null ? 0.18 : +s.gain;
    $('spGainV').textContent = g.toFixed(2);
    if (document.activeElement !== $('spGain')) $('spGain').value = String(g);

    var tune = !!s.tune;
    $('spGain').disabled = !tune;
    $('spApply').disabled = !tune;
    $('spOff').disabled = !tune;
    $('spTip').textContent = tune
      ? '调参已开启：改完点「应用」，只改内存变量、不重启大脑、不碰 68 B 主链路。' + stale / 1000 + ' 秒无新帧自动失效。'
      : '只读模式。想在线调增益，用 FLY_SENSE_TUNE=1 启动大脑；gain=0 即完整退回原链路。';
  }

  function setGain(g) {
    fetch('/sense?gain=' + encodeURIComponent(g))
      .then(function (r) { return r.json(); })
      .then(function () { $('spGainV').textContent = (+g).toFixed(2); })
      .catch(function () { $('spTip').textContent = '调参请求失败：确认大脑以 FLY_SENSE_TUNE=1 启动。'; });
  }
  $('spApply').onclick = function () { setGain($('spGain').value); };
  $('spOff').onclick = function () { $('spGain').value = '0'; setGain(0); };

  // 复用主 tick() 的全局 S，不发新请求；500 ms 刷新一次，与主看板同频。
  setInterval(function () {
    // 自己拉 /api，不依赖主 script 的块级变量（`let S` 跨 <script> 不可见，
    // 曾经因此让面板永远停在"未上报"）。请求走同一个端点，服务器侧无额外开销。
    fetch('/api').then(function (r) { return r.json(); }).then(function (d) {
      try { render(d.sense || null); } catch (e) { try { document.getElementById('spTip').textContent = 'PANEL_ERR: ' + e.message; } catch (e2) {} }
    }).catch(function () { render(null); });
  }, 500);
  render(null);
})();

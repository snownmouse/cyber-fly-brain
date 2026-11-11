# 感觉融合 · MPRS 感官慢车道

两仓一起改：`snownmouse/cyber-fly`（板端）+ `snownmouse/cyber-fly-brain`（云端）。
本轮**只接面包板 6 路**：AHT10 温湿度、BH1750 光照、SGP40 VOC、VL53L0X 测距、
ADS1115 的摇杆 X/Y。摄像头、Mosaico 板载传感器、MQ-135 模拟通道留接口，本轮不实现。

## 先讲人话

原来板子每 50 毫秒给大脑打一次电话，电话里只说「我听到了什么、身体往哪歪」，
这是 68 字节的 MPRB 帧，**一个字节都没动**。

现在多了六双眼睛。要是让它们也挤进这通电话，一方面电话会超时（温湿度传感器
读一次要 110 毫秒、光照要 180 毫秒，比 50 毫秒的通话间隔还长），另一方面大脑
突然收到六股乱糟糟的连续数字，等于有人同时在你耳边报六个数字。

所以加了一条**慢车道**：ESP32 先当「脊髓」，把六路信息嚼一遍 ——

- 慢慢变的东西（温度、湿度、光、气味、距离）：每半秒量一次，压成整数原样交上去，
  **让大脑自己去学它们跟什么有关**；
- 要快的东西（摇杆、突然靠近）：脊髓直接算成「往哪个方向 / 是不是快撞了」，
  再加一个「此刻整体有多反常」的分数。**大脑收到的不是六条曲线，是一个结论**。

像手碰到烫东西会先缩手、过了半秒才觉得疼：预处理留在脊髓，大脑只收消化过的信息。
云端还加了 2.5 秒的「过期作废」——板子要是掉线了，不能拿着半小时前的温度继续骗大脑。

## 线协议（40 B，little endian）

| 偏移 | 类型 | 字段 | 说明 |
|---|---|---|---|
| 0 | u32 | magic | `MPRS` = 0x5352504D |
| 4 | u8 | version | 1 |
| 5 | u8 | type | 5（1=burst, 2=feature, 3=ack, 4=downlink） |
| 6 | u16 | payload_len | 40 |
| 8 | u32 | seq | 感官帧独立序号 |
| 12 | u32 | send_ts_us | 板端时间戳 |
| 16 | i16 | temp_x100 | 摄氏度 ×100 |
| 18 | u16 | rh_x100 | %RH ×100 |
| 20 | u16 | lux | lx |
| 22 | u16 | voc | 0..1000，归一化 SGP40 RAW |
| 24 | u16 | dist_mm | mm，无有效读数时 0 |
| 26 | i16 | joy_x | -1000..1000，板上自校准 + 死区 |
| 28 | i16 | joy_y | 同上 |
| 30 | u16 | valid_mask | bit0 温湿 / 1 光 / 2 VOC / 3 距离 / 4 摇杆 / 5 预留 |
| 32 | u8 | event | 0 无 / 1..8 摇杆八方向 / 9 接近 / 10 远离 / 11 环境突变 |
| 33 | u8 | arousal | 0..255 板端综合显著度 |
| 34 | u16 | spare | 摄像头 / 板载传感器扩展位 |
| 36 | u32 | crc32 | CRC-32/ISO-HDLC over [0,36) |

**有效位是硬规矩**：某一路读失败，那一位就不置，绝不填 0 冒充「温度 0 度」。

## 三条必须守住的不变量

1. **68 B / 20 Hz 一个字节不动**。`relay.js` 只按长度分发，云端 CRC 固定在偏移 64，
   加长 MPRB 会让每一帧被静默丢弃。
2. **40 B 帧绝不进 `stepFrame`、绝不回 MPRC**。否则板子会多收 2 Hz 下行帧，
   打乱 20 Hz 闭环。`stage1_loop.js` 的分流在 `decodeFeature68` 之前，命中即 `return`。
3. **40 B 不转发给 33336 诊断**。`fly_watch2.js` 只认 68 B，会把它记成坏帧。

云端没升级时，这 40 B 只是被 relay 静默丢掉，板子照常跑 —— 可以分步部署。

## 大脑怎么用这两条路

`stage1_loop.js` 的 `IN_PORT` 是三条硬编码通道（audio / jo / touch），
`PRIORITY`、`ARBITERS`、`WATCH` 里到处是这三把钥匙，**不要为六路传感器改它们**。
做法是在 `startServer` 里把感官折成三个小调制量，叠到已有强度上：

| 来源 | 落到哪 | 默认强度 |
|---|---|---|
| B 脊髓：摇杆幅度 + 接近事件 | `touch` | `FLY_SENSE_GAIN` 默认 0.18 |
| B 脊髓：摇杆 X | `jo` | 同上 |
| A 直连：温湿/光/VOC/距离 + arousal | `cmd.arousal`（回写下行帧） | 同上 |

`FLY_SENSE_GAIN=0` 一键退回纯原链路。`FLY_SENSE_STALE_MS`（默认 2500）之后
调制量归零。**想让 A 路真正直连神经元**，用 `FLY_SENSE_PORT=1` 开启自动探测：
启动时从 `data.groups` 里找 `OLFA_* / OLFR_* / THERMO_* / HYGRO_* / ISN`，
命中才 `setRate`，没命中自动降级，不会破坏 `assertPorts()`。

> 注意：v4 子回路的嗅觉 / 温湿组是**果蝇的感觉通路**，把面包板传感器喂进去是
> 工程映射，不是生物学等价论证。默认走调制模式更诚实。

## 部署

```sh
# 本地先验（不需要子回路数据，不需要板子）
node brain_b/b_loop/stage1_loop.js --selftest     # 应打印 SELFTEST PASS

# 云端四进程里的两个（其余不变）
FLY_SENSE_GAIN=0.18 node relay.js
node stage1_loop.js --serve --port 33335 --api 33338
```

`relay.js` 每 20 帧打一行 `[relay] 感官帧 N`；`stage1_loop.js` 每 3 秒在**原本统计行之后
另打一行** `感官帧 N（坏 M），增益 G`（原本那行逐字不动）。板端日志每 500 ms 一行 `感官 有效=0x..`。
更完整的部署/网络/页面说明见文末「调整纪要」。

## 验证

```sh
# 云端：40 B 编解码 + 黄金帧 + CRC 反例
node brain_b/b_loop/stage1_loop.js --selftest

# 板端：C 实现与同一个黄金帧逐字节对拍
gcc -std=c11 -O2 -Wall -Wextra -I projects/cyber_fly/main \
    -o verify_mprs tests/host/verify_mprs.c \
    projects/cyber_fly/main/fly_link.c projects/cyber_fly/main/fly_game.c -lm
./verify_mprs
```

两边都对同一串 `4d5052530105280009000000090300005a0a69144001a401b40080fd70031f0002600000972ca550` 断言，等价于 C 与 JS 跨仓对拍。

## 调整纪要（按「在原本之上叠加、不削减原链路」重排）

### 1. 原链路零删改

用户明确要求「原本有的东西要保留，传感是在原本之上加的」。据此把云端对原有代码行的
删改全部撤回：

| 位置 | 之前（错） | 现在 |
|---|---|---|
| `!quiet` 日志 | 删掉了原本的 `featuresToIntensity(f)` 复用那次调用 | **原样还原**，日志仍报未叠加感官的原始强度 |
| 每 3 秒统计行 | 把「感官 N（坏 M）」塞进原本那行 | 原本那行**逐字不动**，感官统计另起一行 |
| `HELP` / `selftest` | 改写原行、把 `ok` 掺进 MPRS 条件 | 原行还原；MPRS 用前置断言 + 追加日志 |
| `relay.js` 计数与汇总 | 把 `sense` 塞进原本的 `up/down/errs` 行 | 原本行**逐字不动**，感官计数独立一行 |
| 主链路 `stepFrame` | 拆成 `base` / `mod` / `inten` 三行 | **`senseApply(featuresToIntensity(f))` 一行包住**，这是唯一不可避免的改动 |

`senseApply()` 在没有感官帧、数据过期或 `gain=0` 时**原样返回入参**（零分配），
`o.cmd.arousal` 同理，所以关掉感官后 20 Hz 链路与改动前逐字等价。
`git diff --unified=0` 对云端两个 JS 的删除行统计 = **1 行**（就是那行包装），其余全是新增。

### 2. 网络：本地用电脑热点，真实值不进 Git

- 公开仓库继续保留 `Kconfig.projbuild` 的占位符 `your-ssid` / `your-wifi-password` /
  `192.168.1.100`；`sdkconfig.defaults` 里本来就没有网络值。
- 真实值放在**两个 git 仓之外**的 `D:\ESP\local\cyber_fly_net.conf`，模板
  `cyber_fly_net.example.conf`。
- `python tools/set_local_net.py` 只把它们写进 `projects/cyber_fly/build/sdkconfig`
  （`.gitignore` 已忽略 `**/sdkconfig`），`--show` 可查当前值（密码打码）。
  **推 GitHub 前不用手工改回占位符**，本地真实值与公开仓库自动分离。
  配置仍是占位值时脚本是安全的空操作，不会污染 sdkconfig。
- 电脑热点要点：Windows「移动热点」把**网络频带设为 2.4 GHz**（ESP32-S31 无 5 GHz）；
  大脑若跑在同一台电脑，`HOST` 填它在**热点网段**的 IPv4（`ipconfig` 查
  「无线局域网适配器 本地连接* N」，通常 `192.168.137.1`），不是普通 Wi-Fi 地址。
- 真实 SSID / 密码 / IP 由用户稍后提供，填好 conf 后跑一次脚本即可。

### 3. 云端：能跟同机 2~3 个项目共存

那台云服务器还挂着别的项目，不能把资源全耗在本项目上。给出三档，**默认最轻**：

| 档位 | 脚本 | 进程 | 关键开关 |
|---|---|---|---|
| 本机档（推荐调试） | `start_local.ps1` | 2 | 大脑跑在开热点的电脑上，**云服务器零占用** |
| 本机 + 看板 | `start_local.ps1 -WithDashboard` | 4 | 加诊断 / 8080 看板 / 影子脑，`FLY_SENSE_TUNE=1` 可在线调 gain |
| 云端共存档 | `start_local.sh`（`LITE=1` 默认） | 2 | `--api 0` 关影子脑、不开诊断与看板、`--quiet` 减日志 |

- 真正吃 CPU 的是原本就有的 20 Hz 主脑步；**影子脑**（每 250 ms 一次完整脑步，
  约 18 ms、单核 7%）只在开 `--api` 时存在。感官层只有 2 Hz 解码 + 存，**几乎零开销**。
- `OFFSET=1000` / `-Offset 1000` 把整套端口（33333/33335/33336/33338/33340/8080）
  一起平移，跟别的项目零冲突；`stop_local.*` **只按 PID 文件 kill**，绝不 `pkill node`。
- `FLY_DASH_POLL_MS=1000` 可把看板轮询从默认 300 ms 降频（默认行为不变）。
- 本机跑大脑需要 `subcircuit_v4.json`（CC BY-NC 4.0 运行时依赖，**不 vendored、不要提交**）。
  脚本会检查 `D:\ESP\local\flylab\results\dodge\subcircuit_v4.json`，缺了会明确提示从云端拷一份。

### 4. 页面：属性变多，看板跟着长

- `stage1_loop.js` 的 `--api` 在原有 JSON 上**只加一个 `sense` 键**（6 路值、有效位、
  事件、显著度、帧计数、gain、stale、tune），其它字段一个不动。
- `fly_dashboard.js` 侧栏新增「感官层」面板：`sense_panel.js` 由服务端拼进同一个
  `<script>`，**原有内联 HTML/JS 一行未删**；面板复用主 `tick()` 的全局 `S`，
  **不多发一次请求**；`--api` 关闭时降级为一行提示。
- `FLY_SENSE_TUNE=1` 时大脑多一个只绑 `127.0.0.1` 的 `/api/sense?gain=`，看板代理到
  `/sense?gain=`，页面滑块可在线改增益（只改内存变量、不重启、不碰 68 B 链路）；
  默认关闭，安全且零开销。
- `cyber_fly_flow.html` 纯追加第 ⑨ 张卡片（两条通路 / 三条不变量 / 部署档位 / 网络），
  ①~⑧ 的图与表格一个字未动。

### 5. 本次仍**没有**做的事

没有刷机、没有部署到云服务器、没有连设备、没有跑完整链接编译（上一轮卡在沙箱
`build/config/*.cdep` 写权限，与代码无关）。网络真实值待用户提供；拿到后填 conf、
跑 `set_local_net.py`、编译出 `.irisfw`、经 `iris system-update` 刷入即可。

## 后续扩展点（本轮故意不做）

- VL53L0X 只跑了 best-effort 单次测距，**没有**跑 ST 官方 API 初始化序列；
  读不到就不置 `VALID_DIST`。完整测距与摄像头一起接。
- SGP40 上报归一化 RAW，不是 Sensirion VOC Index（后者要浮点算法）。
- MQ-135 模拟量、摄像头、Mosaico 板载传感器：`valid_mask` bit5 与 `spare` 已留位。
- 「本地快反射」（极近距离直接由 ESP 触发避让、不等 100 ms 云端往返）留作下一阶段，
  本轮所有决策仍由大脑给。

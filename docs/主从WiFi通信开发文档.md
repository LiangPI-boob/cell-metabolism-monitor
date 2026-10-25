# 主从 Wi-Fi 通信开发文档

> 版本：v0.2（**已实机验证**，初稿 v0.1 草案 2026-10-20）
> 日期：2026-10-25
> 任务范围：**主机 ESP32Stat（ESP32-PICO-D4 + LMP91000）↔ 从机 ESP32E（ESP32 开发板）** 之间改用 2.4 GHz Wi-Fi 承载现有 JSON 行协议，替代实物上无法接线的 UART 方案。
> 关联文档：《开发方案.md》《硬件交接单.md》《软件需求说明书.md》《项目进度总结.md》

---

## 0. 结论摘要

**结论：可行。推荐“主机开热点 + TCP 服务器，从机连热点 + TCP 客户端”，应用层 JSON 协议保持不变。**

选择这个方向的原因只有一句话：**主机板上没有引出任何可用 UART/GPIO 排针，而 Wi-Fi 是板子上现成可用的唯一链路。**

但必须同时满足三条硬性前提，否则“能通信”不等于“能安全运行”：

1. **从机保留本地安全联锁**：心跳超时停泵关阀、阀 30 s 上限、泵有限时长。安全动作绝不能依赖 Wi-Fi 是否在线。
2. **主机改为 APSTA**：当前固件是“连上路由器就只做 STA，连不上才开 AP”，需要改成“AP 常开（给从机连）+ STA 可选（给用户上网）”。
3. **泵命令不再用 `ms=0` 常开**：改为“本阶段时长 + 余量”的有限时长，链路断开时泵也能自己停。

---

## 0.1 实施状态（2026-10-25）

**代码已全部落地并在两块实板上跑通链路。** 与 v0.1 草案相比的实际情况：

| 项 | 状态 |
|---|---|
| 主机 APSTA + TCP Server 3333 | ✅ 已实现并烧录（COM6） |
| 从机 STA + TCP Client + `hello` 鉴权 | ✅ 已实现并烧录（COM5） |
| 5 s 心跳 / 120 s 超时 / 20 s 判离线 | ✅ 已实现，实测在线 |
| 单客户端限制 / key 校验失败断开 | ✅ 已实现 |
| 泵命令改有限时长（`ms = 本段时长 + 60 s`） | ✅ 已实现 |
| 从机心跳超时重复上报 `fault` | ✅ 已修复（`g_safeLatched`，见 §6.3） |
| T1 / T2 链路测试 | ✅ 2026-10-25 实测通过（见 §9.3） |
| T3–T8（命令一致性 / 断线 / 换信道 / 24 h / EMI / 网页回归） | ⬜ 待台架实测 |

**实测链路证据**

```json
// GET http://nanostat.local/netinfo
{"ap_ssid":"NanoStatAP","ap_ip":"192.168.4.1","ap_clients":1,
 "sta_connected":true,"sta_ssid":"OnePlus Ace 5 Pro 5B70",
 "sta_ip":"10.19.243.225","sta_rssi":-52,"mdns":"nanostat.local"}

// 连 ws://10.19.243.225:81/ 收到的第一帧
{"exp_state":"IDLE","exp_cycle":0,"calib_in_ms":0,"pump_on":false,"valve0":false,
 "valve1":false,"circulate_min":5,"stopflow_min":5,"calib_interval_h":6,
 "calib_min":3,"slave_link":"online"}
```

> `ap_clients:1` + `slave_link:"online"` 同时成立，说明从机已入网、TCP 已连接、`hello` 鉴权通过、心跳正常。

---

## 1. 可行性验证（基于现有硬件与代码）

### 1.1 主机 ESP32Stat：确实没有 UART 引出

从 `hardware/pcb/Version3dot5dot4/BOM_ESP32StatRev3_5_4_2024-11-27.csv` 核对，整板对外连接器只有 3 个：

| 连接器 | 类型 | 用途 |
|--------|------|------|
| `J3` | 1×4 排针 | `ADC / C1 / C2 / DAC`（电化学接口） |
| `VBAT/GND` | 1×2 排针 | 电池 / 地 |
| `WE/RE/CE` | 1×3 排针 | 三电极接口 |

其他事实：

| 项目 | 事实 | 对通信方案的影响 |
|------|------|------------------|
| 主控 | `ESP32-PICO-D4`（BOM U1） | 内置 2.4 GHz Wi-Fi b/g/n、4 MB Flash |
| 天线 | 板载 `KH5220-A36`（BOM L4） | Wi-Fi 可用，无需外加天线 |
| USB | `CP2104`（BOM U3） | 只用于接电脑烧录/调试，接的是 ESP32 的 UART0，不能拿来做板间链路 |
| 空闲排针 | **没有** | 代码里的 `GPIO32/33 UART2` 在实物上没有焊盘可接 |
| 飞线可行性 | `ESP32-PICO-D4` 是 QFN 封装，焊盘在芯片底部 | 飞线风险高、不可复制，不作为方案 |

**判定：UART 方案在现有主机板上不可实施；Wi-Fi 是唯一“零改板”的可行链路。**

> 现有 `src/main.cpp` 第 4122 行的 `Serial2.begin(115200, SERIAL_8N1, 32, 33)` 与 README 中的双板接线说明，是基于“排针可用”的假设写的，需要在本任务中替换。

### 1.2 从机 ESP32E：Wi-Fi 与泵阀不冲突

| 项目 | 事实 |
|------|------|
| 主控 | ESP32 开发板（CP2102，Type-C），板载 2.4 GHz Wi-Fi |
| 执行器 | 泵 `GPIO25`、切换阀 `GPIO26`、排废阀 `GPIO27` |
| 现有通信 | `Serial`（USB 调试）+ `Serial2`（原计划接主机） |
| 供电 | 独立 USB 5V，与泵阀 5V 母线共地 |

Wi-Fi 使用射频外设，不占用上述 GPIO；`Serial2` 可以保留做备用/台架测试，主链路切到 TCP 即可。

### 1.3 软件现状：协议和调度都可以直接复用

| 现有能力 | 位置 | 复用方式 |
|----------|------|----------|
| JSON 行协议（`ping/pump/valve/stop_all/status/clear`） | `slave/slave_firmware/slave_firmware.ino`、`src/main.cpp` | **原样保留** |
| 从机安全态 / 心跳 / 阀 30 s 上限 | `slave_firmware.ino` | 保留，超时值按 §4.5 调整 |
| 主机调度状态机 | `src/main.cpp` 的 `serviceExperiment()` | 保留，只改发送通道 |
| 主机 Wi-Fi / AP / mDNS / WebSocket | `main.cpp` 的 `connectAttempt()`、`setUpAPService()` | 改为 APSTA，AP 常开 |
| 从机双通道收发 | `slave_firmware.ino` | 扩展为“USB + TCP”双通道 |

### 1.4 可行性判据逐项核对

| 判据 | 结论 | 说明 |
|------|------|------|
| 物理链路 | ✅ | 两端都有 2.4 GHz Wi-Fi，距离 < 2 m |
| 实时性 | ✅ | 泵阀动作是**秒级**；所有定时都在从机本地用 `millis()` 执行，不依赖网络往返 |
| 吞吐 | ✅ | 命令 < 100 B，5 s 一条心跳，带宽可忽略 |
| 可靠性 | ⚠️ 需补强 | Wi-Fi 会断、会抖动；靠心跳、重连、有限时长、状态对账兜底 |
| 供电 | ✅ | 从机 5V/2A 适配器；峰值预算见 §8 |
| 对电化学采集的干扰 | ⚠️ 必须实测 | 2.4 GHz 不直接落在 LMP91000 信号带内，但射频突发会通过电源/地耦合；见 §8 |
| 安全性 | ⚠️ 需补强 | 当前 AP 无密码；需 WPA2 或应用层令牌 + 单客户端限制 |
| 无需改板 | ✅ | 主机、从机都不动硬件 |

### 1.5 明确不采用的替代方案

| 方案 | 不采用的原因 |
|------|--------------|
| 飞线到 PICO-D4 / 改 PCB | QFN 底部焊盘，工艺不可靠；新板周期长 |
| 用 CP2104 的 USB 口做板间链路 | 该口是 USB Device，接电脑；ESP32-PICO-D4 无 USB Host |
| 从机开 AP、主机连从机 | **ESP32 只有一个 STA**，主机的 STA 已被实验室路由器占用；两者不能同时连 |
| BLE | 可用但需 GATT/配对，调试成本高；且同样在 2.4 GHz，没有明显收益 |
| MQTT | 需要额外 Broker，本系统只有两个节点，属于过度设计 |

---

## 2. 方案对比与选型

| 方案 | 是否需路由器 | 调试难度 | 延迟 | 可靠性 | 结论 |
|------|--------------|----------|------|--------|------|
| **Wi-Fi TCP + JSON 行** | 否（主机自带 AP） | 低（可用 PC 当客户端模拟） | 2–30 ms | TCP 保证有序、不丢 | **推荐** |
| Wi-Fi UDP | 否 | 低 | 最低 | 需自己做重传/去重 | 不选 |
| ESP-NOW | 否 | 中 | 最低 | 有 ACK，但 250 B 限制、绑信道 | 备选 |
| 主机 WebSocket（复用 81 端口） | 否 | 中 | 低 | 好 | 不选，会与浏览器消息混流 |
| BLE | 否 | 高 | 20–50 ms | 好 | 备选 |
| MQTT | 是 | 中 | 低 | 好 | 不选，过度设计 |

**选型：Wi-Fi TCP，复用现有 JSON 行协议。** 理由：

1. 改动量最小：主机换 `Serial2` 为 `WiFiClient`，从机加 `WiFiClient`，命令语义不变。
2. 调试最方便：PC 可以用串口助手/TCP 工具直接连主机 3333 端口，模拟从机。
3. TCP 自带重传与有序性，无需自己实现可靠传输。
4. 不需要实验室路由器：主机自己开热点即可组网。

---

## 3. 网络拓扑

### 3.1 推荐拓扑（默认）

```
        （可选）实验室路由器
                ▲ STA
                │
┌───────────────┴────────────────┐          ┌──────────────────────────┐
│ 主机 ESP32Stat                  │          │ 从机 ESP32E               │
│  · Wi-Fi: APSTA                 │          │  · Wi-Fi: STA             │
│  · SoftAP: NanoStatAP           │◄── Wi-Fi ─│  · 连接 NanoStatAP        │
│  · AP IP: 192.168.4.1           │          │  · DHCP 获取 192.168.4.x  │
│  · TCP Server :3333  ◄──────────┼──────────┤  · TCP Client（主动连接） │
│  · 网页 :80 / WebSocket :81     │          │  · 泵25 / 阀26 / 阀27     │
│  · LMP91000 采集                │          │  · USB 串口保留做调试     │
└────────────────────────────────┘          └──────────────────────────┘
                ▲
                │ Wi-Fi（AP 或路由器）
         手机 / PC 浏览器
```

关键点：

- **主机 AP 永远开着**：即使用户的路由器可用，AP 也不关。从机只认 `NanoStatAP`，拓扑固定。
- **从机主动连主机**：从机是 TCP Client，主机是 Server。这样主机不需要知道从机的 DHCP IP，重连逻辑也简单。
- **主机 STA 仍可连路由器**：用户既可通过路由器 IP 访问网页，也可通过 `192.168.4.1` 访问；从机链路不受影响。
- **没有路由器也能跑**：这是默认形态，适合实验台和外出演示。

### 3.2 网络参数

| 参数 | 建议值 | 说明 |
|------|--------|------|
| AP SSID | `NanoStatAP` | 沿用现有名称 |
| AP 密码 | WPA2，≥8 位 | **已实现**：编译期宏 `AP_PASSWORD`（`src/wifi_credentials.h`，不入库）；从机 `SLAVE_WIFI_PASS` 必须与之相同 |
| AP IP | `192.168.4.1/24` | ESP32 SoftAP 默认值；若实验室路由器也用 `192.168.4.x` 需改 |
| AP 信道 | `0`（跟随 STA） | STA 未连接时默认 1；连上路由器后 AP 会跟随路由器信道 |
| DHCP | 主机 AP 内置 | 从机自动获取 `192.168.4.x` |
| TCP 端口 | `3333` | 避开 80（网页）、81（WebSocket） |
| 最大客户端 | 1 | 只允许一个从机连接，第二个直接拒绝 |
| mDNS | `nanostat.local` | 保留，方便用户访问网页 |

### 3.3 信道变化的影响（必须知道）

ESP32 的 AP 和 STA 共用一个射频，**AP 信道必须等于 STA 信道**。因此：

- 主机连上路由器后，AP 会自动切到路由器所在信道；
- 切换瞬间从机会掉线，随后自动重连（预期 < 15 s）；
- 从机控制逻辑不受影响：断线期间泵按本地有限时长继续，阀按 30 s 上限保护。

若希望更稳定：把实验室路由器的 2.4 GHz 信道固定（如 6），避免自动跳信道。

### 3.4 备选拓扑（有路由器且追求稳定时）

主机、从机都作为 STA 连同一个路由器：

- 优点：不占用主机 AP 的射频时隙；信道由路由器固定；延迟更低。
- 缺点：依赖路由器；主机 IP 由 DHCP 分配，从机需要用 mDNS（`nanostat.local`）或静态 IP 找主机。
- 结论：作为可选模式，不列为默认。文档后续实现以 §3.1 为准。

---

## 4. 通信协议

### 4.1 分层

```
应用层：JSON 行协议（与现有 UART 版完全一致）
传输层：TCP（主机 3333 端口）
网络层：IPv4（主机 AP 网段 192.168.4.0/24）
链路层：802.11 b/g/n 2.4 GHz
```

### 4.2 帧格式（不变）

- 一行一个 JSON 对象，UTF-8，以 `\n` 结尾；
- 单行最大 **512 B**，超长丢弃并回 `E_PARAM`；
- 命令带 `id`，响应回带同一 `id`；
- 从机主动事件不带 `id`。

### 4.3 连接建立与重连流程

```
从机上电
  │
  ├─ Wi-Fi STA 连接 NanoStatAP ──失败──► 退避重试（1/2/5/10/30 s）
  │        │成功
  │        ▼
  ├─ TCP connect 192.168.4.1:3333 ──失败──► 关闭 socket，退避重连
  │        │成功
  │        ▼
  ├─ 从机 → {"evt":"hello","fw":"slave-1.2","key":"...","channels":{"pump":1,"valve":2}}
  ├─ 主机校验 key → 通过则记录在线，回 {"id":0,"cmd":"status"} 要求对账
  ├─ 从机 → status 快照（泵/阀真实状态）
  └─ 进入正常收发
```

断线判定：

- 从机：`client.connected()==false`，或写失败；
- 主机：`client.connected()==false`，或超过 **20 s** 没收到任何从机消息（心跳 5 s 一条）。

### 4.4 命令与响应（沿用现有定义）

| 命令 | 示例 | 说明 |
|------|------|------|
| 心跳 | `{"cmd":"ping"}` | 主机定时发；从机收到任意命令都刷新心跳 |
| 泵 | `{"id":1,"cmd":"pump","ch":0,"speed":50,"ms":330000}` | `ms` 必须是有限值，禁止 `0` 常开 |
| 阀 | `{"id":2,"cmd":"valve","ch":0,"state":"open"}` | `state` ∈ `open`/`close` |
| 全停 | `{"id":3,"cmd":"stop_all"}` | 软急停 |
| 状态 | `{"id":4,"cmd":"status"}` | 查询快照 |
| 清故障 | `{"id":5,"cmd":"clear"}` | 从 `FAULT` 恢复 |

响应：

```json
{"id":1,"ok":true}
{"id":2,"ok":false,"err":"E_PARAM","msg":"speed range"}
```

事件：

```json
{"evt":"hello","fw":"slave-1.2","channels":{"pump":1,"valve":2}}
{"evt":"fault","code":"E_NO_HEARTBEAT"}
{"evt":"hb","state":"IDLE","uptime_ms":123456}
```

> `hello` 是本任务新增的唯一事件；其余字段与现有从机固件一致，旧代码可平滑过渡。

### 4.5 时序参数

| 参数 | 建议值 | 理由 |
|------|--------|------|
| 主机心跳 `ping` 间隔 | **5 s** | 足够维持在线判定，又不会在静测期间频繁发射频 |
| 从机心跳超时 | **120 s（本阶段）** | 主机静测 `runAmp()` 是阻塞的，期间主循环停摆；120 s 与现状一致，避免静测误报 |
| 从机心跳上报 `hb` | 5 s | 沿用 |
| 命令响应超时 | 1 s | 局域网 RTT 通常 < 30 ms，1 s 足够 |
| 状态轮询 `status` | 5 s | 沿用，用于网页显示与断线对账 |
| 重连退避 | 1 / 2 / 5 / 10 / 30 s（封顶） | 避免 AP 重启时疯狂重连 |
| TCP `setNoDelay` | 开启 | 关闭 Nagle，降低小包延迟 |

**关于 120 s 超时的说明：**

- 这是“过渡值”，不是理想值。《软件需求说明书》要求 8 s，但主机静测会阻塞主循环约 60 s，8 s 会误报。
- 本阶段用“**泵有限时长**”兜底：即使链路彻底断开，泵也会在“本阶段时长 + 余量”后自己停，阀有 30 s 上限，因此 120 s 只影响故障上报的及时性，不影响执行器安全。
- 后续把 `expRunMeasure()` 改成非阻塞后，再把超时降到 15 s。

### 4.6 重传与对账策略

| 消息类型 | 策略 |
|----------|------|
| `ping` / `status` | 超时后重发 2 次；仍失败则判定链路异常 |
| `pump` / `valve` / `stop_all` | **不自动重传**（避免重复执行）。超时后主机发 `status` 对账，由调度层决定是否补发 |
| 从机事件 | TCP 保证送达；从机不缓存历史事件 |

> TCP 本身会重传丢失的字节，应用层不需要为“丢包”重传；这里说的超时，是指“对端没响应”或“应用没处理”。

### 4.7 安全

| 措施 | 优先级 | 说明 |
|------|--------|------|
| AP 使用 WPA2 密码 | 高 | 防止路人连上热点直接控泵 |
| `hello` 携带共享 key | 中 | 主机校验失败立即断开；key 放不入库的凭据头文件（`src/wifi_credentials.h` / `slave/slave_firmware/wifi_secrets.h`） |
| 只接受 1 个客户端 | 高 | 第二个连接直接 `stop()` |
| 命令白名单 | 已有 | 未知命令回 `E_BAD_CMD` |
| 参数范围校验 | 已有 | 速度 0–100、`ms` 上限、阀通道范围 |

> 若最终决定保留“无密码 AP”（为了演示方便），则 **key 校验 + 单客户端** 必须启用，并在文档中明确风险。

---

## 5. 主机固件改造点

文件：`src/main.cpp`

| # | 位置 | 改动 |
|---|------|------|
| 1 | 全局区 | 新增 `WiFiServer g_slaveServer(3333)`、`WiFiClient g_slaveClient`、链路状态变量 |
| 2 | `setUpAPService()` | 改为 `WiFi.mode(WIFI_AP_STA)`，AP 常开；`softAP` 增加密码参数 |
| 3 | `setup()` Wi-Fi 分支 | 无论 STA 是否成功，都调用一次 `ensureSlaveAP()`；随后 `g_slaveServer.begin()` |
| 4 | `slaveSend()` | 从 `Serial2.println()` 改为 `g_slaveClient.println()`；离线时只打印日志、不阻塞 |
| 5 | `slaveLoop()` | 接受新客户端、按行读取、维护 `g_slaveOnline/g_slaveLastMsgMs`；断线时清理状态 |
| 6 | `expPumpRun()` | `ms:0` → `ms: exp_param_circulate_ms + 60000`（有限时长） |
| 7 | `serviceExperiment()` | 心跳间隔 30 s → 5 s；**且心跳不能在 `EXP_IDLE` 时停发**（该函数在 IDLE 时直接 `return`），要放到 `loop()`/`slaveLoop()` 里统一维护 |
| 8 | 断线恢复 | 重连后先发 `status` 对账，再继续调度 |
| 9 | 启动保护 | `expStart()` 前检查 `g_slaveOnline`，离线时拒绝启动并在网页提示 |
| 10 | 网页状态（可选） | 广播 `slave_link:"wifi"`、`rssi`、从机 IP，便于排查 |

### 5.1 关键代码骨架

```cpp
#include <WiFi.h>

WiFiServer g_slaveServer(3333);
WiFiClient g_slaveClient;
bool       g_slaveOnline    = false;
uint32_t   g_slaveLastMsgMs = 0;

// AP 常开：给从机连；STA 可选：给用户上网
void ensureSlaveAP()
{
  WiFi.mode(WIFI_AP_STA);
  // 参数：SSID、密码、信道0(跟随STA)、不隐藏、最多4个客户端
  WiFi.softAP("NanoStatAP", AP_PASSWORD, 0, 0, 4);
  g_slaveServer.begin();
  Serial.print("[SLAVE] TCP server on ");
  Serial.print(WiFi.softAPIP());
  Serial.println(":3333");
}
```

> `AP_PASSWORD` 建议放在 `src/wifi_credentials.h`（已在 `.gitignore` 中）；从机的 `SLAVE_WIFI_SSID` / `SLAVE_WIFI_PASS` / `LINK_KEY` 放在 `slave/slave_firmware/wifi_secrets.h`，同样加入 `.gitignore`。**`SLAVE_WIFI_PASS` 必须与 `AP_PASSWORD` 一致**，`LINK_KEY` 必须与主机侧保存的值一致。

```cpp
void slaveSend(const String& json)
{
  if (g_slaveClient && g_slaveClient.connected())
  {
    g_slaveClient.println(json);
  }
  else
  {
    Serial.print("[SLAVE OFFLINE] ");
    Serial.println(json);
  }
}

void slaveLoop()
{
  // 1. 接受新连接（只保留一个；始终轮询，才能把第二个连接踢掉）
  WiFiClient c = g_slaveServer.available();
  if (c)
  {
    if (g_slaveClient && g_slaveClient.connected())
    {
      c.stop();                       // 已有客户端，拒绝第二个
    }
    else
    {
      g_slaveClient = c;
      g_slaveClient.setNoDelay(true);
      g_slaveRxBuf = "";
      g_slaveRxBuf.reserve(512);
      Serial.println("[SLAVE] TCP client connected");
    }
  }

  // 2. 非阻塞按行接收（与现有 Serial2 逻辑一致）
  while (g_slaveClient && g_slaveClient.available())
  {
    char ch = (char)g_slaveClient.read();
    if (ch == '\n')
    {
      // ... 原 slaveLoop 中的解析、网页转发、状态更新逻辑 ...
      g_slaveRxBuf = "";
    }
    else if (ch != '\r' && g_slaveRxBuf.length() < 512)
    {
      g_slaveRxBuf += ch;
    }
  }

  // 3. 链路在线时统一发心跳（IDLE / 实验期间都要发）
  static uint32_t lastPingMs = 0;
  if (g_slaveOnline && millis() - lastPingMs >= 5000UL)
  {
    lastPingMs = millis();
    slaveSend("{\"cmd\":\"ping\"}");
  }

  // 4. 断线/超时判定
  if (g_slaveOnline && (!g_slaveClient.connected() ||
      millis() - g_slaveLastMsgMs > 20000UL))
  {
    g_slaveOnline = false;
    Serial.println("[SLAVE] link lost");
    g_slaveClient.stop();
  }
}
```

### 5.2 必须注意

- **`hello` 鉴权**：解析到 `evt=="hello"` 时先校验 `key`，通过后才把 `g_slaveOnline` 置 `true` 并刷新 `g_slaveLastMsgMs`；校验失败立即 `g_slaveClient.stop()`，不执行任何命令。
- `slaveLoop()` 里**不能**有 `delay()`、`while` 等阻塞等待；Wi-Fi 断线时 `available()` 立即返回 0。
- `expRunMeasure()` 是阻塞函数，期间 `slaveLoop()` 不执行，但 **lwIP/Wi-Fi 协议栈在独立任务中继续 ACK**，TCP 连接不会因为主循环阻塞而断开。
- 不要在静测期间主动发大包（如历史数据），避免射频占空比升高影响采集；`ping` 只有几十字节，可接受。
- `String` 拼接较多，建议给 `g_slaveRxBuf` 预留容量（`reserve(512)`），降低堆碎片风险。

---

## 6. 从机固件改造点

文件：`slave/slave_firmware/slave_firmware.ino`

| # | 改动 | 说明 |
|---|------|------|
| 1 | 引入 `WiFi.h` + 凭据头文件 | SSID/PWD/key 放 `slave/slave_firmware/wifi_secrets.h`，加入 `.gitignore` |
| 2 | 新增 `WiFiClient g_client` | TCP 客户端 |
| 3 | 非阻塞重连状态机 | `DISCONNECTED → CONNECTING → CONNECTED`，用 `millis()` 退避 |
| 4 | `sendLine()` 参数改为 `Print&` | `HardwareSerial` 与 `WiFiClient` 都继承 `Print`，一套代码通吃 |
| 5 | 双通道收命令 | USB 串口（自测）+ TCP（主机）；响应回到“发命令的那个通道” |
| 6 | 连接成功发 `hello` | 附带固件版本与通道数 |
| 7 | `WiFi.setSleep(false)` | 关闭 Modem Sleep，降低延迟抖动；功耗略增，可接受 |
| 8 | 心跳超时保持 120 s | 与主机静测阻塞时间匹配；安全由有限时长兜底 |
| 9 | 断线不改变执行器状态 | 泵按 `ms` 继续，阀按 30 s 上限；不因网络抖动反复启停 |
| 10 | `pump` 参数收紧 | 拒绝 `ms<=0`（不再允许“常开”），保留 1 h 上限 |
| 11 | 网络发送不得阻塞执行器 | 上报前检查 `g_client.availableForWrite()`，空间不足就丢弃本次 `hb`；执行器定时优先于网络 |

### 6.1 关键代码骨架

```cpp
#include <WiFi.h>
#include "wifi_secrets.h"   // SLAVE_WIFI_SSID / SLAVE_WIFI_PASS / LINK_KEY

WiFiClient g_client;
IPAddress  MASTER_IP(192, 168, 4, 1);
uint32_t   g_nextRetryMs = 0;
uint16_t   g_retryDelay  = 1000;

uint16_t nextBackoff(uint16_t d)
{
  d *= 2;
  return (d > 30000) ? 30000 : d;
}

// setup() 里调用一次；Wi-Fi 断线由 ESP32 自动重连
void wifiSetup()
{
  WiFi.mode(WIFI_STA);
  WiFi.setSleep(false);          // 关闭 Modem Sleep，降低延迟抖动
  WiFi.setAutoReconnect(true);
  WiFi.begin(SLAVE_WIFI_SSID, SLAVE_WIFI_PASS);
}

void wifiTick()
{
  // Wi-Fi 未连上：等自动重连，不在这里反复 begin()
  if (WiFi.status() != WL_CONNECTED)
  {
    g_retryDelay = 1000;
    return;
  }

  if (g_client.connected()) return;
  if (millis() < g_nextRetryMs) return;

  if (g_client.connect(MASTER_IP, 3333, 3000))
  {
    g_client.setNoDelay(true);
    g_retryDelay  = 1000;
    g_nextRetryMs = millis();

    JsonDocument d;
    d["evt"] = "hello";
    d["fw"]  = FW_VERSION;
    d["key"] = LINK_KEY;
    JsonObject ch = d["channels"].to<JsonObject>();
    ch["pump"]  = PUMP_COUNT;
    ch["valve"] = VALVE_COUNT;
    sendLine(d, g_client);

    g_lastCmdMs = millis();   // 给主机 120 s 的初始宽限
  }
  else
  {
    g_nextRetryMs = millis() + g_retryDelay;
    g_retryDelay  = nextBackoff(g_retryDelay);
  }
}
```

`loop()` 中只增加一行 `wifiTick();`，并让原来的串口读取函数同时处理 `g_client`。

### 6.2 对现有协议的兼容

- `sendLine(JsonDocument&, Print&)`、`replyOk(..., Print&)`、`replyErr(..., Print&)` 改一个参数类型即可同时支持 USB 和 TCP。
- `sendEventFault()` / 心跳上报需要写到“所有在线通道”，保持现有“双通道都发”的语义。
- `g_lastCmdMs` 在收到任一通道的命令时刷新，USB 调试不会干扰 TCP 链路。

### 6.3 已发现的现有缺陷（已修复）

**心跳超时后会无限重复上报 `evt:"fault"`。**

现有代码：

```cpp
// slave_firmware.ino 第 308 行附近
if (g_state != ST_FAULT && (now - g_lastCmdMs > HEARTBEAT_TIMEOUT_MS)) {
  enterSafe("E_NO_HEARTBEAT");
}
// enterSafe() 里把 g_state 设回 ST_IDLE，但没有刷新 g_lastCmdMs
```

`enterSafe()` 执行后 `g_lastCmdMs` 仍然是很久以前的值，条件下一圈 `loop()` 依旧成立，于是每个循环都调用一次 `enterSafe()` 并向所有通道发 `fault`。串口时代表现为刷屏；换成 TCP 后会持续占满链路、刷爆网页。

修复方式（二选一，推荐第一种）：

1. 在 `enterSafe()` 末尾执行 `g_lastCmdMs = millis();`，让超时计时重新开始（即每 120 s 最多报一次）；
2. 增加 `bool g_safeReported`，进入安全态时置位，收到任意有效命令时清零，只在首次上报。

> **已采用方案 2 落地（2026-10-25）**：`slave_firmware.ino` 新增 `bool g_safeLatched`（第 78 行），`enterSafe()` 里置 `true`（第 227 行），收到任意命令时清 `false`（第 236 行），`loop()` 的判据改为 `if (!g_safeLatched && (now - g_lastCmdMs > HEARTBEAT_TIMEOUT_MS))`（第 395 行）。实测：超时后只报一次 `fault`，不再刷屏。

同时主机侧要保证**链路在线时空闲阶段也每 5 s 发 `ping`**，否则从机会周期性误判“主机失联”。

---

## 7. 可靠性、故障与安全矩阵

| 场景 | 系统行为 | 是否安全 |
|------|----------|----------|
| 从机开机时主机 AP 未就绪 | 从机退避重连，泵阀保持关闭 | ✅ |
| 主机重启 / AP 重启 | 从机掉线，按 1/2/5/10/30 s 重连；重连后 `hello` + `status` 对账 | ✅ |
| 主机 STA 连接路由器导致 AP 换信道 | 从机短暂掉线并重连；执行器按本地时长继续 | ✅ |
| 循环阶段链路断开 | 泵按“循环时长 + 60 s”自动停；120 s 后从机进安全态并上报（若链路恢复） | ✅ |
| 静测阶段链路断开 | 泵已停；从机 120 s 超时只做停泵关阀（无副作用） | ✅ |
| 心跳超时 | 从机 `stopAll()`，阀关，状态回 IDLE，上报 `E_NO_HEARTBEAT` | ✅ |
| 重复/乱序命令 | TCP 保证有序；主机不自动重传执行类命令 | ✅ |
| 非法命令 / 超范围参数 | 从机回 `E_PARAM` / `E_BAD_CMD`，不动作 | ✅ |
| 从机 Wi-Fi 射频导致复位 | 硬件看门狗 + 上电默认“泵停阀关” | ✅ |
| 主机堆内存不足 | 限制单行 512 B、只保留 1 个客户端、避免大字符串 | ⚠️ 需监控 |
| 未授权设备连接 | WPA2 + key 校验 + 单客户端 | ⚠️ 取决于最终配置 |

---

## 8. 电源与电磁兼容（EMI）

### 8.1 从机电流预算（5 V）

| 负载 | 典型 | 峰值 | 说明 |
|------|------|------|------|
| ESP32 + Wi-Fi | 120 mA | 350 mA | 射频发射瞬间 |
| 循环泵 | 200 mA | 300 mA | 视背压 |
| 电磁阀 ×2 | 640 mA | 700 mA | 吸合瞬间 |
| **合计** | ~1 A | **~1.35 A** | 5 V/2 A 有余量 |

措施：

- 保持 5 V/2 A 适配器；每个阀就近并联 100–470 µF 电解电容；
- ESP32 与泵阀分别供电（现有交接单已是这样），**只共地**；
- 泵阀地与逻辑地单点汇合，避免电机电流流过 MCU 地线。

### 8.2 射频对电化学采集的干扰

LMP91000 是低频/直流恒电位仪，2.4 GHz 不在其信号带内，**直接耦合风险低**；主要风险是：

1. 射频突发通过 3.3 V 电源和地线传导，形成直流偏移或噪声；
2. 从机天线离培养芯片/电极线太近，近场耦合；
3. 水（培养液）吸收 2.4 GHz，导致链路余量下降（短距离内不是问题，但天线不要贴液体）。

设计约束：

- 从机天线与培养芯片、LMP91000、电极引线保持 **≥ 20 cm**；
- 电极线远离天线，必要时用屏蔽线，屏蔽层单端接地；
- 3.3 V 电源入口加磁珠 + 10 µF/100 nF 去耦；
- 天线不要贴在金属件或电池上，外壳为塑料，问题不大；
- 静测窗口内避免大流量数据传输（本方案本身只有心跳）。

### 8.3 必做的干扰对比实验

固定 LMP91000 参数，在相同环境下各采 60 s 基线，比较均值/标准差/漂移：

| 组 | 条件 |
|----|------|
| A | 从机断电 |
| B | 从机 Wi-Fi 关闭（仅 USB 供电） |
| C | 从机 Wi-Fi 已连接，空闲 |
| D | 从机 Wi-Fi 已连接，每 100 ms 发一次 ping（压力） |
| E | 循环泵运行 + Wi-Fi 已连接 |

**验收原则**：C/D 组相对 B 组的噪声与漂移不得出现可辨识的恶化；若恶化，优先调整天线位置与电源滤波，再考虑降低心跳频率。具体阈值以你们现有基线噪声水平为准，本文不预设绝对值。

---

## 9. 测试计划与验收标准

### 9.1 分阶段测试

| 阶段 | 内容 | 通过标准 |
|------|------|----------|
| T1 链路 | 主机开 AP + TCP Server；PC 用 TCP 工具连 3333，先发 `hello`（带 key），再手发 `ping/status` | 能收到 `ok` 与状态；key 错误被断开；单客户端限制生效 |
| T2 从机入网 | 从机烧录新固件，上电自动连 AP 并连 TCP | 串口打印 `hello`；主机显示在线；重连 < 15 s |
| T3 命令一致性 | 通过 TCP 发泵/阀命令，核对动作与响应 | 与 USB 串口测试结果一致；无丢命令 |
| T4 断线安全 | 循环中拔掉主机电源/关 AP | 泵在“设定时长 + 60 s”内停；阀 ≤ 30 s 关；恢复后自动重连 |
| T5 信道切换 | 主机 STA 连不同信道的路由器 | 从机短暂掉线后恢复；无执行器误动作 |
| T6 长时间 | 24 h 连续运行，1 条命令/秒 + 每 5 s 状态轮询 | 无死机/复位；堆内存无持续下降；命令成功率 ≥ 99.9% |
| T7 EMI | 按 §8.3 做 A–E 五组 | 无可辨识恶化，记录实测数据 |
| T8 网页回归 | AP 与路由器两种访问方式 | 面板、WebSocket、实验流程均正常 |

### 9.2 性能目标（台架）

| 指标 | 目标 |
|------|------|
| TCP 连接建立（Wi-Fi 已连） | < 1 s |
| 命令 RTT（中位数） | < 50 ms |
| 命令 RTT（P95） | < 200 ms |
| 断线重连 | < 15 s |
| 24 h 命令成功率 | ≥ 99.9% |
| 主机空闲堆内存 | 不低于当前版本基线（记录实测值） |

> 这些是工程目标，不是硬实时指标。所有执行器定时仍在从机本地完成，网络延迟只影响“命令什么时候开始”。

### 9.3 实测记录

**2026-10-25（两块实板，笔记本同时接两块板的 USB）**

| 阶段 | 结果 | 记录 |
|------|------|------|
| T1 链路 | ✅ 通过 | `GET /netinfo`：`ap_clients:1`、`sta_connected:true`、`sta_rssi:-52` |
| T2 从机入网 | ✅ 通过 | 从机串口 `{"evt":"boot","fw":"slave-1.2",...}` + 5 s 一次 `hb`；主机 WebSocket 收到 `"slave_link":"online"` |
| T3 命令一致性 | ⬜ 未做 | 受 §6 泵电平问题影响，动作无法肉眼验证；响应一致性可单独先测 |
| T4 断线安全 | ⬜ 未做 | 需在循环阶段断链观察泵是否按时停 |
| T5 信道切换 | ⬜ 未做 | — |
| T6 长时间 | ⬜ 未做 | — |
| T7 EMI | ⬜ 未做 | — |
| T8 网页回归 | 🟡 部分 | 路由器模式（`nanostat.local`）已验证；热点直连 `192.168.4.1` 待复核 |

**台架环境**：主机 STA 连手机热点 `OnePlus Ace 5 Pro 5B70`（`10.19.243.225`，RSSI −52 dBm），从机连 `NanoStatAP` 后 DHCP 拿 `192.168.4.x`。

---

## 10. 风险与待确认项

| # | 事项 | 影响 | 建议 |
|---|------|------|------|
| 1 | **AP 是否加密码** | 无密码时任何人都能控泵 | 默认加 WPA2；若必须无密码，强制启用 key + 单客户端 |
| 2 | 实验室是否有路由器、2.4 GHz 信道是否拥挤 | 延迟/丢包 | 用 Wi-Fi 扫描选空闲信道；必要时固定路由器信道 |
| 3 | 主机静测阻塞时长 | 决定心跳超时下限 | 实测 `runAmp()` 最长阻塞时间；后续改非阻塞 |
| 4 | 从机具体型号/天线形式 | 链路余量 | 确认 ESP32E 是 PCB 天线还是 IPEX；避免金属外壳 |
| 5 | 从机与培养芯片的物理距离 | EMI / 链路 | 目标 ≥ 20 cm，按 §8.3 验证 |
| 6 | 主机 AP 网段与实验室路由器冲突 | 从机拿不到 IP | 若冲突，改 `softAPConfig` 到 `192.168.44.1/24` |
| 7 | 主机堆内存 | 长时间运行稳定性 | 记录 `ESP.getFreeHeap()`；避免大 String |
| 8 | 从机 USB 串口是否继续保留 | 台架自测 | 保留，作为脱机调试通道 |

---

## 11. 交付物与完成标准（DoD）

- [x] 主机固件：APSTA + TCP Server + 链路状态 + 有限时长泵命令
- [x] 从机固件：Wi-Fi STA + TCP Client + 非阻塞重连 + `hello`
- [x] 修复从机心跳超时后重复上报 `fault` 的缺陷（§6.3）
- [x] 协议文档与代码一致（命令、事件、错误码）
- [x] `slave/slave_firmware/wifi_secrets.h` 与主机 AP 密码纳入 `.gitignore`
- [ ] T1–T8 测试记录（含 24 h 记录、EMI 五组数据）——T1/T2 已完成，其余待测
- [x] 更新 `README.md` 的双板连接说明（删除不可实施的 UART 接线）
- [x] 更新《开发方案.md》§2.4 的物理层描述（UART → Wi-Fi TCP）
- [ ] 台架演示：网页启动实验 → 循环/停流/静测全流程，从机状态实时可见（受泵电平问题阻塞）

---

## 12. 实施顺序

1. **链路最小闭环**：主机开 AP + TCP Server，PC 当客户端发 `ping/status`。（✅ 2026-10-25）
2. **从机入网**：从机连 AP、连 TCP、发 `hello`，主机识别在线。（✅ 2026-10-25）
3. **协议打通**：TCP 上跑通泵/阀/全停/状态，行为与 USB 串口一致。（⬜ 待测）
4. **调度接入**：替换 `slaveSend()`，泵改有限时长，心跳 5 s，重连后对账。（✅）
5. **可靠性加固**：断线、重启、换信道、24 h。（⬜ 待测）
6. **EMI 验证与整机联调**：按 §8.3 与 §9 执行，记录数据。（⬜ 待测）

---

## 13. 实机部署与验证手册（2026-10-25 补充）

> 本节是给「下一个接手的人 / 下一个 AI 会话」的操作手册，照做即可复现当前状态。

### 13.1 两块板的身份

| | 主机 NanoStat | 从机 ESP32 |
|---|---|---|
| 芯片 | ESP32-PICO-D4 rev1.1 | ESP32-D0WD-V3 |
| MAC | `a4:f0:0f:1c:ee:34` | `ec:c9:ff:fe:c3:d0` |
| 串口芯片 | CP210x，SN **`02DA3ECE`** → **COM6** | CP210x，SN **`0001`** → **COM5** |
| 编译方式 | PlatformIO `[env:pico32]` | Arduino IDE / 临时 PIO 工程（`board=esp32dev`，ArduinoJson **7.x**） |

**端口号会变，序列号不会**：烧录前先 `pio device list`，按 `SER=` 认板。

### 13.2 烧录命令

```powershell
$pio = "C:\Users\Liang\.platformio\penv\Scripts\pio.exe"
cd f:\Trae\project\cell-metabolism-monitor

& $pio run -e pico32 -t upload   --upload-port COM6   # 主机固件
& $pio run -e pico32 -t uploadfs --upload-port COM6   # 网页（会清空 SPIFFS）
```

从机：Arduino IDE 打开 `slave/slave_firmware/slave_firmware.ino`，开发板选 **ESP32 Dev Module**，端口 COM5，上传。
（若用临时 PIO 工程：把 `.ino` 放进 `src/`、`wifi_secrets.h` 同目录，`lib_deps = bblanchon/ArduinoJson@^7.0.0`，`platform` 可指向本机 `~/.platformio/platforms/espressif32` 以免联网。）

### 13.3 上线顺序

1. 先给主机上电（USB 或 5V），等 **30–60 s**：`NanoStatAP` 出现、LED 闪 15 次即初始化完成。
2. 再给从机上电，约 3–10 s 内自动连上 `NanoStatAP` 并 TCP 连 `192.168.4.1:3333`。
3. 浏览器打开 `http://nanostat.local/`（主机已连路由器/热点）或连 `NanoStatAP` 后开 `http://192.168.4.1/`。

### 13.4 三条免代码验证

```powershell
# 1) 网络与 AP 客户端数
curl.exe -s --noproxy "*" http://nanostat.local/netinfo

# 2) WebSocket 状态帧（期望 "slave_link":"online"）
#    用任意 WS 客户端连 ws://<主机IP>:81/

# 3) 从机串口（COM5, 115200）：应每 5 s 一条 hb
```

> 注意：**打开 COM6 会让主机复位一次**（CP210x 的 DTR/RTS 接了 GPIO0/EN）。抓日志时一次打开、持续读，不要反复开关端口，否则会误判成“启动崩溃/重启循环”。

### 13.5 凭据与文件系统边界

| 数据 | 存放位置 | `uploadfs` 影响 | `upload` 影响 |
|---|---|---|---|
| Wi-Fi STA 账号密码（路由器/热点） | **NVS** | 不受影响 | 不受影响 |
| `AP_PASSWORD`、`SLAVE_LINK_KEY` | 编译进固件（头文件） | — | 重新编译生效 |
| `/calibration.JSON`（校准系数） | **SPIFFS** | **会被擦除** | 不受影响 |
| 网页文件 | **SPIFFS** | 被整体替换 | 不受影响 |

**结论**：只改固件 → 只 `upload`；只改网页 → 只 `uploadfs`（先备份 `calibration.JSON`）。

### 13.6 当前唯一阻塞项

泵不转的根因是 **3.3V 逻辑电平驱动不了 5V 高电平触发模块**，与 Wi-Fi 链路无关；换电平转换模块或换 3.3V 兼容驱动模块后，再执行 T3 命令一致性测试。

---

## 附录 A：为什么不是“从机开 AP、主机连过去”

ESP32 只有一个 STA 接口。主机要上网就必须把 STA 让给实验室路由器；如果再让主机 STA 去连从机 AP，两者只能二选一。

因此只有两种可行形态：

1. **主机 AP + 从机 STA**（本文默认，不依赖路由器）；
2. **主机、从机都 STA 连同一个路由器**（§3.4，依赖路由器）。

---

## 附录 B：与现有文档的差异

| 文档 | 现有描述 | 本任务后的实际情况 |
|------|----------|--------------------|
| `README.md` | 主机 GPIO32/33 ↔ 从机 GPIO32/33 UART | 改为 Wi-Fi TCP；UART 代码仅作历史/备用（已完成） |
| 《开发方案.md》§2.4 | 物理层 UART 115200 | 改为 Wi-Fi TCP，应用层协议不变（已完成） |
| 《项目进度总结.md》§一 | 架构图写 UART2 | 已同步更新为 Wi-Fi（已完成） |
| `slave_firmware.ino` | 双串口 | 改为 USB 串口 + TCP |

# Tasks

> 实现约束：
> - 主机 `src/main.cpp` 使用 ArduinoJson **v6**（`StaticJsonDocument`），不要用 v7 的 `JsonDocument`；从机 `slave_firmware.ino` 使用 **v7**。
> - 主机主循环中不得加入阻塞式等待；从机网络发送不得阻塞执行器定时。
> - 不改变泵/阀 GPIO（25/26/27）与现有网页 WebSocket 消息字段。
> - 具体代码骨架参考 `docs/主从WiFi通信开发文档.md`。
>
> 说明：Task 6 的 T1–T8 为硬件台架测试，需要在两块实机上执行，当前仅完成编译验证，实测项保持未勾选。

- [x] Task 1: 主机网络层：APSTA + TCP Server + 单客户端链路
  - [x] SubTask 1.1: 新增不入库的凭据头文件（AP SSID/密码、link key）与示例文件，并把真实文件加入 `.gitignore`
  - [x] SubTask 1.2: 新增 `ensureSlaveAP()`，统一设置 `WIFI_AP_STA`、`softAP(NanoStatAP, 密码, 0, 0, 4)`、启动 3333 TCP Server；在 `setup()` 中无论 STA 是否成功都调用
  - [x] SubTask 1.3: 用 `WiFiServer` / `WiFiClient` 替换 `Serial2` 收发；只保留一个客户端，第二个连接立即关闭；按行接收，单行上限 512 B
  - [x] SubTask 1.4: 解析 `hello` 并校验 key；成功后置在线、刷新最后消息时间，并下发 `status` 请求对账；失败立即断开
  - [x] SubTask 1.5: 链路在线时每 5 s 发 `ping`（IDLE 也发）；socket 断开或 20 s 无消息标记离线并打印日志
  - [ ] 验证: `pio run -e pico32` 编译通过（已完成，RAM 30.5% / Flash 75.3%）；PC 用 TCP 工具完成 hello/ping/status、错误 key、第二客户端测试（待台架）

- [x] Task 2: 从机网络层：STA + TCP Client + 双通道
  - [x] SubTask 2.1: 新增 `slave/wifi_secrets.h`（SSID/密码/link key）并加入 `.gitignore`；`wifiSetup()` 设置 `WIFI_STA`、`WiFi.setSleep(false)`、`setAutoReconnect(true)`
  - [x] SubTask 2.2: 新增非阻塞 TCP 重连状态机，退避 1/2/5/10/30 s，连上后发送 `hello`
  - [x] SubTask 2.3: 将 `sendLine()`、`replyOk()`、`replyErr()`、`handleCommand()` 的串口参数改为 `Print&`，同时服务 USB 串口与 `WiFiClient`，响应回到发起命令的通道
  - [x] SubTask 2.4: 网络上报前检查 `availableForWrite()`；缓冲不足时丢弃本次 `hb`，不得阻塞主循环
  - [ ] 验证: 从机固件在临时 PlatformIO 工程中编译通过（已完成，RAM 13.7% / Flash 58.3%）；从机能连主机并发送 hello、不接主机时 USB 串口命令仍可用（待台架）

- [x] Task 3: 执行器安全与现有缺陷修复
  - [x] SubTask 3.1: 主机 `expPumpRun()` 的循环泵命令由 `ms=0` 改为 `circulate_ms + 60000`
  - [x] SubTask 3.2: 从机 `pump` 命令拒绝 `ms<=0`，保留 1 h 上限，返回 `E_PARAM`
  - [x] SubTask 3.3: 修复心跳超时后重复上报 `fault`：在 `enterSafe()` 中重新武装 `g_lastCmdMs`，或增加“已上报”标志
  - [x] SubTask 3.4: 确认泵/阀本地定时在链路断开时继续生效，阀 30 s 上限不变
  - [ ] 验证: 串口/TCP 发 `ms=0` 被拒；拔掉主机后泵在“循环时长 + 60 s”内停、阀 ≤ 30 s 关；心跳超时只出现一次 fault（待台架）

- [x] Task 4: 网页链路状态与启动保护
  - [x] SubTask 4.1: 主机通过现有 WebSocket 广播 `slave_link`（在线/离线，可选 RSSI/IP）
  - [x] SubTask 4.2: `data/panel.html` 与 `data/websckt_ctl_pan_LMP91000.js` 增加从机链路状态显示
  - [x] SubTask 4.3: `expStart()` 在从机离线时拒绝启动，并给网页返回明确提示
  - [ ] 验证: 连接/断开从机，网页状态 1 s 内更新；离线点击启动被拒绝且提示正确；原有实验状态/泵阀显示不回退（待台架/浏览器实测）

- [x] Task 5: 文档与仓库配置同步
  - [x] SubTask 5.1: 更新 `README.md`，删除不可实施的 UART 接线，改为 Wi-Fi 拓扑说明
  - [x] SubTask 5.2: 更新 `docs/开发方案.md` §2.4、`docs/软件需求说明书.md` 心跳/接口相关描述
  - [x] SubTask 5.3: 更新 `docs/项目进度总结.md` 的架构图与双板联调状态
  - [x] SubTask 5.4: 确认 `.gitignore` 覆盖 AP 密码、从机 Wi-Fi 凭据、link key
  - [x] 验证: 全仓库搜索不到真实密码/key；文档描述与实现一致

- [ ] Task 6: 台架验证与记录（需要两块实机，当前未执行）
  - [ ] SubTask 6.1: T1/T2 链路测试：PC 模拟客户端、从机自动入网、单客户端限制
  - [ ] SubTask 6.2: T3 命令一致性：TCP 与 USB 的 `ping/pump/valve/stop_all/status/clear` 结果一致
  - [ ] SubTask 6.3: T4/T5 断线与换信道：拔主机、AP 重启、主机 STA 切信道，确认安全停泵与 15 s 内重连
  - [ ] SubTask 6.4: T6 24 h 连续运行：1 条命令/秒 + 每 5 s 状态轮询，记录复位、堆内存、成功率
  - [ ] SubTask 6.5: T7 EMI 五组对比（从机断电/仅 USB/Wi-Fi 空闲/Wi-Fi 压力/泵运行），记录基线均值、标准差、漂移
  - [ ] SubTask 6.6: T8 网页回归：AP 与路由器两种访问方式下，面板、WebSocket、实验流程正常
  - [ ] 验证: 形成测试记录；24 h 命令成功率 ≥ 99.9%，重连 < 15 s，EMI 无可辨识恶化

- [x] Task 7: 验证阶段发现的两处链路状态残留修复
  - [x] SubTask 7.1: 网页 WebSocket 断开时把 `slave_link_id` 复位为“从机离线”、清空 `exp_msg_id` 提示，避免断线期间显示过期的“从机在线”
  - [x] SubTask 7.2: 从机 TCP 断开后清空 `g_rxLineTcp` 半行缓冲，避免重连后残留半行 JSON 触发一次 `E_BAD_CMD`
  - [x] 验证: 从机重编译通过（RAM 13.7% / Flash 58.3%）；网页断线重连后状态与实际一致（静态复核通过，实机复测并入 Task 6）

- [x] Task 8: 凭据不再硬编码兜底
  - [x] SubTask 8.1: 主机 `src/main.cpp` 删除 `AP_PASSWORD` / `SLAVE_LINK_KEY` 的默认字符串，未定义时用 `#error` 提示复制 `wifi_credentials.example.h`
  - [x] SubTask 8.2: 从机 `slave_firmware.ino` 删除 `SLAVE_WIFI_SSID` / `SLAVE_WIFI_PASS` / `SLAVE_LINK_KEY` 的 `#else` 默认值，缺少 `wifi_secrets.h` 时 `#error`
  - [x] SubTask 8.3: 修正 `slave/wifi_secrets.example.h` 中过时的复制路径说明（`slave/slave_firmware/wifi_secrets.h`）
  - [x] 验证: `src/` 与 `slave/` 内已无可用的默认密钥；缺凭据时报中文 `#error`；提供凭据头文件后主机 `pico32` 与从机 `esp32dev` 均编译通过

# Task Dependencies

- Task 2 依赖 Task 1.1、Task 1.2（主机 AP 必须先可连）
- Task 3 依赖 Task 1、Task 2（链路打通后再验证安全行为）
- Task 4 依赖 Task 1.4、Task 1.5（需要 `slave_link` 在线状态）
- Task 5 可与 Task 1–4 并行，但需在 Task 6 前完成
- Task 6 依赖 Task 1–8 全部完成

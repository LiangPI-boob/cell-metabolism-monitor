/* =================================================================
 *  细胞代谢监测系统 —— 从机固件 v1.2（流体控制板）
 * -----------------------------------------------------------------
 *  硬件：ESP32 DevKit + 3× MOS 驱动模块（高电平触发）
 *  通道：泵0(循环泵) = GPIO25
 *        阀0(切换阀) = GPIO26
 *        阀1(排废阀) = GPIO27
 *
 *  通信：
 *    - USB 串口（Serial）  → 接电脑，用于调试 / 脱机自测
 *    - Wi-Fi TCP Client    → 连接主机 SoftAP（NanoStatAP，192.168.4.1:3333）
 *    - 硬件串口（Serial2） → 台架调试备用，GPIO32 RX / GPIO33 TX
 *    各通道都能收命令，响应回到"发命令的那个通道"。
 *
 *  依赖：ArduinoJson（库管理器搜索安装，v7）
 * ================================================================= */

#include <ArduinoJson.h>
#include <WiFi.h>

/* ---------------- 凭据 ---------------- */
// 凭据来自不入库的 wifi_secrets.h（由 wifi_secrets.example.h 复制）。
#if __has_include("wifi_secrets.h")
#include "wifi_secrets.h"
#else
#error "缺少 wifi_secrets.h：请复制 slave/slave_firmware/wifi_secrets.example.h 为同目录下的 wifi_secrets.h 并填写"
#endif

/* ---------------- 引脚配置 ---------------- */
#define PIN_PUMP0   25
#define PIN_VALVE0  26   // 切换阀
#define PIN_VALVE1  27   // 排废阀

#define PIN_MASTER_RX 32 // 台架备用串口 RX
#define PIN_MASTER_TX 33 // 台架备用串口 TX

/* ---------------- 参数 ---------------- */
#define SERIAL_BAUD          115200
#define HEARTBEAT_TIMEOUT_MS 120000UL    // 120 秒没收到命令 → 进安全态
                                         // （主机静测时会静默约 60s，留足余量）
#define VALVE_MAX_ON_MS      30000UL     // 阀最长通电 30 秒（防线圈过热）
#define PUMP_MAX_MS          3600000UL   // 泵单次最长 1 小时
#define HB_REPORT_MS         5000UL      // 心跳上报间隔
#define FW_VERSION           "slave-1.2"

#define TCP_PORT             3333
IPAddress MASTER_IP(192, 168, 4, 1);     // 主机 SoftAP 地址

/* ---------------- 系统状态 ---------------- */
enum SystemState { ST_BOOT, ST_IDLE, ST_RUNNING, ST_FAULT };
SystemState g_state = ST_BOOT;

/* ---------------- 执行器 ---------------- */
struct Pump {
  uint8_t  pin;
  bool     on;
  uint8_t  speed;
  uint32_t startMs;
  uint32_t durationMs;   // 0 = 常开
};

struct Valve {
  uint8_t  pin;
  bool     open;
  uint32_t openStartMs;
};

Pump  g_pump      = { PIN_PUMP0, false, 0, 0, 0 };
Valve g_valves[2] = { { PIN_VALVE0, false, 0 },
                      { PIN_VALVE1, false, 0 } };

const uint8_t PUMP_COUNT  = 1;
const uint8_t VALVE_COUNT = 2;

/* ---------------- 运行时 ---------------- */
uint32_t g_lastCmdMs = 0;
uint32_t g_lastHbMs  = 0;
bool     g_safeLatched = false;   // 心跳超时故障只上报一次

String g_rxLineUsb    = "";   // USB 口收的行
String g_rxLineMaster = "";   // Serial2 收的行
String g_rxLineTcp    = "";   // TCP 收的行

WiFiClient g_client;

// TCP 重连退避：1/2/5/10/30 秒
const uint32_t RETRY_DELAY_MS[] = { 1000UL, 2000UL, 5000UL, 10000UL, 30000UL };
const uint8_t  RETRY_DELAY_COUNT = sizeof(RETRY_DELAY_MS) / sizeof(RETRY_DELAY_MS[0]);
uint8_t  g_retryIdx    = 0;
uint32_t g_nextRetryMs = 0;
bool     g_tcpWasConnected = false;   // 记录 TCP 是否曾经连上，用于检测断开瞬间

/* =================================================================
 *  工具
 * ================================================================= */
static const char* stateName(SystemState s) {
  switch (s) {
    case ST_BOOT:    return "BOOT";
    case ST_IDLE:    return "IDLE";
    case ST_RUNNING: return "RUNNING";
    default:         return "FAULT";
  }
}

void sendLine(JsonDocument& doc, Print& out) {
  serializeJson(doc, out);
  out.println();
}

void replyOk(long id, Print& out) {
  JsonDocument d;
  d["id"] = id;
  d["ok"] = true;
  sendLine(d, out);
}

void replyErr(long id, const char* code, const char* msg, Print& out) {
  JsonDocument d;
  d["id"]  = id;
  d["ok"]  = false;
  d["err"] = code;
  if (msg) d["msg"] = msg;
  sendLine(d, out);
}

// TCP 发送缓冲足够才写，避免阻塞执行器定时
bool tcpCanWrite(int needBytes) {
  return g_client.connected() && g_client.availableForWrite() >= needBytes;
}

// 故障事件同时上报 USB、Serial2、TCP
void sendEventFault(const char* code) {
  JsonDocument d;
  d["evt"]  = "fault";
  d["code"] = code;
  sendLine(d, Serial);
  sendLine(d, Serial2);
  if (tcpCanWrite(64)) sendLine(d, g_client);
}

/* =================================================================
 *  Wi-Fi TCP 客户端
 * ================================================================= */
void wifiSetup() {
  WiFi.mode(WIFI_STA);
  WiFi.setSleep(false);
  WiFi.setAutoReconnect(true);
  WiFi.begin(SLAVE_WIFI_SSID, SLAVE_WIFI_PASS);
}

void sendHello() {
  JsonDocument d;
  d["evt"] = "hello";
  d["fw"]  = FW_VERSION;
  d["key"] = SLAVE_LINK_KEY;
  JsonObject ch = d["channels"].to<JsonObject>();
  ch["pump"]  = PUMP_COUNT;
  ch["valve"] = VALVE_COUNT;
  sendLine(d, g_client);
}

// 非阻塞重连状态机，每圈 loop 调用
void wifiTick() {
  if (WiFi.status() != WL_CONNECTED) {
    g_retryIdx = 0;   // 依赖 WiFi 自动重连，重连后从最短退避开始
    return;
  }
  if (g_client.connected()) {
    g_tcpWasConnected = true;
    return;
  }
  if (g_tcpWasConnected) {
    // 刚断开：丢弃半行缓冲，避免重连后新旧数据拼接导致解析失败
    g_tcpWasConnected = false;
    g_rxLineTcp = "";
  }
  if ((int32_t)(millis() - g_nextRetryMs) < 0) return;   // 未到重试时间

  if (g_client.connect(MASTER_IP, TCP_PORT, 500)) {
    g_client.setNoDelay(true);
    g_tcpWasConnected = true;
    g_retryIdx    = 0;
    g_nextRetryMs = 0;
    sendHello();
    g_lastCmdMs = millis();   // 建链当作一次握手，避免立刻超时
  } else {
    g_nextRetryMs = millis() + RETRY_DELAY_MS[g_retryIdx];
    if (g_retryIdx + 1 < RETRY_DELAY_COUNT) g_retryIdx++;
  }
}

/* =================================================================
 *  执行器控制
 * ================================================================= */
void pumpStop() {
  analogWrite(g_pump.pin, 0);
  g_pump.on = false;
  g_pump.durationMs = 0;
}

void pumpStart(uint8_t speedPct, uint32_t ms) {
  if (speedPct > 100) speedPct = 100;
  g_pump.speed = speedPct;
  g_pump.durationMs = ms;
  g_pump.startMs = millis();
  g_pump.on = true;
  analogWrite(g_pump.pin, (uint16_t)speedPct * 255 / 100);
}

void valveSet(uint8_t idx, bool open) {
  if (idx >= VALVE_COUNT) return;
  digitalWrite(g_valves[idx].pin, open ? HIGH : LOW);
  g_valves[idx].open = open;
  g_valves[idx].openStartMs = millis();
}

void stopAll() {
  pumpStop();
  for (uint8_t i = 0; i < VALVE_COUNT; i++) valveSet(i, false);
}

// 进入安全态（心跳超时）：停泵关阀，但状态回 IDLE，
// 这样主机恢复发命令时能立刻继续工作，不需要 clear。
void enterSafe(const char* code) {
  stopAll();
  g_state = ST_IDLE;
  g_safeLatched = true;     // 一次超时只报一次故障
  sendEventFault(code);
}

/* =================================================================
 *  命令处理
 * ================================================================= */
void handleCommand(JsonDocument& doc, Print& out) {
  g_lastCmdMs = millis();   // 收到任何命令都算心跳
  g_safeLatched = false;    // 收到新命令后允许再次上报超时故障

  const char* cmd = doc["cmd"];
  if (!cmd) return;

  long id = doc["id"] | 0;

  if (strcmp(cmd, "ping") == 0) { replyOk(id, out); return; }

  if (strcmp(cmd, "stop_all") == 0) {
    stopAll(); g_state = ST_IDLE; replyOk(id, out); return;
  }

  if (strcmp(cmd, "clear") == 0) {
    g_state = ST_IDLE; replyOk(id, out); return;
  }

  if (strcmp(cmd, "status") == 0) {
    JsonDocument d;
    d["id"]    = id;
    d["ok"]    = true;
    d["state"] = stateName(g_state);
    d["uptime_ms"] = millis();

    JsonObject p = d["pump0"].to<JsonObject>();
    p["on"]    = g_pump.on;
    p["speed"] = g_pump.speed;

    JsonArray vs = d["valves"].to<JsonArray>();
    for (uint8_t i = 0; i < VALVE_COUNT; i++) {
      JsonObject v = vs.add<JsonObject>();
      v["ch"]   = i;
      v["open"] = g_valves[i].open;
    }
    sendLine(d, out);
    return;
  }

  if (strcmp(cmd, "pump") == 0) {
    int ch = doc["ch"] | -1;
    if (ch < 0 || ch >= PUMP_COUNT) { replyErr(id, "E_PARAM", "invalid pump ch", out); return; }
    int speed = doc["speed"] | 100;
    if (speed < 0 || speed > 100) { replyErr(id, "E_PARAM", "speed range", out); return; }
    long ms = doc["ms"] | 1000;
    if (ms <= 0 || (uint32_t)ms > PUMP_MAX_MS) { replyErr(id, "E_PARAM", "ms range", out); return; }
    pumpStart((uint8_t)speed, (uint32_t)ms);
    g_state = ST_RUNNING;
    replyOk(id, out);
    return;
  }

  if (strcmp(cmd, "valve") == 0) {
    int ch = doc["ch"] | -1;
    if (ch < 0 || ch >= VALVE_COUNT) { replyErr(id, "E_PARAM", "invalid valve ch", out); return; }
    const char* st = doc["state"];
    if (!st) { replyErr(id, "E_PARAM", "missing state", out); return; }
    bool open;
    if      (strcmp(st, "open") == 0)  open = true;
    else if (strcmp(st, "close") == 0) open = false;
    else { replyErr(id, "E_PARAM", "state open/close", out); return; }
    valveSet((uint8_t)ch, open);
    replyOk(id, out);
    return;
  }

  replyErr(id, "E_BAD_CMD", cmd, out);
}

/* 处理某个通道收到的一整行，响应回到该通道 */
void processLine(String& line, Print& out) {
  line.trim();
  if (line.length() == 0) return;

  JsonDocument doc;
  DeserializationError err = deserializeJson(doc, line);
  if (err) {
    JsonDocument d;
    d["ok"]  = false;
    d["err"] = "E_BAD_CMD";
    sendLine(d, out);
  } else {
    handleCommand(doc, out);
  }
  line = "";
}

/* 从任意 Stream 读数据，按行切分 */
void pumpStream(Stream& in, Print& out, String& buf) {
  while (in.available()) {
    int v = in.read();
    if (v < 0) break;
    char c = (char)v;
    if (c == '\n') {
      processLine(buf, out);
    } else if (c != '\r') {
      if (buf.length() < 512) buf += c;
    }
  }
}

/* =================================================================
 *  setup / loop
 * ================================================================= */
void setup() {
  Serial.begin(SERIAL_BAUD);                                   // USB 调试口
  Serial2.begin(SERIAL_BAUD, SERIAL_8N1, PIN_MASTER_RX, PIN_MASTER_TX); // 台架备用
  wifiSetup();                                                 // STA 连接主机 AP

  pinMode(PIN_PUMP0,  OUTPUT);
  pinMode(PIN_VALVE0, OUTPUT);
  pinMode(PIN_VALVE1, OUTPUT);
  stopAll();

  g_lastCmdMs = millis();
  g_lastHbMs  = millis();

  JsonDocument d;
  d["evt"] = "boot";
  d["fw"]  = FW_VERSION;
  JsonObject ch = d["channels"].to<JsonObject>();
  ch["pump"]  = PUMP_COUNT;
  ch["valve"] = VALVE_COUNT;
  sendLine(d, Serial);
  sendLine(d, Serial2);

  g_state = ST_IDLE;
}

void loop() {
  /* 0. Wi-Fi / TCP 重连（非阻塞） */
  wifiTick();

  /* 1. 三个通道都收，响应回到各自通道 */
  pumpStream(Serial, Serial, g_rxLineUsb);
  pumpStream(Serial2, Serial2, g_rxLineMaster);
  if (g_client.connected()) pumpStream(g_client, g_client, g_rxLineTcp);

  uint32_t now = millis();

  /* 2. 泵定时停止（断链不影响，按 ms 继续） */
  if (g_pump.on && g_pump.durationMs > 0) {
    if (now - g_pump.startMs >= g_pump.durationMs) pumpStop();
  }

  /* 3. 阀超时保护 */
  for (uint8_t i = 0; i < VALVE_COUNT; i++) {
    if (g_valves[i].open && (now - g_valves[i].openStartMs >= VALVE_MAX_ON_MS)) {
      valveSet(i, false);
    }
  }

  /* 4. 动作做完回空闲 */
  if (g_state == ST_RUNNING && !g_pump.on) {
    bool anyOpen = false;
    for (uint8_t i = 0; i < VALVE_COUNT; i++) if (g_valves[i].open) anyOpen = true;
    if (!anyOpen) g_state = ST_IDLE;
  }

  /* 5. 心跳超时 → 安全态（一次超时只报一次） */
  if (!g_safeLatched && (now - g_lastCmdMs > HEARTBEAT_TIMEOUT_MS)) {
    enterSafe("E_NO_HEARTBEAT");
  }

  /* 6. 周期心跳上报 */
  if (now - g_lastHbMs >= HB_REPORT_MS) {
    g_lastHbMs = now;
    JsonDocument d;
    d["evt"]       = "hb";
    d["state"]     = stateName(g_state);
    d["uptime_ms"] = now;
    sendLine(d, Serial);
    sendLine(d, Serial2);
    // TCP 缓冲不足则跳过本次 hb，避免阻塞
    if (tcpCanWrite(128)) sendLine(d, g_client);
  }
}

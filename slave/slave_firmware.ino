/* =================================================================
 *  细胞代谢监测系统 —— 从机固件 v1.1（流体控制板）
 * -----------------------------------------------------------------
 *  硬件：ESP32 DevKit + 3× MOS 驱动模块（高电平触发）
 *  通道：泵0(循环泵) = GPIO25
 *        阀0(切换阀) = GPIO26
 *        阀1(排废阀) = GPIO27
 *
 *  通信：
 *    - USB 串口（Serial）  → 接电脑，用于调试 / 脱机自测
 *    - 硬件串口（Serial2） → 接主机 NanoStat
 *        RX = GPIO32   ← 主机 TX(GPIO33)
 *        TX = GPIO33   → 主机 RX(GPIO32)
 *    两个口都能收命令，响应回到"发命令的那个口"。
 *
 *  依赖：ArduinoJson（库管理器搜索安装，v6 / v7 均可）
 * ================================================================= */

#include <ArduinoJson.h>

/* ---------------- 引脚配置 ---------------- */
#define PIN_PUMP0   25
#define PIN_VALVE0  26   // 切换阀
#define PIN_VALVE1  27   // 排废阀

#define PIN_MASTER_RX 32 // 接主机 TX
#define PIN_MASTER_TX 33 // 接主机 RX

/* ---------------- 参数 ---------------- */
#define SERIAL_BAUD          115200
#define HEARTBEAT_TIMEOUT_MS 120000UL    // 120 秒没收到命令 → 进安全态
                                         // （主机静测时会静默约 60s，留足余量）
#define VALVE_MAX_ON_MS      30000UL     // 阀最长通电 30 秒（防线圈过热）
#define PUMP_MAX_MS          3600000UL   // 泵单次最长 1 小时
#define HB_REPORT_MS         5000UL      // 心跳上报间隔
#define FW_VERSION           "slave-1.1"

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

String g_rxLineUsb    = "";   // USB 口收的行
String g_rxLineMaster = "";   // 主机口收的行

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

void sendLine(JsonDocument& doc, HardwareSerial& out) {
  serializeJson(doc, out);
  out.println();
}

void replyOk(long id, HardwareSerial& out) {
  JsonDocument d;
  d["id"] = id;
  d["ok"] = true;
  sendLine(d, out);
}

void replyErr(long id, const char* code, const char* msg, HardwareSerial& out) {
  JsonDocument d;
  d["id"]  = id;
  d["ok"]  = false;
  d["err"] = code;
  if (msg) d["msg"] = msg;
  sendLine(d, out);
}

// 故障事件同时上报两个口
void sendEventFault(const char* code) {
  JsonDocument d;
  d["evt"]  = "fault";
  d["code"] = code;
  sendLine(d, Serial);
  sendLine(d, Serial2);
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
  sendEventFault(code);
}

/* =================================================================
 *  命令处理
 * ================================================================= */
void handleCommand(JsonDocument& doc, HardwareSerial& out) {
  g_lastCmdMs = millis();   // 收到任何命令都算心跳

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
    if (ms < 0 || (uint32_t)ms > PUMP_MAX_MS) { replyErr(id, "E_PARAM", "ms range", out); return; }
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

/* 处理一个串口收到的完整行 */
void processLine(String& line, HardwareSerial& out) {
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

/* 从某个串口读数据，按行切分 */
void pumpSerial(HardwareSerial& port, String& buf) {
  while (port.available()) {
    char c = (char)port.read();
    if (c == '\n') {
      processLine(buf, port);
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
  Serial2.begin(SERIAL_BAUD, SERIAL_8N1, PIN_MASTER_RX, PIN_MASTER_TX); // 接主机
  delay(300);

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
  uint32_t now = millis();

  /* 1. 两个口都收 */
  pumpSerial(Serial,  g_rxLineUsb);
  pumpSerial(Serial2, g_rxLineMaster);

  /* 2. 泵定时停止 */
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

  /* 5. 心跳超时 → 安全态（但不锁死，可直接恢复） */
  if (g_state != ST_FAULT && (now - g_lastCmdMs > HEARTBEAT_TIMEOUT_MS)) {
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
  }
}

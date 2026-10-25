#ifndef SLAVE_WIFI_SECRETS_H
#define SLAVE_WIFI_SECRETS_H

/* Wi-Fi / 链路凭据示例
 * 复制本文件为 slave/slave_firmware/wifi_secrets.h 后填写真实值；
 * wifi_secrets.h 已在 .gitignore 中（由主机任务添加），不会提交到仓库。
 * 没有 wifi_secrets.h 时固件无法编译（会给出 #error 提示）。
 */
#define SLAVE_WIFI_SSID "NanoStatAP"
#define SLAVE_WIFI_PASS "your_ap_password"
#define SLAVE_LINK_KEY  "your_link_key"

#endif

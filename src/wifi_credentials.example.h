// 复制本文件为 wifi_credentials.h，再填入你的配置。
// wifi_credentials.h 已在 .gitignore 中忽略，不会上传到仓库。
//
// SSID / PASSWORD 目前不参与连接流程：路由器凭据在网页「系统 → WiFi」里填写，
// 保存到设备 /credentials.JSON（最多 3 组，开机按顺序尝试），这里保留占位即可。
char SSID[] = "your_wifi_ssid";
char PASSWORD[] = "your_wifi_password";

// 主机 SoftAP（NanoStatAP）密码：至少 8 位，从机用同一个密码连接。
#define AP_PASSWORD "your_ap_password"

// 从机链路握手密钥：必须与从机 wifi_secrets.h 中的 SLAVE_LINK_KEY 完全一致。
#define SLAVE_LINK_KEY "your_slave_link_key"

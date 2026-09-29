# Twitter 热点自动化监控方案 - CryptoPathX

**版本：** v1.0  
**创建日期：** 2026-04-05  
**负责人：** 二牛  
**原则：** 100% 免费 + 全自动化 + 实时推送

---

## 一、整体架构

```
┌─────────────────┐     ┌─────────────────┐     ┌─────────────────┐
│  数据源层       │     │  监控处理层     │     │  推送通知层     │
├─────────────────┤     ├─────────────────┤     ├─────────────────┤
│ Binance API     │────▶│  Python 脚本     │────▶│  飞书 webhook   │
│ (价格/涨跌幅)   │     │  (每 5 分钟轮询)  │     │  (实时推送)     │
├─────────────────┤     ├─────────────────┤     ├─────────────────┤
│ 律动 RSS        │────▶│  Python 脚本     │────▶│  飞书 webhook   │
│ (行业新闻)      │     │  (每 10 分钟抓取) │     │  (实时推送)     │
├─────────────────┤     ├─────────────────┤     ├─────────────────┤
│ Twitter API     │────▶│  Python 脚本     │────▶│  飞书 webhook   │
│ (KOL 推文)      │     │  (每 15 分钟抓取) │     │  (实时推送)     │
└─────────────────┘     └─────────────────┘     └─────────────────┘
                              │
                              ▼
                     ┌─────────────────┐
                     │  热点追踪表     │
                     │  (Excel/飞书)   │
                     └─────────────────┘
```

---

## 二、监控方案详情

### 2.1 价格异动监控（Binance API）

**监控目标：**
- BTC/USDT 涨跌幅>5%
- ETH/USDT 涨跌幅>8%
- 其他主流币涨跌幅>10%
- 全网爆仓量>5000 万 USD

**实现方式：** Python 脚本 + Binance 公开 API + 飞书 webhook

**脚本位置：** `C:\Users\your_user\.openclaw\workspace-erniu\scripts\binance_monitor.py`

**运行频率：** 每 5 分钟

**推送条件：** 触发阈值时立即推送

---

### 2.2 新闻聚合监控（律动 RSS）

**监控目标：**
- 律动快讯（7x24 小时滚动）
- 关键词：量化、回测、策略、工具、API、TradingView

**实现方式：** Python 脚本 + RSS 解析 + 飞书 webhook

**脚本位置：** `C:\Users\your_user\.openclaw\workspace-erniu\scripts\news_monitor.py`

**运行频率：** 每 10 分钟

**推送条件：** 匹配关键词时推送

---

### 2.3 Twitter KOL 监控（可选）

**监控目标：**
- 20-30 个量化/KOL 账号
- 推文互动量>1000（平时 100 左右）

**实现方式：** 
- 方案 A：Twitter API 免费版（限制较多）
- 方案 B：RSS 桥接（如 rss.app 免费版）
- 方案 C：人工监控（Lulu 每日 3 次）

**推荐：** 先用方案 C（人工），如效果好看是否升级

---

## 三、自动化脚本

### 3.1 Binance 价格监控脚本

**文件：** `scripts/binance_monitor.py`

**依赖：**
```bash
pip install requests
```

**代码：**
```python
#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
Binance 价格异动监控脚本
监控 BTC/ETH 等主流币价格变化，超过阈值时推送至飞书
"""

import requests
import json
import time
from datetime import datetime

# ========== 配置区 ==========
# 飞书 webhook 地址（替换成你自己的）
FEISHU_WEBHOOK = "https://open.feishu.cn/open-apis/bot/v2/hook/your_webhook_token_WEBHOOK_KEY"

# 监控币种及阈值
MONITOR_SYMBOLS = {
    "BTCUSDT": 5.0,   # BTC 涨跌幅>5% 推送
    "ETHUSDT": 8.0,   # ETH 涨跌幅>8% 推送
    "BNBUSDT": 10.0,  # BNB 涨跌幅>10% 推送
}

# 上次推送记录（避免重复推送）
LAST_PUSH = {}
# ========== 配置区 ==========


def get_ticker_24h(symbol):
    """获取 24 小时行情"""
    url = "https://api.binance.com/api/v3/ticker/24hr"
    params = {"symbol": symbol}
    try:
        resp = requests.get(url, params=params, timeout=5)
        data = resp.json()
        return {
            "symbol": data["symbol"],
            "price": float(data["lastPrice"]),
            "change": float(data["priceChangePercent"]),
            "high": float(data["highPrice"]),
            "low": float(data["lowPrice"]),
            "volume": float(data["volume"]),
        }
    except Exception as e:
        print(f"获取行情失败：{e}")
        return None


def send_feishu_message(title, content, color="blue"):
    """发送飞书消息"""
    headers = {"Content-Type": "application/json"}
    payload = {
        "msg_type": "interactive",
        "card": {
            "header": {
                "title": {"tag": "plain_text", "content": title},
                "template": color
            },
            "elements": [
                {
                    "tag": "markdown",
                    "content": content
                }
            ]
        }
    }
    try:
        resp = requests.post(FEISHU_WEBHOOK, json=payload, headers=headers, timeout=5)
        if resp.status_code == 200:
            print(f"推送成功：{title}")
            return True
        else:
            print(f"推送失败：{resp.status_code}")
            return False
    except Exception as e:
        print(f"推送异常：{e}")
        return False


def check_price_change():
    """检查价格变化"""
    alerts = []
    
    for symbol, threshold in MONITOR_SYMBOLS.items():
        ticker = get_ticker_24h(symbol)
        if not ticker:
            continue
        
        change = ticker["change"]
        abs_change = abs(change)
        
        # 超过阈值且距离上次推送超过 1 小时
        if abs_change >= threshold:
            last_push_time = LAST_PUSH.get(symbol, 0)
            if time.time() - last_push_time > 3600:  # 1 小时内不重复推送
                color = "red" if change < 0 else "green"
                direction = "📉" if change < 0 else "📈"
                
                title = f"{direction} {symbol[:-4]} 价格异动预警"
                content = f"""**{symbol[:-4]} 24 小时涨跌幅超 {threshold}%**

当前价格：${ticker["price"]:,.2f}
涨跌幅：{change:+.2f}%
24h 最高：${ticker["high"]:,.2f}
24h 最低：${ticker["low"]:,.2f}
24h 成交量：{ticker["volume"]:,.0f} {symbol[:-4]}

时间：{datetime.now().strftime("%Y-%m-%d %H:%M:%S")}"""
                
                alerts.append((title, content, color))
                LAST_PUSH[symbol] = time.time()
    
    return alerts


def main():
    """主函数"""
    print(f"[{datetime.now()}] 启动 Binance 价格监控...")
    
    while True:
        try:
            alerts = check_price_change()
            for title, content, color in alerts:
                send_feishu_message(title, content, color)
            
            if not alerts:
                print(f"[{datetime.now()}] 无价格异动，继续监控...")
            
            time.sleep(300)  # 每 5 分钟检查一次
        except KeyboardInterrupt:
            print("监控已停止")
            break
        except Exception as e:
            print(f"监控异常：{e}")
            time.sleep(60)  # 异常后等待 1 分钟


if __name__ == "__main__":
    main()
```

---

### 3.2 律动新闻监控脚本

**文件：** `scripts/news_monitor.py`

**依赖：**
```bash
pip install feedparser
```

**代码：**
```python
#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
律动新闻监控脚本
监控律动 RSS，匹配关键词时推送至飞书
"""

import feedparser
import requests
import time
from datetime import datetime

# ========== 配置区 ==========
# 飞书 webhook 地址（替换成你自己的）
FEISHU_WEBHOOK = "https://open.feishu.cn/open-apis/bot/v2/hook/your_webhook_token_WEBHOOK_KEY"

# 律动 RSS 地址
RSS_URL = "https://www.theblockbeats.info/rss"

# 关键词过滤（匹配任意一个即推送）
KEYWORDS = [
    "量化",
    "回测",
    "策略",
    "工具",
    "API",
    "TradingView",
    "算法交易",
    "量化交易",
    "交易机器人",
    "backtest",
    "quantitative",
    "trading bot",
]

# 已推送文章记录（避免重复）
PUSHED_ARTICLES = set()
# ========== 配置区 ==========


def fetch_rss():
    """获取 RSS 内容"""
    try:
        feed = feedparser.parse(RSS_URL)
        entries = []
        for entry in feed.entries[:20]:  # 只取最新 20 条
            entries.append({
                "title": entry.title,
                "link": entry.link,
                "published": entry.published if hasattr(entry, "published") else "",
                "summary": entry.summary if hasattr(entry, "summary") else ""
            })
        return entries
    except Exception as e:
        print(f"获取 RSS 失败：{e}")
        return []


def match_keywords(text):
    """检查是否匹配关键词"""
    text_lower = text.lower()
    for keyword in KEYWORDS:
        if keyword.lower() in text_lower:
            return keyword
    return None


def send_feishu_message(title, content, link=""):
    """发送飞书消息"""
    headers = {"Content-Type": "application/json"}
    payload = {
        "msg_type": "interactive",
        "card": {
            "header": {
                "title": {"tag": "plain_text", "content": title},
                "template": "blue"
            },
            "elements": [
                {
                    "tag": "markdown",
                    "content": content
                },
                {
                    "tag": "action",
                    "actions": [
                        {
                            "tag": "button",
                            "text": {"tag": "plain_text", "content": "阅读原文"},
                            "url": link,
                            "type": "default"
                        }
                    ]
                }
            ]
        }
    }
    try:
        resp = requests.post(FEISHU_WEBHOOK, json=payload, headers=headers, timeout=5)
        if resp.status_code == 200:
            print(f"推送成功：{title}")
            return True
        else:
            print(f"推送失败：{resp.status_code}")
            return False
    except Exception as e:
        print(f"推送异常：{e}")
        return False


def check_news():
    """检查新闻"""
    alerts = []
    entries = fetch_rss()
    
    for entry in entries:
        # 避免重复推送
        if entry["link"] in PUSHED_ARTICLES:
            continue
        
        # 检查关键词
        matched_keyword = match_keywords(entry["title"] + " " + entry.get("summary", ""))
        if matched_keyword:
            PUSHED_ARTICLES.add(entry["link"])
            
            title = f"📰 匹配关键词：{matched_keyword}"
            content = f"""**{entry["title"]}**

时间：{entry["published"]}
来源：律动 BlockBeats
匹配关键词：{matched_keyword}"""
            
            alerts.append((title, content, entry["link"]))
    
    return alerts


def main():
    """主函数"""
    print(f"[{datetime.now()}] 启动律动新闻监控...")
    
    while True:
        try:
            alerts = check_news()
            for title, content, link in alerts:
                send_feishu_message(title, content, link)
            
            if not alerts:
                print(f"[{datetime.now()}] 无匹配新闻，继续监控...")
            
            time.sleep(600)  # 每 10 分钟检查一次
        except KeyboardInterrupt:
            print("监控已停止")
            break
        except Exception as e:
            print(f"监控异常：{e}")
            time.sleep(60)  # 异常后等待 1 分钟


if __name__ == "__main__":
    main()
```

---

## 四、部署指南

### 4.1 环境准备

**系统要求：** Windows 10+ / macOS / Linux

**步骤 1：安装 Python**
```bash
# Windows: 从 python.org 下载安装
# macOS: brew install python
# Linux: sudo apt install python3
```

**步骤 2：安装依赖**
```bash
pip install requests feedparser
```

**步骤 3：创建飞书 webhook**
1. 打开飞书 → 群聊 → 添加机器人
2. 选择"自定义机器人"
3. 复制 webhook 地址
4. 替换脚本中的 `FEISHU_WEBHOOK`

---

### 4.2 运行脚本

**方式 A：手动运行**
```bash
# 终端 1：运行价格监控
python scripts/binance_monitor.py

# 终端 2：运行新闻监控
python scripts/news_monitor.py
```

**方式 B：后台运行（Windows）**
```powershell
# 价格监控（后台）
Start-Process python -ArgumentList "scripts/binance_monitor.py" -WindowStyle Hidden

# 新闻监控（后台）
Start-Process python -ArgumentList "scripts/news_monitor.py" -WindowStyle Hidden
```

**方式 C：开机自启（Windows 任务计划程序）**
1. 打开"任务计划程序"
2. 创建基本任务 → "Binance 价格监控"
3. 触发器：开机时
4. 操作：启动程序 → `python.exe` → 参数 `scripts/binance_monitor.py`
5. 同样步骤创建"律动新闻监控"

---

### 4.3 推送效果示例

**价格异动推送：**
```
📈 BTC 价格异动预警

BTC 24 小时涨跌幅超 5%

当前价格：$67,234.50
涨跌幅：+6.23%
24h 最高：$67,500.00
24h 最低：$63,100.00
24h 成交量：23,456 BTC

时间：2026-04-05 19:30:00
```

**新闻匹配推送：**
```
📰 匹配关键词：量化

某知名机构推出加密货币量化基金

时间：2026-04-05 19:25:00
来源：律动 BlockBeats
匹配关键词：量化

[阅读原文按钮]
```

---

## 五、成本核算

| 项目 | 费用 |
|------|------|
| Python | 免费（开源） |
| Binance API | 免费（公开数据） |
| 律动 RSS | 免费（公开） |
| 飞书 webhook | 免费（基础版） |
| 服务器 | 免费（本地电脑运行） |
| **总计** | **¥0** |

---

## 六、维护说明

### 6.1 日常维护

**Lulu 每日检查：**
- [ ] 飞书群是否收到推送（早中晚各一次）
- [ ] 如无推送，检查脚本是否运行
- [ ] 记录推送内容到热点追踪表

**二牛每周检查：**
- [ ] 脚本运行日志
- [ ] 推送频率是否合理（太多/太少需调整阈值）
- [ ] 关键词是否需要优化

### 6.2 常见问题

**Q1：脚本运行后没有推送？**
- 检查飞书 webhook 地址是否正确
- 检查网络连接
- 查看脚本输出日志

**Q2：推送太频繁？**
- 调整阈值（如 BTC 从 5% 改为 8%）
- 增加重复推送间隔（脚本中 3600 秒改为 7200 秒）

**Q3：推送太少？**
- 降低阈值
- 增加监控币种
- 增加关键词

**Q4：脚本崩溃了？**
- 查看错误日志
- 重启脚本
- 如持续崩溃，联系二牛

---

## 七、后续优化（可选）

### 7.1 增加监控源

- Coinglass API（爆仓数据）
- Glassnode API（链上数据）
- Twitter API（KOL 推文）

### 7.2 增加推送渠道

- Telegram Bot
- 邮件通知
- 短信通知（付费）

### 7.3 增加数据分析

- 热点响应效果统计
- 推送转化率分析
- 自动推荐响应优先级

---

*此方案由二牛制定，Lulu 执行监控，二牛维护脚本。*

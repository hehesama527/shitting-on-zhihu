import urllib.request
import json
import time

payloads = [
    {
        "endpoint": "/api/detect-session-state",
        "name": "Session Detection (Active)",
        "data": {
            "url": "https://www.zhihu.com/question/123",
            "title": "测试知乎问题",
            "buttons": ["写回答", "关注问题"],
            "visibleTexts": ["写回答", "关注问题", "邀请回答", "二牛是个老实人"]
        }
    },
    {
        "endpoint": "/api/understand-publish-page",
        "name": "Page Understanding (Click Write Answer)",
        "data": {
            "url": "https://www.zhihu.com/question/123",
            "title": "测试知乎问题",
            "buttons": ["写回答", "关注问题"],
            "visibleTexts": ["写回答", "关注问题", "邀请回答"]
        }
    },
    {
        "endpoint": "/api/review-publish-result",
        "name": "Review Result (Success)",
        "data": {
            "currentUrl": "https://www.zhihu.com/question/123/answer/456",
            "title": "回答 - 知乎",
            "matchedSignals": ["关键句测试"],
            "editorStillVisible": False,
            "visibleTexts": ["发布成功", "分享到微信", "赞同 0"],
            "expectedExcerpt": "关键句测试"
        }
    }
]

print("=== Benchmarking Laya CPU on 223 Server ===")
for p in payloads:
    url = f"http://127.0.0.1:8105{p['endpoint']}"
    req = urllib.request.Request(
        url,
        data=json.dumps(p["data"]).encode("utf-8"),
        headers={"Content-Type": "application/json"}
    )
    t0 = time.time()
    with urllib.request.urlopen(req) as resp:
        res = json.loads(resp.read().decode("utf-8"))
        elapsed = (time.time() - t0) * 1000
    print(f"[{p['name']}]")
    print(f"  Result: {res}")
    print(f"  Latency: {elapsed:.2f} ms\n")

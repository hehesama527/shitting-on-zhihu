import urllib.request
import json

payload = {
    "url": "https://www.zhihu.com/question/2001668790279245831",
    "buttons": ["\u200b", "9消息", "35私信", "关注问题", "\u200b编辑回答", "显示全部 \u200b", "关注者449", "\u200b邀请回答"],
    "visibleTexts": ["初学者如何快速入门学会Claude Code ？"]
}

req = urllib.request.Request(
    "http://127.0.0.1:8105/api/understand-publish-page",
    data=json.dumps(payload).encode("utf-8"),
    headers={"Content-Type": "application/json"}
)

res = urllib.request.urlopen(req)
print("HTTP status:", res.status)
print("Response:", res.read().decode("utf-8"))

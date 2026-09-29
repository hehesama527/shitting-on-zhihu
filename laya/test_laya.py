import sys
import time
import laya
from laya import Router

# 设置输出编码，避免 Windows 控制台乱码
sys.stdout.reconfigure(encoding='utf-8')

print("=" * 65)
print("【1. 模型预加载测试 (Preload)】")
print("=" * 65)

load_start = time.time()
# 预加载，保证后续推理达到数十毫秒极速
router = Router(preload=True)
print(f"✓ Laya 模型预加载完成！耗时: {time.time() - load_start:.2f} 秒")

print("\n" + "=" * 65)
print("【2. 知乎发布页场景：智能意图与按钮决策】")
print("=" * 65)

state = {
    "user_intent": "我的知乎文章已经写完了，全部校对完毕，我现在需要把它正式公开发布出去，让读者可以看到。",
    "page_state": "当前处于知乎文章编辑界面，标题已填，正文已填，无错误提示。",
    "editor_buttons": "页面底部有四个功能按钮：[存为草稿]、[预览文章]、[确认发布]、[删除草稿]。"
}

questions = {
    "button_decision": {
        "type": "choice",
        "instructions": "根据 `user_intent` 和 `page_state`，用户现在想要公开上线文章，系统应该执行点击哪个按钮？",
        "criteria": {
            "btn_publish": "确认发布：将文章正式推送到知乎公开社区，供所有人阅读",
            "btn_draft": "存为草稿：暂时保存在个人草稿箱，不公开展示",
            "btn_preview": "预览文章：查看排版渲染效果，并不执行发布",
            "btn_delete": "删除草稿：放弃当前内容并清空文章"
        }
    },
    "ready_to_publish": {
        "type": "noul",
        "instructions": "根据 `page_state`，当前文章编辑状态是否完备，可以立即进行发布操作？"
    }
}

print("执行推理中...")
infer_start = time.time()
result = router.predict(state, questions)
infer_ms = (time.time() - infer_start) * 1000

print("\n" + "=" * 65)
print(f"【3. 推理完成，纯计算延迟仅: {infer_ms:.2f} ms】")
print("=" * 65)

routing = result.get("routing", {})
print(f"使用的模型版本: {routing.get('model')} ({routing.get('repo')})")
print(f"分派原因: {routing.get('reason')}")

answers = result.get("answers", {})

btn_res = answers.get("button_decision", {})
print("\n>>> 决策判断一：目标按钮选择")
print(f"  决策结果: {btn_res.get('choice')}  （命中预期：btn_publish）")
print(f"  模型置信度: {btn_res.get('confidence') * 100:.2f}%")
print("  概率分布:")
for k, v in btn_res.get("probabilities", {}).items():
    print(f"    - {k}: {v * 100:.2f}%")

ready_res = answers.get("ready_to_publish", {})
print("\n>>> 决策判断二：页面就绪状态检查")
print(f"  是否就绪 (布尔): {ready_res.get('noul') > 0.5} (概率值: {ready_res.get('noul')})")
print(f"  模型置信度: {ready_res.get('confidence') * 100:.2f}%")

print(f"\nToken 统计: 输入 {result['usage']['input_tokens']} tokens, 输出 0 tokens (非自回归单次前向)")

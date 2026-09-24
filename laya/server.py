import os
import sys
import time
from typing import List, Optional, Dict, Any
from fastapi import FastAPI, HTTPException
from pydantic import BaseModel
import torch
import laya

# Ensure standard UTF-8 output safely
try:
    if hasattr(sys.stdout, 'reconfigure'):
        sys.stdout.reconfigure(encoding='utf-8')
except Exception:
    pass

app = FastAPI(title="Laya Decision Service for Zhihu Automation")

# Global agent reference
AGENT: Optional[laya.Agent] = None


class SessionSnapshotInput(BaseModel):
    url: str = ""
    title: str = ""
    visibleTexts: List[str] = []
    buttons: List[str] = []
    links: List[Dict[str, Any]] = []

class SessionDetectionResponse(BaseModel):
    session_state: str  # "active" | "login_required" | "session_expired" | "unknown"
    reason: str
    confidence: str  # "high" | "medium" | "low"

class PageSnapshotInput(BaseModel):
    url: str = ""
    title: str = ""
    buttons: List[str] = []
    links: List[Dict[str, Any]] = []
    visibleTexts: List[str] = []
    editorContent: Optional[str] = None

class UnderstandPageResponse(BaseModel):
    nextAction: str  # "CLICK_WRITE_ANSWER" | "FOCUS_EDITOR" | "PASTE_CONTENT" | "CLICK_SUBMIT" | "WAIT" | "VERIFY_RESULT" | "REQUEST_MANUAL_LOGIN"
    targetTexts: List[str]
    targetRoles: List[str]
    confidence: str
    reason: str

class ReviewPublishInput(BaseModel):
    currentUrl: str = ""
    title: str = ""
    matchedSignals: List[str] = []
    editorStillVisible: bool = False
    visibleTexts: List[str] = []
    expectedExcerpt: str = ""

class ReviewPublishResponse(BaseModel):
    decision: str  # "SUCCESS" | "CONTENT_RISK" | "UNCERTAIN"
    confidence: str
    matchedSignals: List[str]
    reason: str

class PublishFailureInput(BaseModel):
    currentUrl: str = ""
    title: str = ""
    buttons: List[str] = []
    visibleTexts: List[str] = []
    editorStillVisible: bool = False
    lastAction: str = ""
    lastError: str = ""

class PublishFailureResponse(BaseModel):
    failureType: str
    confidence: str
    reason: str

class TopicClassificationInput(BaseModel):
    title: str = ""
    url: str = ""
    sourceType: str = ""
    historyMatched: bool = False

class TopicClassificationResponse(BaseModel):
    relevant: bool
    topicType: str
    valueLevel: str
    riskLevel: str
    duplicateRisk: str
    confidence: str
    reason: str = ""

class DraftPrecheckInput(BaseModel):
    title: str = ""
    content: str = ""
    topicSummary: str = ""

class DraftPrecheckResponse(BaseModel):
    decision: str
    riskFlags: List[Dict[str, str]] = []
    formatIssues: List[str] = []
    duplicateSignals: List[str] = []
    confidence: str

class HumanizerMarkInput(BaseModel):
    content: str = ""

class HumanizerMarkResponse(BaseModel):
    segments: List[Dict[str, Any]] = []
    confidence: str

class RetryDecisionInput(BaseModel):
    failureType: str = ""
    retryCount: int = 0
    stage: str = ""
    context: Dict[str, Any] = {}

class RetryDecisionResponse(BaseModel):
    action: str
    waitMs: int
    reason: str
    confidence: str

@app.on_event("startup")
def startup_event():
    global AGENT
    device = "cuda" if torch.cuda.is_available() else "cpu"
    if device == "cpu":
        # Limit threads to avoid OpenMP contention on many-core servers
        threads = min(8, os.cpu_count() or 4)
        torch.set_num_threads(threads)
        print(f"[*] Configured PyTorch CPU threads: {torch.get_num_threads()}")
    print(f"[*] Initializing Laya Agent on device: {device}...")
    start_t = time.time()
    AGENT = laya.load("convaiinnovations/laya", subfolder="multilingual", device=device)
    print(f"[+] Laya Multilingual Agent initialized in {time.time() - start_t:.2f}s on {AGENT.device}")

@app.get("/health")
def health():
    return {
        "status": "ok",
        "device": str(AGENT.device) if AGENT else "not_loaded",
        "model": "convaiinnovations/laya/multilingual",
        "timestamp": time.time()
    }

@app.post("/api/detect-session-state", response_model=SessionDetectionResponse)
def detect_session_state(data: SessionSnapshotInput):
    if not AGENT:
        raise HTTPException(status_code=503, detail="Laya model not initialized")

    # Fast heuristics check first
    combined_texts_str = " ".join(data.visibleTexts + data.buttons).lower()
    if any(k in combined_texts_str for k in ["安全验证", "极验", "人机验证", "滑块", "异常验证"]):
        return SessionDetectionResponse(
            session_state="session_expired",
            reason="Laya快速核验：检测到安全验证或风控挑战页",
            confidence="high"
        )
    if "signin" in data.url.lower() or any(k in data.buttons for k in ["登录/注册", "立即登录", "获取短信验证码"]):
        return SessionDetectionResponse(
            session_state="login_required",
            reason="Laya快速核验：当前处于登录/注册拦截页面",
            confidence="high"
        )
    if any(any(k in b for k in ["发布回答", "存草稿", "保存修改", "账号设置", "私信", "消息", "创作中心", "创作者中心"]) for b in data.buttons):
        return SessionDetectionResponse(
            session_state="active",
            reason="Laya快速核验：页面已登录，存在真实创作或账户管理入口",
            confidence="high"
        )

    # Fall back to Laya neural decision
    combined_buttons = "，".join(data.buttons[:15])
    combined_texts = "；".join([t.strip() for t in data.visibleTexts[:10] if t.strip()])
    
    state = {
        "url": data.url,
        "title": data.title,
        "buttons": combined_buttons,
        "page_text": combined_texts[:350]
    }

    questions = {
        "session_state": {
            "type": "choice",
            "instructions": "根据知乎页面元素 `buttons`、`title` 和 `url` 判断当前账号登录状态：",
            "criteria": {
                "active": "已正常登录，在设置页、创作中心或正在编辑回答",
                "login_required": "未登录，显示登录或注册表单，或访问创作页面被重定向拦截",
                "session_expired": "出现风控、安全验证或滑块挑战",
                "unknown": "普通浏览页或无法确定"
            }
        }
    }

    res = AGENT.system_one(state, questions)
    ans = res.get("answers", {}).get("session_state", {})
    choice = ans.get("choice", "unknown")
    conf_score = ans.get("confidence", 0.5)
    confidence = "high" if conf_score >= 0.7 else ("medium" if conf_score >= 0.4 else "low")

    return SessionDetectionResponse(
        session_state=choice,
        reason=f"Laya毫秒决策：判定登录态为 {choice}",
        confidence=confidence
    )

@app.post("/api/understand-publish-page", response_model=UnderstandPageResponse)
def understand_publish_page(data: PageSnapshotInput):
    if not AGENT:
        raise HTTPException(status_code=503, detail="Laya model not initialized")

    # Fast heuristic check on explicit buttons
    has_submit = any(sub in b for b in data.buttons for sub in ["发布回答", "提交回答", "发布修改", "保存修改"])
    has_editor = data.editorContent is not None or any(k in " ".join(data.visibleTexts) for k in ["DraftEditor", "撤销", "清除格式"])
    has_view_my_answer = any("查看我的回答" in b for b in data.buttons)
    has_write_or_edit = any(sub in b for b in data.buttons for sub in ["写回答", "编辑回答", "继续写"])

    if has_submit:
        target = [b for b in data.buttons if any(k in b for k in ["发布回答", "提交回答", "发布修改", "保存修改"])][:1]
        return UnderstandPageResponse(
            nextAction="CLICK_SUBMIT",
            targetTexts=target if target else ["发布回答"],
            targetRoles=["button"],
            confidence="high",
            reason="Laya快速判断：已进入编辑完成态，存在发布提交按钮"
        )
    if has_editor:
        return UnderstandPageResponse(
            nextAction="FOCUS_EDITOR",
            targetTexts=[],
            targetRoles=["textbox"],
            confidence="high",
            reason="Laya快速判断：已识别到回答编辑器，下一步聚焦编辑"
        )
    if has_view_my_answer:
        target = [b for b in data.buttons if "查看我的回答" in b][:1]
        return UnderstandPageResponse(
            nextAction="VERIFY_RESULT",
            targetTexts=target if target else ["查看我的回答"],
            targetRoles=["button"],
            confidence="high",
            reason="Laya快速判断：检测到已发布回答（查看我的回答），直接核验结果"
        )
    if has_write_or_edit:
        target = [b for b in data.buttons if any(k in b for k in ["编辑回答", "写回答", "继续写"])][:1]
        return UnderstandPageResponse(
            nextAction="CLICK_WRITE_ANSWER",
            targetTexts=target if target else ["写回答"],
            targetRoles=["button"],
            confidence="high",
            reason="Laya快速判断：问题页存在创作或编辑入口（写回答/编辑草稿），下一步点击展开编辑器"
        )

    # Neural dispatch for ambiguous pages
    link_texts = [link.get("text", "").strip() for link in data.links if link.get("text", "").strip()]
    all_buttons = "，".join(data.buttons[:15])
    all_links = "，".join(link_texts[:15])
    text_snippet = "；".join([t.strip() for t in data.visibleTexts[:8] if t.strip()])

    state = {
        "url": data.url,
        "title": data.title,
        "buttons": all_buttons,
        "links": all_links,
        "visible_text": text_snippet[:350]
    }

    questions = {
        "next_action": {
            "type": "choice",
            "instructions": "自动化发帖流程中，根据页面元素 `buttons`、`links` 和 `url`，下一步应执行的动作是：",
            "criteria": {
                "CLICK_WRITE_ANSWER": "当前在问题详情页，需要点击'写回答'或'编辑回答'按钮展开编辑器",
                "FOCUS_EDITOR": "页面已展开编辑器，下一步点击聚焦输入框",
                "PASTE_CONTENT": "输入框已就绪，下一步执行内容粘贴",
                "CLICK_SUBMIT": "正文已填写完成，下一步点击'发布回答'按钮",
                "VERIFY_RESULT": "页面出现'查看我的回答'，说明此前已回答过，核验结果",
                "REQUEST_MANUAL_LOGIN": "页面跳出登录或人机验证",
                "WAIT": "页面加载中或证据不足，等待"
            }
        }
    }

    res = AGENT.system_one(state, questions)
    ans = res.get("answers", {}).get("next_action", {})
    action = ans.get("choice", "WAIT")
    conf_score = ans.get("confidence", 0.5)
    confidence = "high" if conf_score >= 0.7 else ("medium" if conf_score >= 0.4 else "low")

    return UnderstandPageResponse(
        nextAction=action,
        targetTexts=[],
        targetRoles=[],
        confidence=confidence,
        reason=f"Laya语义研判：判定下一步动作 {action}"
    )

@app.post("/api/review-publish-result", response_model=ReviewPublishResponse)
def review_publish_result(data: ReviewPublishInput):
    if not AGENT:
        raise HTTPException(status_code=503, detail="Laya model not initialized")

    # Fast heuristics
    is_answer = "/answer/" in data.currentUrl
    has_signals = len(data.matchedSignals) > 0
    any_text = " ".join(data.visibleTexts).lower()

    # 1. 如果已经跳转到回答详情页，且编辑器已关闭，直接确认发布成功 (避免误伤知乎侧边栏的“违法和不良信息举报”等通用文字)
    if is_answer and not data.editorStillVisible:
        return ReviewPublishResponse(
            decision="SUCCESS",
            confidence="high",
            matchedSignals=data.matchedSignals,
            reason="Laya快速核验：URL已成功跳转至回答详情页(/answer/)，发布成功"
        )
    
    # 2. 如果还在编辑态且弹出了明确的违规提示
    if data.editorStillVisible and any(k in any_text for k in ["不符合社区规范", "包含敏感词汇", "内容未通过审核", "发布失败：包含敏感"]):
        return ReviewPublishResponse(
            decision="CONTENT_RISK",
            confidence="high",
            matchedSignals=data.matchedSignals,
            reason="Laya快速核验：页面明确命中内容违规或风控拦截信息"
        )

    if data.editorStillVisible and not is_answer:
        return ReviewPublishResponse(
            decision="UNCERTAIN",
            confidence="medium",
            matchedSignals=data.matchedSignals,
            reason="Laya快速核验：当前依然停留在编辑页，结果待定"
        )

    # Neural fallback
    state = {
        "current_url": data.currentUrl,
        "is_answer_url": is_answer,
        "editor_still_visible": data.editorStillVisible,
        "matched_content_signals": "，".join(data.matchedSignals),
        "page_texts": any_text[:350]
    }

    questions = {
        "publish_result": {
            "type": "choice",
            "instructions": "根据 `current_url` 和 `matched_content_signals` 判断发布是否成功：",
            "criteria": {
                "SUCCESS": "已跳转至回答详情页或已呈现正文内容",
                "CONTENT_RISK": "页面明确出现违规拦截或发布失败警告",
                "UNCERTAIN": "停留在编辑器或状态未定"
            }
        }
    }

    res = AGENT.system_one(state, questions)
    ans = res.get("answers", {}).get("publish_result", {})
    decision = ans.get("choice", "UNCERTAIN")
    conf_score = ans.get("confidence", 0.5)
    confidence = "high" if conf_score >= 0.7 else ("medium" if conf_score >= 0.4 else "low")

    return ReviewPublishResponse(
        decision=decision,
        confidence=confidence,
        matchedSignals=data.matchedSignals,
        reason=f"Laya毫秒核验：判定状态为 {decision}"
    )

@app.post("/api/classify-publish-failure", response_model=PublishFailureResponse)
def classify_publish_failure(data: PublishFailureInput):
    if not AGENT:
        raise HTTPException(status_code=503, detail="Laya model not initialized")

    text = " ".join(data.visibleTexts + data.buttons + [data.title, data.lastError]).lower()
    if any(k in text for k in ["验证码", "人机验证", "滑块", "captcha"]):
        return PublishFailureResponse(failureType="CAPTCHA_REQUIRED", confidence="high", reason="检测到验证码或人机验证")
    if any(k in text for k in ["安全验证", "风控", "异常验证", "账号异常", "违规"]):
        return PublishFailureResponse(failureType="RISK_CONTROL", confidence="high", reason="检测到安全验证或风控提示")
    if "/signin" in data.currentUrl.lower() or "/login" in data.currentUrl.lower() or "登录" in text:
        return PublishFailureResponse(failureType="LOGIN_REQUIRED", confidence="high", reason="当前页面要求登录")
    if any(k in data.lastError.lower() for k in ["timeout", "超时", "网络"]):
        return PublishFailureResponse(failureType="NETWORK_TIMEOUT", confidence="high", reason="最近一次动作发生网络或页面超时")
    if data.editorStillVisible and any(k in text for k in ["不可用", "无法发布", "发布按钮置灰"]):
        return PublishFailureResponse(failureType="SUBMIT_DISABLED", confidence="high", reason="编辑器仍在页面且提交入口不可用")

    state = {
        "url": data.currentUrl,
        "title": data.title,
        "buttons": "，".join(data.buttons[:20]),
        "visible_text": "；".join(data.visibleTexts[:20])[:500],
        "editor_still_visible": data.editorStillVisible,
        "last_action": data.lastAction,
        "last_error": data.lastError[:300]
    }
    questions = {
        "failure_type": {
            "type": "choice",
            "instructions": "判断知乎发布失败的主要原因，只选择一个最可能类别。",
            "criteria": {
                "ELEMENT_NOT_FOUND": "目标按钮或输入区域不存在",
                "EDITOR_NOT_READY": "编辑器尚未加载或没有可编辑区域",
                "SUBMIT_DISABLED": "发布按钮存在但不可用或被校验阻止",
                "LOGIN_REQUIRED": "需要登录",
                "CAPTCHA_REQUIRED": "验证码或人机验证",
                "RISK_CONTROL": "安全验证、风控或违规提示",
                "NETWORK_TIMEOUT": "网络或页面超时",
                "PAGE_LAYOUT_CHANGED": "页面结构与既有模式明显不同",
                "PUBLISH_UNCERTAIN": "点击后无法确认是否已发布",
                "UNKNOWN": "证据不足"
            }
        }
    }
    result = AGENT.system_one(state, questions)
    answer = result.get("answers", {}).get("failure_type", {})
    allowed = {"ELEMENT_NOT_FOUND", "EDITOR_NOT_READY", "SUBMIT_DISABLED", "LOGIN_REQUIRED", "CAPTCHA_REQUIRED", "RISK_CONTROL", "NETWORK_TIMEOUT", "PAGE_LAYOUT_CHANGED", "PUBLISH_UNCERTAIN", "UNKNOWN"}
    failure_type = answer.get("choice", "UNKNOWN")
    if failure_type not in allowed:
        failure_type = "UNKNOWN"
    score = answer.get("confidence", 0.5)
    confidence = "high" if score >= 0.7 else ("medium" if score >= 0.4 else "low")
    return PublishFailureResponse(failureType=failure_type, confidence=confidence, reason=f"Laya异常分类：{failure_type}")

@app.post("/api/classify-topic", response_model=TopicClassificationResponse)
def classify_topic(data: TopicClassificationInput):
    title = data.title.strip()
    if not title:
        return TopicClassificationResponse(relevant=False, topicType="unknown", valueLevel="low", riskLevel="high", duplicateRisk="low", confidence="high", reason="标题为空")
    risk_terms = ["违法", "赌博", "色情", "破解", "刷量", "代写"]
    if any(term in title for term in risk_terms):
        return TopicClassificationResponse(relevant=False, topicType="risk", valueLevel="low", riskLevel="high", duplicateRisk="low", confidence="high", reason="标题命中高风险词")
    if data.historyMatched:
        return TopicClassificationResponse(relevant=False, topicType="duplicate", valueLevel="low", riskLevel="low", duplicateRisk="high", confidence="high", reason="候选题已有历史匹配")
    topic_type = "tooling" if any(term in title.lower() for term in ["api", "模型", "claude", "gpt", "编程", "开发", "工具"]) else "general"
    return TopicClassificationResponse(relevant=True, topicType=topic_type, valueLevel="medium", riskLevel="low", duplicateRisk="low", confidence="medium", reason="未命中明显风险，进入主流程复核")

@app.post("/api/precheck-draft", response_model=DraftPrecheckResponse)
def precheck_draft(data: DraftPrecheckInput):
    content = data.content.strip()
    if not content:
        return DraftPrecheckResponse(decision="BLOCK", formatIssues=["正文为空"], confidence="high")
    risk_terms = ["保证100%", "稳赚", "绝对有效", "官方内部", "绕过限制"]
    flags = [{"type": "风险承诺", "text": term, "reason": "命中绝对化或规避限制表达"} for term in risk_terms if term in content]
    issues = ["正文过短"] if len(content) < 120 else []
    decision = "BLOCK" if flags else ("REVIEW" if issues else "PASS")
    return DraftPrecheckResponse(decision=decision, riskFlags=flags, formatIssues=issues, confidence="high" if flags else "medium")

@app.post("/api/humanizer-mark", response_model=HumanizerMarkResponse)
def humanizer_mark(data: HumanizerMarkInput):
    segments = []
    for phrase in ["首先，", "其次，", "最后，", "综上所述，", "值得注意的是，"]:
        start = data.content.find(phrase)
        if start >= 0:
            segments.append({"start": start, "end": start + len(phrase), "issue": "模板化连接词", "suggestion": "结合具体经历或上下文改写"})
    return HumanizerMarkResponse(segments=segments[:8], confidence="medium" if segments else "high")

@app.post("/api/retry-decision", response_model=RetryDecisionResponse)
def retry_decision(data: RetryDecisionInput):
    if data.failureType in ["LOGIN_REQUIRED", "CAPTCHA_REQUIRED", "RISK_CONTROL", "challenge_required"]:
        return RetryDecisionResponse(action="manual_login", waitMs=0, reason="需要人工处理登录或风控挑战", confidence="high")
    if data.failureType in ["NETWORK_TIMEOUT", "network_or_page_error"]:
        if data.retryCount == 0:
            return RetryDecisionResponse(action="refresh", waitMs=1800, reason="网络或页面异常，先刷新后重试", confidence="high")
        return RetryDecisionResponse(action="stop", waitMs=0, reason="网络异常已重试，停止自动操作", confidence="medium")
    if data.retryCount < 2:
        return RetryDecisionResponse(action="retry", waitMs=1000 + data.retryCount * 800, reason="可恢复错误，有限次数重试", confidence="medium")
    return RetryDecisionResponse(action="stop", waitMs=0, reason="超过自动重试上限", confidence="high")

if __name__ == "__main__":
    import uvicorn
    uvicorn.run(app, host="127.0.0.1", port=8100)

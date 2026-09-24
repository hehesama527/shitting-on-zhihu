#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
大模型 API 中转站“防掺水与真伪鉴别”自动化巡检工具
用法:
    python scripts/relay_checker.py --url https://api.your-relay.com/v1 --key sk-xxx --model gpt-4o
"""

import os
import sys
import time
import json
import argparse
import requests

if sys.platform == "win32":
    try:
        sys.stdout.reconfigure(encoding="utf-8")
        sys.stderr.reconfigure(encoding="utf-8")
    except Exception:
        pass

def run_relay_audit(base_url: str, api_key: str, model_name: str):
    print("\n" + "=" * 65)
    print(" 🚀 大模型 API 中转站真伪与防掺水全自动化体检")
    print(f" 🎯 目标网关: {base_url}")
    print(f" 🎯 申报模型: {model_name}")
    print("=" * 65)

    headers = {
        "Authorization": f"Bearer {api_key}",
        "Content-Type": "application/json"
    }
    api_endpoint = f"{base_url.rstrip('/')}/chat/completions"

    # 1. 探针：Logprobs 原生支持
    print("\n[探针 1/5] 正在测试 logprobs 参数支持 (一票否决逆向与粗糙小模型)...")
    payload_logprobs = {
        "model": model_name,
        "messages": [{"role": "user", "content": "Hello"}],
        "max_tokens": 5,
        "logprobs": True,
        "top_logprobs": 2
    }
    try:
        r = requests.post(api_endpoint, headers=headers, json=payload_logprobs, timeout=20)
        res = r.json()
        if r.status_code == 200 and "choices" in res and res["choices"][0].get("logprobs") is not None:
            print("  ✅ [PASS] 该接口支持 logprobs 原生字段（符合官方 API 特征）。")
        else:
            print(f"  ⚠️ [WARN] 接口不支持 logprobs！返回状态: {r.status_code}，响应: {res}")
            print("     说明：很多逆向车或偷换的模型不支持 logprobs 概率计算。")
    except Exception as e:
        print(f"  ❌ [ERROR] logprobs 探测异常: {e}")

    # 2. 探针：Tool Calls (Function Calling) 原生结构
    print("\n[探针 2/5] 正在测试 Tool Calls / Function Calling 结构解析...")
    tools_def = [
        {
            "type": "function",
            "function": {
                "name": "query_database_status",
                "description": "查询数据库运行状态",
                "parameters": {
                    "type": "object",
                    "properties": {"db_id": {"type": "string"}},
                    "required": ["db_id"]
                }
            }
        }
    ]
    payload_tools = {
        "model": model_name,
        "messages": [{"role": "user", "content": "帮我查询 db_id 为 prod_cluster_01 的数据库状态"}],
        "tools": tools_def,
        "tool_choice": "auto"
    }
    try:
        r = requests.post(api_endpoint, headers=headers, json=payload_tools, timeout=20)
        res = r.json()
        if r.status_code == 200 and "choices" in res:
            choice = res["choices"][0]
            if "message" in choice and choice["message"].get("tool_calls"):
                calls = choice["message"]["tool_calls"]
                print(f"  ✅ [PASS] 成功触发原生 tool_calls 结构: {calls[0]['function']['name']}")
            else:
                print("  ⚠️ [WARN] 模型未触发 tool_calls，甚至当成了普通文本输出。")
        else:
            print(f"  ❌ [FAIL] 接口不支持 tools 协议。状态码: {r.status_code}")
    except Exception as e:
        print(f"  ❌ [ERROR] Tool Calls 探测异常: {e}")

    # 3. 探针：流式首字延迟 (TTFT) 与连贯性
    print("\n[探针 3/5] 正在测算流式首字延迟 (TTFT) 与每秒吞吐 (TPS)...")
    payload_stream = {
        "model": model_name,
        "messages": [{"role": "user", "content": "请输出一段 50 字的关于计算机历史的简述。"}],
        "stream": True
    }
    try:
        start_time = time.time()
        ttft = None
        chunk_count = 0
        with requests.post(api_endpoint, headers=headers, json=payload_stream, stream=True, timeout=25) as r:
            for line in r.iter_lines():
                if line:
                    decoded = line.decode("utf-8", errors="ignore")
                    if decoded.startswith("data: ") and decoded != "data: [DONE]":
                        if ttft is None:
                            ttft = time.time() - start_time
                        chunk_count += 1
        total_time = time.time() - start_time
        if ttft is not None:
            print(f"  ⏱️ 首字延迟 (TTFT): {ttft:.3f}s | 总耗时: {total_time:.3f}s | 收到数据块: {chunk_count}")
            if ttft > 3.0:
                print("  ⚠️ [WARN] 首字延迟 > 3.0 秒，极有可能是网页逆向、被限流或劣质二次转发车。")
            else:
                print("  ✅ [PASS] 延迟表现良好，响应平滑。")
        else:
            print("  ❌ [FAIL] 未收到有效流式数据。")
    except Exception as e:
        print(f"  ❌ [ERROR] 流式测速异常: {e}")

    # 4. 探针：DeepSeek R1 专有 reasoning_content 检验
    if "r1" in model_name.lower():
        print("\n[探针 4/5] 检验 DeepSeek R1 的流式 reasoning_content 思考字段...")
        payload_r1 = {
            "model": model_name,
            "messages": [{"role": "user", "content": "9.11 和 9.9 哪个数字更大？"}],
            "stream": True
        }
        has_reasoning = False
        try:
            with requests.post(api_endpoint, headers=headers, json=payload_r1, stream=True, timeout=30) as r:
                for line in r.iter_lines():
                    if line:
                        decoded = line.decode("utf-8", errors="ignore")
                        if decoded.startswith("data: ") and decoded != "data: [DONE]":
                            data = json.loads(decoded[6:])
                            delta = data["choices"][0].get("delta", {})
                            if "reasoning_content" in delta:
                                has_reasoning = True
                                break
            if has_reasoning:
                print("  ✅ [PASS] 成功检测到原生的 delta.reasoning_content 独立传输！")
            else:
                print("  ❌ [FAIL] 未检测到 reasoning_content！思考过程可能是系统提示词伪造或逆向！")
        except Exception as e:
            print(f"  ❌ [ERROR] R1 思考探针异常: {e}")
    else:
        print("\n[探针 4/5] 非 R1 推理模型，跳过 reasoning_content 检验。")

    # 5. 探针：弱智吧双关逻辑试金石 (区分 4o 与 4o-mini)
    print("\n[探针 5/5] 发送逻辑试金石题（区分 4o 与 4o-mini）...")
    trick_prompt = "我把两张五块钱的纸币折在一起，为什么不能变成一张十块钱的纸币？请一句话切中要害指出原因。"
    payload_trick = {
        "model": model_name,
        "messages": [{"role": "user", "content": trick_prompt}],
        "temperature": 0.1
    }
    try:
        r = requests.post(api_endpoint, headers=headers, json=payload_trick, timeout=25)
        res = r.json()
        ans = res["choices"][0]["message"]["content"].strip()
        print(f"  📝 模型回答: 「{ans}」")
        print("  💡 辨析基准：")
        print("     - 正版 4o / Claude 旗舰：直接指出'货币面额由法定背书决定，物理叠放改变不了法律与信用价值'。")
        print("     - 降级 4o-mini / 粗糙小模型：往往一本正经讨论'纸张分子结构与物理形变未发生化学反应'。")
    except Exception as e:
        print(f"  ❌ [ERROR] 逻辑测试异常: {e}")

    print("\n" + "=" * 65)
    print(" 🏁 巡检完成！")
    print("=" * 65 + "\n")

def main():
    parser = argparse.ArgumentParser(description="大模型 API 中转站真伪与防掺水自动化巡检工具")
    parser.add_argument("--url", default=os.environ.get("OPENAI_BASE_URL", "https://api.openai.com/v1"), help="API Base URL (例如 https://api.relay.com/v1)")
    parser.add_argument("--key", default=os.environ.get("OPENAI_API_KEY", ""), help="API Key")
    parser.add_argument("--model", default="gpt-4o", help="要测试的模型名称 (例如 gpt-4o, claude-3-5-sonnet, deepseek-r1)")
    args = parser.parse_args()

    if not args.key:
        print("⚠️ 请提供 API Key，例如: python scripts/relay_checker.py --url https://api.relay.com/v1 --key sk-xxx --model gpt-4o")
        sys.exit(1)

    run_relay_audit(args.url, args.key, args.model)

if __name__ == "__main__":
    main()

"use client";

import { useState } from "react";
import { collectZhihuEngagement } from "../lib/api";

export function DataAgentActions({ jobId }: { jobId: number }) {
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState("");
  return <div className="inline-row">
    <button className="button button--ghost" disabled={busy} onClick={async () => {
      setBusy(true); setMessage("");
      try { await collectZhihuEngagement(jobId); setMessage("已完成"); } catch (error) { setMessage(error instanceof Error ? error.message : "采集失败"); } finally { setBusy(false); }
    }}>{busy ? "采集中..." : "回收数据"}</button>
    {message ? <span className="muted">{message}</span> : null}
  </div>;
}

"use client";

import { useEffect, useState, useTransition } from "react";
import type { VideoFeedbackDocumentSummary } from "@zhihu-mvp/shared";
import { createVideoFeedbackDocument, getVideoHubSummary } from "../../lib/api";

export function VideoFeedbackConsole() {
  const [documents, setDocuments] = useState<VideoFeedbackDocumentSummary[]>([]);
  const [notes, setNotes] = useState("");
  const [scope, setScope] = useState<VideoFeedbackDocumentSummary["scope"]>("global");
  const [message, setMessage] = useState("");
  const [isPending, startTransition] = useTransition();

  useEffect(() => {
    void hydrate().catch((error) => {
      setMessage(error instanceof Error ? error.message : "反馈文档加载失败。");
    });
  }, []);

  function hydrate() {
    return getVideoHubSummary().then((summary) => {
      setDocuments(summary.feedbackDocuments);
    });
  }

  function submit() {
    startTransition(() => {
      void (async () => {
        try {
          setMessage("");
          await createVideoFeedbackDocument({ scope, notes });
          setNotes("");
          await hydrate();
          setMessage("反馈文档已生成。");
        } catch (error) {
          setMessage(error instanceof Error ? error.message : "反馈文档生成失败。");
        }
      })();
    });
  }

  return (
    <div className="stack">
      <header className="page-header">
        <div>
          <h2>反馈文档</h2>
          <p className="muted">FeedbackAgent 会把零散反馈沉淀成文档，用来辅助后续选题和写作。</p>
        </div>
      </header>

      <section className="card">
        <div className="grid grid--two">
          <label className="field">
            <span>Scope</span>
            <select value={scope} onChange={(event) => setScope(event.target.value as VideoFeedbackDocumentSummary["scope"])}>
              <option value="global">global</option>
              <option value="topic">topic</option>
              <option value="writer">writer</option>
              <option value="visual">visual</option>
              <option value="project">project</option>
            </select>
          </label>
        </div>
        <label className="field">
          <span>反馈 notes</span>
          <textarea value={notes} rows={6} onChange={(event) => setNotes(event.target.value)} />
        </label>
        <button className="button" onClick={submit} disabled={isPending || !notes.trim()}>
          生成反馈文档
        </button>
        {message ? <p className="helper-text">{message}</p> : null}
      </section>

      <section className="grid">
        {documents.map((doc) => (
          <article key={doc.id} className="card">
            <div className="card-header">
              <h3>{doc.scope}</h3>
              <span className="helper-text">{new Date(doc.createdAt).toLocaleString("zh-CN")}</span>
            </div>
            <pre style={{ marginTop: "1rem" }}>{doc.markdown}</pre>
          </article>
        ))}
        {documents.length === 0 ? <section className="card">还没有反馈文档。</section> : null}
      </section>
    </div>
  );
}

import Link from "next/link";
import { AccountSwitcher } from "../../../../components/account-switcher";
import { getAccounts, getJobs, getZhihuEngagementSnapshots } from "../../../../lib/api";
import { DataAgentActions } from "../../../../components/data-agent-actions";

type Props = { searchParams?: Promise<{ accountId?: string }> };

export default async function ZhihuDataAgentPage({ searchParams }: Props) {
  const params = searchParams ? await searchParams : undefined;
  const accountId = params?.accountId ? Number(params.accountId) : null;
  const [accounts, snapshots, jobs] = await Promise.all([
    getAccounts(),
    getZhihuEngagementSnapshots(Number.isInteger(accountId) ? accountId : null),
    getJobs()
  ]);
  const publishedJobs = jobs.filter((job) => job.status === "published" && job.finalUrl && (!accountId || job.accountId === accountId));

  return <div className="stack">
    <section className="page-header">
      <div><h2>知乎数据回收</h2><p className="muted">回收已发布帖子的点赞、评论和历史互动快照。</p></div>
    </section>
    <AccountSwitcher accounts={accounts} selectedAccountId={accountId} basePath="/zhihu/data-agent" />
    <section className="card">
      <div className="card-header"><div><h3>已发布帖子</h3><p className="muted">选择任务后执行一次数据采集。</p></div></div>
      <div className="table-wrap"><table className="table"><thead><tr><th>任务</th><th>账号</th><th>链接</th><th>操作</th></tr></thead><tbody>
        {publishedJobs.length ? publishedJobs.map((job) => <tr key={job.id}><td><Link href={`/zhihu/jobs/${job.id}`}>{job.title ?? `任务 #${job.id}`}</Link></td><td>{accounts.find((account) => account.id === job.accountId)?.name ?? `账号 #${job.accountId}`}</td><td><a href={job.finalUrl!} target="_blank" rel="noreferrer">打开帖子</a></td><td><DataAgentActions jobId={job.id} /></td></tr>) : <tr><td colSpan={4}>暂无已发布帖子。</td></tr>}
      </tbody></table></div>
    </section>
    <section className="card"><div className="card-header"><div><h3>历史快照</h3><p className="muted">每次采集都会保留，方便比较互动增长。</p></div></div>
      <div className="table-wrap"><table className="table"><thead><tr><th>采集时间</th><th>帖子</th><th>点赞</th><th>评论</th><th>状态</th></tr></thead><tbody>
        {snapshots.snapshots.length ? snapshots.snapshots.map((snapshot) => <tr key={snapshot.id}><td>{new Date(snapshot.collectedAt).toLocaleString("zh-CN")}</td><td><a href={snapshot.postUrl} target="_blank" rel="noreferrer">{snapshot.title ?? snapshot.postUrl}</a></td><td>{snapshot.voteCount}</td><td>{snapshot.commentCount}</td><td>{snapshot.status === "succeeded" ? "成功" : snapshot.errorMessage ?? "失败"}</td></tr>) : <tr><td colSpan={5}>还没有采集记录。</td></tr>}
      </tbody></table></div>
    </section>
  </div>;
}

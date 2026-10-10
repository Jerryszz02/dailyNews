import { useEffect, useRef, useState } from "react";
import { Link, useBlocker, useNavigate } from "react-router";
import { SITE } from "@aihot/industry/site";
import { CATEGORIES } from "@aihot/industry/taxonomy";
import type { ReviewBatchDetail, ReviewMaterial, ReviewOverview, ReviewQualityReason, ReviewStatus, ReviewTask } from "@aihot/contracts/review";
import type { CalibrationMetric, CalibrationOverview } from "@aihot/contracts/calibration";
import type { Route } from "./+types/review";
import { adminGet } from "../../lib/admin.server";
import { useAdminAction } from "../../features/admin/action";
import { AdminPage, Badge, Button, Card, Empty, ReasonDialog, Select, Textarea } from "../../features/admin/ui";
import { bj } from "../../features/admin/format";
import { nextReviewIndex, reviewDraft, reviewValidation, type ReviewDraft } from "../../features/admin/review-state";

export async function loader({ request }: Route.LoaderArgs) {
  const url = new URL(request.url);
  const overview = await adminGet<ReviewOverview>(request, "/api/admin/review");
  const calibration = await adminGet<CalibrationOverview>(request, "/api/admin/review/calibration");
  const batchId = url.searchParams.get("batch") ?? overview.batches[0]?.id;
  const detail = batchId ? await adminGet<ReviewBatchDetail>(request, `/api/admin/review/batches/${encodeURIComponent(batchId)}`) : null;
  return { overview, detail, calibration, taskId: url.searchParams.get("task") };
}
export const meta: Route.MetaFunction = () => [{ title: `新闻标注 · ${SITE.name} 后台` }];
const categoryName = (key: string | null) => CATEGORIES.find((c) => c.key === key)?.label ?? (key === "unrelated" ? "与本站无关" : key === "insufficient" ? "材料不足" : "未分类");
const statuses: Record<ReviewStatus, string> = { pending: "待标注", completed: "已保存", skipped: "已跳过", later: "稍后再看" };
const reasons: Array<[ReviewQualityReason, string]> = [["fact_translation", "事实或翻译错误"], ["number_unit", "数字单位错误"], ["qualification", "遗漏预计、拟议等限定"], ["attribution", "错误来源归属"], ["contamination", "混入其他内容"], ["other", "其他"]];

function Choices<T extends string>({ label, value, options, onChange }: { label: string; value?: T; options: Array<[T, string]>; onChange: (value: T) => void }) {
  return <fieldset className="space-y-2"><legend className="text-[14px] font-semibold text-ink">{label}</legend><div className="flex flex-wrap gap-2">{options.map(([key, text]) => <label key={key} className={`cursor-pointer rounded-control px-3 py-2 text-[13px] ring-1 focus-within:ring-2 focus-within:ring-accent ${value === key ? "bg-accent-soft text-accent ring-accent" : "bg-surface text-ink-2 ring-line-strong"}`}><input type="radio" name={label} value={key} checked={value === key} onChange={() => onChange(key)} className="mr-2 accent-accent" />{text}</label>)}</div></fieldset>;
}
function Material({ material, label, blind = false }: { material: ReviewMaterial; label?: string; blind?: boolean }) {
  const body = material.bodyOriginal;
  return <Card title={label ?? "新闻与原文证据"} right={<a href={material.url} target="_blank" rel="noopener noreferrer" className="text-accent">打开原文 ↗</a>}>
    <div className="flex flex-wrap gap-2">{blind ? <Badge tone="accent">人工盲标</Badge> : <><Badge tone="accent">{categoryName(material.category)}</Badge><Badge>{material.selected === null ? "精选判断未记录" : material.selected ? "系统已精选" : "系统未精选"}</Badge></>}{material.backfill ? <Badge tone="warn">历史资料</Badge> : null}</div>
    <h2 className="mt-3 text-[20px] font-semibold leading-snug text-ink">{material.title}</h2>
    <p className="mt-2 text-[12px] text-ink-3">{material.sourceName} · {material.publishedAt ? `${bj(material.publishedAt, true)}（北京时间）` : "原文时间未提供"}</p>
    <p className="mt-4 whitespace-pre-wrap text-[14px] leading-7 text-ink-2">{material.summary ?? "暂无中文摘要，请根据原文判断；材料不足可以选择无法判断。"}</p>
    {material.storyTitle ? <div className="mt-4 border-t border-line pt-3 text-[13px] text-ink-2"><span className="text-ink-3">事件标题：</span>{material.storyTitle}</div> : null}
    <div className="mt-4 rounded-control bg-bg-sunk p-3 text-[12px] leading-6 text-ink-3">材料范围：{material.bodyStatus === "ok" ? "已保存来源材料，可能只含视频简介或片段；请对照来源核验。" : "正文可能不完整；只判断提供的证据，拿不准可跳过。"} {body ? "下方是保存的材料片段，打开原文可进一步核对。" : "没有可核对的正文。"}</div>
    <details className="mt-4" open><summary className="cursor-pointer text-[13px] font-medium text-ink-2">原文标题与片段</summary><h3 className="mt-2 text-[14px] font-medium text-ink">{material.originalTitle}</h3><pre className="mt-2 max-h-[360px] overflow-auto whitespace-pre-wrap break-words font-sans text-[13px] leading-6 text-ink-2">{body?.slice(0, 12000) ?? "未保存正文，请打开原文；无法访问时可以选择无法判断。"}</pre></details>
    {!body && material.bodyZh ? <details className="mt-4 text-[13px] text-ink-3"><summary className="cursor-pointer">查看中文整理稿（不能代替原文证据）</summary><p className="mt-2 max-h-[360px] overflow-auto whitespace-pre-wrap leading-6">{material.bodyZh.slice(0, 12000)}</p></details> : null}
    {blind ? null : <details className="mt-4 text-[12px] text-ink-3"><summary className="cursor-pointer">模型与材料版本</summary><p className="mt-2">模型：{material.model ?? "未记录"} · 分数：{material.score ?? "未记录"} · 材料版本：{material.inputRevision}</p></details>}
  </Card>;
}
function ReviewEditor({ task, onSaved, onPrevious, hasPrevious, onReload, frozen = false }: { task: ReviewTask; onSaved: (task: ReviewTask) => void; onPrevious: () => void; hasPrevious: boolean; onReload: () => void; frozen?: boolean }) {
  const { run, pending } = useAdminAction();
  const blind = task.mode === "blind";
  const [draft, setDraft] = useState<ReviewDraft>(() => reviewDraft(task.answer));
  const [message, setMessage] = useState("");
  const [failed, setFailed] = useState(false);
  const attempt = useRef<{ fingerprint: string; id: string } | null>(null);
  const set = (patch: ReviewDraft) => { setDraft((d) => ({ ...d, ...patch })); setMessage(""); };
  const dirty = JSON.stringify(draft) !== JSON.stringify(reviewDraft(task.answer));
  const savedNavigation = useRef(false);
  const blocker = useBlocker(() => dirty && !savedNavigation.current);
  useEffect(() => {
    if (blocker.state === "blocked") {
      if (window.confirm("当前选择还没有保存。离开并放弃这些选择？")) blocker.proceed();
      else blocker.reset();
    }
  }, [blocker]);
  useEffect(() => {
    if (!dirty) return;
    const warn = (event: BeforeUnloadEvent) => { event.preventDefault(); event.returnValue = ""; };
    window.addEventListener("beforeunload", warn);
    return () => window.removeEventListener("beforeunload", warn);
  }, [dirty]);
  async function save(status: Exclude<ReviewStatus, "pending">) {
    if (frozen) return;
    if (status === "completed") { const invalid = reviewValidation(draft, task.kind, task.snapshot.annotationVersion); if (invalid) { setMessage(invalid); return; } }
    const answer = { ...draft };
    if (answer.classification !== "change") delete answer.category;
    if (answer.quality !== "problem") delete answer.qualityReasons;
    const fingerprint = JSON.stringify({ status, answer, version: task.version });
    if (attempt.current?.fingerprint !== fingerprint) attempt.current = { fingerprint, id: crypto.randomUUID() };
    const result = await run<{ task: ReviewTask }>("POST", `/api/admin/review/tasks/${encodeURIComponent(task.id)}/answer`, { requestId: attempt.current.id, version: task.version, status, answer }, { label: `review-${task.id}-${attempt.current.id}`, revalidate: false, success: status === "completed" ? "已保存标注" : statuses[status] });
    if (!result) { setFailed(true); setMessage("未保存，当前选择仍保留。请重试；若其他页面已修改这条标注，先重新读取已保存版本。重新读取会放弃未保存选择。"); return; }
    setFailed(false); savedNavigation.current = true; onSaved(result.task);
  }
  return <Card title={task.kind === "relation" ? "判断两篇新闻的关系" : "你的判断"} right={<Badge tone={task.status === "completed" ? "ok" : "muted"}>{statuses[task.status]}</Badge>}><fieldset disabled={pending !== null || frozen} aria-label="标注判断" className="space-y-6">
    <p className="text-[12px] leading-6 text-ink-3">没有预选答案。拿不准也可以保存。{frozen ? "此校准批次已冻结，仅可回看。" : blind ? "当前为人工盲标，系统判断已隐藏。" : "当前为辅助标注，已展示系统答案。"}</p>
    {task.kind === "relation" ? <><p className="text-[13px] text-ink-3">系统当前：{task.snapshot.relationship === "merged" ? "已合并到同一事件" : "尚未合并到同一事件"}。</p><Choices label="两篇新闻的关系" value={draft.relation} options={[["same_event", "同一次事件"], ["development", "同一事件的新进展"], ["unrelated", "无关"], ["uncertain", "拿不准"]]} onChange={(relation) => set({ relation })} /></> : <>
      <Choices label="这篇新闻是否与 AI 相关？" value={draft.aiRelevance} options={[["relevant", "与 AI 相关"], ["irrelevant", "与 AI 无关"], ["uncertain", "拿不准"]]} onChange={(aiRelevance) => set({ aiRelevance })} />
      <p className="text-[12px] leading-6 text-ink-3">根据原文判断是否实质涉及 AI，与重要性/是否精选分开。{(task.snapshot.annotationVersion ?? 1) >= 2 ? "这项需要独立选择。" : "这是旧版任务，这项可选补填；原答案不会自动补全。"}{blind ? " AI 相关性与标题摘要问题本轮用于诊断，完成后可查看统计，不会自动修改模型。" : ""}</p>
      {blind ? <Choices label="这篇新闻应该归到哪个分类？" value={draft.classification === "uncertain" ? "uncertain" : draft.category} options={[...CATEGORIES.map((c): [string, string] => [c.key, c.label]), ["unrelated", "与本站无关"], ["insufficient", "材料不足"], ["uncertain", "拿不准"]]} onChange={(category) => set(category === "uncertain" ? { classification: "uncertain", category: undefined } : { classification: "change", category })} /> : <>
      <Choices label="分类对不对？" value={draft.classification} options={[["ok", "分类 OK"], ["change", "修改分类"], ["uncertain", "拿不准"]]} onChange={(classification) => set({ classification, category: undefined })} />
      {draft.classification === "change" ? <Choices label="应该归到哪个分类？" value={draft.category} options={[...CATEGORIES.map((c): [string, string] => [c.key, c.label]), ["unrelated", "与本站无关"], ["insufficient", "材料不足"]]} onChange={(category) => set({ category })} /> : null}</>}
      <Choices label="标题和摘要忠于原文吗？" value={draft.quality} options={[["ok", "OK"], ["problem", "有问题"], ["uncertain", "无法判断"]]} onChange={(quality) => set({ quality, qualityReasons: [] })} />
      {draft.quality === "problem" ? <fieldset><legend className="mb-2 text-[13px] font-medium text-ink">哪些地方有问题？可多选</legend><div className="space-y-2">{reasons.map(([key, text]) => <label key={key} className="flex items-center gap-2 text-[13px] text-ink-2"><input type="checkbox" className="accent-accent" checked={draft.qualityReasons?.includes(key) ?? false} onChange={(e) => set({ qualityReasons: e.target.checked ? [...(draft.qualityReasons ?? []), key] : draft.qualityReasons?.filter((r) => r !== key) })} />{text}</label>)}</div></fieldset> : null}
      <Choices label="是否值得进入精选？" value={draft.selection} options={[["select", "应该精选"], ["reject", "不应该精选"], ["uncertain", "拿不准"]]} onChange={(selection) => set({ selection })} /><p className="text-[12px] leading-6 text-ink-3">判断它是否有值得关注的新事实、有用信息或重要进展。AI 新闻和其他分类会分别统计。</p>
    </>}
    <label className="block text-[13px] text-ink-2">补充说明（可选）<Textarea className="mt-2" maxLength={4000} value={draft.note ?? ""} onChange={(e) => set({ note: e.target.value })} placeholder="例如：标题漏了“预计”，原文第 2 段提到……" /></label>
    {message ? <div role="alert" className="rounded-control bg-hot-soft p-3 text-[13px] text-hot">{message}{failed ? <Button className="mt-2" onClick={() => { if (window.confirm("放弃未保存选择，重新读取已保存版本？")) { savedNavigation.current = true; onReload(); } }} disabled={pending !== null}>重新读取已保存版本</Button> : null}</div> : null}
    <div className="flex flex-wrap gap-2 border-t border-line pt-4">{frozen ? <p className="text-[13px] text-ink-3">已冻结，不能再修改这批答案。</p> : <><Button tone="primary" busy={pending !== null} onClick={() => save("completed")}>保存并下一条</Button><Button disabled={pending !== null || !hasPrevious} onClick={onPrevious}>上一条</Button><Button disabled={pending !== null} onClick={() => save("skipped")}>暂时跳过</Button><Button disabled={pending !== null} onClick={() => save("later")}>稍后再看</Button></>}</div>
  </fieldset></Card>;
}
function CalibrationPanel({ overview, onOpen }: { overview: CalibrationOverview; onOpen: (batchId: string) => void }) {
  const { run, pending } = useAdminAction();
  const requests = useRef(new Map<string, { fingerprint: string; id: string }>());
  const [dialog, setDialog] = useState<"activate" | "rollback" | null>(null);
  const [message, setMessage] = useState("");
  const requestId = (operation: string, fingerprint = operation) => {
    if (requests.current.get(operation)?.fingerprint !== fingerprint) requests.current.set(operation, { fingerprint, id: crypto.randomUUID() });
    return requests.current.get(operation)!.id;
  };
  async function prepare() {
    if (overview.batchId) { onOpen(overview.batchId); return; }
    const id = requestId("prepare");
    const result = await run<{ batchId: string; created: boolean }>("POST", "/api/admin/review/calibration", { requestId: id }, { label: `calibration-prepare-${id}`, revalidate: false });
    if (result) { setMessage(""); onOpen(result.batchId); }
    else setMessage("未能准备校准批次，请重试。需要 200 条已有分析的真实文章，不会在这里调用模型。");
  }
  async function evaluate() {
    const id = requestId("evaluate");
    const result = await run<CalibrationOverview>("POST", "/api/admin/review/calibration/evaluate", { requestId: id }, { label: `calibration-evaluate-${id}`, success: "已冻结标注并生成检验结果" });
    setMessage(result ? "" : "未完成检验，请重试。全部 200 条需要保存，跳过和稍后不算完成。");
  }
  async function changeActive(reason: string) {
    const operation = dialog!;
    const body = { expectedActiveId: overview.activeCandidateId, reason, ...(operation === "activate" ? { candidateId: overview.candidate!.id } : {}) };
    const id = requestId(operation, JSON.stringify(body));
    const result = await run<CalibrationOverview>("POST", `/api/admin/review/calibration/${operation}`, { ...body, requestId: id }, { label: `calibration-${operation}-${id}`, success: operation === "activate" ? "校准规则将用于后续新闻" : "已停止后续应用校准规则" });
    if (result !== null) requests.current.delete(operation);
    return result !== null;
  }
  const candidate = overview.candidate;
  const metrics: Array<[string, CalibrationMetric]> = candidate ? [["分类", candidate.report.category], ["AI 精选", candidate.report.selectionAi], ["非 AI 精选", candidate.report.selectionNonAi]] : [];
  const ready = overview.total === overview.target && overview.completed === overview.target;
  const active = Boolean(overview.activeCandidateId);
  return <Card className="mb-5" title="一次性 200 条校准" right={<Badge tone={active ? "ok" : "muted"}>{active ? "后续应用已启用" : overview.frozen ? "结果已冻结" : "待完成盲标"}</Badge>}>
    <p className="text-[13px] leading-6 text-ink-2">人工盲标 200 篇文章，{overview.batchId ? "实际" : "预计"}学习 {overview.batchId ? overview.train : 160} 条、留出验证 {overview.batchId ? overview.holdout : 40} 条。完成后比较固定基线与离线纠错层，不会自动循环。</p>
    <p className="mt-1 text-[12px] leading-6 text-ink-3">首版纠正分类和过滤误选；精选漏选保留原有门槛。留出结果仅覆盖本批材料，不代表全量准确率。</p>
    <div className="mt-3 flex flex-wrap items-center gap-3"><span className="num text-[13px] text-ink-2">已完成 {overview.completed} / {overview.total || overview.target}</span><Button busy={pending !== null} onClick={prepare}>{overview.batchId ? overview.frozen ? "回看 200 条" : "继续 200 条" : "准备 200 条"}</Button>{overview.batchId && !overview.frozen ? <Button tone="primary" disabled={!ready} busy={pending !== null} onClick={evaluate}>完成标注并检验</Button> : null}</div>
    {message ? <p role="status" className="mt-3 text-[13px] text-hot">{message}</p> : null}
    {candidate ? <div className="mt-4 space-y-3 border-t border-line pt-4">
      <p className="text-[13px] text-ink-2">实际拆分：学习 {candidate.report.train} 条，留出 {candidate.report.holdout} 条。错误数按有效判断分别统计，拿不准与材料不足不当作正确答案。</p>
      <div className="overflow-x-auto"><table className="w-full min-w-[560px] text-left text-[13px]"><thead><tr className="border-b border-line text-ink-3"><th className="py-2 font-medium">留出检验</th><th className="font-medium">有效判断</th><th className="font-medium">错误：原规则 → 候选</th><th className="font-medium">误选</th><th className="font-medium">漏选</th></tr></thead><tbody>{metrics.map(([label, metric]) => <tr key={label} className="border-b border-line/70 text-ink-2"><td className="py-2">{label}</td><td>{metric.evaluated}</td><td>{metric.baselineErrors} → {metric.candidateErrors}</td><td>{label === "分类" ? "—" : `${metric.baselineFalseSelects} → ${metric.candidateFalseSelects}`}</td><td>{label === "分类" ? "—" : `${metric.baselineMisses} → ${metric.candidateMisses}`}</td></tr>)}</tbody></table></div>
      <details className="text-[13px] text-ink-2"><summary className="cursor-pointer">其他标注诊断</summary><p className="mt-2 text-[12px] leading-6 text-ink-3">AI 相关性与摘要问题本轮只做诊断，不会自动修改模型；系统未记录的 AI 相关性判断不当作通过。</p>{candidate.report.diagnostics ? <><p className="mt-2">整批 {overview.total} 条：分类未纳入比较 {candidate.report.diagnostics.excludedCategories} 条，精选拿不准 {candidate.report.diagnostics.uncertainSelections} 条，标题摘要有问题 {candidate.report.diagnostics.qualityProblems} 条。</p><p className="mt-2">留出 {candidate.report.holdout} 条：人工判断与 AI 相关 {candidate.report.diagnostics.holdoutAiRelevant} 条，系统误拦截 {candidate.report.diagnostics.holdoutAiFalseBlocks} 条，系统相关性判断未记录 {candidate.report.diagnostics.holdoutAiUnrecorded} 条。</p></> : <p className="mt-2">本候选未记录其他诊断。</p>}</details>
      <Badge tone={candidate.report.passed ? "ok" : "warn"}>{candidate.report.passed ? "达到启用门槛" : "未达到启用门槛"}</Badge>
      {candidate.report.reasons.length ? <ul className="list-disc space-y-1 pl-5 text-[13px] text-ink-2">{candidate.report.reasons.map((reason, i) => <li key={i}>{reason}</li>)}</ul> : null}
      <details className="text-[13px] text-ink-2"><summary className="cursor-pointer">查看候选规则（{candidate.policy.rules.length} 条）</summary><ul className="mt-2 space-y-2">{candidate.policy.rules.map((rule) => <li key={rule.id}>{rule.dimension === "category" ? "分类" : "精选过滤"} · 原分类 {categoryName(rule.fromCategory)} · 词项「{rule.token}」 → {rule.value === false ? "不精选" : categoryName(rule.value)} · 支持 {rule.support} 条，纠正 {rule.corrected} 条</li>)}</ul>{!candidate.policy.rules.length ? <p className="mt-2">没有得到有充分支持的纠错规则。</p> : null}</details>
      <details className="text-[13px] text-ink-2"><summary className="cursor-pointer">查看留出判断变化（{candidate.report.changes.length} 条）</summary><ul className="mt-2 space-y-2">{candidate.report.changes.map((change, i) => <li key={`${change.taskId}-${i}`}><Link className="text-accent" to={`?${new URLSearchParams({ batch: overview.batchId!, task: change.taskId })}`}>回看条目</Link> · {change.dimension === "category" ? "分类" : "精选"}：{typeof change.before === "boolean" ? change.before ? "精选" : "未精选" : categoryName(change.before)} → {typeof change.after === "boolean" ? change.after ? "精选" : "未精选" : categoryName(change.after)} · {change.correct ? "符合人工判断" : "不符合人工判断"}</li>)}</ul></details>
      <div className="flex flex-wrap items-center gap-3"><Button tone="primary" disabled={!candidate.report.passed || active || pending !== null} onClick={() => setDialog("activate")}>启用候选，用于后续新闻</Button>{active ? <Button disabled={pending !== null} onClick={() => setDialog("rollback")}>停止后续应用，回到原规则</Button> : null}<span className="text-[12px] text-ink-3">批次已冻结，可回看；历史新闻判断保留。</span></div>
    </div> : null}
    <ReasonDialog open={dialog !== null} title={dialog === "activate" ? "启用校准候选" : "停止应用校准规则"} description={dialog === "activate" ? "通过本批留出检验的规则将用于后续新材料；已有新闻判断保留。" : "后续新材料恢复使用原规则；候选和历史新闻判断保留。"} confirmLabel={dialog === "activate" ? "启用" : "停止后续应用"} busy={pending !== null} onClose={() => setDialog(null)} onSubmit={changeActive} />
  </Card>;
}
export default function Review({ loaderData }: Route.ComponentProps) {
  const { overview, detail, calibration, taskId } = loaderData;
  const navigate = useNavigate();
  const { run, pending } = useAdminAction();
  const prepareId = useRef<string | null>(null);
  const [prepareMessage, setPrepareMessage] = useState("");
  const [editorEpoch, setEditorEpoch] = useState(0);
  const tasks = detail?.tasks ?? [];
  const index = Math.max(0, taskId ? tasks.findIndex((t) => t.id === taskId) : nextReviewIndex(tasks));
  const task = tasks[index];
  const progress = detail?.progress ?? overview.progress;
  const toTask = (id: string) => navigate(`?${new URLSearchParams({ batch: detail!.batch.id, task: id })}`, { preventScrollReset: true });
  async function prepare() {
    prepareId.current ??= crypto.randomUUID();
    const result = await run<{ batchId: string; created: boolean }>("POST", "/api/admin/review/batches", { requestId: prepareId.current, count: 20 }, { label: `prepare-${prepareId.current}`, revalidate: false });
    if (!result) { setPrepareMessage("未能准备标注。若提示没有已分析新闻，请等待后台完成真实更新后重试；这里不会触发模型调用。已有标注仍保留。"); return; }
    prepareId.current = null;
    setPrepareMessage(""); navigate(`?${new URLSearchParams({ batch: result.batchId })}`);
  }
  return <AdminPage title="新闻标注" subtitle="对照原文，分别判断 AI 相关性、分类、摘要和精选。保存后继续，冻结前可回看修改。" actions={<Button busy={pending !== null} onClick={prepare}>准备 20 条辅助标注</Button>}>
    <CalibrationPanel overview={calibration} onOpen={(batchId) => navigate(`?${new URLSearchParams({ batch: batchId })}`)} />
    {prepareMessage ? <p role="status" className="mb-4 rounded-control bg-bg-sunk p-3 text-[13px] text-ink-2">{prepareMessage}</p> : null}
    <div className="mb-5 flex flex-wrap items-center gap-3 text-[13px] text-ink-3"><span className="num">已完成 {progress.completed} / {progress.total}</span><span>待标注 {progress.pending}</span><span>跳过 {progress.skipped}</span><span>稍后 {progress.later}</span><Badge>{detail?.batch.mode === "blind" ? "人工盲标" : "辅助标注"}</Badge></div>
    <p className="mb-5 rounded-control bg-bg-sunk p-3 text-[13px] leading-6 text-ink-2">辅助标注用于回看系统判断；一次性校准使用人工盲标，整批拆分为学习和留出验证。这里的离线比较不代表全量新闻准确率或正式验收。</p>
    {progress.total > 0 && progress.completed === progress.total ? <p role="status" className="mb-4 text-[13px] text-ok">本批已全部保存。{calibration.frozen && detail?.batch.id === calibration.batchId ? "校准结果已冻结，可回看。" : detail?.batch.mode === "blind" ? "可在上方完成标注并检验。" : "可以回看修改，或准备下一批。"}</p> : null}
    {overview.batches.length ? <div className="mb-5 flex flex-wrap items-center gap-3"><label className="flex items-center gap-2 text-[13px] text-ink-2">本批<Select aria-label="选择标注批次" value={detail?.batch.id ?? ""} onChange={(e) => navigate(`?${new URLSearchParams({ batch: e.target.value })}`)}>{overview.batches.map((b) => <option key={b.id} value={b.id}>{b.label} · {b.count} 条</option>)}</Select></label>{["json", "csv", "gold"].map((format) => <a key={format} className="text-[13px] text-accent" href={`/api/admin/review/export?${new URLSearchParams({ format, ...(detail ? { batchId: detail.batch.id } : {}) })}`} download>导出 {format === "gold" ? "AI 精选标注" : format.toUpperCase()}</a>)}<Link to="/admin/selectbench" className="text-[13px] text-accent">查看模型评测</Link></div> : null}
    {task ? <><div className="mb-4"><label className="flex items-center gap-2 text-[13px] text-ink-2">回看或继续<Select aria-label="选择标注新闻" value={task.id} onChange={(e) => toTask(e.target.value)}>{tasks.map((t, i) => <option key={t.id} value={t.id}>{i + 1}. {statuses[t.status]} · {t.kind === "relation" ? "关系：" : ""}{t.snapshot.article.title.slice(0, 45)}</option>)}</Select></label></div>
      <div className={`grid items-start gap-5 ${task.kind === "article" ? "xl:grid-cols-[minmax(0,1.15fr)_minmax(360px,1fr)]" : ""}`}><div className={task.kind === "relation" ? "grid gap-4 lg:grid-cols-2" : ""}><Material blind={task.mode === "blind"} material={task.snapshot.article} label={task.kind === "relation" ? "新闻 A" : undefined} />{task.snapshot.related ? <Material blind={task.mode === "blind"} material={task.snapshot.related} label="新闻 B" /> : null}</div>
      <ReviewEditor key={`${task.id}-${task.version}-${editorEpoch}`} task={task} frozen={calibration.frozen && task.batchId === calibration.batchId} hasPrevious={index > 0} onPrevious={() => toTask(tasks[index - 1]!.id)} onReload={() => { setEditorEpoch((epoch) => epoch + 1); navigate(`?${new URLSearchParams({ batch: detail!.batch.id, task: task.id })}`, { replace: true }); }} onSaved={(saved) => { const nextTasks = tasks.map((t) => t.id === saved.id ? saved : t); toTask(nextTasks[nextReviewIndex(nextTasks, saved.id)]!.id); }} /></div>
    </> : <Card><Empty>还没有标注任务。新闻完成分析后，点“准备 20 条”即可开始；不用手动上传文件。阅读和保存标注不会调用模型。</Empty></Card>}
  </AdminPage>;
}

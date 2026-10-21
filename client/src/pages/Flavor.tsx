/**
 * 去AI味：机械检测（词表 / 统计）+ 语义诊断（模型）+ 整章补丁修复。
 * 机械命中在正文中高亮；语义问题带原文证据，可勾选后让 AI 做最小补丁，预览确认再生效。
 */
import { useEffect, useMemo, useState } from 'react';
import { api, sse, countWords } from '../api';
import { useProject } from './ProjectPage';
import { Badge, Spinner, ErrorNote, Empty, Modal, Switch, ConfirmButton } from '../components/ui';

type Severity = 'low' | 'medium' | 'high';

interface Hit {
  id: string;
  type: 'word' | 'stat';
  category?: string;
  code?: string;
  phrase: string;
  reason: string;
  suggestion: string;
  severity: Severity;
  index: number;
  end?: number;
  excerpt?: string;
  count?: number;
  inDialogue?: boolean;
}

interface Violation {
  id: string;
  ruleId: string | null;
  ruleName: string;
  ruleType: string;
  severity: Severity;
  start: number;
  end: number;
  excerpt: string;
  reason: string;
  suggestion: string;
  canAutoRewrite: boolean;
}

interface Trend {
  direction: 'up' | 'down' | 'flat';
  slope: number;
  latest: number;
  first: number;
  series: { id: number; chapterIdx: number | null; score: number; riskScore: number | null; level: string; createdAt: string }[];
}

interface AvoidTerm {
  phrase: string;
  hits: number;
  lastChapter: number | null;
  suggestion: string;
}

interface Report {
  score: number;
  riskScore: number | null;
  level: 'ok' | 'warn' | 'block';
  levelText: string;
  summary: string;
  wordHits: Hit[];
  statHits: Hit[];
  violations: Violation[];
  semantic: { enabled: boolean; riskScore: number | null; summary: string; dropped?: number };
  modelNote: string;
  thresholds: { warn: number; block: number };
  stats: {
    words: number;
    wordScore: number;
    wordRules: number;
    statScore: number;
    wordHits: number;
    statHits: number;
    violations: number;
    invalidEvidence: number;
  };
  trend?: Trend | null;
  avoidTop?: AvoidTerm[];
}

interface RuleItem {
  id: string;
  phrase: string;
  reason: string;
  suggestion: string;
  severity: Severity;
  category: string;
  enabled: boolean;
}

interface FlavorConfig {
  wordEnabled: boolean;
  statEnabled: boolean;
  modelEnabled: boolean;
  avoidEnabled: boolean;
  warnThreshold: number;
  blockThreshold: number;
  avoidMinHits: number;
  avoidLimit: number;
  rules: RuleItem[];
}

interface RewriteState {
  hit: Hit | null;
  selection: string;
  start: number;
  end: number;
  result: string;
  streaming: boolean;
  error: string | null;
  flavor?: { before: number; after: number; newHits: string[] };
}

interface RepairPatch {
  issueId: string;
  ruleName: string;
  start: number;
  end: number;
  before: string;
  after: string;
  reason: string;
}

interface RepairResult {
  text: string;
  summary: string;
  applied: number;
  skipped: { issueId: string; reason: string }[];
  patches: RepairPatch[];
  scoreBefore: number;
  scoreAfter: number;
  wordBefore: number;
  wordAfter: number;
  statBefore: number;
  statAfter: number;
  blockThreshold: number;
  remaining: { phrase: string; severity: Severity; suggestion: string; inDialogue: boolean }[];
}

type Mark =
  | { kind: 'violation'; start: number; end: number; data: Violation }
  | { kind: 'word'; start: number; end: number; data: Hit }
  | { kind: 'stat'; start: number; end: number; data: Hit };

/** 取 index 所在的句子（按中英文句末标点与换行切分） */
function sentenceAt(text: string, index: number) {
  const stops = '。！？!?…\n';
  let start = index;
  while (start > 0 && !stops.includes(text[start - 1])) start--;
  let end = index;
  while (end < text.length && !stops.includes(text[end])) end++;
  if (end < text.length) end++;
  return { start, end, sentence: text.slice(start, end) };
}

/** 覆盖优先级：语义问题 > 词表 > 统计，重叠时只保留优先级更高的一条 */
function buildMarks(text: string, report: Report): Mark[] {
  const candidates: { priority: number; mark: Mark }[] = [];
  for (const v of report.violations) {
    candidates.push({ priority: 0, mark: { kind: 'violation', start: v.start, end: v.end, data: v } });
  }
  for (const h of report.wordHits) {
    candidates.push({
      priority: 1,
      mark: { kind: 'word', start: h.index, end: h.end ?? h.index + h.phrase.length, data: h },
    });
  }
  for (const h of report.statHits) {
    if (!h.excerpt || !h.end || h.end <= h.index) continue;
    candidates.push({ priority: 2, mark: { kind: 'stat', start: h.index, end: h.end, data: h } });
  }
  candidates.sort((a, b) => a.priority - b.priority || a.mark.start - b.mark.start || (b.mark.end - b.mark.start) - (a.mark.end - a.mark.start));
  const accepted: Mark[] = [];
  for (const c of candidates) {
    const m = c.mark;
    if (m.start < 0 || m.end > text.length || m.start >= m.end) continue;
    if (accepted.some((x) => m.start < x.end && m.end > x.start)) continue;
    accepted.push(m);
  }
  return accepted.sort((a, b) => a.start - b.start);
}

const LEVEL_TONE = { ok: 'ok', warn: 'warn', block: 'accent' } as const;
const LEVEL_COLOR = { ok: 'var(--ok)', warn: 'var(--warn)', block: 'var(--accent)' } as const;
const SEVERITY_LABEL: Record<Severity, string> = { low: '轻', medium: '中', high: '重' };
const SEVERITY_TONE: Record<Severity, 'default' | 'warn' | 'accent'> = { low: 'default', medium: 'warn', high: 'accent' };

function ScoreRing({ score, level }: { score: number | null; level?: Report['level'] }) {
  const pct = Math.max(0, Math.min(100, score ?? 0));
  const color = level ? LEVEL_COLOR[level] : 'var(--line-2)';
  return (
    <div
      className={`flavor-ring ${score == null ? 'idle' : ''}`}
      style={{ background: `conic-gradient(${color} ${pct}%, #ece6d9 0)` }}
    >
      <div className="flavor-ring-inner">
        <b>{score == null ? '—' : score}</b>
        <span>{score == null ? '未扫描' : 'AI 腔'}</span>
      </div>
    </div>
  );
}

function LayerRow({ on, title, desc }: { on: boolean; title: string; desc: string }) {
  return (
    <div className="flavor-layer-row">
      <span className={`flavor-layer-dot ${on ? 'on' : ''}`} />
      <div className="flavor-layer-copy">
        <b>{title}</b>
        <small>{desc}</small>
      </div>
      <span className={`flavor-layer-state ${on ? 'on' : ''}`}>{on ? '已启用' : '未启用'}</span>
    </div>
  );
}

function TrendBars({ trend }: { trend: Trend }) {
  const series = trend.series;
  const latest = series[series.length - 1]?.score ?? 0;
  const prev = series.length > 1 ? series[series.length - 2].score : null;
  const delta = prev == null ? null : latest - prev;
  const directionText = trend.direction === 'down' ? '下降' : trend.direction === 'up' ? '上升' : '持平';
  return (
    <div className="flavor-trend-card">
      <div className="flavor-trend-head">
        <b>扫描趋势</b>
        <span className={`flavor-trend-direction ${trend.direction}`}>
          {directionText}{delta != null ? ` · 较上次 ${delta > 0 ? '+' : ''}${delta}` : ''}
        </span>
        <span className="grow" />
        <span className="muted small">最近 {series.length} 次</span>
      </div>
      <div className="flavor-trend" aria-label="最近扫描分数">
        {series.map((s) => (
          <span
            key={s.id}
            className={`flavor-trend-bar ${s.level}`}
            style={{ height: `${Math.max(8, Math.min(100, s.score))}%` }}
            title={`${s.chapterIdx != null ? `第${s.chapterIdx}章 · ` : ''}${s.score} 分${s.riskScore != null ? ` · 语义 ${s.riskScore}` : ''}`}
          />
        ))}
      </div>
    </div>
  );
}

export default function Flavor() {
  const { project, reload } = useProject();
  const withContent = useMemo(() => project.chapters.filter((c) => c.word_count > 0), [project.chapters]);
  const chapters = withContent.length ? withContent : project.chapters;

  const [cid, setCid] = useState<number>(chapters[0]?.id ?? 0);
  const [text, setText] = useState('');
  const [savedText, setSavedText] = useState('');
  const [loaded, setLoaded] = useState(false);
  const [loading, setLoading] = useState(false);
  const [scanning, setScanning] = useState(false);
  const [saving, setSaving] = useState(false);
  const [report, setReport] = useState<Report | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [note, setNote] = useState<string | null>(null);
  const [config, setConfig] = useState<FlavorConfig | null>(null);
  const [rewrite, setRewrite] = useState<RewriteState | null>(null);
  const [sideTab, setSideTab] = useState<'report' | 'issues' | 'settings'>('report');

  const [trend, setTrend] = useState<Trend | null>(null);
  const [avoidTop, setAvoidTop] = useState<AvoidTerm[]>([]);
  const [checked, setChecked] = useState<Record<string, boolean>>({});
  const [selectedIssue, setSelectedIssue] = useState<string | null>(null);
  const [repairing, setRepairing] = useState(false);
  const [repairResult, setRepairResult] = useState<RepairResult | null>(null);

  useEffect(() => {
    api.get('/flavor/settings').then(setConfig).catch(() => {});
  }, []);

  useEffect(() => {
    if (!project.id) return;
    api.get(`/projects/${project.id}/flavor-history`).then((d) => {
      setTrend(d.trend || null);
    }).catch(() => {});
    api.get(`/projects/${project.id}/flavor-avoid`).then((d) => setAvoidTop(d.terms || [])).catch(() => {});
  }, [project.id]);

  /** 轻提示 3 秒后自动收起，避免一直占着版面 */
  useEffect(() => {
    if (!note) return;
    const t = window.setTimeout(() => setNote(null), 3000);
    return () => window.clearTimeout(t);
  }, [note]);

  useEffect(() => {
    if (!cid) return;
    let alive = true;
    setLoading(true);
    setErr(null);
    setReport(null);
    setLoaded(false);
    setRewrite(null);
    setRepairResult(null);
    api.get(`/projects/${project.id}/chapters/${cid}`)
      .then((c) => { if (alive) { setText(c.content || ''); setSavedText(c.content || ''); setLoaded(true); } })
      .catch((e) => { if (alive) setErr(e.message); })
      .finally(() => { if (alive) setLoading(false); });
    return () => { alive = false; };
  }, [cid, project.id]);

  /** 每次换报告都重置勾选：默认只勾选允许自动修复的问题 */
  useEffect(() => {
    if (!report) {
      setChecked({});
      setSelectedIssue(null);
      return;
    }
    const next: Record<string, boolean> = {};
    for (const v of report.violations) next[v.id] = v.canAutoRewrite;
    setChecked(next);
    setSelectedIssue(null);
  }, [report]);

  const chapter = chapters.find((c) => c.id === cid);

  async function scan() {
    if (!cid || !text.trim()) return;
    setScanning(true);
    setErr(null);
    setNote(null);
    try {
      const r = await api.post(`/projects/${project.id}/chapters/${cid}/flavor-scan`, { text });
      setReport(r);
      setTrend(r.trend || null);
      setAvoidTop(r.avoidTop || []);
      setSideTab('report');
    } catch (e: any) {
      setErr(e.message);
    } finally {
      setScanning(false);
    }
  }

  async function save() {
    if (!cid || !dirty) return;
    const content = text;
    setSaving(true);
    setErr(null);
    try {
      await api.put(`/projects/${project.id}/chapters/${cid}/content?reason=manual`, { content });
      setSavedText(content);
      setNote('已保存到本章正文');
      await reload();
    } catch (e: any) {
      setErr(e.message);
    } finally {
      setSaving(false);
    }
  }

  function openRewrite(hit: Hit) {
    const { start, end, sentence } = sentenceAt(text, hit.index);
    setRewrite({ hit, selection: sentence, start, end, result: '', streaming: true, error: null });
    let acc = '';
    sse(`/projects/${project.id}/chapters/${cid}/flavor-rewrite`, {
      selection: sentence,
      hits: [hit],
      before: text.slice(Math.max(0, start - 200), start),
      after: text.slice(end, end + 200),
    }, {
      onDelta: (d) => {
        acc += d.text;
        setRewrite((s) => (s ? { ...s, result: acc } : s));
      },
      onDone: (d) => {
        const flavor = (d as typeof d & { flavor?: RewriteState['flavor'] }).flavor;
        setRewrite((s) => (s ? { ...s, result: d.text || acc, streaming: false, flavor } : s));
      },
      onError: (d) => {
        setRewrite((s) => (s ? { ...s, streaming: false, error: d.message } : s));
      },
    });
  }

  function applyRewrite() {
    if (!rewrite) return;
    const next = text.slice(0, rewrite.start) + rewrite.result.trim() + text.slice(rewrite.end);
    setText(next);
    setRewrite(null);
    setReport(null);
    setSideTab('report');
    setNote('已替换该句，记得点「保存到本章」');
  }

  async function repairSelected() {
    if (!report) return;
    const selected = report.violations.filter((v) => checked[v.id]);
    if (!selected.length) return;
    setRepairing(true);
    setErr(null);
    setNote(null);
    try {
      const r = await api.post(`/projects/${project.id}/chapters/${cid}/flavor-repair`, {
        text,
        issues: selected.map((v) => ({
          issueId: v.id,
          ruleName: v.ruleName,
          excerpt: v.excerpt,
          reason: v.reason,
          suggestion: v.suggestion,
          severity: v.severity,
        })),
      });
      if (!r.applied) {
        setNote(r.summary || '模型没有给出可安全应用的补丁，可先手动改写');
      } else {
        setRepairResult(r);
      }
    } catch (e: any) {
      setErr(e.message);
    } finally {
      setRepairing(false);
    }
  }

  function applyRepair() {
    if (!repairResult) return;
    setText(repairResult.text);
    const count = repairResult.applied;
    const delta = `${repairResult.scoreBefore}→${repairResult.scoreAfter}`;
    setRepairResult(null);
    setReport(null);
    setSideTab('report');
    setNote(`已应用 ${count} 处补丁，机械分 ${delta}；记得保存并重新扫描确认`);
  }

  function locateViolation(v: Violation) {
    setSideTab('report');
    setSelectedIssue(v.id);
    window.setTimeout(() => {
      document.getElementById(`flavor-mark-${v.id}`)?.scrollIntoView({ block: 'center', behavior: 'smooth' });
    }, 60);
  }

  async function saveConfig(patch: Partial<FlavorConfig>) {
    if (!config) return;
    const next = { ...config, ...patch };
    setConfig(next);
    try {
      const saved = await api.put('/flavor/settings', next);
      setConfig(saved);
    } catch (e: any) {
      setErr(e.message);
    }
  }

  /** 拖动结束 / 键盘调整后再落库，避免滑动过程中反复请求 */
  function commitThreshold(key: 'warnThreshold' | 'blockThreshold', value: number) {
    saveConfig({ [key]: value } as Partial<FlavorConfig>);
  }

  async function resetRules() {
    try {
      const saved = await api.post('/flavor/rules/reset');
      setConfig(saved);
      setNote('词表已恢复默认');
    } catch (e: any) {
      setErr(e.message);
    }
  }

  async function clearAvoid() {
    try {
      await api.post(`/projects/${project.id}/flavor-avoid/reset`);
      setAvoidTop([]);
      setNote('已清空本书避雷库，之后扫描新的正文时会重新累积');
    } catch (e: any) {
      setErr(e.message);
    }
  }

  const marks = useMemo(() => (report ? buildMarks(text, report) : []), [report, text]);

  const segments = useMemo(() => {
    if (!report) return [{ text, mark: null as Mark | null }];
    const out: { text: string; mark: Mark | null }[] = [];
    let cur = 0;
    for (const m of marks) {
      if (m.start < cur) continue;
      if (m.start > cur) out.push({ text: text.slice(cur, m.start), mark: null });
      out.push({ text: text.slice(m.start, m.end), mark: m });
      cur = m.end;
    }
    if (cur < text.length) out.push({ text: text.slice(cur), mark: null });
    return out;
  }, [report, text, marks]);

  /** 词表命中按短语聚合，长清单更易读 */
  const wordGroups = useMemo(() => {
    if (!report) return [];
    const map = new Map<string, { hit: Hit; count: number; dialogue: number }>();
    for (const h of report.wordHits) {
      const group = map.get(h.phrase);
      if (group) {
        group.count++;
        if (h.inDialogue) group.dialogue++;
      } else {
        map.set(h.phrase, { hit: h, count: 1, dialogue: h.inDialogue ? 1 : 0 });
      }
    }
    return [...map.values()].sort((a, b) => b.count - a.count || a.hit.index - b.hit.index);
  }, [report]);

  const allHits = report ? [...report.wordHits, ...report.statHits] : [];
  const violationRuleCounts = useMemo(() => {
    const map = new Map<string, number>();
    for (const v of report?.violations || []) {
      map.set(v.ruleName, (map.get(v.ruleName) || 0) + 1);
    }
    return map;
  }, [report]);
  const autoViolations = report ? report.violations.filter((v) => v.canAutoRewrite) : [];
  const checkedCount = report ? report.violations.filter((v) => checked[v.id]).length : 0;
  const allAutoChecked = autoViolations.length > 0 && autoViolations.every((v) => checked[v.id]);
  const dirty = loaded && text !== savedText;
  const activeTrend = report?.trend || trend;

  function toggleAllAuto(next: boolean) {
    if (!report) return;
    const map: Record<string, boolean> = { ...checked };
    for (const v of report.violations) {
      if (v.canAutoRewrite) map[v.id] = next;
    }
    setChecked(map);
  }

  if (!chapters.length) {
    return <Empty title="还没有章节" desc="先在「架构规划」里拆章，再来做去AI味。" />;
  }

  return (
    <div className="page flavor-page">
      <div className="page-head flavor-head">
        <div>
          <h1>去AI味</h1>
          <div className="sub">词表与统计找证据，模型做语义诊断；勾选问题后可整章补丁修复，确认后才写回正文。</div>
        </div>
        <div className="flavor-actions">
          <select value={cid} onChange={(e) => setCid(Number(e.target.value))} aria-label="选择章节">
            {chapters.map((c) => (
              <option key={c.id} value={c.id}>第{c.idx}章《{c.title || '未命名'}》</option>
            ))}
          </select>
          <button className="btn primary" onClick={scan} disabled={scanning || !text.trim()} title={!text.trim() ? '先写或粘贴一段正文' : '扫描本章 AI 腔'}>
            {scanning ? '扫描中…' : report ? '重新扫描' : '扫描本章'}
          </button>
        </div>
      </div>

      {err && <ErrorNote error={err} />}
      {note && <div className="hint-box flavor-note"><span>{note}</span></div>}

      <div className="flavor-layout">
        <section className="editor-card">
          <div className="flavor-editor-head">
            <div className="flavor-editor-title">
              <span className="flavor-chapter-badge">第{chapter?.idx ?? '—'}章</span>
              <h2>{chapter?.title || '未命名'}</h2>
            </div>
            <div className="flavor-editor-meta">
              {report ? (
                <Badge tone={LEVEL_TONE[report.level]}>{report.levelText}</Badge>
              ) : (
                <span className="flavor-status-idle">待扫描</span>
              )}
              {loaded && (
                <span className={`flavor-save-flag ${dirty ? 'dirty' : ''}`}>
                  <i />{dirty ? '未保存' : '已保存'}
                </span>
              )}
              <span className="flavor-wordcount"><b>{countWords(text)}</b> 字</span>
            </div>
          </div>

          {report && (
            <div className="flavor-legend">
              <span><i className="flavor-dot phrase" />词表命中 {report.wordHits.length} 处 / {report.stats.wordRules} 类</span>
              <span><i className="flavor-dot signal" />统计信号 {report.statHits.length}</span>
              <span><i className="flavor-dot violation" />语义问题 {report.violations.length}</span>
              <span className="muted">
                {report.violations.length ? '点红色问题可查看原因；点黄色词可改写所在句' : '点击高亮可查看原因或改写'}
              </span>
            </div>
          )}

          {loading ? (
            <div className="loading-block flavor-loading"><Spinner text="正在打开章节…" /></div>
          ) : report ? (
            <div className="flavor-paper">
              <div className="flavor-paper-inner">
                {segments.map((s, i) => {
                  const m = s.mark;
                  if (!m) return <span key={i}>{s.text}</span>;
                  if (m.kind === 'word') {
                    return (
                      <mark
                        key={i}
                        className={`flavor-mark sev-${m.data.severity}`}
                        title={`${m.data.reason}\n建议：${m.data.suggestion}`}
                        onClick={() => openRewrite(m.data)}
                      >
                        {s.text}
                      </mark>
                    );
                  }
                  if (m.kind === 'stat') {
                    return (
                      <mark
                        key={i}
                        className="flavor-mark signal"
                        title={`${m.data.phrase}\n${m.data.reason}\n建议：${m.data.suggestion}`}
                      >
                        {s.text}
                      </mark>
                    );
                  }
                  const v = m.data;
                  return (
                    <mark
                      id={`flavor-mark-${v.id}`}
                      key={i}
                      className={`flavor-mark violation ${selectedIssue === v.id ? 'selected' : ''}`}
                      title={`${v.ruleName}\n${v.reason}\n建议：${v.suggestion}`}
                      onClick={() => {
                        setSelectedIssue(v.id);
                        setSideTab('issues');
                      }}
                    >
                      {s.text}
                    </mark>
                  );
                })}
              </div>
            </div>
          ) : (
            <textarea
              className="flavor-input"
              value={text}
              spellCheck={false}
              placeholder="本章还没有正文，或直接粘贴一段文字来检测。"
              onChange={(e) => setText(e.target.value)}
            />
          )}

          <div className="flavor-editor-foot">
            {report ? (
              <button className="btn ghost small" onClick={() => setReport(null)}>← 回到编辑</button>
            ) : (
              <span className="muted small">{loaded ? '内容只在本机处理' : '正在读取正文…'}</span>
            )}
            <span className="grow" />
            <span className="muted small">
              {report ? `命中 ${allHits.length} 处 · 语义问题 ${report.violations.length} 处` : '扫描后会标出可改写的位置'}
            </span>
            <button
              className={`btn small ${dirty ? 'primary' : ''}`}
              onClick={save}
              disabled={saving || !dirty || !cid}
            >
              {saving ? '保存中…' : dirty ? '保存到本章' : '已保存'}
            </button>
          </div>
        </section>

        <aside className="flavor-side">
          <section className="card flavor-panel">
            <div className="flavor-tabs" role="tablist" aria-label="检测面板">
              <button
                type="button"
                role="tab"
                aria-selected={sideTab === 'report'}
                className="flavor-tab"
                onClick={() => setSideTab('report')}
              >
                检测报告
                {report ? <span className="flavor-tab-count">{report.score}</span> : null}
              </button>
              <button
                type="button"
                role="tab"
                aria-selected={sideTab === 'issues'}
                className="flavor-tab"
                onClick={() => setSideTab('issues')}
                disabled={!report}
              >
                问题清单
                {report && report.violations.length ? <span className="flavor-tab-count">{report.violations.length}</span> : null}
              </button>
              <button
                type="button"
                role="tab"
                aria-selected={sideTab === 'settings'}
                className="flavor-tab"
                onClick={() => setSideTab('settings')}
                disabled={!config}
              >
                检测设置
              </button>
              <span className="grow" />
              {sideTab === 'settings' ? <span className="flavor-auto">改动即保存</span> : null}
            </div>

            <div className="flavor-panel-body">
            {sideTab === 'report' && (report ? (
              <>
                <div className="flavor-score">
                  <ScoreRing score={report.score} level={report.level} />
                  <div className="flavor-score-copy">
                    <div className="flavor-score-top">
                      <b>{report.levelText}</b>
                      <span className="muted small">阈值 {report.thresholds.warn} / {report.thresholds.block}</span>
                    </div>
                    <p className="flavor-summary">{report.summary}</p>
                  </div>
                </div>

                <div className="flavor-metrics four">
                  <div><span>词表</span><b>{report.stats.wordScore}</b></div>
                  <div><span>统计</span><b>{report.stats.statScore}</b></div>
                  <div><span title="语义诊断层给出的表达风险">语义</span><b>{report.riskScore ?? '—'}</b></div>
                  <div><span>问题</span><b>{report.violations.length}</b></div>
                </div>

                {report.semantic.enabled && report.stats.invalidEvidence > 0 && (
                  <div className="flavor-evidence-note">
                    已丢弃 {report.stats.invalidEvidence} 条找不到原文依据的模型问题，避免误改。
                  </div>
                )}
                {report.modelNote && <div className="flavor-model-note">语义诊断：{report.modelNote}</div>}
                {!report.semantic.enabled && (
                  <div className="flavor-evidence-note">
                    {config?.modelEnabled
                      ? '语义诊断本次没有返回结果，当前只显示机械候选；可稍后重新扫描。'
                      : '当前只显示机械候选（词表/统计），正常表达也可能被算入；开启「语义诊断层」后会结合上下文判断。'}
                  </div>
                )}

                {activeTrend && activeTrend.series.length > 1 && <TrendBars trend={activeTrend} />}

                <div className="flavor-hits-head">
                  <b>词表命中</b>
                  <span className="chip">{report.wordHits.length}</span>
                </div>
                {wordGroups.length ? (
                  <div className="flavor-hits">
                    {wordGroups.slice(0, 40).map(({ hit, count, dialogue }) => (
                      <div key={hit.phrase} className={`flavor-hit phrase sev-${hit.severity}`}>
                        <div className="flavor-hit-top">
                          <Badge tone={SEVERITY_TONE[hit.severity]}>{SEVERITY_LABEL[hit.severity]}</Badge>
                          <b>「{hit.phrase}」</b>
                          {count > 1 ? <span className="chip">×{count}</span> : null}
                          <button className="btn ghost small" onClick={() => openRewrite({ ...hit, index: hit.index })}>改写首处</button>
                        </div>
                        <div className="flavor-hit-reason">{hit.reason}</div>
                        {hit.suggestion ? <div className="flavor-hit-suggestion">建议：{hit.suggestion}</div> : null}
                        {dialogue ? (
                          <div className="flavor-hit-suggestion">其中对白 {dialogue} 处，已降低计分权重</div>
                        ) : null}
                      </div>
                    ))}
                  </div>
                ) : (
                  <div className="flavor-clear">✓ 词表没有命中。</div>
                )}

                <div className="flavor-hits-head flavor-hits-head-gap">
                  <b>统计信号</b>
                  <span className="chip">{report.statHits.length}</span>
                </div>
                {report.statHits.length ? (
                  <div className="flavor-hits">
                    {report.statHits.map((h) => (
                      <div key={h.id} className={`flavor-hit signal sev-${h.severity}`}>
                        <div className="flavor-hit-top">
                          <Badge tone="info">统计</Badge>
                          <b>{h.phrase}</b>
                        </div>
                        <div className="flavor-hit-reason">{h.reason}</div>
                        {h.suggestion ? <div className="flavor-hit-suggestion">建议：{h.suggestion}</div> : null}
                      </div>
                    ))}
                  </div>
                ) : (
                  <div className="flavor-clear">✓ 统计层没有发现机械特征。</div>
                )}
              </>
            ) : (
              <>
                <div className="flavor-score">
                  <ScoreRing score={null} />
                  <div className="flavor-score-copy">
                    <div className="flavor-score-top"><b>还没有检测</b></div>
                    <p className="flavor-summary">扫描会先做词表与句式统计，再可选让模型做语义诊断；问题可按补丁方式修复。</p>
                  </div>
                </div>
                <div className="flavor-layer-list">
                  <LayerRow on={!!config?.wordEnabled} title="词表命中层" desc="禁用表达、套路化用词" />
                  <LayerRow on={!!config?.statEnabled} title="统计特征层" desc="句长、句首复读、虚词与副词聚集" />
                  <LayerRow on={!!config?.modelEnabled} title="语义诊断层" desc="结合上下文判断套路与空转，需要 AI 通道" />
                  <LayerRow on={!!config?.avoidEnabled} title="文风避雷库" desc="把反复出现的 AI 腔注入下一次生成" />
                </div>
                {activeTrend && activeTrend.series.length ? (
                  <div className="flavor-last-scan">
                    最近一次扫描 AI 腔 <b>{activeTrend.latest}</b> 分，
                    {activeTrend.direction === 'down' ? '整体在下降' : activeTrend.direction === 'up' ? '整体在上升' : '整体持平'}。
                  </div>
                ) : null}
                <div className="flavor-empty-hint">点击右上角「扫描本章」开始检测。检测结果不会改动正文，只有你确认改写后才会变化。</div>
              </>
            ))}

            {sideTab === 'issues' && report && (
              <div className="flavor-issues-body">
                {report.violations.length ? (
                  <>
                    <div className="flavor-issue-toolbar">
                      <label className="flavor-issue-selectall">
                        <input
                          type="checkbox"
                          checked={allAutoChecked}
                          onChange={(e) => toggleAllAuto(e.target.checked)}
                          disabled={!autoViolations.length}
                        />
                        全选可自动修复
                      </label>
                      <span className="muted small">共 {report.violations.length} 条，可自动修复 {autoViolations.length} 条</span>
                    </div>
                    <div className="flavor-issue-list">
                      {report.violations.map((v) => (
                        <div
                          key={v.id}
                          className={`flavor-issue sev-${v.severity} ${selectedIssue === v.id ? 'selected' : ''}`}
                          onClick={() => setSelectedIssue(v.id)}
                        >
                          <label className="flavor-issue-check" onClick={(e) => e.stopPropagation()}>
                            <input
                              type="checkbox"
                              checked={!!checked[v.id]}
                              disabled={!v.canAutoRewrite}
                              onChange={(e) => setChecked((prev) => ({ ...prev, [v.id]: e.target.checked }))}
                            />
                          </label>
                          <div className="grow">
                            <div className="flavor-issue-head">
                              <Badge tone={SEVERITY_TONE[v.severity]}>{SEVERITY_LABEL[v.severity]}</Badge>
                              <b>{v.ruleName}</b>
                              {(violationRuleCounts.get(v.ruleName) || 1) > 1 ? (
                                <span className="chip">同规则 {violationRuleCounts.get(v.ruleName)} 处</span>
                              ) : null}
                              {!v.canAutoRewrite && <span className="muted small">需人工修改</span>}
                            </div>
                            <div className="flavor-issue-excerpt">「{v.excerpt}」</div>
                            <div className="flavor-issue-reason">{v.reason}</div>
                            <div className="flavor-issue-suggestion">建议：{v.suggestion}</div>
                            <div className="flavor-issue-actions">
                              <button
                                className="btn ghost small"
                                onClick={(e) => { e.stopPropagation(); locateViolation(v); }}
                              >
                                在正文中定位
                              </button>
                            </div>
                          </div>
                        </div>
                      ))}
                    </div>
                    <div className="flavor-issue-foot">
                      <span className="muted small">只修复勾选的问题；生成补丁后先预览，确认才写回正文。</span>
                      <button
                        className="btn primary"
                        disabled={repairing || checkedCount === 0}
                        onClick={repairSelected}
                      >
                        {repairing ? '生成补丁中…' : `修复选中 ${checkedCount} 处`}
                      </button>
                    </div>
                  </>
                ) : (
                  <div className="flavor-clear">✓ 语义层没有发现问题。机械命中可在「检测报告」里处理。</div>
                )}
              </div>
            )}

            {sideTab === 'settings' && config && (
              <div className="flavor-settings-body">
              <div className="flavor-toggle-list">
                <div className="flavor-toggle">
                  <div className="flavor-toggle-copy">
                    <b>词表命中层</b>
                    <small>禁用表达、套路化用词</small>
                  </div>
                  <Switch checked={config.wordEnabled} onChange={(v) => saveConfig({ wordEnabled: v })} />
                </div>
                <div className="flavor-toggle">
                  <div className="flavor-toggle-copy">
                    <b>统计特征层</b>
                    <small>句长、句首复读、虚词与副词聚集</small>
                  </div>
                  <Switch checked={config.statEnabled} onChange={(v) => saveConfig({ statEnabled: v })} />
                </div>
                <div className="flavor-toggle">
                  <div className="flavor-toggle-copy">
                    <b>语义诊断层</b>
                    <small>调用审阅模型，逐条给出原文证据与修改方向</small>
                  </div>
                  <Switch checked={config.modelEnabled} onChange={(v) => saveConfig({ modelEnabled: v })} />
                </div>
                <div className="flavor-toggle">
                  <div className="flavor-toggle-copy">
                    <b>文风避雷库</b>
                    <small>把章节里反复出现的 AI 腔注入下一次生成</small>
                  </div>
                  <Switch checked={config.avoidEnabled} onChange={(v) => saveConfig({ avoidEnabled: v })} />
                </div>
              </div>

              <div className="flavor-thresholds">
                <div className="flavor-threshold">
                  <div className="flavor-threshold-head">
                    <span>警告阈值</span>
                    <b className="warn">{config.warnThreshold}</b>
                  </div>
                  <input
                    className="flavor-range warn"
                    type="range"
                    aria-label="警告阈值"
                    min={0}
                    max={100}
                    value={config.warnThreshold}
                    onChange={(e) => setConfig({ ...config, warnThreshold: Number(e.target.value) })}
                    onPointerUp={(e) => commitThreshold('warnThreshold', Number((e.target as HTMLInputElement).value))}
                    onKeyUp={(e) => commitThreshold('warnThreshold', Number((e.target as HTMLInputElement).value))}
                  />
                </div>
                <div className="flavor-threshold">
                  <div className="flavor-threshold-head">
                    <span>拦截阈值</span>
                    <b>{config.blockThreshold}</b>
                  </div>
                  <input
                    className="flavor-range block"
                    type="range"
                    aria-label="拦截阈值"
                    min={0}
                    max={100}
                    value={config.blockThreshold}
                    onChange={(e) => setConfig({ ...config, blockThreshold: Number(e.target.value) })}
                    onPointerUp={(e) => commitThreshold('blockThreshold', Number((e.target as HTMLInputElement).value))}
                    onKeyUp={(e) => commitThreshold('blockThreshold', Number((e.target as HTMLInputElement).value))}
                  />
                </div>
              </div>

              {config.avoidEnabled && (
                <div className="flavor-avoid-settings">
                  <div className="flavor-avoid-head">
                    <b>避雷库</b>
                    <span className="muted small">出现不少于 N 次才注入，最多注入 M 条</span>
                  </div>
                  <div className="flavor-avoid-inputs">
                    <label>
                      门槛
                      <input
                        type="number"
                        min={1}
                        max={20}
                        value={config.avoidMinHits}
                        onChange={(e) => setConfig({ ...config, avoidMinHits: Number(e.target.value) })}
                        onBlur={(e) => saveConfig({ avoidMinHits: Number(e.target.value) })}
                      />
                    </label>
                    <label>
                      条数
                      <input
                        type="number"
                        min={1}
                        max={25}
                        value={config.avoidLimit}
                        onChange={(e) => setConfig({ ...config, avoidLimit: Number(e.target.value) })}
                        onBlur={(e) => saveConfig({ avoidLimit: Number(e.target.value) })}
                      />
                    </label>
                  </div>
                  {avoidTop.length ? (
                    <div className="flavor-avoid-preview">
                      {avoidTop.slice(0, 10).map((x) => (
                        <span key={x.phrase} className="flavor-avoid-chip" title={x.suggestion}>
                          「{x.phrase}」×{x.hits}
                        </span>
                      ))}
                    </div>
                  ) : (
                    <div className="muted small flavor-avoid-empty">还没有累积到足够的命中；多扫描几章后会自动出现在生成上下文里。</div>
                  )}
                  <ConfirmButton className="btn ghost small flavor-reset" onConfirm={clearAvoid}>清空本书避雷库</ConfirmButton>
                </div>
              )}

              <details className="flavor-words">
                <summary>
                  <span>词表</span>
                  <span className="chip">{config.rules.filter((x) => x.enabled).length}/{config.rules.length} 启用</span>
                  <span className="grow" />
                  <span className="flavor-caret">▾</span>
                </summary>
                <div className="flavor-word-list">
                  {config.rules.map((rule) => (
                    <label key={rule.id} className={`flavor-word ${rule.enabled ? 'on' : ''}`} title={`${rule.reason}｜${rule.category}`}>
                      <input
                        type="checkbox"
                        checked={rule.enabled}
                        onChange={(e) => saveConfig({ rules: config.rules.map((x) => (x.id === rule.id ? { ...x, enabled: e.target.checked } : x)) })}
                      />
                      <i className={`flavor-sev-dot ${rule.severity}`} />
                      <span>{rule.phrase}</span>
                    </label>
                  ))}
                </div>
                <button className="btn ghost small flavor-reset" onClick={resetRules}>恢复默认词表</button>
              </details>
              </div>
            )}
            {sideTab === 'settings' && !config && (
              <div className="flavor-panel-loading"><Spinner text="正在读取检测设置…" /></div>
            )}
            </div>
          </section>
        </aside>
      </div>

      {rewrite && (
        <Modal title="AI 重写该句" onClose={() => setRewrite(null)} wide>
          <div className="stack">
            {rewrite.hit && (
              <div className="flavor-rewrite-hint">
                <Badge tone={SEVERITY_TONE[rewrite.hit.severity]}>命中「{rewrite.hit.phrase}」</Badge>
                <span>{rewrite.hit.reason}</span>
                {rewrite.hit.suggestion ? <span className="muted">建议：{rewrite.hit.suggestion}</span> : null}
              </div>
            )}
            <div className="flavor-compare">
              <div className="flavor-compare-col">
                <div className="flavor-compare-label">原句</div>
                <div className="flavor-compare-body">{rewrite.selection}</div>
              </div>
              <div className="flavor-compare-arrow">→</div>
              <div className="flavor-compare-col">
                <div className="flavor-compare-label">改写</div>
                <div className={`flavor-compare-body ${rewrite.streaming ? 'streaming' : ''}`}>
                  {rewrite.result || (rewrite.streaming ? '生成中…' : '（暂无内容）')}
                </div>
              </div>
            </div>
            {rewrite.flavor && !rewrite.streaming ? (
              <div className={`flavor-rewrite-score ${rewrite.flavor.after > rewrite.flavor.before || rewrite.flavor.newHits.length ? 'bad' : rewrite.flavor.after < rewrite.flavor.before ? 'good' : ''}`}>
                机械命中 {rewrite.flavor.before} → {rewrite.flavor.after}
                {rewrite.flavor.newHits.length
                  ? ` · 新引入：${rewrite.flavor.newHits.join('、')}`
                  : rewrite.flavor.after < rewrite.flavor.before
                    ? ' · 已减少模板词'
                    : ''}
              </div>
            ) : null}
            {rewrite.error && <ErrorNote error={rewrite.error} />}
            <div className="row">
              <span className="grow" />
              <button className="btn" onClick={() => setRewrite(null)}>取消</button>
              <button className="btn primary" disabled={rewrite.streaming || !rewrite.result.trim()} onClick={applyRewrite}>替换回正文</button>
            </div>
          </div>
        </Modal>
      )}

      {repairResult && (
        <Modal title="整章修复预览" onClose={() => setRepairResult(null)} wide>
          <div className="stack">
            <div className="flavor-repair-summary">
              {repairResult.summary || `已生成 ${repairResult.applied} 处补丁`}
            </div>
            <div className={`flavor-repair-score ${repairResult.scoreAfter > repairResult.scoreBefore ? 'bad' : repairResult.scoreAfter < repairResult.scoreBefore ? 'good' : ''}`}>
              <span>机械分</span>
              <b>{repairResult.scoreBefore} → {repairResult.scoreAfter}</b>
              <span className="muted small">
                词表 {repairResult.wordBefore}→{repairResult.wordAfter} · 统计 {repairResult.statBefore}→{repairResult.statAfter}
              </span>
            </div>
            {repairResult.scoreAfter > repairResult.scoreBefore ? (
              <div className="flavor-repair-warn">修复后机械分上升，可能是补丁换入了新的模板表达；建议取消或只保留部分补丁。</div>
            ) : repairResult.scoreAfter >= repairResult.blockThreshold ? (
              <div className="flavor-repair-warn">修复后仍有拦截级机械信号，建议应用后再扫描一轮。</div>
            ) : null}
            {repairResult.remaining.length > 0 ? (
              <div className="flavor-remaining">
                修复后仍有：
                {repairResult.remaining.slice(0, 6).map((x) => (
                  <span key={`${x.phrase}-${x.inDialogue}`} className="flavor-avoid-chip" title={x.suggestion}>
                    「{x.phrase}」{x.inDialogue ? '（对白）' : ''}
                  </span>
                ))}
              </div>
            ) : null}
            {repairResult.patches.length ? (
              <div className="flavor-patch-list">
                {repairResult.patches.map((p, i) => (
                  <div key={`${p.issueId}-${i}`} className="flavor-patch">
                    <div className="flavor-patch-head">
                      <Badge tone="info">{p.ruleName || '补丁'}</Badge>
                      {p.reason ? <span className="muted small">{p.reason}</span> : null}
                    </div>
                    <div className="flavor-patch-diff">
                      <div className="flavor-patch-before">{p.before}</div>
                      <div className="flavor-patch-arrow">→</div>
                      <div className="flavor-patch-after">{p.after}</div>
                    </div>
                  </div>
                ))}
              </div>
            ) : (
              <div className="muted">没有可应用的补丁。</div>
            )}
            {repairResult.skipped.length > 0 && (
              <details className="flavor-patch-skipped">
                <summary>已跳过 {repairResult.skipped.length} 条（证据不匹配、引入新 AI 腔或改动风险过高）</summary>
                <div className="flavor-patch-skipped-list">
                  {repairResult.skipped.map((s, i) => (
                    <div key={i}>· {s.reason}</div>
                  ))}
                </div>
              </details>
            )}
            <div className="row">
              <span className="grow" />
              <button className="btn" onClick={() => setRepairResult(null)}>取消</button>
              <button className="btn primary" disabled={!repairResult.applied} onClick={applyRepair}>
                应用 {repairResult.applied} 处并回到编辑
              </button>
            </div>
          </div>
        </Modal>
      )}
    </div>
  );
}

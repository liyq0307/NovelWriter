/**
 * 去AI味：三层检测（词表 / 统计 / 模型评分）与逐处改写。
 * 词表命中在正文中高亮，点一下即可让 AI 重写该句，确认后替换并保存。
 */
import { useEffect, useMemo, useState } from 'react';
import { api, sse, countWords } from '../api';
import { useProject } from './ProjectPage';
import { Badge, Spinner, ErrorNote, Empty, Modal } from '../components/ui';

interface Hit {
  id: string;
  type: 'word' | 'stat';
  phrase: string;
  reason: string;
  suggestion: string;
  index: number;
}

interface Report {
  score: number;
  level: 'ok' | 'warn' | 'block';
  levelText: string;
  summary: string;
  wordHits: Hit[];
  statHits: Hit[];
  modelScore: number | null;
  modelNote: string;
  thresholds: { warn: number; block: number };
  stats: { words: number; wordScore: number; statScore: number };
}

interface RuleItem {
  id: string;
  phrase: string;
  reason: string;
  suggestion: string;
  enabled: boolean;
}

interface FlavorConfig {
  wordEnabled: boolean;
  statEnabled: boolean;
  modelEnabled: boolean;
  warnThreshold: number;
  blockThreshold: number;
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
}

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

const LEVEL_TONE = { ok: 'ok', warn: 'warn', block: 'accent' } as const;

export default function Flavor() {
  const { project, reload } = useProject();
  const withContent = useMemo(() => project.chapters.filter((c) => c.word_count > 0), [project.chapters]);
  const chapters = withContent.length ? withContent : project.chapters;

  const [cid, setCid] = useState<number>(chapters[0]?.id ?? 0);
  const [text, setText] = useState('');
  const [loaded, setLoaded] = useState(false);
  const [loading, setLoading] = useState(false);
  const [scanning, setScanning] = useState(false);
  const [saving, setSaving] = useState(false);
  const [report, setReport] = useState<Report | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [note, setNote] = useState<string | null>(null);
  const [config, setConfig] = useState<FlavorConfig | null>(null);
  const [rewrite, setRewrite] = useState<RewriteState | null>(null);

  useEffect(() => {
    api.get('/flavor/settings').then(setConfig).catch(() => {});
  }, []);

  useEffect(() => {
    if (!cid) return;
    let alive = true;
    setLoading(true);
    setErr(null);
    setReport(null);
    api.get(`/projects/${project.id}/chapters/${cid}`)
      .then((c) => { if (alive) { setText(c.content || ''); setLoaded(true); } })
      .catch((e) => { if (alive) setErr(e.message); })
      .finally(() => { if (alive) setLoading(false); });
    return () => { alive = false; };
  }, [cid, project.id]);

  const chapter = chapters.find((c) => c.id === cid);

  async function scan() {
    if (!cid || !text.trim()) return;
    setScanning(true);
    setErr(null);
    setNote(null);
    try {
      const r = await api.post(`/projects/${project.id}/chapters/${cid}/flavor-scan`, { text });
      setReport(r);
    } catch (e: any) {
      setErr(e.message);
    } finally {
      setScanning(false);
    }
  }

  async function save() {
    if (!cid) return;
    setSaving(true);
    setErr(null);
    try {
      await api.put(`/projects/${project.id}/chapters/${cid}/content?reason=manual`, { content: text });
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
        setRewrite((s) => (s ? { ...s, result: d.text || acc, streaming: false } : s));
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
    setNote('已替换该句，记得点「保存到本章」');
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

  async function resetRules() {
    try {
      const saved = await api.post('/flavor/rules/reset');
      setConfig(saved);
      setNote('词表已恢复默认');
    } catch (e: any) {
      setErr(e.message);
    }
  }

  const segments = useMemo(() => {
    if (!report) return [{ text, hit: null as Hit | null }];
    const marks = [...report.wordHits].sort((a, b) => a.index - b.index);
    const out: { text: string; hit: Hit | null }[] = [];
    let cur = 0;
    for (const h of marks) {
      if (h.index < cur) continue;
      if (h.index > cur) out.push({ text: text.slice(cur, h.index), hit: null });
      out.push({ text: text.slice(h.index, h.index + h.phrase.length), hit: h });
      cur = h.index + h.phrase.length;
    }
    if (cur < text.length) out.push({ text: text.slice(cur), hit: null });
    return out;
  }, [report, text]);

  if (!chapters.length) {
    return <Empty title="还没有章节" desc="先在「架构规划」里拆章，再来做去AI味。" />;
  }

  return (
    <div className="page">
      <div className="page-head">
        <div>
          <h1>去AI味</h1>
          <div className="sub">词表命中 → 统计特征 → 模型评分；点正文里的高亮即可逐句改写。</div>
        </div>
        <div className="row">
          <select value={cid} onChange={(e) => setCid(Number(e.target.value))}>
            {chapters.map((c) => (
              <option key={c.id} value={c.id}>第{c.idx}章《{c.title || '未命名'}》</option>
            ))}
          </select>
          <button className="btn primary" onClick={scan} disabled={scanning || !text.trim()}>
            {scanning ? '扫描中…' : '扫描本章'}
          </button>
          <button className="btn" onClick={save} disabled={saving || !cid}>{saving ? '保存中…' : '保存到本章'}</button>
        </div>
      </div>

      {err && <ErrorNote error={err} />}
      {note && <div className="hint-box" style={{ marginBottom: 14 }}><span>{note}</span></div>}

      <div className="grid" style={{ gridTemplateColumns: 'minmax(0, 1.55fr) minmax(300px, 1fr)', alignItems: 'start' }}>
        <div className="editor-card">
          <div className="editor-toolbar">
            {report ? (
              <>
                <Badge tone={LEVEL_TONE[report.level]}>{report.summary.split('。')[0]}</Badge>
                <span className="muted small">词表 {report.wordHits.length} · 统计 {report.statHits.length}</span>
              </>
            ) : (
              <span className="muted small">{chapter ? `第${chapter.idx}章《${chapter.title}》` : ''}</span>
            )}
            <span className="grow" />
            <span className="muted small">{countWords(text)} 字</span>
          </div>
          {loading ? (
            <div className="loading-block"><Spinner text="正在打开章节…" /></div>
          ) : report ? (
            <div className="editor-area" style={{ whiteSpace: 'pre-wrap', overflow: 'auto', maxHeight: '62vh' }}>
              {segments.map((s, i) => (s.hit ? (
                <mark
                  key={i}
                  title={`${s.hit.reason}\n建议：${s.hit.suggestion}`}
                  style={{ background: 'var(--warn-soft)', color: 'inherit', borderRadius: 3, cursor: 'pointer', padding: '0 2px' }}
                  onClick={() => openRewrite(s.hit as Hit)}
                >
                  {s.text}
                </mark>
              ) : (<span key={i}>{s.text}</span>)))}
            </div>
          ) : (
            <textarea
              className="editor-area"
              style={{ width: '100%', resize: 'vertical' }}
              value={text}
              placeholder="本章还没有正文，或直接粘贴一段文字来检测。"
              onChange={(e) => setText(e.target.value)}
            />
          )}
          {report && (
            <div className="editor-foot">
              <button className="btn small" onClick={() => setReport(null)}>回到编辑</button>
              <span className="muted">点高亮词可改写所在句</span>
            </div>
          )}
        </div>

        <div className="stack">
          {report && <ReportCard report={report} onRewrite={openRewrite} />}

          {config && (
            <div className="card">
              <div className="card-title">检测设置</div>
              <div className="stack" style={{ gap: 8 }}>
                <label className="row small"><input type="checkbox" checked={config.wordEnabled} onChange={(e) => saveConfig({ wordEnabled: e.target.checked })} /> 词表命中层</label>
                <label className="row small"><input type="checkbox" checked={config.statEnabled} onChange={(e) => saveConfig({ statEnabled: e.target.checked })} /> 统计特征层</label>
                <label className="row small"><input type="checkbox" checked={config.modelEnabled} onChange={(e) => saveConfig({ modelEnabled: e.target.checked })} /> 模型打分层（需 AI 通道）</label>
                <div className="row small">
                  <span className="muted" style={{ width: 64 }}>警告阈值</span>
                  <input type="range" min={0} max={100} value={config.warnThreshold} onChange={(e) => setConfig({ ...config, warnThreshold: Number(e.target.value) })} onMouseUp={(e) => saveConfig({ warnThreshold: Number((e.target as HTMLInputElement).value) })} style={{ flex: 1 }} />
                  <b>{config.warnThreshold}</b>
                </div>
                <div className="row small">
                  <span className="muted" style={{ width: 64 }}>拦截阈值</span>
                  <input type="range" min={0} max={100} value={config.blockThreshold} onChange={(e) => setConfig({ ...config, blockThreshold: Number(e.target.value) })} onMouseUp={(e) => saveConfig({ blockThreshold: Number((e.target as HTMLInputElement).value) })} style={{ flex: 1 }} />
                  <b>{config.blockThreshold}</b>
                </div>
              </div>
              <details style={{ marginTop: 12 }}>
                <summary className="small muted" style={{ cursor: 'pointer' }}>词表（{config.rules.filter((x) => x.enabled).length}/{config.rules.length} 启用）</summary>
                <div className="stack" style={{ gap: 6, marginTop: 8, maxHeight: 260, overflow: 'auto' }}>
                  {config.rules.map((rule) => (
                    <label key={rule.id} className="row small" title={rule.reason}>
                      <input
                        type="checkbox"
                        checked={rule.enabled}
                        onChange={(e) => saveConfig({ rules: config.rules.map((x) => (x.id === rule.id ? { ...x, enabled: e.target.checked } : x)) })}
                      />
                      <span>{rule.phrase}</span>
                    </label>
                  ))}
                </div>
                <button className="btn small" style={{ marginTop: 8 }} onClick={resetRules}>恢复默认词表</button>
              </details>
            </div>
          )}
        </div>
      </div>

      {rewrite && (
        <Modal title="AI 重写该句" onClose={() => setRewrite(null)} wide>
          <div className="stack">
            {rewrite.hit && (
              <div className="muted small">命中「{rewrite.hit.phrase}」：{rewrite.hit.reason}（{rewrite.hit.suggestion}）</div>
            )}
            <div>
              <div className="muted small" style={{ marginBottom: 4 }}>原句</div>
              <div className="editor-area" style={{ whiteSpace: 'pre-wrap', padding: 12, minHeight: 0 }}>{rewrite.selection}</div>
            </div>
            <div>
              <div className="muted small" style={{ marginBottom: 4 }}>改写</div>
              <div className="editor-area" style={{ whiteSpace: 'pre-wrap', padding: 12, minHeight: 60 }}>
                {rewrite.result || (rewrite.streaming ? '生成中…' : '（暂无内容）')}
              </div>
            </div>
            {rewrite.error && <ErrorNote error={rewrite.error} />}
            <div className="row">
              <span className="grow" />
              <button className="btn" onClick={() => setRewrite(null)}>取消</button>
              <button className="btn primary" disabled={rewrite.streaming || !rewrite.result.trim()} onClick={applyRewrite}>替换回正文</button>
            </div>
          </div>
        </Modal>
      )}
    </div>
  );
}

function ReportCard({ report, onRewrite }: { report: Report; onRewrite: (h: Hit) => void }) {
  const hits = [...report.wordHits, ...report.statHits];
  return (
    <div className="card">
      <div className="card-title">
        AI 腔指数 <b style={{ fontSize: 22 }}>{report.score}</b>
        <Badge tone={LEVEL_TONE[report.level]}>{report.levelText}</Badge>
      </div>
      <div className="muted small">
        词表 {report.stats.wordScore} 分 · 统计 {report.stats.statScore} 分
        {report.modelScore != null ? ` · 模型 ${report.modelScore} 分` : ''}
        （警告 {report.thresholds.warn} / 拦截 {report.thresholds.block}）
      </div>
      {report.modelNote && <p className="small muted" style={{ marginTop: 8 }}>模型建议：{report.modelNote}</p>}
      {!hits.length ? (
        <p className="small muted" style={{ marginTop: 10 }}>没有命中，本章 AI 腔很轻。</p>
      ) : (
        <div className="stack" style={{ gap: 8, marginTop: 12, maxHeight: '46vh', overflow: 'auto' }}>
          {hits.map((h) => (
            <div key={h.id} style={{ borderBottom: '1px solid var(--line)', paddingBottom: 8 }}>
              <div className="row small">
                <b>{h.phrase}</b>
                <span className="grow" />
                {h.type === 'word' && <button className="btn small" onClick={() => onRewrite(h)}>改写本句</button>}
              </div>
              <div className="muted small" style={{ marginTop: 2 }}>{h.reason}</div>
              <div className="small" style={{ color: 'var(--ink-2)' }}>建议：{h.suggestion}</div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

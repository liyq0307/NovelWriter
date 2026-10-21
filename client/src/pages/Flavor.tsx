/**
 * 去AI味：三层检测（词表 / 统计 / 模型评分）与逐处改写。
 * 词表命中在正文中高亮，点一下即可让 AI 重写该句，确认后替换并保存。
 */
import { useEffect, useMemo, useState } from 'react';
import { api, sse, countWords } from '../api';
import { useProject } from './ProjectPage';
import { Badge, Spinner, ErrorNote, Empty, Modal, Switch } from '../components/ui';

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
const LEVEL_COLOR = { ok: 'var(--ok)', warn: 'var(--warn)', block: 'var(--accent)' } as const;

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
  const [sideTab, setSideTab] = useState<'report' | 'settings'>('report');

  useEffect(() => {
    api.get('/flavor/settings').then(setConfig).catch(() => {});
  }, []);

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
    api.get(`/projects/${project.id}/chapters/${cid}`)
      .then((c) => { if (alive) { setText(c.content || ''); setSavedText(c.content || ''); setLoaded(true); } })
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

  const allHits = report ? [...report.wordHits, ...report.statHits] : [];
  const dirty = loaded && text !== savedText;

  if (!chapters.length) {
    return <Empty title="还没有章节" desc="先在「架构规划」里拆章，再来做去AI味。" />;
  }

  return (
    <div className="page flavor-page">
      <div className="page-head flavor-head">
        <div>
          <h1>去AI味</h1>
          <div className="sub">词表命中 → 统计特征 → 模型评分；点正文高亮即可逐句改写。</div>
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
              <span><i className="flavor-dot word" />词表命中 {report.wordHits.length}</span>
              <span><i className="flavor-dot stat" />统计特征 {report.statHits.length}</span>
              <span className="muted">
                {report.wordHits.length ? '点击黄色高亮可改写所在句' : '统计命中不定位到具体词，可按右侧建议调整'}
              </span>
            </div>
          )}

          {loading ? (
            <div className="loading-block flavor-loading"><Spinner text="正在打开章节…" /></div>
          ) : report ? (
            <div className="flavor-paper">
              <div className="flavor-paper-inner">
                {segments.map((s, i) => (s.hit ? (
                  <mark
                    key={i}
                    className="flavor-mark"
                    title={`${s.hit.reason}\n建议：${s.hit.suggestion}`}
                    onClick={() => openRewrite(s.hit as Hit)}
                  >
                    {s.text}
                  </mark>
                ) : (<span key={i}>{s.text}</span>)))}
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
              {report ? `命中 ${allHits.length} 处` : '扫描后会标出可改写的位置'}
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

                <div className="flavor-metrics">
                  <div><span>词表</span><b>{report.stats.wordScore}</b></div>
                  <div><span>统计</span><b>{report.stats.statScore}</b></div>
                  <div><span>模型</span><b>{report.modelScore ?? '—'}</b></div>
                </div>

                {report.modelNote && <div className="flavor-model-note">模型建议：{report.modelNote}</div>}

                <div className="flavor-hits-head">
                  <b>命中明细</b>
                  <span className="chip">{allHits.length}</span>
                </div>
                {allHits.length ? (
                  <div className="flavor-hits">
                    {allHits.map((h) => (
                      <div key={h.id} className={`flavor-hit ${h.type}`}>
                        <div className="flavor-hit-top">
                          <Badge tone={h.type === 'word' ? 'warn' : 'info'}>{h.type === 'word' ? '词表' : '统计'}</Badge>
                          <b>{h.phrase}</b>
                          {h.type === 'word' && (
                            <button className="btn ghost small" onClick={() => openRewrite(h)}>改写本句</button>
                          )}
                        </div>
                        <div className="flavor-hit-reason">{h.reason}</div>
                        {h.suggestion ? <div className="flavor-hit-suggestion">建议：{h.suggestion}</div> : null}
                      </div>
                    ))}
                  </div>
                ) : (
                  <div className="flavor-clear">✓ 没有命中，本章 AI 腔很轻。</div>
                )}
              </>
            ) : (
              <>
                <div className="flavor-score">
                  <ScoreRing score={null} />
                  <div className="flavor-score-copy">
                    <div className="flavor-score-top"><b>还没有检测</b></div>
                    <p className="flavor-summary">扫描会同时检查词表命中与句式统计；开启模型层后，还会让 AI 给出整体评分。</p>
                  </div>
                </div>
                <div className="flavor-layer-list">
                  <LayerRow on={!!config?.wordEnabled} title="词表命中层" desc="禁用表达、套路化用词" />
                  <LayerRow on={!!config?.statEnabled} title="统计特征层" desc="句长、句首复读、段落节奏" />
                  <LayerRow on={!!config?.modelEnabled} title="模型打分层" desc="需要可用的 AI 通道" />
                </div>
                <div className="flavor-empty-hint">点击右上角「扫描本章」开始检测。检测结果不会改动正文，只有你确认改写后才会变化。</div>
              </>
            ))}

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
                    <small>句长、句首复读、段落节奏</small>
                  </div>
                  <Switch checked={config.statEnabled} onChange={(v) => saveConfig({ statEnabled: v })} />
                </div>
                <div className="flavor-toggle">
                  <div className="flavor-toggle-copy">
                    <b>模型打分层</b>
                    <small>需要可用的 AI 通道</small>
                  </div>
                  <Switch checked={config.modelEnabled} onChange={(v) => saveConfig({ modelEnabled: v })} />
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

              <details className="flavor-words">
                <summary>
                  <span>词表</span>
                  <span className="chip">{config.rules.filter((x) => x.enabled).length}/{config.rules.length} 启用</span>
                  <span className="grow" />
                  <span className="flavor-caret">▾</span>
                </summary>
                <div className="flavor-word-list">
                  {config.rules.map((rule) => (
                    <label key={rule.id} className={`flavor-word ${rule.enabled ? 'on' : ''}`} title={rule.reason}>
                      <input
                        type="checkbox"
                        checked={rule.enabled}
                        onChange={(e) => saveConfig({ rules: config.rules.map((x) => (x.id === rule.id ? { ...x, enabled: e.target.checked } : x)) })}
                      />
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
                <Badge tone="warn">命中「{rewrite.hit.phrase}」</Badge>
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

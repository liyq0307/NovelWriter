import { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { api } from '../api';
import { useProject } from './ProjectPage';
import { Badge, Spinner, ErrorNote, Modal, Field } from '../components/ui';
import type { Direction } from '../types';

const SELLING_POINTS = ['升级打脸', '悬念反转', '情感羁绊', '智斗博弈', '生存压力', '群像成长', '日常治愈'];
const SETTINGS = ['东方玄幻', '现代都市', '近未来科幻', '架空历史', '西式奇幻', '末世废土', '民国年代', '校园日常'];
const PROTAGONISTS = ['普通人逆袭', '落魄强者回归', '天才型主角', '反英雄 / 灰度', '群像无绝对主角'];
const POVS = ['第一人称', '第三人称限知', '第三人称全知', '多视角轮转'];
const TONES = ['冷峻克制', '热血爽快', '温暖治愈', '诡异悬疑', '轻快幽默', '压抑沉重'];

type Guide = {
  genre: string;
  setting: string;
  references: string;
  protagonist: string;
  pov: string;
  tone: string;
  pacing: string;
  audience: string;
  sellingPoints: string[];
  mustHave: string;
  taboos: string;
};

/** 把顿号 / 逗号 / 分号分隔的文本拆成数组 */
const splitList = (s: string) => s.split(/[,，、;；\s]+/).map((x) => x.trim()).filter(Boolean);

export default function Directions() {
  const { project, reload } = useProject();
  const [candidates, setCandidates] = useState<Direction[] | null>(null);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [note, setNote] = useState<string | null>(null);
  const [guideOpen, setGuideOpen] = useState(false);
  const [guide, setGuide] = useState<Guide>({
    genre: '',
    setting: '',
    references: '',
    protagonist: '',
    pov: '',
    tone: '',
    pacing: '',
    audience: '',
    sellingPoints: [],
    mustHave: '',
    taboos: '',
  });
  const [edit, setEdit] = useState<Direction | null>(null);
  const [pointsText, setPointsText] = useState('');
  const [taboosText, setTaboosText] = useState('');
  const [saving, setSaving] = useState(false);
  const [picked, setPicked] = useState<number[]>([]);
  const [mergeOpen, setMergeOpen] = useState(false);
  const [mergeNote, setMergeNote] = useState('');
  const [merging, setMerging] = useState(false);
  const [merged, setMerged] = useState<Direction | null>(null);
  const nav = useNavigate();

  const d = project.direction;

  const togglePoint = (p: string) => {
    setGuide((g) => ({
      ...g,
      sellingPoints: g.sellingPoints.includes(p) ? g.sellingPoints.filter((x) => x !== p) : [...g.sellingPoints, p],
    }));
  };

  /** 单选偏好：再次点击同一项即取消 */
  const pick = (key: 'setting' | 'protagonist' | 'pov' | 'tone', v: string) => {
    setGuide((g) => ({ ...g, [key]: g[key] === v ? '' : v }));
  };

  const guideCount =
    ['genre', 'setting', 'references', 'protagonist', 'pov', 'tone', 'pacing', 'audience', 'mustHave', 'taboos']
      .filter((k) => guide[k as keyof Guide]).length + (guide.sellingPoints.length ? 1 : 0);

  const generate = async () => {
    setBusy(true); setErr(null); setNote(null);
    try {
      const arr: Direction[] = await api.post(`/projects/${project.id}/directions`, { guide });
      setCandidates(arr);
      setPicked([]);
      setMerged(null);
      if (guideOpen) setGuideOpen(false);
    } catch (e: any) {
      setErr(e.message);
    } finally {
      setBusy(false);
    }
  };

  const choose = async (dir: Direction) => {
    setBusy(true); setErr(null);
    try {
      await api.patch(`/projects/${project.id}`, {
        direction: dir,
        contract: dir.contract,
        status: 'direction',
        title: project.title === '未命名作品' ? dir.title : project.title,
      });
      await reload();
      setNote(`已选定《${dir.title}》——接下来去「世界手册」搭世界、「角色库」立人物。`);
      setCandidates(null);
      setPicked([]);
      setMerged(null);
    } catch (e: any) {
      setErr(e.message);
    } finally {
      setBusy(false);
    }
  };

  /** 勾选 / 取消勾选候选方向 */
  const togglePick = (i: number) => {
    setPicked((v) => (v.includes(i) ? v.filter((x) => x !== i) : [...v, i]));
  };

  const mergeSelected = async () => {
    if (!candidates) return;
    const chosen = picked.map((i) => candidates[i]).filter(Boolean);
    if (chosen.length < 2) return;
    setMerging(true); setErr(null);
    try {
      const dir: Direction = await api.post(`/projects/${project.id}/directions/merge`, {
        candidates: chosen,
        note: mergeNote.trim(),
        guide,
      });
      setMerged(dir);
      setMergeOpen(false);
      setNote('融合完成：保留各方向最有张力的部分，合成一个可执行的新方向。');
    } catch (e: any) {
      setErr(e.message);
    } finally {
      setMerging(false);
    }
  };

  const startEdit = () => {
    if (!d) return;
    setErr(null); setNote(null);
    setPointsText((d.sellingPoints || []).join('、'));
    setTaboosText((d.contract?.taboos || []).join('、'));
    setEdit({ ...d, contract: { ...(d.contract || {}) } });
  };

  const patchEdit = (patch: Partial<Direction>) => setEdit((v) => (v ? { ...v, ...patch } : v));
  const patchContract = (patch: Partial<Direction['contract']>) =>
    setEdit((v) => (v ? { ...v, contract: { ...(v.contract || {}), ...patch } } : v));

  const saveEdit = async () => {
    if (!edit) return;
    setSaving(true); setErr(null);
    const direction: Direction = {
      ...edit,
      sellingPoints: splitList(pointsText),
      contract: { ...(edit.contract || {}), taboos: splitList(taboosText) },
    };
    try {
      await api.patch(`/projects/${project.id}`, {
        title: direction.title.trim() || project.title,
        direction,
        contract: direction.contract,
      });
      await reload();
      setEdit(null);
      setNote('方向与创作约定已保存，之后的生成都会按新约定执行。');
    } catch (e: any) {
      setErr(e.message);
    } finally {
      setSaving(false);
    }
  };

  return (
    <div>
      {note && <div className="hint-box" style={{ marginBottom: 16 }}>{note} <button className="btn small" onClick={() => nav('/p/' + project.id)}>回概览</button></div>}

      <div className="card" style={{ marginBottom: 16 }}>
        <div className="row-wrap" style={{ justifyContent: 'space-between' }}>
          <div>
            <b>构思向导</b>
            <span className="muted small" style={{ marginLeft: 8 }}>
              可选：定下题材、人物、情绪与底线，生成的方向会更贴口味
            </span>
          </div>
          <button className="btn ghost small" onClick={() => setGuideOpen((v) => !v)}>
            {guideOpen ? '收起' : guideCount ? `展开 · 已设 ${guideCount} 项` : '展开'}
          </button>
        </div>
        {guideOpen && (
          <div className="mt16">
            <div className="field-label wizard-sec">题材与世界</div>
            <div className="grid grid-2">
              <label className="field">
                <span className="field-label">题材赛道 <em className="field-hint">留空则不限</em></span>
                <input type="text" value={guide.genre} placeholder="如 悬疑 / 玄幻 / 都市异能"
                  onChange={(e) => setGuide({ ...guide, genre: e.target.value })} />
              </label>
              <label className="field">
                <span className="field-label">对标作品 <em className="field-hint">可写书名或风格</em></span>
                <input type="text" value={guide.references} placeholder="如 诡秘之主 / 双雪涛的冷叙事"
                  onChange={(e) => setGuide({ ...guide, references: e.target.value })} />
              </label>
            </div>
            <div className="field">
              <span className="field-label">世界观偏好 <em className="field-hint">单选，再点一次取消</em></span>
              <div className="row-wrap">
                {SETTINGS.map((v) => (
                  <button key={v} type="button" className={`chip chip-btn ${guide.setting === v ? 'active' : ''}`}
                    onClick={() => pick('setting', v)}>{v}</button>
                ))}
              </div>
            </div>

            <div className="field-label wizard-sec">人物与视角</div>
            <div className="field">
              <span className="field-label">主角类型</span>
              <div className="row-wrap">
                {PROTAGONISTS.map((v) => (
                  <button key={v} type="button" className={`chip chip-btn ${guide.protagonist === v ? 'active' : ''}`}
                    onClick={() => pick('protagonist', v)}>{v}</button>
                ))}
              </div>
            </div>
            <div className="field">
              <span className="field-label">叙事视角</span>
              <div className="row-wrap">
                {POVS.map((v) => (
                  <button key={v} type="button" className={`chip chip-btn ${guide.pov === v ? 'active' : ''}`}
                    onClick={() => pick('pov', v)}>{v}</button>
                ))}
              </div>
            </div>

            <div className="field-label wizard-sec">情绪与节奏</div>
            <div className="field">
              <span className="field-label">情绪基调</span>
              <div className="row-wrap">
                {TONES.map((v) => (
                  <button key={v} type="button" className={`chip chip-btn ${guide.tone === v ? 'active' : ''}`}
                    onClick={() => pick('tone', v)}>{v}</button>
                ))}
              </div>
            </div>
            <div className="grid grid-2">
              <label className="field">
                <span className="field-label">节奏偏好</span>
                <select value={guide.pacing} onChange={(e) => setGuide({ ...guide, pacing: e.target.value })}>
                  <option value="">不限</option>
                  <option>快节奏强冲突</option>
                  <option>张弛有度</option>
                  <option>慢热细腻</option>
                </select>
              </label>
              <label className="field">
                <span className="field-label">目标读者</span>
                <input type="text" value={guide.audience} placeholder="如 偏好强情节的男性读者 / 女性向成长"
                  onChange={(e) => setGuide({ ...guide, audience: e.target.value })} />
              </label>
            </div>

            <div className="field-label wizard-sec">爽点与底线</div>
            <div className="field">
              <span className="field-label">核心爽点 <em className="field-hint">可多选</em></span>
              <div className="row-wrap">
                {SELLING_POINTS.map((p) => (
                  <button key={p} type="button" className={`chip chip-btn ${guide.sellingPoints.includes(p) ? 'active' : ''}`}
                    onClick={() => togglePoint(p)}>{p}</button>
                ))}
              </div>
            </div>
            <div className="grid grid-2">
              <label className="field">
                <span className="field-label">必须包含</span>
                <input type="text" value={guide.mustHave} placeholder="如 必须有师徒线 / 每卷一次反转"
                  onChange={(e) => setGuide({ ...guide, mustHave: e.target.value })} />
              </label>
              <label className="field">
                <span className="field-label">明确禁忌</span>
                <input type="text" value={guide.taboos} placeholder="如 不写虐恋 / 不出现系统面板"
                  onChange={(e) => setGuide({ ...guide, taboos: e.target.value })} />
              </label>
            </div>
          </div>
        )}
      </div>

      {d && (
        <div className="card dir-card dir-picked" style={{ marginBottom: 20 }}>
          <div className="row-wrap">
            <span className="dir-title">《{d.title}》</span>
            <Badge tone="accent">{d.genre}</Badge>
            <Badge>当前方向</Badge>
          </div>
          <div className="dir-logline">{d.logline}</div>
          <div className="row-wrap">
            {d.sellingPoints?.map((s, i) => <span key={i} className="chip">{s}</span>)}
          </div>
          <div className="kv mt8">
            <div><b>主角</b>{d.protagonist}</div>
            <div><b>文风</b>{d.style}</div>
            <div><b>读者</b>{d.audience}</div>
          </div>
          <div className="row mt8">
            <button className="btn small" onClick={startEdit} disabled={busy}>编辑方向与约定</button>
            <button className="btn small" disabled={busy} onClick={generate}>{busy ? <Spinner /> : '重新生成候选方向'}</button>
          </div>
        </div>
      )}

      {!d && !busy && candidates === null && (
        <div className="card" style={{ textAlign: 'center', padding: '40px 20px' }}>
          <div style={{ fontFamily: 'var(--serif)', fontSize: 20, marginBottom: 8 }}>一句灵感，三个方向</div>
          <p className="muted" style={{ maxWidth: 480, margin: '0 auto 20px', lineHeight: 1.8 }}>
            AI 会基于你的灵感给出三个差异明显的候选方向：题材赛道、情绪基调、叙事方式各不相同。
            选定后即生成本书的「创作约定」（视角 / 基调 / 禁忌 / 弧线），后续所有生成都会遵守。
          </p>
          <button className="btn primary big" onClick={generate}>AI 生成候选方向</button>
        </div>
      )}

      {busy && (
        <div className="card loading-block"><Spinner text="正在基于灵感策划三个方向…" /></div>
      )}

      <ErrorNote error={err} onRetry={generate} />

      {merged && (
        <div className="card dir-card dir-merged" style={{ marginBottom: 20 }}>
          <div className="row-wrap">
            <span className="dir-title">《{merged.title}》</span>
            <Badge tone="accent">{merged.genre}</Badge>
            <Badge tone="ok">融合结果</Badge>
          </div>
          <div className="dir-logline">{merged.logline}</div>
          <div className="row-wrap">
            {merged.sellingPoints?.map((s, i) => <span key={i} className="chip">{s}</span>)}
          </div>
          <div className="kv mt8">
            <div><b>主角</b>{merged.protagonist}</div>
            <div><b>文风</b>{merged.style}</div>
            <div><b>读者</b>{merged.audience}</div>
          </div>
          <div className="row mt8">
            <button className="btn primary" disabled={busy || merging} onClick={() => choose(merged)}>选定此方向</button>
            <button className="btn small" disabled={busy || merging} onClick={() => setMergeOpen(true)}>调整要求再融合</button>
            <button className="btn ghost small" disabled={merging} onClick={() => setMerged(null)}>丢弃</button>
          </div>
        </div>
      )}

      {candidates && (
        <div className="dir-merge-bar">
          <span className="small">
            {picked.length
              ? `已选 ${picked.length} 个方向${picked.length < 2 ? '，再选一个即可融合' : ''}`
              : `从 ${candidates.length} 个候选方向中勾选至少 2 个，可融合成一个新方向`}
          </span>
          <div className="grow" />
          <button
            className="btn primary small"
            disabled={busy || merging || picked.length < 2}
            onClick={() => { setErr(null); setMergeOpen(true); }}
          >
            融合所选方向
          </button>
          <button className="btn ghost small" disabled={busy || merging} onClick={generate}>
            {busy ? <Spinner text="重新生成中…" /> : '对这批不满意，重新生成'}
          </button>
          {picked.length > 0 && (
            <button className="btn ghost small" disabled={merging} onClick={() => setPicked([])}>清空</button>
          )}
        </div>
      )}

      {candidates && (
        <div className="grid grid-3">
          {candidates.map((c, i) => (
            <div key={i} className={`card dir-card ${picked.includes(i) ? 'picked' : ''}`}>
              <div className="row-wrap">
                <span className="dir-title">{c.title}</span>
                <Badge tone="accent">{c.genre}</Badge>
              </div>
              <div className="dir-logline">{c.logline}</div>
              <div className="row-wrap">
                {c.sellingPoints?.slice(0, 3).map((s, j) => <span key={j} className="chip">{s}</span>)}
              </div>
              <div className="kv">
                <div><b>主角</b>{c.protagonist}</div>
                <div><b>文风</b>{c.style}</div>
                <div><b>读者</b>{c.audience}</div>
              </div>
              <div className="dir-actions mt8">
                <label className="dir-pick">
                  <input type="checkbox" checked={picked.includes(i)} disabled={busy || merging} onChange={() => togglePick(i)} />
                  加入融合
                </label>
                <button className="btn primary" disabled={busy || merging} onClick={() => choose(c)}>选定此方向</button>
              </div>
            </div>
          ))}
        </div>
      )}
      {mergeOpen && candidates && (
        <Modal title="融合候选方向" onClose={() => setMergeOpen(false)}>
          <div className="muted small" style={{ lineHeight: 1.8, marginBottom: 12 }}>
            将把 {picked.map((i) => `《${candidates[i]?.title}》`).join('、')} 融合成一个新方向：
            AI 会吸收各方向最有力的冲突、卖点与情绪基调，消除互相矛盾之处，而不是简单拼接字段。
          </div>
          <Field label="融合要求" hint="可选，越具体越贴预期">
            <textarea
              rows={4}
              value={mergeNote}
              placeholder="如：保留悬疑的追查主线，用玄幻的力量体系承载；主角要有一条温暖的师徒线；不要多视角。"
              onChange={(e) => setMergeNote(e.target.value)}
            />
          </Field>
          {err && <ErrorNote error={err} />}
          <div className="row" style={{ justifyContent: 'flex-end', marginTop: 18 }}>
            <button className="btn" disabled={merging} onClick={() => setMergeOpen(false)}>取消</button>
            <button className="btn primary" disabled={merging} onClick={mergeSelected}>
              {merging ? <Spinner text="正在融合…" /> : '开始融合'}
            </button>
          </div>
        </Modal>
      )}
      {edit && (
        <Modal title="编辑方向与创作约定" wide onClose={() => setEdit(null)}>
          <div className="grid grid-2">
            <Field label="作品名">
              <input type="text" value={edit.title} onChange={(e) => patchEdit({ title: e.target.value })} />
            </Field>
            <Field label="题材标签">
              <input type="text" value={edit.genre || ''} onChange={(e) => patchEdit({ genre: e.target.value })} />
            </Field>
          </div>
          <Field label="一句话故事" hint="60 字内，作为全书的核心钩子">
            <textarea rows={2} value={edit.logline || ''} onChange={(e) => patchEdit({ logline: e.target.value })} />
          </Field>
          <Field label="核心卖点" hint="用顿号或逗号分隔">
            <input type="text" value={pointsText} onChange={(e) => setPointsText(e.target.value)} />
          </Field>
          <Field label="主角设定" hint="核心欲望与阻力">
            <textarea rows={2} value={edit.protagonist || ''} onChange={(e) => patchEdit({ protagonist: e.target.value })} />
          </Field>
          <div className="grid grid-2">
            <Field label="文风基调">
              <input type="text" value={edit.style || ''} onChange={(e) => patchEdit({ style: e.target.value })} />
            </Field>
            <Field label="目标读者">
              <input type="text" value={edit.audience || ''} onChange={(e) => patchEdit({ audience: e.target.value })} />
            </Field>
          </div>

          <div className="field-label" style={{ margin: '4px 0 10px', paddingTop: 12, borderTop: '1px dashed var(--line)' }}>
            创作约定 <em className="field-hint">会注入每一次正文生成</em>
          </div>
          <div className="grid grid-2">
            <Field label="叙事视角">
              <input type="text" value={edit.contract?.pov || ''} onChange={(e) => patchContract({ pov: e.target.value })} />
            </Field>
            <Field label="语言基调">
              <input type="text" value={edit.contract?.tone || ''} onChange={(e) => patchContract({ tone: e.target.value })} />
            </Field>
          </div>
          <Field label="故事弧线">
            <textarea rows={2} value={edit.contract?.arc || ''} onChange={(e) => patchContract({ arc: e.target.value })} />
          </Field>
          <Field label="避免的写法" hint="用顿号或逗号分隔">
            <input type="text" value={taboosText} onChange={(e) => setTaboosText(e.target.value)} />
          </Field>

          {err && <ErrorNote error={err} />}
          <div className="row" style={{ justifyContent: 'flex-end', marginTop: 18 }}>
            <button className="btn" onClick={() => setEdit(null)}>取消</button>
            <button className="btn primary" disabled={saving} onClick={saveEdit}>{saving ? <Spinner /> : '保存修改'}</button>
          </div>
        </Modal>
      )}
    </div>
  );
}

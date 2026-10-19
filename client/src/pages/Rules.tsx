import { useEffect, useState } from 'react';
import { api } from '../api';
import { useProject } from './ProjectPage';
import { Switch, Modal, Field, ErrorNote, Empty, ConfirmButton, Badge, Spinner } from '../components/ui';
import type { Rule } from '../types';

export default function Rules() {
  const { project } = useProject();
  const [rules, setRules] = useState<Rule[] | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [editing, setEditing] = useState<Partial<Rule> | null>(null);
  const [seeding, setSeeding] = useState(false);

  const load = () => api.get(`/rules?projectId=${project.id}`).then(setRules).catch((e) => setErr(e.message));
  useEffect(() => { load(); }, [project.id]);

  const toggle = async (r: Rule, enabled: boolean) => {
    await api.put(`/rules/${r.id}`, { enabled });
    load();
  };
  const save = async () => {
    if (!editing?.name?.trim() || !editing?.content?.trim()) { setErr('规则名与内容不能为空'); return; }
    try {
      if (editing.id) await api.put(`/rules/${editing.id}`, editing);
      else await api.post('/rules', { ...editing, projectId: editing.project_id });
      setEditing(null);
      load();
    } catch (e: any) {
      setErr(e.message);
    }
  };
  const seed = async () => {
    setSeeding(true);
    try {
      await api.post('/rules/seed-anti-ai');
      await load();
    } catch (e: any) {
      setErr(e.message);
    } finally {
      setSeeding(false);
    }
  };

  const groups = [
    { kind: 'style' as const, title: '写法资产', desc: '正文的表达方式约束：视角、节奏、对话……让每本书有自己的手艺。' },
    { kind: 'anti_ai' as const, title: '反 AI 规则', desc: '专治 AI 腔：陈词滥调、排比堆叠、空洞抒情、总结式结尾。' },
  ];

  return (
    <div>
      <div className="row-wrap" style={{ marginBottom: 16 }}>
        <span className="muted small">启用的规则会注入每一次正文生成与修文 —— 这是全平台统一的「手感」。</span>
        <span className="grow" />
        <button className="btn" disabled={seeding} onClick={seed}>{seeding ? <Spinner /> : '导入推荐反 AI 规则'}</button>
        <button className="btn primary" onClick={() => setEditing({ kind: 'style', project_id: project.id })}>＋ 新增规则</button>
      </div>
      <ErrorNote error={err} />

      {rules === null ? (
        <div className="loading-block"><Spinner /></div>
      ) : (
        groups.map((g) => {
          const items = rules.filter((r) => r.kind === g.kind);
          return (
            <div key={g.kind} className="card" style={{ marginBottom: 16 }}>
              <div className="row" style={{ marginBottom: 6 }}>
                <span className="card-title" style={{ margin: 0 }}>{g.title}</span>
                <Badge>{items.filter((r) => r.enabled).length}/{items.length} 启用</Badge>
              </div>
              <p className="muted small" style={{ marginBottom: 6 }}>{g.desc}</p>
              {items.length === 0 ? (
                <span className="muted small">暂无规则。</span>
              ) : (
                items.map((r) => (
                  <div key={r.id} className={`rule-row ${r.enabled ? '' : 'disabled'}`}>
                    <Switch checked={!!r.enabled} onChange={(v) => toggle(r, v)} />
                    <div className="grow">
                      <span className="rule-name">{r.name}</span>
                      {r.project_id ? <span className="rule-scope">本书</span> : <span className="rule-scope">全局</span>}
                      <div className="rule-content">{r.content}</div>
                    </div>
                    <button className="btn ghost small" onClick={() => setEditing({ ...r })}>编辑</button>
                    <ConfirmButton className="btn ghost small" onConfirm={async () => { await api.del(`/rules/${r.id}`); load(); }}>删除</ConfirmButton>
                  </div>
                ))
              )}
            </div>
          );
        })
      )}
      {rules !== null && rules.length === 0 && (
        <Empty title="还没有任何规则" desc="从「导入推荐反 AI 规则」开始，或写下你自己的第一条写法资产。" />
      )}

      {editing && (
        <Modal title={editing.id ? '编辑规则' : '新增规则'} onClose={() => setEditing(null)}>
          <Field label="规则类型">
            <select value={editing.kind || 'style'} onChange={(e) => setEditing({ ...editing, kind: e.target.value as Rule['kind'] })}>
              <option value="style">写法资产</option>
              <option value="anti_ai">反 AI 规则</option>
            </select>
          </Field>
          <Field label="生效范围">
            <select value={editing.project_id ? 'book' : 'global'} onChange={(e) => setEditing({ ...editing, project_id: e.target.value === 'book' ? project.id : null })}>
              <option value="global">全局（所有书）</option>
              <option value="book">仅本书《{project.title}》</option>
            </select>
          </Field>
          <Field label="规则名"><input type="text" value={editing.name || ''} onChange={(e) => setEditing({ ...editing, name: e.target.value })} /></Field>
          <Field label="规则内容" hint="写成可执行的指令，AI 才好遵守"><textarea rows={4} value={editing.content || ''} onChange={(e) => setEditing({ ...editing, content: e.target.value })} /></Field>
          <div className="row" style={{ justifyContent: 'flex-end' }}>
            <button className="btn ghost" onClick={() => setEditing(null)}>取消</button>
            <button className="btn primary" onClick={save}>保存</button>
          </div>
        </Modal>
      )}
    </div>
  );
}

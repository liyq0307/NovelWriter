/** 与服务端 API 契约对应的类型定义 */

export interface Contract {
  pov?: string;
  tone?: string;
  taboos?: string[];
  arc?: string;
}

export interface Direction {
  title: string;
  genre: string;
  logline: string;
  sellingPoints: string[];
  protagonist: string;
  style: string;
  audience: string;
  contract: Contract;
}

export interface WorldEntry {
  id: number;
  project_id: number;
  category: string;
  name: string;
  content: string;
  source: string;
}

export interface Character {
  id: number;
  name: string;
  role: string;
  profile: string;
  goals: string;
  appearance: string;
  status: string;
}

export interface Relation {
  id: number;
  from_name: string;
  to_name: string;
  type: string;
  description: string;
}

export interface Volume {
  id: number;
  idx: number;
  title: string;
  summary: string;
}

export interface ReviewIssue {
  severity: 'high' | 'medium' | 'low';
  type: string;
  location: string;
  problem: string;
  suggestion: string;
}

export interface Review {
  score: number;
  summary: string;
  issues: ReviewIssue[];
}

export interface Chapter {
  id: number;
  volume_id: number | null;
  idx: number;
  title: string;
  brief: string;
  scenes: string;
  cast: string[];
  hook: string;
  status: 'planned' | 'draft' | 'done';
  content?: string;
  summary?: string;
  word_count: number;
  review: Review | null;
}

export interface ChapterContextPreview {
  target: number;
  promptChars: number;
  promptTokens: number;
  prevTitle: string | null;
  tail: string;
  world: { category: string; name: string; content: string }[];
  characters: { name: string; role: string; status: string; profile: string }[];
  styleRules: { name: string; content: string }[];
  antiRules: { name: string; content: string }[];
  flavorWords: { phrase: string; suggestion: string }[];
  flavorAvoid: { phrase: string; hits: number; suggestion: string }[];
  threads: { name: string; status: string; detail: string }[];
  facts: { kind: string; subject: string; fact: string }[];
  summaries: { idx: number; title: string; summary: string }[];
  recalls: { kind: string; title: string; snippet: string }[];
}

export interface Thread {
  id: number;
  project_id: number;
  name: string;
  kind: '伏笔' | '线索' | '悬念' | '承诺';
  status: 'planted' | 'reinforced' | 'resolved' | 'abandoned';
  detail: string;
  planted_chapter: number | null;
  last_chapter: number | null;
  created_at: string;
  updated_at: string;
}

export interface Revision {
  id: number;
  word_count: number;
  reason: string;
  created_at: string;
  preview: string;
}

export interface Batch {
  id: number;
  project_id: number;
  status: 'running' | 'paused' | 'done' | 'error' | 'cancelled';
  from_idx: number;
  to_idx: number;
  cursor_idx: number;
  done_chapters: number;
  words_added: number;
  review: number;
  sync: number;
  overwrite: number;
  message: string;
  created_at: string;
  updated_at: string;
  running?: boolean;
  paused?: boolean;
  current?: { id: number; idx: number; title: string };
}

export interface Stats {
  days: { day: string; words: number }[];
  today: number;
  total: number;
  streak: number;
  bestDay: { day: string; words: number } | null;
}

export type ProjectStatus = 'idea' | 'direction' | 'building' | 'planned' | 'writing' | 'done';

export interface Fact {
  id: number;
  project_id: number;
  kind: string;
  subject: string;
  fact: string;
  chapter_idx: number | null;
  status: string;
  created_at: string;
  updated_at: string;
}

export interface DeconstructionRule {
  kind: 'style' | 'anti_ai';
  name: string;
  content: string;
}

export interface DeconstructionResult {
  summary: string;
  structure: { pattern: string; beats: string[] };
  characters: { name: string; role: string; want: string; flaw: string; arc: string }[];
  style: {
    pov: string;
    tone: string;
    sentence: string;
    dialogue: string;
    description: string;
    pacing: string;
    signature: string[];
  };
  techniques: string[];
  rules: DeconstructionRule[];
}

export interface Deconstruction {
  id: number;
  project_id: number;
  title: string;
  chapter_count: number;
  word_count: number;
  chapters: { idx: number; title: string; words: number }[];
  result: DeconstructionResult | null;
  status: 'analyzing' | 'done' | 'error';
  error: string | null;
  created_at: string;
  updated_at: string;
}

export interface PromptTemplate {
  step: string;
  label: string;
  desc: string;
  system: string;
  suffix: string;
  overridden: boolean;
  global: boolean;
  updated_at: string | null;
}

export interface PromptTemplateVersion {
  id: number;
  system: string;
  suffix: string;
  created_at: string;
}

export interface SearchHit {
  kind: 'world' | 'character' | 'chapter' | 'fact' | 'thread';
  refId: number;
  title: string;
  snippet: string;
}

export interface Project {
  id: number;
  title: string;
  type: 'novel' | 'short';
  status: ProjectStatus;
  premise: string;
  direction: Direction | null;
  contract: Contract | null;
  target_words: number;
  sync_state: number;
  created_at: string;
  updated_at: string;
  volumes: Volume[];
  chapters: Chapter[];
  world: WorldEntry[];
  characters: Character[];
  relations: Relation[];
  threads: Thread[];
  facts: Fact[];
  word_total: number;
}

export interface ProjectSummary extends Omit<Project, 'volumes' | 'chapters' | 'world' | 'characters' | 'relations' | 'threads' | 'facts'> {
  chapters_total: number;
  chapters_done: number;
  word_total: number;
}

export interface Rule {
  id: number;
  project_id: number | null;
  kind: 'style' | 'anti_ai';
  name: string;
  content: string;
  enabled: number;
}

export interface AISettings {
  provider: 'mock' | 'openai' | 'anthropic';
  baseUrl: string;
  apiKey: string;
  models: { planner: string; writer: string; reviewer: string };
}

export interface UsageRow {
  id: number;
  project_id: number | null;
  chapter_id: number | null;
  step: string;
  model: string;
  input_tokens: number;
  output_tokens: number;
  cached_tokens: number;
  estimated: number;
  status: string;
  error: string | null;
  duration_ms: number;
  summary: string;
  created_at: string;
}

export interface UsageData {
  rows: UsageRow[];
  totals: { calls: number; ok: number | null; errors: number | null; input_tokens: number; output_tokens: number; cached_tokens: number; estimated: number };
  byModel: { model: string; calls: number; input_tokens: number; output_tokens: number }[];
  byStep: { step: string; calls: number; input_tokens: number; output_tokens: number }[];
}

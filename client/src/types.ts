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
  word_count: number;
  review: Review | null;
}

export type ProjectStatus = 'idea' | 'direction' | 'building' | 'planned' | 'writing' | 'done';

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
  word_total: number;
}

export interface ProjectSummary extends Omit<Project, 'volumes' | 'chapters' | 'world' | 'characters' | 'relations'> {
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
  provider: 'mock' | 'openai';
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

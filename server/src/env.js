import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

/** server/ 根目录 */
export const ROOT = path.resolve(__dirname, '..');
/** 数据主目录（可用 NW_HOME 覆盖，供测试隔离） */
export const HOME = process.env.NW_HOME || ROOT;
export const DATA_DIR = path.join(HOME, 'data');
export const DB_PATH = process.env.NW_DB_PATH || path.join(DATA_DIR, 'novelwriter.db');
export const PORT = Number(process.env.PORT || 4680);
export const HOST = process.env.HOST || '127.0.0.1';

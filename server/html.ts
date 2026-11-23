import fs from 'fs';
import path from 'path';
import { getStore } from './store.ts';

const PUBLIC_ATELIER = path.resolve(process.cwd(), 'public', 'atelier');
const BUILD_TAG = '20261122-cloud-v2';

function readTemplate(fileName: string): string {
  return fs.readFileSync(path.join(PUBLIC_ATELIER, fileName), 'utf-8');
}

export function renderAtelierAppHtml(): string {
  const tpl = readTemplate('atelier.html');
  return tpl
    .replace(/\{\{\s*build\s*\}\}/g, BUILD_TAG)
    .replace(/\{\{\s*csrf_token\s*\}\}/g, 'atelier-cloud-csrf');
}

export function renderAtelierLoginHtml(): string {
  const tpl = readTemplate('atelier-login.html');
  return tpl
    .replace(/\{\{\s*build\s*\}\}/g, BUILD_TAG)
    .replace(/\{\{\s*workshop\s*\}\}/g, 'منصة رقمي السحابية لإدارة المطابع');
}

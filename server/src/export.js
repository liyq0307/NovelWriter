/**
 * 导出构建器：把项目正文打包为 docx / epub（零依赖）。
 * 输入为项目、卷与章节的原始行（与导出路由一致）。
 */
import { createHash } from 'node:crypto';
import { zipStore } from './zip.js';

const esc = (s) => String(s ?? '')
  .replace(/&/g, '&amp;')
  .replace(/</g, '&lt;')
  .replace(/>/g, '&gt;')
  .replace(/"/g, '&quot;');

const paragraphs = (text) => String(text || '').split(/\n+/).map((s) => s.trim()).filter(Boolean);

/* ============ DOCX ============ */

const CONTENT_TYPES = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">
<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>
<Default Extension="xml" ContentType="application/xml"/>
<Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/>
</Types>`;

const ROOT_RELS = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/>
</Relationships>`;

function docParagraph(text, { bold = false, size = 0, center = false, spacing = 0 } = {}) {
  const pPr = [];
  if (center) pPr.push('<w:jc w:val="center"/>');
  if (spacing) pPr.push(`<w:spacing w:before="${spacing}" w:after="${spacing}"/>`);
  const rPr = [];
  if (bold) rPr.push('<w:b/>');
  if (size) rPr.push(`<w:sz w:val="${size}"/><w:szCs w:val="${size}"/>`);
  return `<w:p>${pPr.length ? `<w:pPr>${pPr.join('')}</w:pPr>` : ''}<w:r>${rPr.length ? `<w:rPr>${rPr.join('')}</w:rPr>` : ''}<w:t xml:space="preserve">${esc(text)}</w:t></w:r></w:p>`;
}

/** 生成 docx Buffer */
export function buildDocx(p, volumes, chapters) {
  const body = [];
  body.push(docParagraph(p.title, { bold: true, size: 40, center: true, spacing: 240 }));
  const d = p.direction ? safeJSON(p.direction) : null;
  if (d?.logline) body.push(docParagraph(d.logline, { center: true }));
  if (p.premise) body.push(docParagraph(`灵感：${p.premise}`, { center: true }));

  const byVolume = (vol) => chapters.filter((c) => c.volume_id === vol.id);
  const orphans = chapters.filter((c) => !c.volume_id || !volumes.some((v) => v.id === c.volume_id));
  const emit = (c) => {
    body.push(docParagraph(`第${c.idx}章 ${c.title || ''}`, { bold: true, size: 32, spacing: 200 }));
    for (const para of paragraphs(c.content)) body.push(docParagraph(para));
    if (!c.content?.trim()) body.push(docParagraph('（本章尚未写作）'));
  };
  for (const v of volumes) {
    body.push(docParagraph(v.title, { bold: true, size: 36, center: true, spacing: 160 }));
    if (v.summary) body.push(docParagraph(v.summary));
    byVolume(v).forEach(emit);
  }
  if (orphans.length) orphans.forEach(emit);

  const documentXml = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main">
<w:body>${body.join('')}<w:sectPr><w:pgSz w:w="11906" w:h="16838"/><w:pgMar w:top="1440" w:right="1440" w:bottom="1440" w:left="1440"/></w:sectPr></w:body>
</w:document>`;

  return zipStore([
    { name: '[Content_Types].xml', data: CONTENT_TYPES },
    { name: '_rels/.rels', data: ROOT_RELS },
    { name: 'word/document.xml', data: documentXml },
  ]);
}

function safeJSON(v) {
  try { return JSON.parse(v); } catch { return null; }
}

/* ============ EPUB ============ */

const xhtml = (title, inner) => `<?xml version="1.0" encoding="utf-8"?>
<!DOCTYPE html>
<html xmlns="http://www.w3.org/1999/xhtml">
<head><meta charset="utf-8"/><title>${esc(title)}</title></head>
<body>${inner}</body>
</html>`;

const xhtmlParagraphs = (text) => paragraphs(text).map((t) => `<p>${esc(t)}</p>`).join('');

/** 生成 epub Buffer */
export function buildEpub(p, volumes, chapters) {
  const uuid = (() => {
    const h = createHash('md5').update(`novelwriter:${p.id}:${p.title}`).digest('hex');
    return `urn:uuid:${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20, 32)}`;
  })();

  const files = [];
  const manifest = [];
  const spine = [];
  const navPoints = [];
  let n = 0;

  files.push({ name: 'mimetype', data: 'application/epub+zip' });
  files.push({
    name: 'META-INF/container.xml',
    data: `<?xml version="1.0" encoding="UTF-8"?>
<container version="1.0" xmlns="urn:oasis:names:tc:opendocument:xmlns:container">
<rootfiles><rootfile full-path="OEBPS/content.opf" media-type="application/oebps-package+xml"/></rootfiles>
</container>`,
  });

  const chapterFile = (title, content, headingLevel = 2) => {
    n++;
    const id = `ch${n}`;
    const href = `${id}.xhtml`;
    files.push({ name: `OEBPS/${href}`, data: xhtml(title, `<h${headingLevel}>${esc(title)}</h${headingLevel}>${xhtmlParagraphs(content)}`) });
    manifest.push(`<item id="${id}" href="${href}" media-type="application/xhtml+xml"/>`);
    spine.push(`<itemref idref="${id}"/>`);
    navPoints.push(`<navPoint id="nav${n}" playOrder="${n}"><navLabel><text>${esc(title)}</text></navLabel><content src="${href}"/></navPoint>`);
    return href;
  };

  chapterFile(p.title, [p.premise && `灵感：${p.premise}`, p.direction && safeJSON(p.direction)?.logline].filter(Boolean).join('\n\n'), 1);

  const byVolume = (vol) => chapters.filter((c) => c.volume_id === vol.id);
  const orphans = chapters.filter((c) => !c.volume_id || !volumes.some((v) => v.id === c.volume_id));
  for (const v of volumes) {
    chapterFile(v.title, v.summary || '', 1);
    for (const c of byVolume(v)) chapterFile(`第${c.idx}章 ${c.title || ''}`, c.content || '（本章尚未写作）');
  }
  for (const c of orphans) chapterFile(`第${c.idx}章 ${c.title || ''}`, c.content || '（本章尚未写作）');

  files.push({
    name: 'OEBPS/content.opf',
    data: `<?xml version="1.0" encoding="utf-8"?>
<package xmlns="http://www.idpf.org/2007/opf" unique-identifier="bookid" version="2.0">
<metadata xmlns:dc="http://purl.org/dc/elements/1.1/">
<dc:title>${esc(p.title)}</dc:title>
<dc:language>zh-CN</dc:language>
<dc:identifier id="bookid">${uuid}</dc:identifier>
<dc:creator>NovelWriter</dc:creator>
</metadata>
<manifest>
<item id="ncx" href="toc.ncx" media-type="application/x-dtbncx+xml"/>
${manifest.join('\n')}
</manifest>
<spine toc="ncx">${spine.join('')}</spine>
</package>`,
  });

  files.push({
    name: 'OEBPS/toc.ncx',
    data: `<?xml version="1.0" encoding="utf-8"?>
<ncx xmlns="http://www.daisy.org/z3986/2005/ncx/" version="2005-1">
<head><meta name="dtb:uid" content="${uuid}"/><meta name="dtb:depth" content="1"/><meta name="dtb:totalPageCount" content="0"/><meta name="dtb:maxPageNumber" content="0"/></head>
<docTitle><text>${esc(p.title)}</text></docTitle>
<navMap>${navPoints.join('')}</navMap>
</ncx>`,
  });

  return zipStore(files);
}

// Turns a visual email design (plain JSON) into email-safe HTML: tables, inline styles, no scripts.
// Every value that reaches the HTML goes through a sanitizer, so a design can never inject markup
// (except the explicit Custom HTML block, which is the author's own HTML like any raw campaign).

export const FONTS = {
  arial: 'Arial, Helvetica, sans-serif',
  georgia: "Georgia, 'Times New Roman', serif",
  trebuchet: "'Trebuchet MS', Arial, sans-serif",
  verdana: 'Verdana, Geneva, sans-serif',
  tahoma: 'Tahoma, Geneva, sans-serif',
  courier: "'Courier New', Courier, monospace"
};
export const FONT_LABELS = { arial: 'Arial', georgia: 'Georgia', trebuchet: 'Trebuchet', verdana: 'Verdana', tahoma: 'Tahoma', courier: 'Courier' };
export const BLOCK_TYPES = ['heading', 'text', 'image', 'button', 'columns', 'divider', 'spacer', 'social', 'html'];
export const BLOCK_LABELS = { heading: 'Heading', text: 'Text', image: 'Image', button: 'Button', columns: 'Columns', divider: 'Divider', spacer: 'Spacer', social: 'Social links', html: 'Custom HTML', footer: 'Footer' };
export const RATIOS = { '50-50': [50, 50], '33-67': [33, 67], '67-33': [67, 33] };

/* ---------- sanitizers ---------- */
const ENT = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };
export const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ENT[c]);
const unesc = (s) => String(s).replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&');
const hex = (v, fb) => (/^#([0-9a-f]{3}|[0-9a-f]{4}|[0-9a-f]{6}|[0-9a-f]{8})$/i.test(String(v ?? '')) ? String(v) : fb);
const num = (v, min, max, fb) => { const n = Number(v); return Number.isFinite(n) ? Math.min(max, Math.max(min, Math.round(n))) : fb; };
const align = (v) => (['left', 'center', 'right'].includes(v) ? v : 'left');

// Links may be http(s), mailto, tel, or a single merge field such as {{unsubscribe_url}}.
export function safeUrl(u) {
  const s = String(u ?? '').trim();
  if (/^(https?:\/\/|mailto:|tel:)[^\s"'<>]+$/i.test(s)) return s;
  if (/^\{\{\s*[\w.|]+\s*\}\}$/.test(s)) return s;
  return '';
}
// Images must be http(s).
export const safeImage = (u) => (/^https?:\/\/[^\s"'<>]+$/i.test(String(u ?? '').trim()) ? String(u).trim() : '');

export const newId = () => Math.random().toString(36).slice(2, 10);

/* ---------- defaults ---------- */
export function defaultSettings() {
  return { background: '#f1f5f9', contentBg: '#ffffff', width: 600, font: 'arial', textColor: '#1e293b', linkColor: '#1d4ed8', fontSize: 16 };
}

export function defaultBlock(type) {
  const base = { padY: 12, padX: 24, bg: '' };
  const props = {
    heading: { ...base, text: 'Your headline', level: 1, color: '', align: 'left' },
    text: { ...base, padY: 8, text: 'Write your message here. Use **bold**, *italic* and [links](https://example.com).\n\nPersonalise it with {{first_name|there}}.', color: '', align: 'left', size: 0 },
    image: { ...base, padY: 8, padX: 0, src: '', alt: '', link: '', width: 100, align: 'center', radius: 0 },
    button: { ...base, label: 'Click here', url: 'https://', color: '#ffffff', buttonBg: '#1d4ed8', radius: 999, align: 'center', full: false },
    columns: { ...base, padY: 8, ratio: '50-50', gap: 16, cols: [[], []] },
    divider: { ...base, color: '#e2e8f0', thickness: 1 },
    spacer: { ...base, padY: 0, padX: 0, height: 24 },
    social: { ...base, align: 'center', items: [{ label: 'Facebook', url: '' }, { label: 'Instagram', url: '' }, { label: 'LinkedIn', url: '' }] },
    html: { ...base, padY: 8, html: '<p>Your custom HTML</p>' },
    footer: { ...base, padY: 8 }
  }[type];
  return { id: newId(), type, props: structuredClone(props || {}) };
}

export function defaultDesign() {
  return { version: 1, settings: defaultSettings(), blocks: [defaultBlock('footer')] };
}

/* ---------- text ---------- */
function inline(escaped, link) {
  return escaped
    .replace(/\[([^\]]+)\]\(([^)\s]+)\)/g, (m, label, url) => {
      const u = unesc(url);
      return safeUrl(u) ? `<a href="${esc(u)}" style="color:${link};text-decoration:underline">${label}</a>` : m;
    })
    .replace(/\*\*([^*\n]+)\*\*/g, '<strong>$1</strong>')
    .replace(/(^|[^*])\*([^*\n]+)\*(?!\*)/g, '$1<em>$2</em>');
}

// Blank line = new paragraph. **bold**, *italic*, [label](https://link). All text is escaped first.
export function formatText(text, link = '#1d4ed8') {
  return String(text ?? '').replace(/\r/g, '').split(/\n{2,}/).filter((p) => p.trim() !== '')
    .map((p) => `<p style="margin:0 0 14px 0">${inline(esc(p), link).replace(/\n/g, '<br>')}</p>`).join('');
}

/* ---------- blocks ---------- */
export function settingsOf(design) {
  const d = defaultSettings();
  const s = design?.settings || {};
  return {
    background: hex(s.background, d.background), contentBg: hex(s.contentBg, d.contentBg), width: num(s.width, 400, 700, d.width),
    font: FONTS[s.font] ? s.font : d.font, textColor: hex(s.textColor, d.textColor), linkColor: hex(s.linkColor, d.linkColor), fontSize: num(s.fontSize, 12, 22, d.fontSize)
  };
}

function content(block, st, editor) {
  const p = block.props || {};
  switch (block.type) {
    case 'heading': {
      const level = [1, 2, 3].includes(Number(p.level)) ? Number(p.level) : 1;
      const size = { 1: 32, 2: 24, 3: 20 }[level];
      return `<h${level} style="margin:0;font-size:${size}px;line-height:1.25;font-weight:700;color:${hex(p.color, st.textColor)};text-align:${align(p.align)}">${inline(esc(p.text), hex(p.color, st.linkColor))}</h${level}>`;
    }
    case 'text':
      return `<div style="font-size:${num(p.size || st.fontSize, 11, 28, st.fontSize)}px;line-height:1.6;color:${hex(p.color, st.textColor)};text-align:${align(p.align)}">${formatText(p.text, st.linkColor)}</div>`;
    case 'image': {
      const src = safeImage(p.src);
      if (!src) return editor ? `<div style="background:#e2e8f0;color:#64748b;text-align:center;padding:38px 12px;font-size:14px;border-radius:${num(p.radius, 0, 40, 0)}px">Image: choose a picture link in the panel</div>` : '';
      const img = `<img src="${esc(src)}" alt="${esc(p.alt)}" width="${num(p.width, 10, 100, 100)}%" style="display:inline-block;width:${num(p.width, 10, 100, 100)}%;max-width:100%;height:auto;border:0;border-radius:${num(p.radius, 0, 40, 0)}px">`;
      const href = safeUrl(p.link);
      return `<div style="text-align:${align(p.align)};line-height:0">${href ? `<a href="${esc(href)}">${img}</a>` : img}</div>`;
    }
    case 'button': {
      const href = safeUrl(p.url) || '#';
      const btn = `<a href="${esc(href)}" style="display:${p.full ? 'block' : 'inline-block'};padding:13px 28px;font-size:16px;font-weight:700;line-height:1.2;text-decoration:none;text-align:center;color:${hex(p.color, '#ffffff')};background:${hex(p.buttonBg, '#1d4ed8')};border-radius:${num(p.radius, 0, 999, 999)}px">${esc(p.label)}</a>`;
      return `<div style="text-align:${align(p.align)}">${btn}</div>`;
    }
    case 'divider':
      return `<div style="border-top:${num(p.thickness, 1, 8, 1)}px solid ${hex(p.color, '#e2e8f0')};font-size:0;line-height:0">&nbsp;</div>`;
    case 'spacer': {
      const h = num(p.height, 4, 120, 24);
      return `<div style="height:${h}px;line-height:${h}px;font-size:0">&nbsp;</div>`;
    }
    case 'social': {
      const links = (Array.isArray(p.items) ? p.items : []).slice(0, 8).map((i) => ({ label: esc(i?.label), url: safeUrl(i?.url) })).filter((i) => i.label && i.url);
      if (!links.length) return editor ? '<div style="text-align:center;color:#94a3b8;font-size:14px">Social links: add addresses in the panel</div>' : '';
      return `<div style="text-align:${align(p.align)};font-size:14px;line-height:1.8">${links.map((i) => `<a href="${esc(i.url)}" style="color:${st.linkColor};text-decoration:none;font-weight:700">${i.label}</a>`).join('<span style="color:#94a3b8">&nbsp;&nbsp;|&nbsp;&nbsp;</span>')}</div>`;
    }
    case 'html':
      return editor ? '<div style="background:#f8fafc;border:1px dashed #cbd5e1;color:#64748b;text-align:center;padding:14px;font-size:14px">Custom HTML block (shown in the preview)</div>' : String(p.html ?? '');
    case 'footer':
      return editor ? '<div style="color:#94a3b8;text-align:center;font-size:12px;padding:6px">Footer: your address and the unsubscribe link are added here automatically</div>' : '{{footer}}';
    case 'columns': {
      const [a, b] = RATIOS[p.ratio] || RATIOS['50-50'];
      const gap = num(p.gap, 0, 48, 16);
      const cell = (i) => (Array.isArray(p.cols?.[i]) ? p.cols[i] : []).filter((c) => c && c.type !== 'columns' && c.type !== 'footer')
        .map((c) => `<div style="padding:${num(c.props?.padY, 0, 60, 8)}px 0;${blockBg(c)}">${content(c, st, editor)}</div>`).join('');
      return `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0"><tr>
<td class="wm-col" width="${a}%" valign="top" style="width:${a}%;padding-right:${gap / 2}px">${cell(0)}</td>
<td class="wm-col" width="${b}%" valign="top" style="width:${b}%;padding-left:${gap / 2}px">${cell(1)}</td></tr></table>`;
    }
    default:
      return '';
  }
}

const blockBg = (b) => (hex(b.props?.bg, '') ? `background:${hex(b.props.bg, '')};` : '');
export const paddingOf = (b) => `${num(b.props?.padY, 0, 60, 12)}px ${num(b.props?.padX, 0, 60, 24)}px`;

// One block as it appears on the editing canvas (a padded div, no table row).
export function renderBlockPreview(block, design) {
  const st = settingsOf(design);
  return `<div style="padding:${paddingOf(block)};${blockBg(block)}">${content(block, st, true)}</div>`;
}

export function renderDesign(design) {
  const st = settingsOf(design);
  const blocks = Array.isArray(design?.blocks) ? design.blocks : [];
  const rows = blocks.map((b) => {
    const inner = content(b, st, false);
    if (!inner && b.type !== 'spacer') return '';
    return `<tr><td class="wm-pad" style="padding:${paddingOf(b)};${blockBg(b)}">${inner}</td></tr>`;
  }).join('\n');
  return `<style>@media (max-width:620px){.wm-col{display:block!important;width:100%!important;padding-left:0!important;padding-right:0!important}.wm-pad{padding-left:16px!important;padding-right:16px!important}}</style>
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="background:${st.background}"><tr><td align="center" style="padding:24px 12px">
<table role="presentation" width="${st.width}" cellpadding="0" cellspacing="0" border="0" style="width:100%;max-width:${st.width}px;background:${st.contentBg};font-family:${FONTS[st.font]};font-size:${st.fontSize}px;line-height:1.6;color:${st.textColor}">
${rows}
</table></td></tr></table>`;
}

/* ---------- previews ---------- */
const SAMPLE = { first_name: 'Ada', last_name: 'Obi', email: 'ada@example.com' };
// A quick stand-in for the real merge, only used to show previews inside the builder.
export function sampleMerge(html) {
  return String(html).replace(/\{\{\s*([\w.]+)\s*(?:\|\s*([^{}]*?)\s*)?\}\}/g, (m, key, fallback) => {
    if (key === 'footer') return '<div style="margin-top:8px;padding-top:12px;border-top:1px solid #e2e8f0;font:12px/1.6 Arial,sans-serif;color:#64748b;text-align:center">Your postal address<br><span style="color:#1d4ed8;text-decoration:underline">Unsubscribe</span> from these emails.</div>';
    if (key === 'unsubscribe_url') return '#';
    return esc(SAMPLE[key] ?? fallback ?? '');
  });
}
export const previewDocument = (html) => `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"></head><body style="margin:0;background:#f8fafc">${sampleMerge(html)}</body></html>`;

export const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

const BASE_CSS = `*{box-sizing:border-box}body{margin:0;font:16px/1.5 system-ui,-apple-system,"Segoe UI",Arial,sans-serif;color:#0f172a}
h1{margin:0 0 6px;font-size:22px;color:#0b2a5b}.muted{color:#64748b}
.btn{display:inline-block;width:100%;border:0;border-radius:999px;padding:12px 22px;font:600 15px system-ui,Arial,sans-serif;color:#fff;background:linear-gradient(135deg,#0b2a5b,#2f80ed);cursor:pointer;text-decoration:none;text-align:center}
.btn:disabled{opacity:.6;cursor:progress}`;

// Plain message page (no scripts). `body` must already be safe HTML.
export function messagePage(title, body, { actionHtml = '' } = {}) {
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="robots" content="noindex"><title>${esc(title)}</title>
<style>${BASE_CSS}body{display:flex;align-items:center;justify-content:center;min-height:100vh;padding:24px;background:linear-gradient(180deg,#fff,#f1f6ff)}
.card{width:100%;max-width:440px;background:#fff;border:1px solid #e2e8f0;border-radius:16px;padding:32px;text-align:center;box-shadow:0 10px 30px rgba(11,42,91,.08)}
.card p{margin:8px 0 20px;color:#475569}.foot{margin-top:18px;font-size:12px;color:#94a3b8}</style></head>
<body><div class="card"><h1>${esc(title)}</h1><p>${body}</p>${actionHtml}<div class="foot">Powered by Wynmail</div></div></body></html>`;
}

export function formPage({ f, t, embed, nonce }) {
  const names = f.ask_names ? `<div class="row"><div class="field"><label for="fn">First name</label><input id="fn" name="first_name" type="text" autocomplete="given-name" maxlength="60"></div>
<div class="field"><label for="ln">Last name</label><input id="ln" name="last_name" type="text" autocomplete="family-name" maxlength="60"></div></div>` : '';
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="robots" content="noindex"><title>${esc(f.title)}</title>
<style>${BASE_CSS}
body{display:flex;justify-content:center;align-items:${embed ? 'flex-start' : 'center'};min-height:${embed ? '0' : '100vh'};padding:${embed ? '4px' : '24px'};background:${embed ? 'transparent' : 'linear-gradient(180deg,#fff,#f1f6ff)'}}
.card{width:100%;max-width:440px;background:#fff;border:1px solid #e2e8f0;border-radius:16px;padding:${embed ? '22px' : '30px'};${embed ? '' : 'box-shadow:0 10px 30px rgba(11,42,91,.08);'}}
.d{margin:0 0 18px;color:#64748b}.field{margin-bottom:14px}.row{display:flex;gap:10px}.row>.field{flex:1;min-width:0}
label{display:block;font-size:13px;font-weight:600;color:#64748b;margin-bottom:6px}
input[type=email],input[type=text]{width:100%;padding:11px 12px;border:1px solid #e2e8f0;border-radius:10px;font:inherit;background:#fff;color:#0f172a}
input:focus{outline:2px solid rgba(47,128,237,.35);border-color:#2f80ed}
.consent{display:flex;gap:10px;align-items:flex-start;font-size:14px;font-weight:400;color:#334155;margin:4px 0 16px}.consent input{margin-top:4px;flex:none}
.err{background:#fef2f2;color:#b91c1c;border:1px solid #fecaca;border-radius:10px;padding:10px 12px;font-size:14px;margin-bottom:14px}
.done{text-align:center;padding:10px 0}.done h1{margin-bottom:8px}
.hp{position:absolute;left:-9999px;width:1px;height:1px;overflow:hidden}.foot{margin-top:16px;text-align:center;font-size:12px;color:#94a3b8}</style></head>
<body><div class="card" id="card">
<form id="f" method="post" action="/f/${esc(f.slug)}/subscribe" novalidate>
<h1>${esc(f.title)}</h1>${f.description ? `<p class="d">${esc(f.description)}</p>` : '<div style="height:12px"></div>'}
<div id="err" class="err" role="alert" hidden></div>
${names}
<div class="field"><label for="em">Email address</label><input id="em" name="email" type="email" autocomplete="email" required maxlength="254"></div>
<div class="hp" aria-hidden="true"><label>Website</label><input type="text" name="website" tabindex="-1" autocomplete="off"></div>
<input type="hidden" name="t" value="${esc(t)}"><input type="hidden" name="tz" id="tz" value="">
<label class="consent"><input type="checkbox" name="consent" value="on" required><span>${esc(f.consent_text)}</span></label>
<button class="btn" id="go" type="submit">${esc(f.button_label)}</button>
</form>
<div class="foot">Powered by Wynmail</div></div>
<script nonce="${nonce}">
(function(){
var form=document.getElementById('f'),err=document.getElementById('err'),go=document.getElementById('go'),label=go.textContent,embed=${embed ? 'true' : 'false'};
try{document.getElementById('tz').value=Intl.DateTimeFormat().resolvedOptions().timeZone||'';}catch(e){}
function size(){if(embed&&parent!==window)parent.postMessage({type:'wynmail-height',height:document.documentElement.scrollHeight+8},'*');}
size();window.addEventListener('load',size);
form.addEventListener('submit',function(e){
e.preventDefault();err.hidden=true;go.disabled=true;go.textContent='Please wait...';
var data={};new FormData(form).forEach(function(v,k){data[k]=v;});
fetch(form.action,{method:'POST',headers:{'Content-Type':'application/json',Accept:'application/json'},body:JSON.stringify(data)})
.then(function(r){return r.json().then(function(j){return {ok:r.ok,j:j};});})
.then(function(x){
if(!x.ok)throw new Error(x.j.error||'Something went wrong. Please try again.');
var c=document.getElementById('card');c.textContent='';
var d=document.createElement('div');d.className='done';var h=document.createElement('h1');h.textContent='Thank you';
var p=document.createElement('p');p.className='d';p.textContent=x.j.message;d.appendChild(h);d.appendChild(p);c.appendChild(d);size();
if(x.j.redirect){setTimeout(function(){if(embed&&parent!==window)parent.postMessage({type:'wynmail-redirect',url:x.j.redirect},'*');else location.href=x.j.redirect;},1500);}
})
.catch(function(ex){err.textContent=ex.message;err.hidden=false;go.disabled=false;go.textContent=label;size();});
});
})();
</script></body></html>`;
}

const maskEmail = (e) => { const [l, d] = String(e).split('@'); return `${l.slice(0, 1)}${'*'.repeat(Math.max(2, Math.min(6, l.length - 1)))}@${d}`; };

// The preference center. Plain forms, no scripts. Every change is a POST, so mail scanners that open the link change nothing.
export function prefsPage({ ws, contact, lists, left, token, notice = '' }) {
  const t = esc(token);
  const checks = [
    ...lists.map((l) => `<label class="opt"><input type="checkbox" name="keep" value="${l.id}" checked><span>${esc(l.name)}</span></label>`),
    ...left.map((l) => `<label class="opt"><input type="checkbox" name="keep" value="${l.id}"><span>${esc(l.name)} <em>(you left this list)</em></span></label>`)
  ].join('');
  const shown = [...lists, ...left].map((l) => l.id).join(',');
  const freq = (v, label) => `<label class="opt"><input type="radio" name="freq" value="${v}"${Number(contact.max_per_week || 0) === v ? ' checked' : ''}><span>${label}</span></label>`;
  const paused = contact.paused_until && new Date(contact.paused_until) > new Date();
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="robots" content="noindex"><title>Email preferences</title>
<style>${BASE_CSS}body{padding:24px;background:linear-gradient(180deg,#fff,#f1f6ff)}
.wrap{max-width:520px;margin:0 auto}.card{background:#fff;border:1px solid #e2e8f0;border-radius:16px;padding:24px;margin-bottom:16px;box-shadow:0 10px 30px rgba(11,42,91,.06)}
h2{margin:0 0 4px;font-size:17px;color:#0b2a5b}.sub{margin:0 0 14px;color:#64748b;font-size:14px}
.opt{display:flex;gap:10px;align-items:flex-start;margin:0 0 10px;font-size:15px;cursor:pointer}.opt input{margin-top:4px;flex:none}.opt em{color:#94a3b8;font-style:normal;font-size:13px}
.ok{background:#ecfdf5;color:#047857;border:1px solid #a7f3d0;border-radius:10px;padding:10px 12px;margin-bottom:16px;font-size:14px}
.btn.sec{background:#fff;color:#0b2a5b;border:1px solid #cbd5e1}.btn.dng{background:#fff;color:#b91c1c;border:1px solid #fecaca}.gap{margin-top:10px}.foot{text-align:center;font-size:12px;color:#94a3b8}
.note{margin:0 0 12px;padding:10px 12px;background:#fffbeb;border:1px solid #fde68a;border-radius:10px;font-size:14px;color:#92400e}</style></head>
<body><div class="wrap">
<h1 style="margin-bottom:4px">Email preferences</h1>
<p class="sub" style="margin-bottom:16px">${esc(ws.name)} sends to ${esc(maskEmail(contact.email))}. Choose what you want to hear about.</p>
${notice ? `<div class="ok" role="status">${esc(notice)}</div>` : ''}
<form class="card" method="post" action="/t/p/${t}">
<input type="hidden" name="action" value="save"><input type="hidden" name="shown" value="${esc(shown)}">
${checks ? `<h2>Topics</h2><p class="sub">Untick anything you do not want any more.</p>${checks}` : ''}
<h2 style="margin-top:${checks ? '18px' : '0'}">How often</h2><p class="sub">A limit applies to every email from this sender.</p>
${freq(0, 'Send me everything')}${freq(1, 'At most 1 email a week')}${freq(2, 'At most 2 emails a week')}
<button class="btn gap" type="submit">Save my preferences</button></form>
<div class="card"><h2>Need a break?</h2>
${paused ? `<div class="note">Emails are paused until ${esc(new Date(contact.paused_until).toDateString())}.</div>
<form method="post" action="/t/p/${t}"><input type="hidden" name="action" value="resume"><button class="btn sec" type="submit">Start emails again</button></form>`
  : `<p class="sub">Pause everything and we will not email you until it ends.</p>
<form method="post" action="/t/p/${t}"><input type="hidden" name="action" value="pause"><div class="opt"><span style="flex:1"><button class="btn sec" name="days" value="30" type="submit">Pause for 30 days</button></span><span style="flex:1"><button class="btn sec" name="days" value="90" type="submit">Pause for 90 days</button></span></div></form>`}
</div>
<div class="card"><h2>Leave completely</h2><p class="sub">You will not receive any more emails from ${esc(ws.name)}.</p>
<form method="post" action="/t/u/${t}"><button class="btn dng" type="submit">Unsubscribe from everything</button></form></div>
<div class="foot">Powered by Wynmail</div></div></body></html>`;
}

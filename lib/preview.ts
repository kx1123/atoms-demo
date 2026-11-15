export function previewDocument(html: string, token: string, state: Record<string, unknown>) {
  const initial = JSON.stringify(state).replace(/</g, '\\u003c').replace(/>/g, '\\u003e');
  const channel = JSON.stringify(token);
  const bridge = `<meta http-equiv="Content-Security-Policy" content="default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; img-src data: blob:; font-src 'none'; connect-src 'none'; frame-src 'none'; object-src 'none'; form-action 'none'; base-uri 'none';">
<script>(()=>{const token=${channel};let data=${initial};const send=(type,payload)=>parent.postMessage({channel:'atoms-preview',token,type,...payload},'*');window.atoms=Object.freeze({get:(key,fallback)=>Object.hasOwn(data,key)?structuredClone(data[key]):fallback,set:(key,value)=>{if(typeof key!=='string'||key.length>100)return;const next={...data,[key]:value};if(JSON.stringify(next).length>100000)throw Error('应用数据超过100KB');data=next;send('state',{value:data})}});window.addEventListener('error',e=>send('error',{message:String(e.message).slice(0,1500)}));window.addEventListener('unhandledrejection',e=>send('error',{message:String(e.reason).slice(0,1500)}));window.addEventListener('DOMContentLoaded',()=>send('ready',{}));})();</script>`;
  return html.replace(/<head(?:\s[^>]*)?>/i, match => `${match}${bridge}`);
}

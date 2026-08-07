import { chromium } from 'playwright';
import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { изолировать, подготовить, вишУжеВиден, ШУМ } from './stub.mjs';
const К='/Users/naboy/Documents/GitHub/aintonx.github.io';
const srv=createServer(async(q,r)=>{const u=decodeURIComponent(q.url.split('?')[0]);
 try{const b=await readFile(path.join(К,u==='/'?'index.html':u.slice(1)));
 r.writeHead(200,{'Content-Type':u.endsWith('.css')?'text/css':u.endsWith('.js')?'text/javascript':'text/html','Cache-Control':'no-store'});r.end(b);}catch{r.writeHead(404).end();}});
await new Promise(r=>srv.listen(0,'127.0.0.1',r));
const база=`http://127.0.0.1:${srv.address().port}/`;
const br=await chromium.launch();
const ctx=await br.newContext({viewport:{width:390,height:844},hasTouch:true,isMobile:true});
const page=await ctx.newPage();
const ошибки=[];
page.on('pageerror',e=>ошибки.push('PAGEERROR: '+e.message));
page.on('console',m=>{if(m.type()==='error'&&!ШУМ.test(m.text()))ошибки.push('console: '+m.text().slice(0,140));});
await изолировать(page,база); await вишУжеВиден(page);
await page.goto(база,{waitUntil:'load'}); await подготовить(page);
await page.waitForTimeout(2500);
const сост=await page.evaluate(()=>({
  оскЕсть: !!document.getElementById('echoOscPath'),
  привязан: !!(document.getElementById('echoOscPath')||{})._echoOscBound,
  d: (document.getElementById('echoOscPath')||{}).getAttribute ? document.getElementById('echoOscPath').getAttribute('d').slice(0,30) : null,
  initEchoБыл: typeof window._echoStartOsc==='function'
}));
console.log(JSON.stringify({ошибок:ошибки.length, ошибки:ошибки.slice(0,6), сост},null,2));
await br.close(); srv.close();

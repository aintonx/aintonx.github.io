import { chromium } from 'playwright';
import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { PNG } from 'pngjs';
import { изолировать, подготовить, вишУжеВиден } from './stub.mjs';
const К='/Users/naboy/Documents/GitHub/aintonx.github.io';
const srv=createServer(async(q,r)=>{const u=decodeURIComponent(q.url.split('?')[0]);
 try{const b=await readFile(path.join(К,u==='/'?'index.html':u.slice(1)));
 r.writeHead(200,{'Content-Type':u.endsWith('.css')?'text/css':u.endsWith('.js')?'text/javascript':'text/html','Cache-Control':'no-store'});r.end(b);}catch{r.writeHead(404).end();}});
await new Promise(r=>srv.listen(0,'127.0.0.1',r));
const база=`http://127.0.0.1:${srv.address().port}/`;
const br=await chromium.launch();
const ctx=await br.newContext({viewport:{width:390,height:844},hasTouch:true,isMobile:true});
const page=await ctx.newPage();
await изолировать(page,база); await вишУжеВиден(page);
await page.goto(база,{waitUntil:'load'}); await подготовить(page);
await page.locator('#echo').scrollIntoViewIfNeeded(); await page.waitForTimeout(1200);
const цель=page.locator(process.argv[2]||'#echoBeam');
const кадры=[];
for(let i=0;i<4;i++){ кадры.push(PNG.sync.read(await цель.screenshot())); await page.waitForTimeout(200); }
function разн(a,b){let n=0;for(let i=0;i<a.data.length;i+=4){if(Math.abs(a.data[i]-b.data[i])>8||Math.abs(a.data[i+1]-b.data[i+1])>8||Math.abs(a.data[i+2]-b.data[i+2])>8)n++;}return n;}
const пары=[];for(let i=1;i<кадры.length;i++)пары.push(разн(кадры[i-1],кадры[i]));
console.log(JSON.stringify({размер:[кадры[0].width,кадры[0].height],
  различийМеждуКадрами:пары, движется:пары.every(v=>v>50)},null,2));
await br.close(); srv.close();

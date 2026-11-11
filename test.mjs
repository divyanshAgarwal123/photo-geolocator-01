import test from 'node:test';
import assert from 'node:assert/strict';
import {createServer} from 'node:http';
import {once} from 'node:events';
import {spawn} from 'node:child_process';
import {mkdtemp,symlink,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {fileURLToPath} from 'node:url';
import {decodeJpeg} from './jpeg.ts';
import {features,locate,laneEvidence} from './main.ts';

function scene(color) {
  const width=240,height=160,rgb=new Uint8Array(width*height*3);
  for (let i=0;i<rgb.length;i+=3) rgb.set(color,i);
  return {width,height,rgb};
}

function road(direction) {
  const image=scene([115,115,115]);
  for (let y=91;y<146;y++) {
    const t=(y-91)/55,x=Math.round(240*(0.5+direction*0.2*t));
    for (let dx=-2;dx<=2;dx++) image.rgb.set([220,190,30],(y*240+x+dx)*3);
  }
  return image;
}

test('a plain field of yellow is not a painted lane',()=>{
  assert.deepEqual(laneEvidence(scene([200,170,30])),[0,0]);
});

test('painted perspective traces preserve their left/right orientation',()=>{
  const left=laneEvidence(road(-1)),right=laneEvidence(road(1));
  assert.ok(left[0]>0.8 && left[0]>left[1]*1.35);
  assert.ok(right[1]>0.8 && right[1]>right[0]*1.35);
  assert.ok(locate(features(road(-1))).lon<0);
  assert.ok(locate(features(road(1))).lon>0);
});

test('uniform scenes yield finite feature ratios and valid coordinates',()=>{
  for (const color of [[0,0,0],[255,255,255],[0,100,0],[150,120,70],[120,120,120]]) {
    const f=features(scene(color));
    for (const n of Object.values(f)) assert.ok(Number.isFinite(n) && n>=0 && n<=1);
    const p=locate(f);
    assert.ok(Number.isFinite(p.lat) && Math.abs(p.lat)<=90);
    assert.ok(Number.isFinite(p.lon) && Math.abs(p.lon)<=180);
  }
});

test('truncated and non-JPEG data fail instead of fabricating pixels',()=>{
  for (const a of [[],[1,2,3],[255,216],[255,216,255,219,0,67]]) {
    assert.throws(()=>decodeJpeg(new Uint8Array(a)));
  }
});

async function runAgent(base,entry='main.ts') {
  const child=spawn(process.execPath,[entry],{
    cwd:new URL('.',import.meta.url),
    env:{PATH:process.env.PATH,MAKEFUN_ENV_URL:base},stdio:['ignore','pipe','pipe'],
  });
  let output='';
  child.stdout.on('data',b=>output+=b); child.stderr.on('data',b=>output+=b);
  const [code]=await once(child,'exit');
  return {code,output};
}

async function withServer(handler,fn) {
  const server=createServer(handler);
  server.listen(0,'127.0.0.1'); await once(server,'listening');
  try { await fn('http://127.0.0.1:'+server.address().port); }
  finally { await new Promise(resolve=>server.close(resolve)); }
}

test('unsupported photo falls back; repeated runs leave identical answer bytes',async()=>{
  const posted=[],routes=[];
  await withServer(async(req,res)=>{
    routes.push(req.url);
    if(req.url==='/photos') return res.end(JSON.stringify({photos:[{id:'p01',url:'/photos/p01.jpg',answered:false}]}));
    if(req.url==='/photos/p01.jpg') return res.end('bad JPEG');
    if(req.url==='/answers') {
      let raw=''; for await(const chunk of req) raw+=chunk;
      posted.push(raw); res.end(JSON.stringify({accepted:['p01'],answered:1,left:0})); return;
    }
    res.writeHead(404);res.end();
  },async base=>{
    assert.equal((await runAgent(base)).code,0);
    assert.equal((await runAgent(base)).code,0);
  });
  assert.equal(posted.length,2); assert.equal(posted[0],posted[1]);
  assert.deepEqual(JSON.parse(posted[0]),{answers:[{id:'p01',lat:15,lon:5}]});
  assert.ok(routes.every(p=>['/photos','/photos/p01.jpg','/answers'].includes(p)));
});

test('a manifest cannot redirect image fetching outside the task API',async()=>{
  await withServer((req,res)=>res.end(JSON.stringify({photos:[{id:'p01',url:'https://example.com/photos/p01.jpg',answered:false}]})),async base=>{
    const result=await runAgent(base);
    assert.equal(result.code,1); assert.match(result.output,/invalid photo URL/);
  });
});

test('already answered photos are not submitted twice',async()=>{
  const routes=[];
  await withServer((req,res)=>{
    routes.push(req.url);
    res.end(JSON.stringify({photos:[{id:'p01',url:'/photos/p01.jpg',answered:true}]}));
  },async base=>assert.equal((await runAgent(base)).code,0));
  assert.deepEqual(routes,['/photos']);
});

test('a duplicate manifest is rejected before an answer batch is sent',async()=>{
  let posted=false;
  await withServer((req,res)=>{
    if(req.url==='/photos') {
      const photo={id:'p01',url:'/photos/p01.jpg',answered:false};
      return res.end(JSON.stringify({photos:[photo,photo]}));
    }
    if(req.url==='/answers') posted=true;
    res.end('bad JPEG');
  },async base=>{
    const result=await runAgent(base);
    assert.equal(result.code,1);
    assert.match(result.output,/duplicate photo identifier/);
  });
  assert.equal(posted,false);
});

test('a symlinked launcher executes the real entrypoint',async()=>{
  const dir=await mkdtemp(join(tmpdir(),'street-compass-test-'));
  const entry=join(dir,'launch.ts');
  await symlink(fileURLToPath(new URL('./main.ts',import.meta.url)),entry);
  const routes=[];
  try {
    await withServer((req,res)=>{
      routes.push(req.url); res.end(JSON.stringify({photos:[]}));
    },async base=>assert.equal((await runAgent(base,entry)).code,0));
    assert.deepEqual(routes,['/photos']);
  } finally {await rm(dir,{recursive:true,force:true});}
});

/** Model-free photo geolocation: handcrafted scene cues and a conservative prior.
 * Calls only the task's photo/answer API. No inference gateway, external services,
 * metadata lookup, stored photo identities, learned weights, or randomness.
 */
import { pathToFileURL } from 'node:url';
import { realpathSync } from 'node:fs';
import { decodeJpeg, type Raster } from './jpeg.ts';

export interface Features {
  green: number; dry: number; red: number; snow: number; sky: number;
  light: number; dark: number; saturation: number; yellowRoad: number;
  yellowLeft: number; yellowRight: number;
}
export interface Estimate {lat:number; lon:number; cue:string}

export function features(image: Raster): Features {
  const f={green:0,dry:0,red:0,snow:0,sky:0,light:0,dark:0,saturation:0,yellowRoad:0,yellowLeft:0,yellowRight:0};
  let ground=0, upper=0, road=0;
  for (let y=0;y<image.height;y+=2) for (let x=0;x<image.width;x+=2) {
    const i=(y*image.width+x)*3, r=image.rgb[i], g=image.rgb[i+1], b=image.rgb[i+2];
    const lo=Math.min(r,g,b), hi=Math.max(r,g,b), chroma=hi-lo;
    const nx=x/image.width, ny=y/image.height;
    if (ny<0.4) {
      upper++;
      if (b>r*1.15 && b>g*1.04 && b>100) f.sky++;
    }
    if (ny>0.35 && ny<0.9) {
      ground++;
      f.saturation+=hi===0 ? 0 : chroma/hi;
      if (g>r*1.08 && g>b*1.12 && g>35) f.green++;
      if (r>b*1.22 && g>b*1.12 && r>=g && r<g*1.5 && r>90) f.dry++;
      if (r>g*1.3 && r>b*1.45 && r>90) f.red++;
      if (lo>190 && chroma<28) f.snow++;
      if (lo>160 && chroma<50) f.light++;
      if (hi<65) f.dark++;
    }
    if (ny>0.55 && ny<0.9 && nx>0.25 && nx<0.75) {
      road++;
      if (r>130 && g>110 && b<g*0.65 && r/g<1.5) f.yellowRoad++;
    }
  }
  for (const k of ['green','dry','red','snow','light','dark','saturation'] as const) f[k]/=Math.max(1,ground);
  f.sky/=Math.max(1,upper); f.yellowRoad/=Math.max(1,road);
  [f.yellowLeft,f.yellowRight]=laneEvidence(image);
  return f;
}

/** Yellow paint must form a thin, road-length trace bordered by neutral pavement.
 * A horizon-to-bottom sweep searches a fixed fan of straight perspective lines.
 * This detects paint geometry, not text, camera identity, or a stored image.
 */
export function laneEvidence(image: Raster): [number,number] {
  const {width:w,height:h,rgb}=image;
  const yellow=(x:number,y:number):boolean => {
    if (x<0 || x>=w || y<0 || y>=h) return false;
    const p=(y*w+x)*3,r=rgb[p],g=rgb[p+1],b=rgb[p+2];
    return r>95 && g>80 && b<g*0.77 && r>g*0.9 && r<g*1.55;
  };
  const neutral=(x:number,y:number):boolean => {
    if (x<0 || x>=w) return false;
    const p=(y*w+x)*3,r=rgb[p],g=rgb[p+1],b=rgb[p+2];
    return Math.max(r,g,b)-Math.min(r,g,b)<32 && r>45 && r<225;
  };
  const result:[number,number]=[0,0];
  const start=Math.floor(h*0.63), stop=Math.floor(h*0.94);
  const separation=Math.max(4,Math.round(w*0.014));
  for (let origin=0.3;origin<=0.7;origin+=0.0125) {
    for (let bottom=0.12;bottom<=0.88;bottom+=0.01) {
      if (Math.abs(bottom-origin)<0.035) continue;
      let hit=0,total=0;
      const bands=[0,0,0];
      for (let y=start;y<stop;y+=2) {
        const t=(y-start)/(stop-start),x=Math.round(w*(origin+(bottom-origin)*t));
        total++;
        let painted=false;
        for (let dx=-2;dx<=2;dx++) {
          const sx=x+dx;
          if (yellow(sx,y) && neutral(sx-separation,y) && neutral(sx+separation,y)
              && neutral(sx-2*separation,y) && neutral(sx+2*separation,y)) painted=true;
        }
        if (painted) { hit++; bands[Math.min(2,Math.floor(t*3))]++; }
      }
      // A sign, building, or a single yellow stripe across the view is insufficient.
      if (bands.every(n=>n>=2)) {
        const side=bottom<origin ? 0 : 1;
        result[side]=Math.max(result[side],hit/total);
      }
    }
  }
  return result;
}

/** These broad rules are qualitative climate guesses, not country recognition. */
export function locate(f: Features): Estimate {
  if (f.yellowLeft>0.5 && f.yellowLeft>f.yellowRight*1.35) {
    return f.dry>0.2
      ? {lat:8,lon:-75,cue:'yellow centreline on left; dry vegetation'}
      : {lat:35,lon:-95,cue:'yellow centreline on left'};
  }
  if (f.yellowRight>0.5 && f.yellowRight>f.yellowLeft*1.35) {
    return f.green>0.15 && f.dark>0.3
      ? {lat:-25,lon:150,cue:'yellow centreline on right; leafy scene'}
      : {lat:15,lon:120,cue:'yellow centreline on right'};
  }
  if (f.snow>0.28 && f.green<0.03) return {lat:57,lon:15,cue:'snow-like ground'};
  if (f.sky<0.02 && f.saturation<0.18) return {lat:52,lon:30,cue:'overcast desaturated scene'};
  if (f.dry>0.24 && f.green<0.04) return {lat:29,lon:22,cue:'dry open scene'};
  if (f.green>0.34 && f.saturation>0.3) return {lat:5,lon:25,cue:'lush scene'};
  return {lat:15,lon:5,cue:'weak cues: geographic prior'};
}

export function estimate(jpeg: Uint8Array): Estimate {
  return locate(features(decodeJpeg(jpeg)));
}

async function json(url: string, init?: RequestInit): Promise<any> {
  const response=await fetch(url,{...init,redirect:'error'});
  if (!response.ok) throw new Error('Task API returned HTTP '+response.status);
  return response.json();
}

export async function main(): Promise<void> {
  const configured=process.env.MAKEFUN_ENV_URL;
  if (!configured) throw new Error('MAKEFUN_ENV_URL is required');
  const base=new URL(configured);
  if (!['http:','https:'].includes(base.protocol)) throw new Error('invalid task API protocol');
  const listed=await json(new URL('/photos',base).href);
  if (!Array.isArray(listed.photos) || listed.photos.length>25) throw new Error('invalid photo manifest');
  const photos=listed.photos.filter((p:any)=>!p.answered);
  const answers:{id:string;lat:number;lon:number}[]=[];
  const seen=new Set<string>();
  for (const photo of photos) {
    if (typeof photo.id!=='string' || !/^p\d{2}$/.test(photo.id)) throw new Error('invalid photo identifier');
    if (seen.has(photo.id)) throw new Error('duplicate photo identifier');
    seen.add(photo.id);
    const url=new URL(photo.url,base);
    if (url.origin!==base.origin || url.pathname!=='/photos/'+photo.id+'.jpg') throw new Error('invalid photo URL');
    const response=await fetch(url,{redirect:'error'});
    if (!response.ok) throw new Error('Photo API returned HTTP '+response.status);
    let guess:Estimate;
    try { guess=estimate(new Uint8Array(await response.arrayBuffer())); }
    catch (error) {
      process.stderr.write('decoder fallback for '+photo.id+': '+String(error)+'\n');
      guess={lat:15,lon:5,cue:'unsupported image'};
    }
    answers.push({id:photo.id,lat:guess.lat,lon:guess.lon});
    process.stdout.write(photo.id+': '+guess.cue+'\n');
  }
  if (answers.length) {
    const receipt=await json(new URL('/answers',base).href,{
      method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({answers}),
    });
    if (!Array.isArray(receipt.accepted) || receipt.accepted.length!==answers.length
        || !answers.every(a=>receipt.accepted.includes(a.id))) throw new Error('answer receipt identifiers mismatch');
    process.stdout.write('Accepted '+answers.length+' answers; model calls: 0.\n');
  }
}

// The local harness stages /var paths that resolve to /private/var on macOS.
if (process.argv[1] && import.meta.url===pathToFileURL(realpathSync(process.argv[1])).href) {
  main().catch(error=>{process.stderr.write(String(error)+'\n');process.exitCode=1;});
}

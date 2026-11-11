/** A small baseline JPEG decoder. No metadata, trained parameters, or dependencies.
 * Produces the average of each 2x2 pixel square directly from the DCT coefficients.
 * The constants below are defined by JPEG's zigzag order and inverse DCT.
 */
export interface Raster { width: number; height: number; rgb: Uint8Array }

const ZIGZAG = [
  0,1,8,16,9,2,3,10,17,24,32,25,18,11,4,5,
  12,19,26,33,40,48,41,34,27,20,13,6,7,14,21,28,
  35,42,49,56,57,50,43,36,29,22,15,23,30,37,44,51,
  58,59,52,45,38,31,39,46,53,60,61,54,47,55,62,63,
];
const BASIS = Array.from({length:4}, (_, x) =>
  Array.from({length:8}, (_, u) => (u === 0 ? Math.SQRT1_2 : 1) *
    (Math.cos((4*x+1)*u*Math.PI/16) + Math.cos((4*x+3)*u*Math.PI/16))/2));
interface Huffman { byLength: Map<number,number>[] }
interface Component {
  id: number; h: number; v: number; q: number; dc: number;
  stride: number; rows: number; plane: Float32Array;
}
const clamp = (x: number) => Math.max(0, Math.min(255, Math.round(x)));

class Bits {
  data: Uint8Array; pos: number; value = 0; left = 0;
  constructor(data: Uint8Array, pos: number) { this.data = data; this.pos = pos; }
  bit(): number {
    if (this.left === 0) {
      if (this.pos >= this.data.length) throw new Error('truncated JPEG entropy');
      this.value = this.data[this.pos++];
      if (this.value === 255 && this.data[this.pos++] !== 0) {
        throw new Error('unexpected marker inside JPEG scan');
      }
      this.left = 8;
    }
    this.left--;
    return (this.value >> this.left) & 1;
  }
  unsigned(n: number): number {
    if (n < 0 || n > 16) throw new Error('invalid JPEG coefficient size');
    let x = 0;
    for (let i=0; i<n; i++) x = x*2 + this.bit();
    return x;
  }
  signed(n: number): number {
    if (n === 0) return 0;
    const x = this.unsigned(n);
    return x < 2**(n-1) ? x - (2**n-1) : x;
  }
  symbol(table: Huffman): number {
    let code = 0;
    for (let n=1; n<=16; n++) {
      code = code*2 + this.bit();
      const value = table.byLength[n].get(code);
      if (value !== undefined) return value;
    }
    throw new Error('invalid JPEG Huffman code');
  }
  restart(expected: number): void {
    this.left = 0;
    if (this.data[this.pos++] !== 255) throw new Error('missing JPEG restart');
    while (this.data[this.pos] === 255) this.pos++;
    if (this.data[this.pos++] !== 0xd0+expected) throw new Error('wrong JPEG restart');
  }
}

/** Separable inverse DCT, evaluated at the four pair-averaged samples per axis. */
function renderBlock(coeff: Float64Array, component: Component, bx: number, by: number): void {
  const temp = new Float64Array(32);
  for (let v=0; v<8; v++) for (let x=0; x<4; x++) {
    let sum = 0;
    for (let u=0; u<8; u++) sum += coeff[v*8+u]*BASIS[x][u];
    temp[v*4+x] = sum;
  }
  for (let y=0; y<4; y++) for (let x=0; x<4; x++) {
    let sum = 0;
    for (let v=0; v<8; v++) sum += temp[v*4+x]*BASIS[y][v];
    component.plane[(by*4+y)*component.stride+bx*4+x] = Math.max(0,Math.min(255,128+sum/4));
  }
}

export function decodeJpeg(data: Uint8Array): Raster {
  if (data.length > 8*1024*1024 || data[0] !== 255 || data[1] !== 216) {
    throw new Error('not a bounded JPEG');
  }
  let pos = 2, width = 0, height = 0, maxH = 0, maxV = 0, restart = 0;
  let components: Component[] = [];
  const quant = new Map<number,Float64Array>();
  const huffman = new Map<number,Huffman>();
  const word = (p: number) => data[p]*256 + data[p+1];
  while (pos < data.length) {
    if (data[pos++] !== 255) throw new Error('invalid JPEG segment boundary');
    while (data[pos] === 255) pos++;
    const marker = data[pos++];
    if (marker === 0xd9) break;
    const length = word(pos);
    if (length < 2 || pos+length > data.length) throw new Error('truncated JPEG segment');
    const end = pos+length;
    pos += 2;
    if (marker === 0xdb) {
      while (pos < end) {
        const info = data[pos++], precision = info >> 4, id = info & 15;
        if (precision > 1 || pos+64*(precision+1) > end) throw new Error('invalid JPEG quantization');
        const values = new Float64Array(64);
        for (let i=0; i<64; i++) {
          values[ZIGZAG[i]] = precision ? word(pos) : data[pos];
          pos += precision+1;
        }
        quant.set(id,values);
      }
    } else if (marker === 0xc4) {
      while (pos < end) {
        const id = data[pos++];
        if (pos+16 > end) throw new Error('truncated Huffman table');
        const counts = data.slice(pos,pos+16); pos += 16;
        let code = 0;
        const byLength = Array.from({length:17}, () => new Map<number,number>());
        for (let n=1; n<=16; n++) {
          if (code+counts[n-1] > 2**n || pos+counts[n-1] > end) throw new Error('invalid Huffman table');
          for (let i=0; i<counts[n-1]; i++) byLength[n].set(code++, data[pos++]);
          code *= 2;
        }
        huffman.set(id,{byLength});
      }
    } else if (marker === 0xc0) {
      if (data[pos++] !== 8) throw new Error('only 8-bit JPEG is supported');
      height = word(pos); width = word(pos+2); pos += 4;
      const count = data[pos++];
      if (![1,3].includes(count) || width < 1 || height < 1 || width*height > 4_000_000) {
        throw new Error('unsupported JPEG dimensions or channels');
      }
      if (pos+count*3 !== end) throw new Error('invalid frame size');
      components = [];
      for (let i=0; i<count; i++) {
        const id=data[pos++], sampling=data[pos++], q=data[pos++];
        const h=sampling>>4, v=sampling&15;
        if (h<1 || h>4 || v<1 || v>4) throw new Error('invalid sampling');
        maxH=Math.max(maxH,h); maxV=Math.max(maxV,v);
        components.push({id,h,v,q,dc:0,stride:0,rows:0,plane:new Float32Array()});
      }
    } else if (marker === 0xdd) {
      if (length !== 4) throw new Error('invalid restart interval');
      restart=word(pos);
    } else if (marker === 0xc2) {
      throw new Error('progressive JPEG is outside the baseline decoder');
    } else if (marker === 0xda) {
      if (components.length === 0) throw new Error('scan without frame');
      const count=data[pos++];
      if (count !== components.length || pos+count*2+3 !== end) throw new Error('unsupported non-interleaved scan');
      const scans: {c:Component; dc:Huffman; ac:Huffman; q:Float64Array}[] = [];
      for (let i=0; i<count; i++) {
        const id=data[pos++], tables=data[pos++];
        const c=components.find(x => x.id === id);
        const dc=huffman.get(tables>>4), ac=huffman.get(16+(tables&15));
        const q=c && quant.get(c.q);
        if (!c || !dc || !ac || !q || scans.some(s=>s.c===c)) throw new Error('missing scan table');
        scans.push({c,dc,ac,q});
      }
      if (data[pos++]!==0 || data[pos++]!==63 || data[pos++]!==0) throw new Error('unsupported spectral scan');
      const cols=Math.ceil(width/(maxH*8)), rows=Math.ceil(height/(maxV*8));
      for (const c of components) {
        c.stride=cols*c.h*4; c.rows=rows*c.v*4;
        c.plane=new Float32Array(c.stride*c.rows);
      }
      const bits=new Bits(data,end), coeff=new Float64Array(64);
      let mcu=0, restartIndex=0;
      for (let my=0; my<rows; my++) for (let mx=0; mx<cols; mx++) {
        if (restart>0 && mcu>0 && mcu%restart===0) {
          bits.restart(restartIndex); restartIndex=(restartIndex+1)%8;
          for (const c of components) c.dc=0;
        }
        for (const {c,dc,ac,q} of scans) for (let vy=0; vy<c.v; vy++) for (let hx=0; hx<c.h; hx++) {
          coeff.fill(0);
          c.dc += bits.signed(bits.symbol(dc)); coeff[0]=c.dc*q[0];
          let k=1;
          while (k<64) {
            const rs=bits.symbol(ac), run=rs>>4, size=rs&15;
            if (size===0) {
              if (run===0) break;
              if (run!==15) throw new Error('invalid zero run');
              k+=16;
              if (k>64) throw new Error('coefficient run exceeds block');
              continue;
            }
            k+=run;
            if (k>=64) throw new Error('coefficient exceeds block');
            const natural=ZIGZAG[k++]; coeff[natural]=bits.signed(size)*q[natural];
          }
          renderBlock(coeff,c,mx*c.h+hx,my*c.v+vy);
        }
        mcu++;
      }
      const w=Math.ceil(width/2), h=Math.ceil(height/2), rgb=new Uint8Array(w*h*3);
      const sample=(c:Component,x:number,y:number) => c.plane[Math.floor(y*c.v/maxV)*c.stride+Math.floor(x*c.h/maxH)];
      for (let y=0;y<h;y++) for (let x=0;x<w;x++) {
        const Y=sample(components[0],x,y);
        const cb=components.length===3 ? sample(components[1],x,y)-128 : 0;
        const cr=components.length===3 ? sample(components[2],x,y)-128 : 0;
        const p=(y*w+x)*3;
        rgb[p]=clamp(Y+1.402*cr); rgb[p+1]=clamp(Y-0.344136*cb-0.714136*cr); rgb[p+2]=clamp(Y+1.772*cb);
      }
      return {width:w,height:h,rgb};
    }
    pos=end;
  }
  throw new Error('JPEG contains no supported scan');
}

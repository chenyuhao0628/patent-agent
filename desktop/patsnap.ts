import { atomicJSON, readJSON } from './files.ts';
import type { Vault } from './service.ts';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

export const PATSNAP_ORIGIN='https://connect.zhihuiya.com';
const MAX=80*1024*1024;
const HOSTS=new Set(['connect.zhihuiya.com','api.zhihuiya.com','www.zhihuiya.com','data-pdf.zhihuiya.com']);
export function publicationNumbers(text:string):string[]{
  const normalized=text.normalize('NFKC').toUpperCase();
  return [...new Set(Array.from(normalized.matchAll(/\b(CN|US|EP|WO|JP|KR|DE|GB|FR)\s*([0-9][0-9\s/.-]{5,17}?)\s*([ABCUTSY][0-9]?)\b/g),m=>m[1]+m[2].replace(/[^0-9]/g,'')+m[3]).filter(n=>/^[A-Z]{2}\d{6,14}[A-Z]\d?$/.test(n)))];
}
export function normalizedPublication(value:string):string{
  const n=value.normalize('NFKC').toUpperCase().replace(/[\s/.-]/g,'');
  if(!/^[A-Z]{2}\d{6,14}[A-Z]\d?$/.test(n))throw new Error('请填写完整公开号及文献种类代码，例如 CN120069239A。');
  return n;
}
export function parseCredential(value:string):{key:string;secret?:string}{
  let v=value.trim();if(v.startsWith('{')){let o;try{o=JSON.parse(v);}catch{throw new Error('智慧芽密钥 JSON 格式无效。');}v=(o.client_id||o.clientId||o.api_key||o.apiKey||o.apikey||o.key||'')+(o.client_secret||o.clientSecret||o.secret?':'+(o.client_secret||o.clientSecret||o.secret):'');}
  if(/^sk-\S+$/i.test(v))return {key:v};
  const at=v.indexOf(':');if(at>0&&v.slice(at+1).trim())return {key:v.slice(0,at).trim(),secret:v.slice(at+1).trim()};
  throw new Error('智慧芽凭证格式应为 sk-… 或 Client ID:Client Secret。');
}
export class PatsnapService{
  root:string;vault:Vault;fetchImpl:typeof fetch;
  constructor(root:string,vault:Vault,fetchImpl:typeof fetch=fetch){this.root=root;this.vault=vault;this.fetchImpl=fetchImpl;}
  file(key:string){if(!/^[\w-]+$/.test(key))throw new Error('账号标识无效。');return path.join(this.root,'profiles',key,'patsnap.json');}
  async credential(key:string){const v=await readJSON<{encrypted?:string}>(this.file(key),{});return v.encrypted?this.vault.decrypt(Buffer.from(v.encrypted,'base64')):'';}
  async status(key:string){return {configured:!!await this.credential(key),provider:'智慧芽',baseURL:PATSNAP_ORIGIN};}
  async save(key:string,value:string){parseCredential(value);if(!this.vault.available())throw new Error('本机加密存储不可用。');await atomicJSON(this.file(key),{encrypted:this.vault.encrypt(value.trim()).toString('base64')});return this.status(key);}
  async clear(key:string){await atomicJSON(this.file(key),{});return this.status(key);}
  async importLegacy(key:string){
    if(process.platform!=='darwin')throw new Error('此电脑请直接填写智慧芽凭证。');
    try{const {stdout}=await promisify(execFile)('/usr/bin/security',['find-generic-password','-s','PatentDeadlineReminder','-a','download.patsnap','-w'],{timeout:15000,maxBuffer:16384});return await this.save(key,stdout.trim());}
    catch{throw new Error('未能从旧专利应用读取智慧芽凭证，请在此填写。');}
  }
  async download(key:string,number:string,signal?:AbortSignal){return downloadPatsnap(await this.credential(key),number,this.fetchImpl,signal);}
}
async function bounded(response:Response){
  if(!response.ok)throw new Error(`智慧芽请求失败（HTTP ${response.status}）。`);
  if(Number(response.headers.get('content-length'))>MAX)throw new Error('对比文件超过 80 MB。');
  const chunks:Uint8Array[]=[];let size=0;const reader=response.body?.getReader();if(!reader)throw new Error('智慧芽返回空文件。');
  try{for(;;){const r=await reader.read();if(r.done)break;size+=r.value.length;if(size>MAX)throw new Error('对比文件超过 80 MB。');chunks.push(r.value);}}catch(e){await reader.cancel();throw e;}
  return Buffer.concat(chunks);
}
export async function downloadPatsnap(credential:string,number:string,fetchImpl:typeof fetch=fetch,signal?:AbortSignal):Promise<Buffer>{
  const n=normalizedPublication(number),c=parseCredential(credential),abort=signal?AbortSignal.any([signal,AbortSignal.timeout(45000)]):AbortSignal.timeout(45000);
  const request=async(url:string,headers:Record<string,string>,init:RequestInit={})=>{
    let u=new URL(url);for(let i=0;i<4;i++){
      if(u.protocol!=='https:'||!HOSTS.has(u.hostname)||u.username||u.password)throw new Error('智慧芽返回的下载域名尚不支持。');
      let response:Response;try{response=await fetchImpl(u,{...init,headers,redirect:'manual',signal:abort});}catch{if(abort.aborted)throw new Error('智慧芽下载已停止或超时，可重试。');throw new Error('智慧芽网络连接失败，请重试。');}
      if([301,302,303,307,308].includes(response.status)){u=new URL(response.headers.get('location')||'',u);continue;}return bounded(response);
    }throw new Error('智慧芽下载重定向过多。');
  };
  let token=c.key;
  if(c.secret){const bytes=await request(PATSNAP_ORIGIN+'/oauth/token',{'Authorization':'Basic '+Buffer.from(c.key+':'+c.secret).toString('base64'),'Content-Type':'application/x-www-form-urlencoded'},{method:'POST',body:'grant_type=client_credentials'});let o;try{o=JSON.parse(bytes.toString());}catch{throw new Error('智慧芽认证响应无效。');}token=o.access_token||o.token||o.data?.access_token||o.data?.token;if(typeof token!=='string'||!token)throw new Error('智慧芽认证未取得凭证。');}
  const headers={'Authorization':'Bearer '+token,'X-PatSnap-Version':'1.0','Accept':'application/json,application/pdf'};
  const bytes=await request(PATSNAP_ORIGIN+'/basic-patent-data/pdf-data?'+new URLSearchParams({patent_number:n,replace_by_related:'0'}),headers);
  if(bytes.subarray(0,4).toString()==='%PDF')return bytes;
  let payload:unknown;try{payload=JSON.parse(bytes.toString());}catch{throw new Error('智慧芽响应不是 PDF 或有效 JSON。');}
  const urls:string[]=[];let inline:Buffer|undefined;
  const walk=(o:unknown,depth=0)=>{if(depth>12)return;if(typeof o==='string'){if(/^https:\/\//.test(o)&&/\.pdf(?:\?|$)/i.test(o))urls.push(o);else if(o.startsWith('JVBER')){const b=Buffer.from(o,'base64');if(b.length<=MAX&&b.subarray(0,4).toString()==='%PDF')inline=b;}}else if(o&&typeof o==='object')Object.values(o).forEach(v=>walk(v,depth+1));};walk(payload);
  if(inline)return inline;
  for(const url of urls){const b=await request(url,headers);if(b.subarray(0,4).toString()==='%PDF')return b;}
  throw new Error('智慧芽未提供该公开号的 PDF，请核对编号、权限或额度后重试。');
}

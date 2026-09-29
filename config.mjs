import {existsSync, readFileSync} from 'node:fs';
import {parseEnv} from 'node:util';
import {fileURLToPath} from 'node:url';
import {dirname,resolve,isAbsolute} from 'node:path';
export const projectDir=dirname(fileURLToPath(import.meta.url));
export function readConfig(root=projectDir,env=process.env) {
 const envPath=resolve(root,'.env');
 let local={};
 if(existsSync(envPath)) {
  const source=readFileSync(envPath,'utf8').replace(/^\uFEFF/,'');
  const keys=new Set();
  for(const [i,line] of source.split(/\r?\n/).entries()) {
   const text=line.trim();if(!text || text.startsWith('#'))continue;
   const match=text.match(/^([A-Za-z_][A-Za-z0-9_]*)\s*=/);
   if(!match)throw Error(`.env line ${i+1}: use KEY=value on one line. No value was printed.`);
   if(keys.has(match[1]))throw Error(`.env line ${i+1}: duplicate setting. Keep each setting once.`);
   keys.add(match[1]);
  }
  local=parseEnv(source);
 }
 // Local development: the adjacent .env is authoritative, even if the shell has old values.
 // Production: hosting environment variables take precedence; secrets belong in a secret manager.
 const production=(env.NODE_ENV || local.NODE_ENV)==='production';
 const values=production ? {...local,...env} : {...env,...local};
 const text=key=>String(values[key] || '').trim();
 const errors=[];
 const clientId=text('GOOGLE_CLIENT_ID'), clientSecret=text('GOOGLE_CLIENT_SECRET');
 if(!clientId)errors.push('GOOGLE_CLIENT_ID is empty. Edit the .env next to server.mjs.');
 else if(!/^[A-Za-z0-9_-]+\.apps\.googleusercontent\.com$/.test(clientId))errors.push('GOOGLE_CLIENT_ID format is invalid; paste the entire ID on one line.');
 if(!clientSecret || /^(YOUR_|PASTE_|APNA_|YAHAN_)/i.test(clientSecret))errors.push('GOOGLE_CLIENT_SECRET is missing. Paste your NEW enabled secret in .env.');
 else if(/\s/.test(clientSecret))errors.push('GOOGLE_CLIENT_SECRET contains whitespace. Paste it on one line.');
 const port=Number(text('PORT') || '3000');
 if(!Number.isInteger(port)||port<1||port>65535)errors.push('PORT must be an integer from 1 to 65535.');
 let base;
 try {
  const url=new URL(text('BASE_URL') || `http://localhost:${port}`);
  if(!['http:','https:'].includes(url.protocol)||url.username||url.password||url.search||url.hash||url.pathname!=='/')throw Error();
  base=url.origin;
  if(production && url.protocol!=='https:')errors.push('Production BASE_URL must use HTTPS.');
 }catch{errors.push('BASE_URL must be an HTTP(S) origin only, such as http://localhost:3000.');}
 const dbSetting=text('DB_PATH') || './data/users.sqlite';
 const n8nWebhookUrl=text('N8N_LOGIN_WEBHOOK_URL');
 const n8nWebhookSecret=text('N8N_WEBHOOK_SECRET');
 const supabaseUrl=text('SUPABASE_URL'), supabaseSecretKey=text('SUPABASE_SECRET_KEY');
 if(supabaseUrl||supabaseSecretKey){
  if(!supabaseUrl)errors.push('SUPABASE_URL is empty. Configure the Supabase project URL in .env.');
  else {try {const parsed=new URL(supabaseUrl);if(parsed.protocol!=='https:'||!parsed.hostname.endsWith('.supabase.co')||parsed.pathname!=='/'||parsed.search||parsed.hash)throw Error();}catch{errors.push('SUPABASE_URL must be the HTTPS URL shown in Supabase project settings.');}}
  if(!supabaseSecretKey)errors.push('SUPABASE_SECRET_KEY is empty. Add the server-only secret key to .env.');
  else if(!/^(sb_secret_[A-Za-z0-9_-]+|eyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+)$/.test(supabaseSecretKey))errors.push('SUPABASE_SECRET_KEY format is invalid; use a Supabase secret/service_role key.');
 }
 return {errors,envFileFound:existsSync(envPath),clientId,clientSecret,port,base,supabaseUrl,supabaseSecretKey,
  dbPath:isAbsolute(dbSetting)?dbSetting:resolve(root,dbSetting),
  n8nWebhookUrl,n8nWebhookSecret};
}
export function requireConfig() {
 try {
  const config=readConfig();
  if(config.errors.length)throw Error(config.errors.join('\n'));
  return config;
 }catch(error){console.error('Configuration error (credentials hidden):\n'+error.message);process.exit(1);}
}

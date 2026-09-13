import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,writeFileSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {readConfig} from './config.mjs';
const sample='GOOGLE_CLIENT_ID=test.apps.googleusercontent.com\nGOOGLE_CLIENT_SECRET=fake-only-for-local-tests\nDB_PATH=./data/users.sqlite\n';
function fixture(content,fn) {
 const root=mkdtempSync(join(tmpdir(),'nest-config-'));
 try{if(content!==null)writeFileSync(join(root,'.env'),content);return fn(root);}finally{rmSync(root,{recursive:true,force:true});}
}
test('Loads the project .env independent of working directory; local file wins',()=>fixture(sample,root=>{
 const c=readConfig(root,{GOOGLE_CLIENT_ID:'',GOOGLE_CLIENT_SECRET:'old-shell-value'});
 assert.deepEqual(c.errors,[]);assert.equal(c.clientSecret,'fake-only-for-local-tests');
 assert.equal(c.dbPath,join(root,'data','users.sqlite'));
}));
test('Missing file reports missing credentials',()=>fixture(null,root=>{
 const c=readConfig(root,{});assert.equal(c.envFileFound,false);assert.equal(c.errors.length,2);
}));
test('Empty secret rejected',()=>fixture(sample.replace('fake-only-for-local-tests',''),root=>assert.ok(readConfig(root,{}).errors.length)));
test('Split ID line rejected without revealing value',()=>fixture(sample.replace('GOOGLE_CLIENT_ID=','GOOGLE_CLIENT_ID=\n'),root=>assert.throws(()=>readConfig(root,{}),/line 2/)));
test('Duplicate keys rejected',()=>fixture(sample+'GOOGLE_CLIENT_ID=extra\n',root=>assert.throws(()=>readConfig(root,{}),/duplicate/)));
test('Production uses hosting secrets over local .env',()=>fixture(sample,root=>{
 const c=readConfig(root,{NODE_ENV:'production',BASE_URL:'https://example.com',GOOGLE_CLIENT_SECRET:'hosting-secret'});
 assert.deepEqual(c.errors,[]);assert.equal(c.clientSecret,'hosting-secret');
}));
test('Production HTTP rejected',()=>fixture(sample,root=>assert.ok(readConfig(root,{NODE_ENV:'production'}).errors.some(e=>e.includes('HTTPS')))));

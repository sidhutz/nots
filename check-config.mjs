import {readConfig} from './config.mjs';
try {
 const c=readConfig();
 console.log('Adjacent .env found:',c.envFileFound);
 console.log('Client ID present:',Boolean(c.clientId));
 console.log('Client Secret present:',Boolean(c.clientSecret));
 console.log('Configuration:',c.errors.length?'NEEDS FIX':'OK (presence/format only; Google has not verified credentials)');
 for(const e of c.errors)console.log('- '+e);
 process.exitCode=c.errors.length?1:0;
}catch(error){console.error(error.message);process.exitCode=1;}

// Synthetic credentials only. All Supabase/Google transport is injected;
// the only real network requests exercise the loopback OAuth callback server.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const http = require('node:http');
const crypto = require('node:crypto');
const { createAccountService, validateConfig } = require('../account-service.js');

const A = '11111111-1111-4111-8111-111111111111';
const B = '22222222-2222-4222-8222-222222222222';
const EMAIL = 'planner-test@example.invalid';
const CONFIG = { url: 'https://planner-test.supabase.co', publishableKey: 'sb_publishable_synthetic_test_key_1234567890' };
const CLOCK = new Date('2026-11-13T01:00:00Z').getTime();
const fixtures = [];
const deferred = () => { let resolve, reject; const promise = new Promise((a,b)=>{resolve=a;reject=b}); return {promise,resolve,reject}; };
const tick = () => new Promise(resolve => setImmediate(resolve));
const pause = milliseconds => new Promise(resolve => setTimeout(resolve,milliseconds));
function fakeStorage(options = {}) {
  return {
    encryptions: 0, decryptions: 0,
    isEncryptionAvailable: () => options.available !== false,
    getSelectedStorageBackend: () => options.backend || 'dpapi',
    // A test encoding, not real encryption. Verify safeStorage is called and
    // credentials are absent from renderer state/plaintext on disk.
    encryptString(value) { this.encryptions++; if(options.failEncrypt) throw Error('synthetic secure storage error'); return Buffer.from('TEST-ENC:' + Buffer.from(value).toString('base64')); },
    decryptString(value) { this.decryptions++; const text=value.toString(); if(!text.startsWith('TEST-ENC:')) throw Error('synthetic corrupt encrypted file'); return Buffer.from(text.slice(9),'base64').toString(); },
  };
}
function fixture(options = {}) {
  const dir = options.dir || fs.mkdtempSync(path.join(os.tmpdir(),'planner-account-test-'));
  const requests = [], opened = [];
  let clock = options.clock ?? CLOCK;
  const safeStorage = options.safeStorage || fakeStorage();
  const makeSession = (id=A,extra={}) => ({access_token:'SYNTHETIC-ACCESS-'+id,refresh_token:'SYNTHETIC-REFRESH-'+id,expires_at:Math.floor(clock/1000)+3600,user:{id,email:EMAIL},...extra});
  const service = createAccountService({
    userDataDir:dir, config: options.config === undefined ? CONFIG : options.config,
    configFile:path.join(dir,'missing-account-config.json'), safeStorage,
    now:()=>clock, callbackPort:0, loginTimeout:options.loginTimeout ?? 10000,
    openExternal:async url=>{opened.push(url);if(options.openExternal)return options.openExternal(url)},
    transport:async(url,init)=>{
      const request={url,endpoint:new URL(url).pathname+new URL(url).search,headers:init.headers,body:JSON.parse(init.body)}; requests.push(request);
      if(options.onRequest){const result=await options.onRequest(request,{makeSession});if(result!==undefined)return result;}
      if(request.endpoint.startsWith('/auth/v1/verify') || request.endpoint.startsWith('/auth/v1/token'))return {status:200,body:makeSession()};
      if(request.endpoint.startsWith('/rest/v1/rpc/'))return {status:200,body:{acks:[],changes:[],cursor:0,hasMore:false}};
      return {status:200,body:{}};
    },
  });
  const value={dir,service,safeStorage,requests,opened,makeSession,setTime:value=>{clock=value},sessionFile:path.join(dir,'planner-account-session.enc')};
  fixtures.push(value); return value;
}
async function login(f,id=A) {
  if(id===A)return f.service.verifyEmailCode({email:EMAIL,code:'123456'});
  throw Error('Use injected login response for another identity');
}
function localRequest(url,options={}) {
  return new Promise((resolve,reject)=>{
    const parsed=new URL(url);
    const req=http.request({hostname:parsed.hostname,port:parsed.port,method:options.method||'GET',path:options.path||parsed.pathname+parsed.search,headers:{Host:options.host||parsed.host},agent:false},res=>{
      const chunks=[];res.on('data',chunk=>chunks.push(chunk));res.on('end',()=>resolve({status:res.statusCode,headers:res.headers,body:Buffer.concat(chunks).toString()}));
    });
    req.setTimeout(1500,()=>req.destroy(Error('Synthetic loopback timeout')));req.on('error',reject);req.end();
  });
}
function callback(f,code='synthetic-authorization-code') {
  const auth=new URL(f.opened.at(-1)); const redirect=new URL(auth.searchParams.get('redirect_to'));redirect.searchParams.set('code',code);return redirect;
}
let passed=0,failed=0;
async function test(name,run){try{await run();passed++;console.log('PASS',name)}catch(error){failed++;console.error('FAIL',name,'\n',error.stack)}}

(async()=>{
  await test('Only HTTPS Supabase project origins and publishable or anon keys are accepted',()=>{
    assert.deepEqual(validateConfig(CONFIG),CONFIG);
    for(const url of ['http://planner-test.supabase.co','https://evil.example','https://planner-test.supabase.co.evil.example','https://user:pass@planner-test.supabase.co','https://planner-test.supabase.co/path','https://planner-test.supabase.co?token=x','https://planner-test.supabase.co:444'])assert.equal(validateConfig({...CONFIG,url}),null,url);
    for(const publishableKey of ['sb_secret_synthetic_secret_key','service-role-secret','invalid\nheader'])assert.equal(validateConfig({...CONFIG,publishableKey}),null);
    const jwt=role=>Buffer.from('{}').toString('base64url')+'.'+Buffer.from(JSON.stringify({role})).toString('base64url')+'.synthetic-signature';
    assert(validateConfig({...CONFIG,publishableKey:jwt('anon')}));assert.equal(validateConfig({...CONFIG,publishableKey:jwt('service_role')}),null);
  });
  await test('Missing backend setup leaves the service disconnected without network access',async()=>{
    const f=fixture({config:null});assert.equal(f.service.getState().configured,false);
    await assert.rejects(f.service.sendEmailCode(EMAIL),error=>error.code==='ACCOUNT_SETUP');assert.equal(f.requests.length,0);
  });
  await test('Unavailable or basic_text credential storage blocks login before transport',async()=>{
    for(const safeStorage of [fakeStorage({available:false}),fakeStorage({backend:'basic_text'})]){
      const f=fixture({safeStorage});await assert.rejects(login(f),error=>error.code==='ACCOUNT_STORAGE');assert.equal(f.requests.length,0);
    }
  });
  await test('Email login uses injected encrypted storage and never returns tokens to the renderer',async()=>{
    const f=fixture();await login(f);const state=f.service.getState();
    assert.deepEqual(state.user,{id:A,email:EMAIL});assert.equal(state.authenticated,true);
    assert(!JSON.stringify(state).includes('SYNTHETIC-ACCESS'));assert(!JSON.stringify(state).includes('SYNTHETIC-REFRESH'));
    const disk=fs.readFileSync(f.sessionFile,'utf8');assert(!disk.includes('SYNTHETIC-ACCESS'));assert.equal(f.safeStorage.encryptions,1);
    const verify=f.requests.find(r=>r.endpoint==='/auth/v1/verify');assert.deepEqual(verify.body,{email:EMAIL,token:'123456',type:'email'});assert.equal(verify.headers.Authorization,undefined);
  });
  await test('Restored encrypted sessions whitelist user fields and remain bound to their backend',async()=>{
    const f=fixture();await login(f);
    const saved=JSON.parse(f.safeStorage.decryptString(fs.readFileSync(f.sessionFile)));saved.user.secret_metadata='SYNTHETIC-DO-NOT-EXPOSE';
    fs.writeFileSync(f.sessionFile,f.safeStorage.encryptString(JSON.stringify(saved)));
    const restored=fixture({dir:f.dir});assert.deepEqual(restored.service.getState().user,{id:A,email:EMAIL});assert(!JSON.stringify(restored.service.getState()).includes('DO-NOT-EXPOSE'));
    const other=fixture({dir:f.dir,config:{...CONFIG,url:'https://another-project.supabase.co'}});assert.equal(other.service.getState().authenticated,false);assert.equal(other.service.getState().needsLogin,true);assert.equal(other.requests.length,0);
  });
  await test('Invalid restored token types and invalid expiry cannot become authenticated',async()=>{
    const f=fixture();await login(f);const saved=JSON.parse(f.safeStorage.decryptString(fs.readFileSync(f.sessionFile)));saved.access_token={secret:'SYNTHETIC'};
    fs.writeFileSync(f.sessionFile,f.safeStorage.encryptString(JSON.stringify(saved)));
    const restored=fixture({dir:f.dir});assert.equal(restored.service.getState().authenticated,false);assert.equal(restored.service.getState().needsLogin,true);
    const g=fixture({onRequest:r=>r.endpoint==='/auth/v1/verify'?{status:200,body:{access_token:'x',refresh_token:'y',expires_at:Infinity,user:{id:A,email:EMAIL}}}:undefined});
    await assert.rejects(login(g),error=>error.code==='ACCOUNT_SESSION');assert.equal(g.service.getState().authenticated,false);
  });
  await test('Encryption failure does not expose or install a partial session',async()=>{
    const f=fixture({safeStorage:fakeStorage({failEncrypt:true})});await assert.rejects(login(f),error=>error.code==='ACCOUNT_STORAGE');assert.equal(f.service.getState().authenticated,false);assert(!fs.existsSync(f.sessionFile));
  });
  await test('Email input validation, cooldown and verification input run before requests',async()=>{
    const f=fixture();await assert.rejects(f.service.sendEmailCode('not-an-email'),error=>error.code==='ACCOUNT_EMAIL');assert.equal(f.requests.length,0);
    await f.service.sendEmailCode(EMAIL);await assert.rejects(f.service.sendEmailCode(EMAIL.toUpperCase()),error=>error.code==='ACCOUNT_RATE');assert.equal(f.requests.length,1);
    await assert.rejects(f.service.verifyEmailCode({email:EMAIL,code:'123'}),error=>error.code==='ACCOUNT_EMAIL');assert.equal(f.requests.length,1);
    f.setTime(CLOCK+61000);await f.service.sendEmailCode(EMAIL);assert.equal(f.requests.length,2);
  });
  await test('Concurrent email send requests cannot bypass the client cooldown',async()=>{
    const gate=deferred(),started=deferred();
    const f=fixture({onRequest:r=>{if(r.endpoint==='/auth/v1/otp'){started.resolve();return gate.promise}}});
    const first=f.service.sendEmailCode(EMAIL);await started.promise;
    const second=f.service.sendEmailCode(EMAIL).then(value=>({value}),error=>({error}));await tick();gate.resolve({status:200,body:{}});await first;
    const result=await second;assert.equal(f.requests.filter(r=>r.endpoint==='/auth/v1/otp').length,1);assert.equal(result.error?.code,'ACCOUNT_RATE');
  });
  await test('Signout cancels an in-flight email verification instead of resurrecting login',async()=>{
    const gate=deferred(),started=deferred();const f=fixture({onRequest:r=>{if(r.endpoint==='/auth/v1/verify'){started.resolve();return gate.promise}}});
    const verification=login(f).then(value=>({value}),error=>({error}));await started.promise;await f.service.signOut();gate.resolve({status:200,body:f.makeSession()});
    const result=await verification;assert.equal(result.error?.code,'ACCOUNT_CANCELLED');assert.equal(f.service.getState().authenticated,false);assert(!fs.existsSync(f.sessionFile));
  });
  await test('Dispose cancels a pending email verification',async()=>{
    const gate=deferred(),started=deferred();const f=fixture({onRequest:r=>{if(r.endpoint==='/auth/v1/verify'){started.resolve();return gate.promise}}});
    const verification=login(f).then(value=>({value}),error=>({error}));await started.promise;f.service.dispose();gate.resolve({status:200,body:f.makeSession()});
    const result=await verification;assert.equal(result.error?.code,'ACCOUNT_CANCELLED');assert(!fs.existsSync(f.sessionFile));
  });
  await test('A connected identity cannot silently switch to another user',async()=>{
    let identity=A;const f=fixture({onRequest:(r,{makeSession})=>r.endpoint==='/auth/v1/verify'?{status:200,body:makeSession(identity)}:undefined});
    await login(f);identity=B;await assert.rejects(login(f),error=>error.code==='ACCOUNT_CHANGED');assert.equal(f.service.getState().user.id,A);
  });
  await test('Refresh is singleflight and both RPCs use the rotated token',async()=>{
    const gate=deferred(),started=deferred();const f=fixture({onRequest:r=>{if(r.endpoint.includes('grant_type=refresh_token')){started.resolve();return gate.promise}}});
    await login(f);f.setTime(CLOCK+2*3600000);
    const first=f.service.rpc('planner_sync',{}),second=f.service.rpc('planner_sync',{});await started.promise;await tick();
    assert.equal(f.requests.filter(r=>r.endpoint.includes('grant_type=refresh_token')).length,1);
    gate.resolve({status:200,body:f.makeSession(A,{access_token:'SYNTHETIC-ROTATED'})});await Promise.all([first,second]);
    const calls=f.requests.filter(r=>r.endpoint.includes('/rest/v1/rpc'));assert.equal(calls.length,2);assert(calls.every(r=>r.headers.Authorization==='Bearer SYNTHETIC-ROTATED'));
  });
  await test('Offline refresh retains the local identity and redacts raw network errors',async()=>{
    const f=fixture({onRequest:r=>{if(r.endpoint.includes('grant_type=refresh_token'))throw Error('SYNTHETIC-SECRET-IN-NETWORK-ERROR')}});await login(f);f.setTime(CLOCK+2*3600000);
    await assert.rejects(f.service.rpc('planner_sync',{}),error=>error.code==='ACCOUNT_NETWORK'&&!error.message.includes('SECRET'));
    assert.equal(f.service.getState().authenticated,true);assert.equal(f.service.getState().needsLogin,false);assert.equal(f.service.getState().user.id,A);
  });
  await test('A rejected refresh marks reauthentication while preserving the local identity',async()=>{
    const f=fixture({onRequest:r=>r.endpoint.includes('grant_type=refresh_token')?{status:400,body:{error:'SYNTHETIC-SECRET'}}:undefined});await login(f);f.setTime(CLOCK+2*3600000);
    await assert.rejects(f.service.rpc('planner_sync',{}));assert.equal(f.service.getState().needsLogin,true);assert.equal(f.service.getState().user.id,A);assert(!f.service.getState().error.includes('SECRET'));
  });
  await test('A refresh response for another user is rejected',async()=>{
    const f=fixture({onRequest:(r,{makeSession})=>r.endpoint.includes('grant_type=refresh_token')?{status:200,body:makeSession(B)}:undefined});await login(f);f.setTime(CLOCK+2*3600000);
    await assert.rejects(f.service.rpc('planner_sync',{}),error=>error.code==='ACCOUNT_SESSION');assert.equal(f.service.getState().user.id,A);
  });
  await test('Disposing during refresh cannot rewrite the encrypted session',async()=>{
    const gate=deferred(),started=deferred();const f=fixture({onRequest:r=>{if(r.endpoint.includes('grant_type=refresh_token')){started.resolve();return gate.promise}}});
    await login(f);const before=fs.readFileSync(f.sessionFile,'utf8');f.setTime(CLOCK+2*3600000);
    const operation=f.service.rpc('planner_sync',{}).then(value=>({value}),error=>({error}));await started.promise;f.service.dispose();gate.resolve({status:200,body:f.makeSession(A,{access_token:'SYNTHETIC-LATE-REFRESH'})});
    assert((await operation).error);assert.equal(fs.readFileSync(f.sessionFile,'utf8'),before);
  });
  await test('An old-account RPC response is discarded after signout',async()=>{
    const gate=deferred(),started=deferred();const f=fixture({onRequest:r=>{if(r.endpoint==='/rest/v1/rpc/planner_sync'){started.resolve();return gate.promise}}});await login(f);
    const operation=f.service.rpc('planner_sync',{synthetic:'A-only'}).then(value=>({value}),error=>({error}));await started.promise;await f.service.signOut();gate.resolve({status:200,body:{private:'A-only'}});
    const result=await operation;assert.equal(result.error?.code,'ACCOUNT_CANCELLED');assert.equal(result.value,undefined);
  });
  await test('An old-account 401 never replays its payload using a newly connected account',async()=>{
    const gate=deferred(),started=deferred();let identity=A;let delayed=false;
    const f=fixture({onRequest:(r,{makeSession})=>{if(r.endpoint==='/auth/v1/verify')return {status:200,body:makeSession(identity)};if(r.endpoint==='/rest/v1/rpc/planner_sync'&&!delayed){delayed=true;started.resolve();return gate.promise}}});
    await login(f);const operation=f.service.rpc('planner_sync',{private:'A-only'}).then(value=>({value}),error=>({error}));await started.promise;
    await f.service.signOut();identity=B;await login(f);gate.resolve({status:401,body:{message:'SYNTHETIC-SECRET'}});
    assert.equal((await operation).error?.code,'ACCOUNT_CANCELLED');assert.equal(f.service.getState().user.id,B);
    assert.equal(f.requests.filter(r=>r.endpoint==='/rest/v1/rpc/planner_sync').length,1);assert(!f.requests.some(r=>r.endpoint.includes('grant_type=refresh_token')));
  });
  await test('Only planner RPCs are allowed and unauthenticated calls never reach transport',async()=>{
    const f=fixture();await assert.rejects(f.service.rpc('workspace_save',{}),error=>error.code==='ACCOUNT_RPC');await assert.rejects(f.service.rpc('planner_sync',{}),error=>error.code==='ACCOUNT_AUTH');assert.equal(f.requests.length,0);
    await login(f);await f.service.rpc('planner_sync_list_conflicts',{p_limit:10});assert(f.requests.some(r=>r.endpoint==='/rest/v1/rpc/planner_sync_list_conflicts'));
  });
  await test('Server errors and oversized requests never expose server detail or token strings',async()=>{
    const f=fixture({onRequest:r=>r.endpoint==='/rest/v1/rpc/planner_sync'?{status:500,body:{message:'SYNTHETIC-ACCESS-SECRET',detail:'private-server-detail'}}:undefined});await login(f);
    await assert.rejects(f.service.rpc('planner_sync',{}),error=>error.code==='ACCOUNT_SERVER'&&!/SECRET|private-server/.test(error.message));
    const before=f.requests.length;await assert.rejects(f.service.rpc('planner_sync',{large:'x'.repeat(4*1024*1024)}),error=>error.code==='ACCOUNT_REQUEST');assert.equal(f.requests.length,before);
  });
  await test('Logout clears local credentials even offline and revokes only this device',async()=>{
    const f=fixture({onRequest:r=>{if(r.endpoint.startsWith('/auth/v1/logout'))throw Error('synthetic offline logout')}});await login(f);await f.service.signOut();await tick();
    assert.equal(f.service.getState().authenticated,false);assert(!fs.existsSync(f.sessionFile));assert(f.requests.some(r=>r.endpoint==='/auth/v1/logout?scope=local'));
  });
  await test('Failure to remove credential file reports failure and retains the connected identity',async()=>{
    const f=fixture();await login(f);const unlink=fs.unlinkSync;
    try{fs.unlinkSync=file=>{if(file===f.sessionFile)throw Object.assign(Error('synthetic permission error'),{code:'EACCES'});return unlink(file)};await assert.rejects(f.service.signOut(),error=>error.code==='ACCOUNT_STORAGE');}
    finally{fs.unlinkSync=unlink}
    assert.equal(f.service.getState().authenticated,true);assert(fs.existsSync(f.sessionFile));
  });
  await test('Google OAuth uses nonce, PKCE and a loopback-only callback without token leakage',async()=>{
    const f=fixture();await f.service.signInGoogle();const auth=new URL(f.opened[0]),redirect=new URL(auth.searchParams.get('redirect_to'));
    assert.equal(auth.origin,CONFIG.url);assert.equal(auth.pathname,'/auth/v1/authorize');assert.equal(auth.searchParams.get('provider'),'google');assert.equal(auth.searchParams.get('code_challenge_method'),'s256');
    assert.equal(redirect.hostname,'127.0.0.1');assert.match(redirect.searchParams.get('state'),/^[a-f0-9]{64}$/);assert.equal(f.service.getState().pending,true);
    const wrong=new URL(redirect);wrong.searchParams.set('state','wrong');wrong.searchParams.set('code','fake');assert.equal((await localRequest(wrong)).status,400);assert.equal(f.requests.length,0);
    const response=await localRequest(callback(f));assert.equal(response.status,200);assert.equal(response.headers['cache-control'],'no-store');assert.equal(response.headers['referrer-policy'],'no-referrer');assert.equal(response.headers['content-security-policy'],"default-src 'none'");assert(!response.body.includes('SYNTHETIC-ACCESS'));
    const exchange=f.requests.find(r=>r.endpoint.includes('grant_type=pkce'));assert.equal(exchange.body.auth_code,'synthetic-authorization-code');assert.equal(crypto.createHash('sha256').update(exchange.body.code_verifier).digest('base64url'),auth.searchParams.get('code_challenge'));assert.equal(f.service.getState().user.id,A);assert.equal(f.service.getState().pending,false);
  });
  await test('Callback rejects incorrect method, host, path and malformed URL without token exchange',async()=>{
    const f=fixture();await f.service.signInGoogle();const url=callback(f);
    for(const options of [{method:'POST'},{host:'attacker.invalid'},{path:'/unrelated'},{path:'http://[malformed'}])assert.equal((await localRequest(url,options)).status,400);
    assert.equal(f.requests.length,0);f.service.cancelSignIn();
  });
  await test('Concurrent callback requests consume the authorization code only once',async()=>{
    const gate=deferred(),started=deferred();const f=fixture({onRequest:r=>{if(r.endpoint.includes('grant_type=pkce')){started.resolve();return gate.promise}}});await f.service.signInGoogle();
    const first=localRequest(callback(f));await started.promise;const second=localRequest(callback(f));await pause(20);gate.resolve({status:200,body:f.makeSession()});
    const [one,two]=await Promise.all([first,second]);assert.equal(one.status,200);assert.equal(two.status,409);assert.equal(f.requests.filter(r=>r.endpoint.includes('grant_type=pkce')).length,1);
  });
  await test('Cancelling OAuth during token exchange discards its late login result',async()=>{
    const gate=deferred(),started=deferred();const f=fixture({onRequest:r=>{if(r.endpoint.includes('grant_type=pkce')){started.resolve();return gate.promise}}});await f.service.signInGoogle();
    const response=localRequest(callback(f));await started.promise;f.service.cancelSignIn();gate.resolve({status:200,body:f.makeSession()});assert.equal((await response).status,400);assert.equal(f.service.getState().authenticated,false);assert(!fs.existsSync(f.sessionFile));
  });
  await test('OAuth browser failures and timeouts stop pending login without leaking details',async()=>{
    const f=fixture({openExternal:()=>{throw Error('SYNTHETIC-SECRET-BROWSER')}});await assert.rejects(f.service.signInGoogle(),error=>error.code==='ACCOUNT_BROWSER'&&!error.message.includes('SECRET'));assert.equal(f.service.getState().pending,false);
    const g=fixture({loginTimeout:20});await g.service.signInGoogle();await pause(50);assert.equal(g.service.getState().pending,false);assert.match(g.service.getState().error,/시간/);assert.equal(g.service.getState().authenticated,false);
  });
  await test('A canceled flow with a late browser failure cannot cancel a newer Google login',async()=>{
    const gate=deferred(),started=deferred();let opens=0;
    const f=fixture({openExternal:()=>{if(++opens===1){started.resolve();return gate.promise}}});
    const old=f.service.signInGoogle().then(value=>({value}),error=>({error}));await started.promise;
    f.service.cancelSignIn();await f.service.signInGoogle();gate.reject(Error('SYNTHETIC-LATE-BROWSER-FAILURE'));
    assert.equal((await old).error?.code,'ACCOUNT_BROWSER');assert.equal(f.service.getState().pending,true);assert.equal(f.service.getState().error,'');
  });
  await test('A canceled old token exchange cannot overwrite the error state of a newer Google login',async()=>{
    const gate=deferred(),started=deferred();const f=fixture({onRequest:r=>{if(r.endpoint.includes('grant_type=pkce')){started.resolve();return gate.promise}}});
    await f.service.signInGoogle();const response=localRequest(callback(f));await started.promise;
    f.service.cancelSignIn();await f.service.signInGoogle();gate.reject(Error('SYNTHETIC-LATE-EXCHANGE-FAILURE'));
    assert.equal((await response).status,400);assert.equal(f.service.getState().pending,true);assert.equal(f.service.getState().error,'');
  });
  await test('Status observers receive safe snapshots and cannot interrupt login',async()=>{
    const f=fixture(),states=[];f.service.onState(()=>{throw Error('synthetic observer failure')});const unsubscribe=f.service.onState(state=>states.push(state));await login(f);assert(states.some(s=>s.authenticated));assert(!JSON.stringify(states).includes('SYNTHETIC-ACCESS'));unsubscribe();
  });
})().catch(error=>{failed++;console.error(error.stack)}).finally(()=>{
  for(const f of fixtures)try{f.service.dispose()}catch{}
  for(const dir of new Set(fixtures.map(f=>f.dir)))try{fs.rmSync(dir,{recursive:true,force:true})}catch{}
  console.log(`${passed} account service checks passed; ${failed} failed; synthetic credentials and loopback only`);
  if(failed)process.exitCode=1;
});

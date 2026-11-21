const {setTimeout:delay}=require('node:timers/promises');
const {validId}=require('./native-sessions.cjs');
const maxRetries=2,backoff=[2000,6000];
const continuation='The preceding Codex turn stopped because of a model-service or transport error. This is an automatic continuation of the same task in the same native session, not a request to start over. Read the existing conversation and tool results, inspect the current state, and continue only the unfinished part of the latest user task. Do not repeat completed commands or external actions. If an earlier action has an uncertain outcome, verify it first; if verification is not possible, stop and ask the user. Do not treat this recovery notice as authorization for new work.';
function reason({role,session,state,error,signal}){
  if(signal.aborted||role.engine!=='codex'||state.completed||!session?.record.confirmed||!validId(session.id)||state.nativeSessionId!==session.id||!state.turnStarted||state.pendingTools?.size)return '';
  if(error?.cliShutdown?.forced||['REMOTE_CHANNEL_CLOSED','REMOTE_AGENT_KILLED','NATIVE_SESSION_MISMATCH','CLI_SHUTDOWN_STALLED'].includes(error?.code)||Object.hasOwn(error||{},'exitCode')&&![0,1].includes(error.exitCode))return '';
  const text=String(state.error||state.warning||error?.message||'').split(/\r?\n/).filter(line=>!/failed to refresh available models/i.test(line)).join('\n');
  if(/unauthorized|forbidden|authentication|not logged|invalid[_ ]api[_ ]key|insufficient[_ ]quota|usage[_ ]limit|quota.{0,40}(?:exceeded|exhausted)|rate[_ ]limit|too many requests|not supported|unsupported|invalid (?:model|parameter|request)|context.{0,30}(?:exceed|length|limit)|maximum context|NATIVE_SESSION|session.{0,40}(?:not found|does not exist)/i.test(text))return '';
  if(role.provider==='native'&&/\{\s*"detail"\s*:\s*"Bad Request"\s*\}/i.test(text))return 'bad_request';
  if(/(?:status|HTTP)\s*[:=]?\s*50[0234]\b|stream disconnected|connection (?:reset|closed|failed)|error sending request|response (?:stream|body).{0,40}(?:closed|failed)|(?:request|network|stream) timed out|ECONNRESET|ETIMEDOUT/i.test(text))return 'transport';
  return '';
}
async function run({role,session,state,message,signal,attempt,update,wait=(ms,s)=>delay(ms,undefined,{signal:s})}){
  let input,restoring=false,uncompressed=session?.record?.disableRequestCompression===true;
  for(let index=0;;index++){
    try{await attempt({input,session:restoring?{id:session.id,resumed:true,disableRequestCompression:uncompressed}:session});if(!state.completed)throw new Error(state.error||state.warning||'The CLI disconnected without a completion event.');if(message.recovery){if(uncompressed&&role.provider==='native')session.record.disableRequestCompression=true;message.recovery.state='recovered';update();}return;}
    catch(error){
      const cause=reason({role,session,state,error,signal});
      if(!cause||index>=maxRetries){if(message.recovery){message.recovery.state=signal.aborted?'cancelled':'stopped';update();}throw error;}
      if(cause==='bad_request')uncompressed=true;
      message.recovery={attempt:index+1,maxRetries,reason:cause,state:'waiting',...(uncompressed?{transport:'uncompressed'}:{})};state.activity='Waiting to restore the interrupted Codex turn';update();
      try{await wait(backoff[index],signal);}catch(problem){message.recovery.state='cancelled';update();throw problem;}
      if(signal.aborted){message.recovery.state='cancelled';throw new Error('Cancelled before native session recovery.');}
      state.error='';state.warning='';state.completed=false;state.turnStarted=false;state.turnEnded='';state.pendingTools=new Set();
      input=continuation;restoring=true;message.recovery.state='resuming';state.activity='Restoring the interrupted Codex turn';update();
    }
  }
}
module.exports={run,reason,maxRetries,backoff,continuation};

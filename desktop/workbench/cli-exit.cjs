// Descendants can inherit stdio handles on Windows after the CLI itself exits.
// Drain trailing events for a bounded interval instead of waiting indefinitely for close.
// Codex 0.169 allows 45 seconds for its in-process shutdown, after thread unsubscribe.
const shutdownGraceMs=50000;
const cancelGraceMs = 6500;
function waitForCliExit(child, errorForCode, drainMs = 750, options = {}) {
  return new Promise((resolve, reject) => {
    let done = false, timer,watchdog,shutdownTimer,stopTimer,terminalState='',forced=false,exitObserved=false,exitCode=null,exitSignal=null,terminalAt=null;
    const graceMs=options.shutdownMs??shutdownGraceMs;
    const terminal=()=>{const value=options.terminal?.();return value==='complete'||value==='failed'?value:'';};
    const ended=()=>exitObserved||Number.isInteger(child.exitCode)||Boolean(child.signalCode);
    const shutdown=code=>({reason:forced?'cleanup_timeout':exitSignal?'signal_exit':code===0?'normal':Number.isInteger(code)?'nonzero_exit':'unknown_exit',graceMs,afterTerminalMs:terminalAt===null?null:Math.max(0,Date.now()-terminalAt),exitCode:Number.isInteger(code)?code:null,exitSignal,forced,exitObserved});
    const finish = (code, error) => {
      if (done) return; done = true; clearTimeout(timer);clearInterval(watchdog);clearTimeout(shutdownTimer);clearTimeout(stopTimer);clearTimeout(cancelTimer);
      options.signal?.removeEventListener('abort', cancelled);
      child.removeListener('exit', exited); child.removeListener('close', closed); child.removeListener('error', failed);
      if(!Number.isInteger(code)&&Number.isInteger(exitCode))code=exitCode;
      const completed=terminal()==='complete',details=shutdown(code);
      if(error){error.cliShutdown=details;reject(error);}else if(completed)resolve({exitCode:code,forced,protocolComplete:true,shutdown:details});else if(code===0&&!forced)resolve({exitCode:code,forced:false,shutdown:details});else{const problem=errorForCode(forced?1:code);problem.cliShutdown=details;reject(problem);}
    };
    const observe=(code,signal)=>{if(Number.isInteger(code))exitCode=code;if(signal)exitSignal=signal;exitObserved=true;clearTimeout(shutdownTimer);clearInterval(watchdog);};
    const exited = (code,signal) => { observe(code,signal);timer = setTimeout(() => { child.stdout.destroy(); child.stderr.destroy(); finish(code); },drainMs); };
    const closed = (code,signal) => {observe(code,signal||exitSignal);finish(code);};
    const failed = error => finish(null,error);
    let cancelTimer;
    function cancelled() {
      cancelTimer = setTimeout(() => {
        if (done || ended()) return;
        const error = new Error('The local agent did not confirm that it stopped.');
        error.code = 'CLI_STOP_UNCONFIRMED';
        finish(null, error);
      }, options.cancelMs ?? cancelGraceMs);
    }
    child.once('error',failed); child.once('exit',exited); child.once('close',closed);
    if (options.signal?.aborted) cancelled();
    else options.signal?.addEventListener('abort', cancelled, { once:true });
    if(options.terminal){
      const check=()=>{
        if(done||forced||ended())return;const current=terminal();if(current===terminalState)return;
        terminalState=current;clearTimeout(shutdownTimer);shutdownTimer=undefined;
        terminalAt=current?Date.now():null;
        if(current)shutdownTimer=setTimeout(()=>{
          if(done||ended()||terminal()!==current)return;forced=true;
          try{options.onStalled?.(current,{graceMs,afterTerminalMs:Date.now()-terminalAt});const requested=(options.stop||(()=>child.kill()))();if(!done&&requested===false)forced=false;}catch(error){finish(null,error);return;}
          if(done)return;
          stopTimer=setTimeout(()=>{const error=new Error('The native agent reported a terminal event but its process could not be closed. The task was not retried.');error.code='CLI_SHUTDOWN_STALLED';finish(null,error);},options.stopTimeoutMs??2000);
        },graceMs);
      };
      watchdog=setInterval(check,options.pollMs??100);check();
    }
  });
}
module.exports = { waitForCliExit,shutdownGraceMs };

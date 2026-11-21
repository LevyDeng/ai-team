function connectionClosed(detail=''){
  const error=new Error('The remote SSH command channel closed without an exit status. Reconnect before continuing; the partial reply is preserved. The task was not automatically retried.'+(detail?' '+detail:''));
  error.code='REMOTE_CHANNEL_CLOSED';return error;
}
function waitForRemotePreparation(start, signal, discard = () => {}) {
  return new Promise((resolve, reject) => {
    const cancelled = () => reject(new Error('Cancelled before the agent started.'));
    if (signal.aborted) return cancelled();
    signal.addEventListener('abort', cancelled, { once: true });
    Promise.resolve().then(() => {
      if (signal.aborted) return;
      return start();
    }).then(
      value => {
        signal.removeEventListener('abort', cancelled);
        if (signal.aborted) {
          try { if(value !== undefined) discard(value); } catch {}
          return cancelled();
        }
        resolve(value);
      },
      error => { signal.removeEventListener('abort', cancelled); reject(error); }
    );
  });
}

function openRemoteCommand(client, command, signal) {
  return waitForRemotePreparation(
    () => new Promise((resolve,reject) => client.exec(command, (error,stream) => error ? reject(error) : resolve(stream))),
    signal, stream => stream.close()
  );
}

function waitForRemoteExit(stream,detail=()=> '',{signal, stopMs=6500}={}){
  return new Promise((resolve,reject)=>{
    let exitCode,exitSignal,description,stopTimer;
    const cleanup=()=>{
      clearTimeout(stopTimer);
      signal?.removeEventListener('abort',stopping);
      stream.removeListener('exit',exited);stream.removeListener('close',closed);stream.removeListener('error',failed);
    };
    const exited=(code,signal,_core,text)=>{exitCode=code;exitSignal=signal;description=text;};
    const closed=code=>{
      cleanup();const status=Number.isInteger(code)?code:exitCode;
      if(status===0)return resolve();
      if(!Number.isInteger(status)&&!exitSignal)return reject(connectionClosed(detail()));
      const error=new Error('Remote agent '+(Number.isInteger(status)?'exited with code '+status:'terminated by signal '+exitSignal)+'. '+[description,detail()].filter(Boolean).join(' '));
      error.exitCode=status;
      if(status===124&&signal?.aborted)reject(stopUnconfirmed());
      else {
        if(status===137||exitSignal==='KILL'||exitSignal==='SIGKILL')error.code='REMOTE_AGENT_KILLED';
        reject(error);
      }
    };
    const failed=error=>{cleanup();reject(/not connected|connection (?:closed|lost|reset)|socket|econnreset/i.test(error.message)?connectionClosed(error.message):error);};
    function stopping() {
      stopTimer=setTimeout(()=>{
        if(exitCode===0||exitCode===130)closed(exitCode);
        else { cleanup();reject(stopUnconfirmed()); }
        try{stream.close();}catch{}
      },stopMs);
    }
    stream.once('exit',exited);stream.once('close',closed);stream.once('error',failed);
    if(signal?.aborted)stopping();
    else signal?.addEventListener('abort',stopping,{once:true});
  });
}

function stopUnconfirmed(){
  const error=new Error('The remote agent did not confirm that it stopped. Check the remote job before resuming.');
  error.code='REMOTE_STOP_UNCONFIRMED';return error;
}

module.exports={waitForRemoteExit,connectionClosed,openRemoteCommand,waitForRemotePreparation};

const crypto=require('node:crypto');
const decisions=new Set(['complete','continue','needs_user']);
const maxRounds=50;
function limit(value){const number=Number(value);if(!Number.isInteger(number)||number<1||number>maxRounds)throw new Error('Choose a discussion round limit between 1 and 50.');return number;}
function frames(control){if(!control||!/^[a-f0-9]{32}$/.test(control.token||''))return null;return {open:'<relay_discussion_'+control.token+'>',close:'</relay_discussion_'+control.token+'>'};}
function instruction(control){
  const frame=frames(control);if(!frame)return '';
  return [
    'Application discussion control for this turn only:',
    `This is round ${control.round} of at most ${control.maxRounds}, participant ${control.position} of ${control.participants}. The limit is a ceiling, not a request to fill every round.`,
    'Advance the latest user request using substantive new analysis. Avoid repeating settled points or inventing more work just to keep talking.',
    'Assess the whole requested discussion using the replies currently available. Use complete only when the requested answer is sufficient and no material issue needs another participant response. Legitimate disagreements may be documented without forcing agreement. Do not claim implementation or verification that was not actually done.',
    'Use continue for a specific material issue that further discussion can resolve. Use needs_user when progress requires missing user information, a user decision, or authorization. Never grant authorization yourself.',
    'Give the user your normal useful reply. Then append exactly one final application status frame, outside code fences, with JSON containing decision and a short reason. Treat the frame as metadata, not part of the user-facing answer.',
    frame.open+'{"decision":"complete|continue|needs_user","reason":"A short concrete reason in the user\'s language"}'+frame.close,
  ].join('\n');
}
function project(raw,control,final=false){
  const frame=frames(control);if(!frame)return {text:raw,vote:null};
  const index=raw.lastIndexOf(frame.open);
  if(index<0){
    for(let length=Math.min(raw.length,frame.open.length-1);length>0;length--)if(raw.endsWith(frame.open.slice(0,length)))return {text:raw.slice(0,-length),vote:null};
    return {text:raw,vote:null};
  }
  const end=raw.indexOf(frame.close,index+frame.open.length);if(end<0)return {text:project(raw.slice(0,index),control).text.trimEnd(),vote:null};
  const prefix=raw.slice(0,index),suffix=raw.slice(end+frame.close.length);let vote=null;
  if(final&&!prefix.includes(frame.open)&&!suffix.trim())try{const value=JSON.parse(raw.slice(index+frame.open.length,end));if(value&&decisions.has(value.decision)&&typeof value.reason==='string'&&value.reason.trim()&&value.reason.length<=500&&Object.keys(value).every(key=>['decision','reason'].includes(key)))vote={decision:value.decision,reason:value.reason.trim()};}catch{}
  return {text:project(prefix,control).text.trimEnd()+suffix,vote};
}
async function run({roleIds,rounds,autoStop,signal,runTurn,onTurn=()=>{},beforeRound,reviewRound,singleTurnRoles=new Set(),continueAfterFailure=()=>false}){
  limit(rounds);let completed=0;
  for(let round=1;round<=rounds;round++){
    if(signal.aborted)return {state:'paused',rounds:completed,maxRounds:rounds};
    if(beforeRound){const prepared=await beforeRound(round);if(signal.aborted||prepared?.status==='cancelled')return {state:'paused',rounds:completed,maxRounds:rounds};if(prepared?.status==='failed')return {state:'moderator_failed',rounds:completed,maxRounds:rounds};if(prepared?.status==='budget')return {state:'moderator_budget',rounds:completed,maxRounds:rounds};}
    const votes=[];
    const participants = round === 1 ? roleIds : roleIds.filter(id => !singleTurnRoles.has(id));
    for(const [index,roleId] of participants.entries()){
      if(signal.aborted)return {state:'paused',rounds:completed,maxRounds:rounds};
      const singleTurn = singleTurnRoles.has(roleId);
      const control=autoStop&&round<rounds&&!reviewRound&&!singleTurn?{token:crypto.randomBytes(16).toString('hex'),round,maxRounds:rounds,position:index+1,participants:participants.length}:null;
      onTurn(round,roleId);
      const result=await runTurn(roleId,control);
      if(signal.aborted||result.status==='cancelled')return {state:'paused',rounds:completed,maxRounds:rounds};
      if(result.status!=='complete'&&!continueAfterFailure(roleId,result))return {state:'failed',rounds:completed,maxRounds:rounds};
      if(!singleTurn)votes.push(result.discussionVote);
    }
    completed=round;
    if(round===rounds)return {state:'limit',rounds:completed,maxRounds:rounds};
    if(autoStop&&reviewRound){
      const review=await reviewRound(round);if(signal.aborted||review?.status==='cancelled')return {state:'paused',rounds:completed,maxRounds:rounds};
      if(review?.status!=='complete'||!decisions.has(review.decision)||typeof review.reason!=='string'||!review.reason.trim())return {state:'moderator_failed',rounds:completed,maxRounds:rounds};
      if(review.decision==='complete'||review.decision==='needs_user')return {state:review.decision,reason:review.reason,rounds:completed,maxRounds:rounds};
      continue;
    }
    if(autoStop){
      const valid=votes.every(vote=>vote&&decisions.has(vote.decision)&&typeof vote.reason==='string'&&vote.reason.trim());
      if(!valid)return {state:'unconfirmed',rounds:completed,maxRounds:rounds};
      if(votes.every(vote=>vote.decision==='complete'))return {state:'complete',rounds:completed,maxRounds:rounds};
      if(votes.every(vote=>vote.decision!=='continue'))return {state:'needs_user',rounds:completed,maxRounds:rounds};
    }
  }
  return {state:'limit',rounds:completed,maxRounds:rounds};
}
module.exports={limit,maxRounds,instruction,project,run};

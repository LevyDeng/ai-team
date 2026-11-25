function decisionFor(node, receipt) {
  if (receipt?.status !== 'complete' || receipt.warningCode === 'CLAUDE_PERMISSION_DENIED') {
    return {reason:'节点未取得已确认的结果，请查看运行记录后重试。'};
  }
  const output = (receipt.text || '').trim();
  const lines = output.split(/\r?\n/);
  const marker = lines.at(-1)?.trim();
  const choice = /^WORKFLOW: EXIT (\d+)$/.exec(marker);
  if (marker === 'WORKFLOW: BLOCKED') {
    return {reason:'节点报告需要人工处理，请查看输出并补充说明。'};
  }
  const evidence = choice || marker === 'WORKFLOW: NEEDS_USER' ? lines.slice(0,-1).join('\n').trim() : output;
  if (node.exits.length === 1 && evidence) return {exit:node.exits[0],evidence};
  const exit = choice && node.exits[Number(choice[1])-1];
  if (exit && evidence) return {exit,evidence};
  return {reason:marker === 'WORKFLOW: NEEDS_USER' ? '节点无法选择出口，请查看输出并补充说明。' :
    '结果缺少依据或有效的出口编号，请查看节点输出。'};
}

function exitInstructions(node) {
  if (node.exits.length === 1) return [
    'This node has one outgoing connection. Report what you achieved, what remains, and the evidence in the language of the task. The workflow forwards the report to the next step, including any findings that the next step should verify. No exit marker is needed.',
    'If you cannot hand off useful results and need the user to unblock this step, explain what you need from them and end with WORKFLOW: BLOCKED on its own line.',
  ];
  return [
    'Compare your observed results against the meaning of the user-defined exit conditions below. Choose the best matching condition based on the evidence, explain your choice in the language of the task, and end with WORKFLOW: EXIT N on its own line (replace N with the exit number). If no condition fits or the evidence is insufficient to choose, explain what is missing and end with WORKFLOW: NEEDS_USER.',
    ...node.exits.map((exit,index)=>(index+1)+'. '+exit.label),
  ];
}

module.exports = {decisionFor, exitInstructions};

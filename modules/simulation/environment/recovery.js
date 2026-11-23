export function onboardingRecovery(session){
  if(!['recovery_required','operation_interrupted','stalled'].includes(session?.state))return null;
  const receipt=session.recovery||{};
  return {operation:receipt.operation||session.operation?.kind||'未说明操作',operationId:receipt.operation_id||session.operation?.operation_id||null,
    startedAt:receipt.started_at||session.operation?.started_at||null,status:session.state};
}
export function recoveryMessage(session){const value=onboardingRecovery(session);return value?`原操作 ${value.operation} 已中断，需要人工恢复。原记录与提交键已保留；自动轮询和后续操作已停止。`:null;}

import { useState } from 'react';
import type { ApprovalProof, ApprovalRequest } from '@opspilot/contracts';

import { Modal } from './ui/modal';

interface RiskDecisionDialogProps {
  environment: string;
  request: ApprovalRequest;
  onApprove: (proof: ApprovalProof) => void;
  onReject: () => void;
}

export function RiskDecisionDialog({
  environment, request, onApprove, onReject,
}: RiskDecisionDialogProps) {
  const requestKey = `${request.approvalId}:${request.argsDigest}:${request.confirmationTarget ?? ''}`;
  const [confirmation, setConfirmation] = useState({ requestKey, value: '' });
  const confirmedResource = confirmation.requestKey === requestKey ? confirmation.value : '';
  const blocked = request.risk.level === 'L4';
  const needsExactTarget = request.risk.level === 'L3';
  const targetMatches = !needsExactTarget || confirmedResource === request.confirmationTarget;

  const approve = () => {
    if (blocked || !targetMatches) return;
    onApprove({
      approvalId: request.approvalId,
      toolCallId: request.toolCallId,
      argsDigest: request.argsDigest,
      ...(needsExactTarget ? { confirmedResource } : {}),
    });
  };

  return <Modal onClose={onReject} open>
    <section aria-labelledby="risk-dialog-title" aria-modal="true" className="risk-dialog" role="alertdialog">
      <header>
        <div>
          <span className={`risk-level risk-${request.risk.level.toLowerCase()}`}>{request.risk.level}</span>
          <h2 id="risk-dialog-title">操作审批</h2>
        </div>
        {environment === 'production' ? <span className="production-chip">生产环境</span> : null}
      </header>

      <dl className="risk-details">
        <div><dt>工具</dt><dd>{request.toolName}</dd></div>
        <div><dt>目标</dt><dd>{request.targetLabel}</dd></div>
        <div><dt>影响</dt><dd>{request.impactSummary}</dd></div>
        <div><dt>风险原因</dt><dd>{request.risk.reason}</dd></div>
        <div><dt>参数摘要</dt><dd className="digest">{request.argsDigest}</dd></div>
        <div><dt>快照</dt><dd>{request.risk.snapshotRequired ? '执行前必须创建' : '此操作不要求'}</dd></div>
      </dl>

      {request.risk.confirmationText ? <p className="confirmation-copy">{request.risk.confirmationText}</p> : null}
      {blocked ? <div className="alert danger-alert"><strong>产品不提供结构化执行</strong><span>请检查目标与操作方式；此风险等级不能在应用内批准。</span></div> : null}
      {needsExactTarget && !blocked ? <label className="confirmation-field">
        确认目标资源
        <input
          autoComplete="off"
          onChange={(event) => setConfirmation({ requestKey, value: event.target.value })}
          placeholder={request.confirmationTarget}
          spellCheck={false}
          value={confirmedResource}
        />
      </label> : null}

      <footer>
        <button onClick={onReject} type="button">拒绝</button>
        {!blocked ? <button className="primary" disabled={!targetMatches} onClick={approve} type="button">确认执行</button> : null}
      </footer>
    </section>
  </Modal>;
}

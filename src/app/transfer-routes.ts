import { FIVE_PARTS, TRANSFER_PART_ROLES, type TransferFileRole, type TransferPartRole, type TransferRoute } from '../transfer-api.ts';

export type TransferRouteDefinition = {
  id: TransferRoute;
  label: string;
  businessKind: 'write' | 'reply' | 'correction';
  fileRoles: readonly TransferFileRole[];
  requiredPartCodes: readonly string[] | 'selected';
  remoteForm: string;
};

export const TRANSFER_ROUTE_DEFINITIONS: Record<TransferRoute, TransferRouteDefinition> = {
  application: { id: 'application', label: '提出申请', businessKind: 'write', fileRoles: ['application'], requiredPartCodes: FIVE_PARTS.map(part => part.code), remoteForm: 'PatentRequestInfo' },
  reply: { id: 'reply', label: '审查意见答复', businessKind: 'reply', fileRoles: ['baseline', 'application', ...Object.keys(TRANSFER_PART_ROLES) as TransferPartRole[], 'reply'], requiredPartCodes: 'selected', remoteForm: 'OpinionStatement' },
  correction: { id: 'correction', label: '补正', businessKind: 'correction', fileRoles: ['baseline', 'application', ...Object.keys(TRANSFER_PART_ROLES) as TransferPartRole[]], requiredPartCodes: 'selected', remoteForm: 'Correction' },
};

export function transferRouteDefinition(route: TransferRoute) { return TRANSFER_ROUTE_DEFINITIONS[route]; }

export const TRANSFER_API_CONTRACT_VERSION = 1 as const;
export const FIVE_PARTS = [
  { code: '100001', name: '权利要求书' }, { code: '100002', name: '说明书' },
  { code: '100003', name: '说明书附图' }, { code: '100004', name: '说明书摘要' },
  { code: '100005', name: '摘要附图' },
] as const;
export type TransferSource = 'workbench' | 'local';
export type TransferRoute = 'application' | 'reply' | 'correction';
export type TransferFileRole = 'baseline' | 'application' | 'reply';
export type CorrectionRow = { ChangeId: string; Sort: number; FileName: string; PositionInFile: string; CorrectionBefore: string; CorrectionAfter: string };
export type PartComparison = { code: string; name: string; changed: boolean | null; reason: string; available?: boolean; before?: string; after?: string };
export type TransferForm = {
  noticeDate: string; noticeName: string; noticeNo: string;
  correctionReason: 1 | 2; addEntrust: boolean; corrections: CorrectionRow[];
  otherProof: boolean; experimentData: boolean; abstractFigure: string;
  declarations: Record<string, boolean>;
};
export type TransferReview = { confirmedDraftId?: string; keepCodes: string[]; form: TransferForm; stepId: string; userId: string; remark: string };
export type RemoteFileDeleteRef = { fileNo: string; handId: string; fingerprint: string };
export type RemoteTransferFile = { fileNo: string; name: string; deleteRef?: RemoteFileDeleteRef; deleteDisabledReason?: string };
export type RemoteFileDeletion = {
  target: RemoteFileDeleteRef; name: string; kind: 'part' | 'mix' | 'reply'; formCode?: string;
  preservationHash: string; requestedAt: string;
};
export type TransferView = {
  sourceDraft?: {id:string;at?:string;pending:boolean};
  sourceMode?: TransferSource; id: string; profileKey: string; caseId: string; caseNumber: string; caseTitle: string; processId: string; processName: string;
  route: TransferRoute; canEditRemote?: boolean; handId?: string; currentNode?: string; currentUser?: string;
  files: Array<{ role: TransferFileRole; name: string; relativePath: string; hash: string }>;
  parts: PartComparison[]; review: TransferReview;
  steps: Array<{ id: string; name: string; users: Array<{ id: string; name: string }> }>;
  phase: 'draft' | 'saved' | 'submitted' | 'uncertain' | 'superseded';
  results: string[]; error?: string; submissionAttempted?: boolean; submissionRetryable?: boolean; submissionFingerprint?: string; existingFileNames: string[]; existingFiles?: RemoteTransferFile[]; at: string;
  revokedByUser?: boolean;
  submissionTarget?: {handId:string;step:{id:string;name:string};user:{id:string;name:string}};
  cleanupPending?: boolean; cleanupFileNos?: string[]; localReviewSaved?: boolean;
  fileDeletion?: RemoteFileDeletion;
};
export type TransferFilePreviewRef = { role?: TransferFileRole; partCode?: string; fileNo?: string; name?: string };
export type TransferFilePreviewResult = {
  name: string;
  content?: string;
  parts?: Array<{ code: string; name: string; content: string }>;
  mediaType?: 'docx' | 'image' | 'text' | 'unknown';
  dataUrl?: string;
};
export type NameDiscrepancyRequest = {
  reqId: string;
  applicationName: string;
  caseName: string;
};
export type TransferAPI = {
  history(profileKey: string, caseId: string): Promise<TransferView[]>;
  inspect(profileKey: string, caseId: string): Promise<TransferView | null>;
  prepare(profileKey: string, caseId: string, sourceMode?: TransferSource): Promise<TransferView>;
  pickFile(profileKey: string, id: string, role: TransferFileRole): Promise<TransferView | null>;
  removeFile(profileKey: string, id: string, role: TransferFileRole): Promise<TransferView>;
  clearRemote(profileKey: string, id: string): Promise<TransferView>;
  deleteRemoteFile(profileKey: string, id: string, target: RemoteFileDeleteRef): Promise<TransferView>;
  previewFile(profileKey: string, id: string, fileRef: TransferFilePreviewRef): Promise<TransferFilePreviewResult>;
  startHand(profileKey: string, id: string): Promise<TransferView>;
  saveLocalReview(profileKey: string, id: string, review: TransferReview): Promise<TransferView>;
  save(profileKey: string, id: string, review: TransferReview): Promise<TransferView>;
  submit(profileKey: string, id: string, review?: TransferReview): Promise<TransferView>;
  refresh(profileKey: string, id: string): Promise<TransferView>;
  reprepare(profileKey: string, id: string): Promise<TransferView>;
  revoke(profileKey: string, id: string): Promise<TransferView>;
  onConfirmNameRequest?: (callback: (req: NameDiscrepancyRequest) => void) => () => void;
  respondConfirmName?: (reqId: string, confirmed: boolean) => Promise<void> | void;
};
